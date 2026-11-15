package com.homecontrol.panel;

import android.util.Log;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.security.cert.X509Certificate;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 极小 MQTT 5 客户端（protocol level 5、QoS0、裸 socket），让「中控屏」作为 MQTT 节点接入 HA：
 * - 上线后发 availability(retain "online") + HA discovery(retain) → HA 自动出现 media_player 实体；
 * - 订阅 homecontrol/<slug>/cmd，收到 play/pause/stop 派发给面板 JS；
 * - 停用(stop)时发 availability "offline"(retain)；崩溃断线实体靠 availability 超时/HA 旧状态（这台 broker 拒 Will，见下）。
 * 为什么是 v5 + 0x10 头 + 不带 Will：逐字节对照 MQTTX 实测这台 EMQX——
 * ① 只认 MQTT 5（3.1.1 CONNECT 被 0 字节关线）；② CONNECT 固定头它只认 **0x10**（spec 标准值 0x20 被拒！MQTTX 也发 0x10）；
 * ③ 任何带 Will Flag 的 CONNECT 都被 0 字节关线（所以没有 LWT，靠 stop 时主动发 offline）。
 * 包型带 v5 的 properties 块（这里一律空块 0x00）。
 * 只支持 broker 必需的最小包型；重连退避 2s→60s。TLS 一律 trust-all（面板只连自己配的服务器）。
 */
public class MqttClient {

  public interface Listener {
    void onCommand(String topic, String payload);
    void onStatus(String statusJson);
  }

  private static final String TAG = "HomeMqtt";
  private static final int KEEPALIVE = 60;

  private final String host;
  private final int port;
  private final boolean tls;
  private final String user;
  private final String pass;
  private final String slug;
  private final String clientId;
  private final Listener listener;

  private final Object wlock = new Object();
  private volatile boolean wantRun = false;
  private volatile Socket socket = null;
  private volatile OutputStream out = null;
  private volatile Thread worker = null;
  private volatile String statusJson = "{\"state\":\"off\"}";
  private volatile long lastDiscoveryAt = 0L;
  // 之前这里有个 static 的 subscribeCmd 开关：一旦订阅失败就永久降级为只发布。后来查明
  // 143 是**我们自己的 SUBSCRIBE 报文少写了 topic 长度前缀**（broker 解析成非法过滤器），
  // 不是配额/ACL，已修（见 connectOnce 的 SUBSCRIBE 段）。现在每次连接都正常订阅，
  // 只有 SUBACK 明确回 >=0x80 才降级并每轮重连重试，不再锁死进程。
  private volatile boolean subscribed = false;

  public MqttClient(String host, int port, boolean tls, String user, String pass, String slug, Listener listener) {
    this.host = host;
    this.port = port;
    this.tls = tls;
    this.user = user == null ? "" : user;
    this.pass = pass == null ? "" : pass;
    this.slug = slug == null || slug.length() == 0 ? "panel" : slug;
    this.clientId = "homecontrol-" + this.slug;
    this.listener = listener;
  }

  public String availTopic() { return "homecontrol/" + slug + "/availability"; }
  public String cmdTopic() { return "homecontrol/" + slug + "/cmd"; }
  public String stateTopic() { return "homecontrol/" + slug + "/state"; }
  public String discoveryTopic() { return "homeassistant/media_player/homecontrol_panel_" + slug + "_music"; }

  public String status() { return statusJson; }
  public boolean connected() { return socket != null && socket.isConnected() && !socket.isClosed(); }

  public void start() {
    synchronized (this) {
      if (worker != null && worker.isAlive()) return;
      wantRun = true;
      worker = new Thread(new Runnable() {
        @Override public void run() { loop(); }
      }, "HomeMqtt");
      worker.setDaemon(true);
      worker.start();
    }
  }

  public void stop() {
    wantRun = false;
    publish(availTopic(), "offline", true); // 没有 LWT（broker 拒 Will）：停用时主动发 offline
    closeQuietly();
    setStatus("{\"state\":\"off\"}");
  }

