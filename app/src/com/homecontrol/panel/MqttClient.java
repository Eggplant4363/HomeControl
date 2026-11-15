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
 * - LWT 写 availability "offline"，断线 HA 自动把实体置 unavailable。
 * 为什么是 v5：用户的 broker（10.10.1.8）只认 MQTT 5——发 3.1.1 CONNECT 会被直接关线（0 字节 eof），
 * HA 那边能连正是因为它配了 v5。包型带 v5 的 properties 块（这里一律空块 0x00）。
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

    // CONNECT（MQTT 5）：clean start + will(availability "offline", retain) + 可选用户名/密码
    // v5 布局：可变头有 properties 块；载荷顺序 = will properties, will topic, will msg properties, will payload(BIN), user, pass
    byte flags = (byte) (0x02 | 0x04 | 0x08 | (user.length() > 0 ? 0x80 : 0) | (pass.length() > 0 ? 0x40 : 0));
    java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
    b.write(0); b.write(4); b.write("MQTT".getBytes("UTF-8"));
    b.write(5); b.write(flags);
    b.write((KEEPALIVE >> 8) & 0xFF); b.write(KEEPALIVE & 0xFF);
    b.write(0); // CONNECT properties：空块
    writeStr(b, clientId);
    byte[] wp = "offline".getBytes("UTF-8");
    b.write(0); // will properties：空块
    writeStr(b, availTopic());
    b.write(0); // will message properties：空块
    b.write((wp.length >>> 24) & 0xFF); b.write((wp.length >>> 16) & 0xFF);
    b.write((wp.length >>> 8) & 0xFF); b.write(wp.length & 0xFF);
    b.write(wp);
    if (user.length() > 0) writeStr(b, user);
    if (pass.length() > 0) writeStr(b, pass);
    writePacket(0x20, b.toByteArray());

    int type = in.read();
    int rem = readRem(in);
    byte[] body = readFull(in, rem);
    if (type != 0x20 || rem < 2 || body[1] != 0) {
      throw new IOException("CONNACK reason=" + (rem >= 2 ? body[1] : -1));
    }
    setStatus("{\"state\":\"connected\",\"tls\":" + (tls ? "true" : "false") + "}");
    publish(availTopic(), "online", true);
    publish(discoveryTopic(), discoveryJson(), true);

    byte[] ct = cmdTopic().getBytes("UTF-8");
    // v5 SUBSCRIBE：报文号, properties(空块), topic, 订阅选项字节(QoS0)
    byte[] sub = new byte[2 + 1 + ct.length + 1];
    sub[0] = 0; sub[1] = 1; // packet id
    sub[2] = 0; // properties：空块
    System.arraycopy(ct, 0, sub, 3, ct.length);
    sub[3 + ct.length] = 0; // options：QoS 0
    writePacket(0x82, sub);

    while (wantRun) {
      int hb;
      try {
        hb = in.read();
      } catch (SocketTimeoutException ste) {
        writePacket(0xC0, new byte[0]); // PINGREQ
        continue;
      }
      if (hb < 0) throw new IOException("socket closed by broker");
      int len = readRem(in);
      byte[] p = readFull(in, len);
      int pktType = hb & 0xF0;
      if (pktType == 0x30) {
        int qos = (hb >> 3) & 0x03;
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
    sb.append(",\"attribute_template\":{\"value_template\":\"{{ value_json.title }}\"}");
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