  public boolean publish(String topic, String payload, boolean retain) {
    if (!connected() || out == null) return false;
    try {
      byte[] t = topic.getBytes("UTF-8");
      byte[] p = (payload == null ? "" : payload).getBytes("UTF-8");
      // v5 PUBLISH：topic, properties(空块), payload（QoS0 无报文号）
      byte[] body = new byte[2 + t.length + 1 + p.length];
      body[0] = (byte) ((t.length >> 8) & 0xFF);
      body[1] = (byte) (t.length & 0xFF);
      System.arraycopy(t, 0, body, 2, t.length);
      body[2 + t.length] = 0; // properties：空块
      System.arraycopy(p, 0, body, 3 + t.length, p.length);
      writePacket(retain ? 0x38 : 0x30, body);
      return true;
    } catch (Throwable e) {
      Log.w(TAG, "publish failed: " + e);
      return false;
    }
  }

  private void setStatus(String s) {
    statusJson = s;
    if (listener != null) listener.onStatus(s);
  }

  private void loop() {
    int backoff = 2000;
    while (wantRun) {
      try {
        connectOnce();
        backoff = 2000;
      } catch (Throwable e) {
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        Log.w(TAG, "mqtt connect failed: " + msg);
        closeQuietly();
        setStatus("{\"state\":\"offline\",\"err\":" + jsonString(msg) + "}");
        try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
        backoff = Math.min(backoff * 2, 60000);
      }
    }
    closeQuietly();
  }

  private void connectOnce() throws Exception {
    Socket s;
    if (tls) {
      SSLContext ctx = SSLContext.getInstance("TLS");
      ctx.init(null, new TrustManager[] { new TrustAll() }, null);
      s = ctx.getSocketFactory().createSocket();
      s.connect(new InetSocketAddress(host, port), 5000);
    } else {
      s = new Socket();
      s.connect(new InetSocketAddress(host, port), 5000);
    }
    s.setSoTimeout(KEEPALIVE * 1000);
    socket = s;
    out = s.getOutputStream();
    DataInputStream in = new DataInputStream(s.getInputStream());

    // CONNECT（MQTT 5）：clean start + 可选用户名/密码。**不带 Will**——实测这台 EMQX
    // 对任何带 Will Flag 的 CONNECT 都直接 0 字节关线（MQTTX 不带 will 能连，逐字节复刻验证）。
    // 固定头首字节发 0x10：这台 broker 认 0x10 不认 spec 标准值 0x20（MQTTX 也发 0x10）。
    byte flags = (byte) (0x02 | (user.length() > 0 ? 0x80 : 0) | (pass.length() > 0 ? 0x40 : 0));
    java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
    b.write(0); b.write(4); b.write("MQTT".getBytes("UTF-8"));
    b.write(5); b.write(flags);
    b.write((KEEPALIVE >> 8) & 0xFF); b.write(KEEPALIVE & 0xFF);
    b.write(0); // CONNECT properties：空块
    writeStr(b, clientId);
    if (user.length() > 0) writeStr(b, user);
    if (pass.length() > 0) writeStr(b, pass);
    writePacket(0x10, b.toByteArray()); // 这台 EMQX 只认 0x10 头的 CONNECT（见类注释）

    int type = in.read();
    int rem = readRem(in);
    byte[] body = readFull(in, rem);
    if (type != 0x20 || rem < 2 || body[1] != 0) {
      throw new IOException("CONNACK reason=" + (rem >= 2 ? body[1] : -1));
    }
    setStatus("{\"state\":\"connected\",\"tls\":" + (tls ? "true" : "false") + "}");
    // 这台 EMQX 拒 retain 发布（0x38 → 直接关线，MQTT5 的 Retain Available=0），所以 availability
    // 和 discovery 都发非 retain；HA 在线时能收到即时消息，discovery 每 ~2 分钟重发一次兜底。
    publish(availTopic(), "online", false);
    publish(discoveryTopic(), discoveryJson(), false);
    lastDiscoveryAt = System.currentTimeMillis();

    // v5 SUBSCRIBE：报文号(2) + properties 空块(1) + **topic 长度(2)** + topic + 订阅选项(1)。
    // 这里原来漏了 topic 长度这两个字节，broker 把 'h','o' 当成过滤器长度，判为非法过滤器后
    // 直接 DISCONNECT reason=143，面板因此被踢线并「永久降级只发布」——这才是实体/命令一直不通的根因。
    {
      byte[] ct = cmdTopic().getBytes("UTF-8");
      byte[] sub = new byte[2 + 1 + 2 + ct.length + 1];
      sub[0] = 0; sub[1] = 1; // packet id
      sub[2] = 0; // properties：空块
      sub[3] = (byte) ((ct.length >> 8) & 0xFF);
      sub[4] = (byte) (ct.length & 0xFF);
      System.arraycopy(ct, 0, sub, 5, ct.length);
      sub[5 + ct.length] = 0; // options：QoS 0
      writePacket(0x82, sub);
    }

    while (wantRun) {
      int hb;
      try {
        hb = in.read();
      } catch (SocketTimeoutException ste) {
        writePacket(0xC0, new byte[0]); // PINGREQ
        // discovery 非 retain，HA 重启后会丢实体：每 ~3 分钟（2 个 keepalive 周期）重发一次
        long now = System.currentTimeMillis();
        if (now - lastDiscoveryAt > 2L * KEEPALIVE * 1000) {
          publish(discoveryTopic(), discoveryJson(), false);
          publish(availTopic(), "online", false);
          lastDiscoveryAt = now;
        }
        continue;
      }
      if (hb < 0) throw new IOException("socket closed by broker");
      int len = readRem(in);
      byte[] p = readFull(in, len);
      int pktType = hb & 0xF0;
      if (pktType == 0xE0) {
        // broker 主动踢线：把原因码带进日志（129=协议错误、143=非法 topic 过滤器、141=换服务器）
        throw new IOException("broker DISCONNECT reason=" + (p.length > 0 ? (p[0] & 0xFF) : -1));
      }
      if (pktType == 0x90 && p.length >= 4) {
        // SUBACK（v5）：报文号(2) + properties 块(varint 长度 + 内容) + 每个过滤器的原因码
        int off2 = 2;
        int pl = 0, mul2 = 1;
        while (off2 < p.length) {
          int d = p[off2] & 0xFF;
          off2++;
          pl += (d & 0x7F) * mul2;
          if ((d & 0x80) == 0) break;
          mul2 *= 128;
        }
        off2 += pl;
        int rc = off2 < p.length ? (p[off2] & 0xFF) : 0x80;
        if (rc >= 0x80) {
          subscribed = false;
          Log.w(TAG, "subscribe denied (0x" + Integer.toHexString(rc) + "): 降级为只发布状态");
          setStatus("{\"state\":\"connected-no-sub\",\"tls\":" + (tls ? "true" : "false") + "}");
        } else {
          subscribed = true;
          Log.i(TAG, "subscribed " + cmdTopic() + " (qos=" + rc + ")");
          setStatus("{\"state\":\"connected\",\"tls\":" + (tls ? "true" : "false") + "}");
        }
      } else if (pktType == 0x30) {
        // QoS 在固定头 bit1-2（0x30 = QoS0），写成 >>3 会得到 2 而多吃 2 字节报文号，把 payload 前两个字切掉
        int qos = (hb >> 1) & 0x03;
        int tl = ((p[0] & 0xFF) << 8) | (p[1] & 0xFF);
        String topic = new String(p, 2, tl, "UTF-8");
        int off = 2 + tl;
        // v5：topic 后是 properties 块（varint 长度 + 内容），先跳掉
        int propLen = 0, mul = 1;
        while (off < p.length) {
          int d = p[off] & 0xFF;
          off++;
          propLen += (d & 0x7F) * mul;
          if ((d & 0x80) == 0) break;
          mul *= 128;
        }
        off += propLen;
        if (qos >= 1 && off + 2 <= p.length) {
          int pid = ((p[off] & 0xFF) << 8) | (p[off + 1] & 0xFF);
          off += 2;
          if (qos == 1) {
            // v5 PUBACK：报文号 + 原因码(0x00成功) + 空 properties
            writePacket(0x90, new byte[] { (byte) ((pid >> 8) & 0xFF), (byte) (pid & 0xFF), 0x00, 0x00 });
          }
        }
        String payload = off <= p.length ? new String(p, off, p.length - off, "UTF-8") : "";
        Log.i(TAG, "cmd " + topic + " <- " + payload);
        if (listener != null) listener.onCommand(topic, payload);
      } else if (pktType == 0xD0) {
        // PINGRESP
      }
    }
    throw new IOException("client stopped");
  }

  private String discoveryJson() {
    StringBuilder sb = new StringBuilder();
    sb.append("{\"availability_topic\":\"").append(availTopic()).append("\"");
    sb.append(",\"payload_available\":\"online\",\"payload_unavailable\":\"offline\"");
    sb.append(",\"state_topic\":\"").append(stateTopic()).append("\"");
    sb.append(",\"value_template\":\"{{ value_json.status }}\"");
    sb.append(",\"attribute_template\":\"{{ value_json.title }}\"");
    sb.append(",\"command_topic\":\"").append(cmdTopic()).append("\"");
    sb.append(",\"payload_play\":\"play\",\"payload_pause\":\"pause\",\"payload_stop\":\"stop\"");
    sb.append(",\"payload_playing\":\"playing\",\"payload_paused\":\"paused\",\"payload_idle\":\"idle\"");
    sb.append(",\"name\":\"中控屏音乐 ").append(slug).append("\"");
    sb.append(",\"unique_id\":\"homecontrol_panel_").append(slug).append("_music\"}");
    return sb.toString();
  }

  private static void writeStr(java.io.ByteArrayOutputStream b, String s) throws IOException {
    byte[] u = s.getBytes("UTF-8");
    b.write((u.length >> 8) & 0xFF);
    b.write(u.length & 0xFF);
    b.write(u);
  }

  private static String jsonString(String s) {
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\') sb.append('\\').append(c);
      else if (c < 0x20) sb.append(' ');
      else sb.append(c);
    }
    return sb.append("\"").toString();
  }

  private void writePacket(int header, byte[] body) throws IOException {
    synchronized (wlock) {
      OutputStream o = out;
      if (o == null) throw new IOException("not connected");
      int rem = body.length;
      byte[] len = new byte[4];
      int n = 0;
      do {
        int d = rem % 128;
        rem /= 128;
        if (rem > 0) d |= 0x80;
        len[n++] = (byte) d;
      } while (rem > 0);
      o.write(header);
      o.write(len, 0, n);
      o.write(body);
      o.flush();
    }
  }

  private static int readRem(DataInputStream in) throws IOException {
    int multiplier = 1, value = 0, count = 0;
    while (true) {
      int d = in.read();
      if (d < 0) throw new IOException("eof");
      value += (d & 0x7F) * multiplier;
      if ((d & 0x80) == 0) return value;
      multiplier *= 128;
      if (++count > 4) throw new IOException("bad remaining length");
    }
  }

  private static byte[] readFull(DataInputStream in, int len) throws IOException {
    byte[] p = new byte[len];
    int got = 0;
    while (got < len) {
      int r = in.read(p, got, len - got);
      if (r < 0) throw new IOException("eof mid packet");
      got += r;
    }
    return p;
  }

  private void closeQuietly() {
    Socket s = socket;
    socket = null;
    out = null;
    if (s != null) {
      try { s.close(); } catch (Throwable ignored) { }
    }
  }

  private static final class TrustAll implements X509TrustManager {
    @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
    @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
    @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
  }
}
