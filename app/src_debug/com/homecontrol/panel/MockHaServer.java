package com.homecontrol.panel;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 仅用于本机联调：在 127.0.0.1 上起一个"假 Home Assistant"。
 *
 * 为什么要它：这块板子的局域网只有一个方向通（PC -> 设备），设备连不到 PC 上的
 * 测试服务，所以"面板用真实 WebSocket 连一个 HA 协议服务"这件事没法在 PC 侧验证。
 * 把服务放进 App 自己，面板连 ws://127.0.0.1:8123/api/websocket，就能在设备上
 * 把 HABackend（真实 WS 客户端路径）跑一遍。
 *
 * 只有 /sdcard/HomeControl/mockha.enabled 存在时才启动，正式使用不受影响。
 * 支持的子集：auth / get_states / 三张 registry / subscribe_events / call_service / ping。
 */
public class MockHaServer {

    static final String TAG = "MockHa";
    static final String TOKEN = "test-token";

    /* 假摄像头的快照（320x180 JPEG，Base64）——不引第三方库，直接内置一张图 */
    private static final String CAM_JPEG_B64 =
            "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDABIMDhAOCxIQDxAUExIVGy0dGxkZGzcoKiEtQjpFREA6Pz5IUWhYSE1iTj4/WntcYmtv" +
            "dHZ0RleAiX9xiGhydHD/2wBDARMUFBsYGzUdHTVwSz9LcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw" +
            "cHBwcHBwcHD/wAARCAC0AUADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF" +
            "BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW" +
            "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi" +
            "4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC" +
            "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm" +
            "Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq" +
            "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlKKKKskKKKKAFooooAKKKKACloooAKWkpaACiiimAUUUUAFLRRQAUUUUAFLSUtABRRRQA" +
            "tFFFABRRS0CCiiigAoopaACiiigApaSloAKKKKYBS0lLQBVoooqRhRRS0AFFFFABRRS0AFFFFAC0UUUAFFFFMAoopaACiiigAooo" +
            "oAWiiigAoopaACiiigQUtFFABRRRQAUtFFABRRRQAtFFFABRRRTAKWiigCrRRRUjCloooAKKKKACloooAKWkpaACiiimAUUUUAFL" +
            "RRQAUUUUAFLSUtABRRRQAUtFFABRRRQIWiiigAoopaACiiigApaSloAKKKKYBRRS0AFFFFAFWiilqRhRRRQAUUUtABRRRQAUtFFA" +
            "BRRRTAKKKKAFooooAKKKKAFooooAKKKWgAooooEFLSUtABRRRQAUtJS0AFFFFAC0UUUAFFFFMApaKKACiiigCrS0UVIwooooAKWi" +
            "igAoopaACiiimAUVYsrG5vpGS1j8xlGSNwHH40XlncWMoiuY/LcjcBkHj8KQFelq/b6LqFxAs8VvujYZB3qM/maoqrO4RVLMTgAD" +
            "JJpgJRWkugaoyBhaHBGeXUH8iaoSxSQyFJUZHHVWGCKQDKWp7Szub2TZbQtIR1x0H1PQVNd6Tf2kXmT2zKndgQwH1x0pgUqKns7O" +
            "4vZTFbR73A3EZA4/Go5InjmaJlPmK20qOeaAGUtXLrS7yzhEtxCI0JwCXXJP0zmqdABRU9pZ3N5JstoWkI646D6noKmutJvrSLzJ" +
            "7dlTuwIYD646UAU6KKux6TfSWn2lICYdpbduHQe2c0AUqKVQWYAdTwKvXOkX9rA009vtjXqd6nH5GgCjRVizsri9dkto/MZRk8gY" +
            "H40l3Zz2UojuY9jkbgMg8fhQBBRRS0CCiiimAUUUtABRRRQAUUUtAFWiiipGFFFFAC0UUUAFLRRQAUUUUwOi8F/8f8//AFy/qKn8" +
            "Uxm7t7a5jGWErQkD1zgfy/WoPBf/AB/z/wDXL+orT0Mpdx3kEnIiuy49vmyP1BpPdAupo2u2FDZp/wAsIkH8/wDCuf8ACUEaLdX0" +
            "gBMfyqfTjJ/pWjpNx9o1XVm7KyqPwyP6Vn+EriJ0ubGQgGTLKPXjBqddfQe2hSl8S6i1wZEdUjzkR7ARj0z1rS18R6hoMGohAsi4" +
            "z9DwR+dZsnhnUFuTGiI8eeJN4Ax7jr+laWvtHp+gwacHDSNgH6Dkn86btbQFe5Le3B0LQ7eK2VRNJwWI745NUNP8TTIJFvx9oVl+" +
            "XCgHPoe2Kv30H9u6JBLalTLHztJxzjke1VNK8OlRLLqqBI1U4XfyP9rIo73DorEXhMq2szMi7FMbELnOBuHFatjpIt7u51CdDJKX" +
            "doo15IGTz9TWX4U8sa3OIixj8ttpbrjcMZqQa5NF4ifz3/0cOYto6KM9ab6WDvcx9T1CbULkyzHAHCJ2UVUrc8Uad9mu/tMQ/czH" +
            "n2bv+fX86w6I7Ce5115OdC0O3jtlUTSdWI745NUbDxLMgkW/H2hWX5cKAc+h7Yq/fQf27okEtqVMsfO0nHOORVPS/DxUSy6ogSNV" +
            "OF38j/ayKXe4+isYccf2m8WOFdvmvhVznGTXbfaorfUYNMUDYYTx/IfkDWD4ZtY5dWlnTJhgzsLdTngZ/DNWJtV0Zr/7S1tctOrc" +
            "SA+n/Aqb6IXdmNe2ps9WeDGAsg2/TPH6V2l+BPHJZnGZomI+ox/jWJ4lhWV7O/i5WTCk/qP61oajP5Ovad6MHQ/jj+tLdJD2bZS8" +
            "MJ9mspLhxhpZliGfrj+p/Kqfi7/kKJ/1yH8zWrqpS1m062iGA9z5h/76/wDsqyvF3/IUT/rkP5mjdphtcw6WiiqJCiiimAUtFFAB" +
            "RRRQAUtJS0AVaKKKkYUtJS0AFFFLQAUUUUAFFFFMCzZX1zYyM9rJ5bMME7QePxp9rqV3aSyyQTbHlOXO0HP5iqdLQBatNRu7NpGt" +
            "5thl+/8AKDn8x71WVmVwykhgcgjgg0lFAGmmvaoiBBdnAGOVUn8yM1nyyyTSGSV2kc9WY5JplLSAntLy5spN9tM0ZPXHQ/UdDU13" +
            "qt9eRiO4uGZP7oAUH6461SopgWLO8uLKUy20mxyNpOAePxqKWRpZWkkOXclmPqTTaKALkmqXstoLWSbdCAAFKL26c4zVOiigCxaX" +
            "lxZyb7aZoyeuOh+o6GpbvVL68j2XFwzJ/dACg/XHWqdFAFq01G7s4nit5diP94bQc/iRVWiigC2dSuzaLambMK4wpUcYORzjNFzq" +
            "N3dTRyzy7niOUO0DH5CqtFAFq41G7uZ455pd0kX3DtAxznsKZd3c97KJLmTe4GAcAcfhUFLQAUUUUxBRRS0AFFFFABRRRQAtFFFA" +
            "FWiiipGLRRRQAUtFFABRRRTAKKKKAFooooAKKKKACloooAKKKWgAooooEFLSUtABRRRQAUtJS0AFFFFABS0UUAFFFFMApaKKACii" +
            "igApaSloAKKKKAKtLSUtSMKKKWgAooooAKKKKYBS0lLQAUUUUAFFFLQAUUUUAFLSUtABRRRQIWiiigAooooAWiiigAoopaACiiig" +
            "AooopgLRRRQAUUUUALRRRQAUUUUAVqKKKkYUtFFABRRRTAKKKKAFooooAKKKKACloooAKKKKAFooooEFLSUtABRRRQAUtJS0AFFF" +
            "FABS0UUAFFFFMApaSloAKKKKAClpKWgAooooAKWkpaAKtFFFSMWiiigAooopgFFFLQAUUUUAFFFLQAUUUUAFLSUtABRRRQIKWiig" +
            "AooooAWiiigAoopaACiiigAooopgLRRRQAUUUUALRRRQAUUUUALRRRQBVpaKKkYUUUUwCiiigApaKKACiiigApaKKACiiigBaKKK" +
            "BBRRRQAtFFFABRRRQAtFFFABS0UUAFFFFMApaKKACiiigApaKKACiiigApaKKACiiigD/9k=" +
            "";
    static final String FLAG = "/sdcard/HomeControl/mockha.enabled";

    private final int port;
    private ServerSocket server;
    private volatile boolean running;
    private final List<Conn> conns = Collections.synchronizedList(new ArrayList<Conn>());
    private final Map<String, JSONObject> states = new LinkedHashMap<String, JSONObject>();
    private int nextSubId = 1;

    public MockHaServer(int port) {
        this.port = port;
        seed();
    }

    public static boolean enabled() {
        try {
            return new File(FLAG).exists();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 联调专用：故意让 WebSocket 握手失败，用来验证面板的 REST 兜底 */
    static boolean wsDisabled() {
        try {
            return new File("/sdcard/HomeControl/mockha.nows").exists();
        } catch (Throwable t) {
            return false;
        }
    }

    /* ---------------- 样例数据 ---------------- */

    private JSONObject mkState(String id, String state, JSONObject attrs) {
        JSONObject o = new JSONObject();
        try {
            o.put("entity_id", id);
            o.put("state", state);
            o.put("attributes", attrs == null ? new JSONObject() : attrs);
            o.put("last_changed", now());
        } catch (Exception e) { }
        return o;
    }

    private JSONObject attrs(String k1, Object v1) {
        JSONObject a = new JSONObject();
        try { a.put(k1, v1); } catch (Exception e) { }
        return a;
    }

    /** 最小服务处理：REST 兜底链路够用（toggle / turn_on / turn_off） */
    void applyRestService(String domain, String service) {
        try {
            for (JSONObject s : states.values()) {
                if (!s.optString("entity_id", "").startsWith(domain + ".")) continue;
                boolean on = "on".equals(s.optString("state", ""));
                if ("toggle".equals(service)) {
                    s.put("state", on ? "off" : "on");
                } else if ("turn_on".equals(service)) {
                    s.put("state", "on");
                } else if ("turn_off".equals(service)) {
                    s.put("state", "off");
                } else if ("open_cover".equals(service) && domain.equals("cover")) {
                    s.put("state", "open");
                } else if ("close_cover".equals(service) && domain.equals("cover")) {
                    s.put("state", "closed");
                }
                s.put("last_changed", now());
            }
            Log.i(TAG, "rest service " + domain + "." + service);
        } catch (Exception e) {
            Log.w(TAG, "rest service failed: " + e);
        }
    }
    private void seed() {
        JSONObject bright = new JSONObject();
        try {
            bright.put("friendly_name", "客厅主灯");
            bright.put("brightness", 204);
            bright.put("supported_color_modes", new JSONArray().put("hs").put("color_temp"));
            bright.put("color_mode", "hs");
            bright.put("hs_color", new JSONArray().put(35.0).put(62.0));
            bright.put("rgb_color", new JSONArray().put(255).put(176).put(80));
            bright.put("min_mireds", 153);
            bright.put("max_mireds", 500);
        } catch (Exception e) { }
        states.put("light.living_main", mkState("light.living_main", "on", bright));

        JSONObject strip = new JSONObject();
        try {
            strip.put("friendly_name", "客厅灯带");
            strip.put("brightness", 255);
            strip.put("supported_color_modes", new JSONArray().put("brightness"));
        } catch (Exception e) { }
        states.put("light.living_strip", mkState("light.living_strip", "off", strip));

        JSONObject plug = new JSONObject();
        try {
            plug.put("friendly_name", "电视插座");
            plug.put("current_power_w", 68);
            plug.put("power", 68);
        } catch (Exception e) { }
        states.put("switch.living_tv", mkState("switch.living_tv", "on", plug));

        JSONObject ac = new JSONObject();
        try {
            ac.put("friendly_name", "客厅空调");
            ac.put("hvac_modes", new JSONArray().put("off").put("cool").put("heat"));
            ac.put("hvac_action", "heating");
            ac.put("current_temperature", 21.7);
            ac.put("temperature", 24);
            ac.put("target_temp_step", 0.5);
            ac.put("fan_modes", new JSONArray().put("auto").put("low").put("mid").put("high"));
            ac.put("fan_mode", "auto");
            ac.put("min_temp", 16);
            ac.put("max_temp", 30);
        } catch (Exception e) { }
        JSONObject acS = mkState("climate.living_ac", "heat", ac);
        states.put("climate.living_ac", acS);

        JSONObject floor = new JSONObject();
        try {
            floor.put("friendly_name", "客厅地暖");
            floor.put("current_temperature", 20.5);
            floor.put("target_temp_low", 20);
            floor.put("target_temp_high", 26);
            floor.put("target_temp_step", 1);
            floor.put("hvac_modes", new JSONArray().put("off").put("heat_cool"));
            floor.put("min_temp", 16);
            floor.put("max_temp", 28);
        } catch (Exception e) { }
        states.put("climate.living_floor", mkState("climate.living_floor", "heat_cool", floor));

        JSONObject fresh = new JSONObject();
        try {
            fresh.put("friendly_name", "客厅新风");
            fresh.put("hvac_modes", new JSONArray().put("off").put("fan_only"));
            fresh.put("supported_features", 384); // TURN_ON|TURN_OFF，没有目标温度
            fresh.put("current_temperature", 22.4);
        } catch (Exception e) { }
        states.put("climate.living_fresh", mkState("climate.living_fresh", "off", fresh));

        JSONObject offline = new JSONObject();
        try {
            offline.put("friendly_name", "客厅落地灯");
            offline.put("supported_color_modes", new JSONArray().put("onoff"));
        } catch (Exception e) { }
        states.put("light.living_offline", mkState("light.living_offline", "unavailable", offline));

        JSONObject auto = new JSONObject();
        try {
            auto.put("friendly_name", "早晨自动开灯");
            auto.put("last_triggered", "2026-11-06T04:00:00");
        } catch (Exception e) { }
        states.put("automation.morning", mkState("automation.morning", "on", auto));
        JSONObject cover = new JSONObject();
        try {
            cover.put("friendly_name", "客厅窗帘");
            cover.put("current_position", 60);
            cover.put("supported_features", 15);
            cover.put("device_class", "curtain");
        } catch (Exception e) { }
        JSONObject cam = new JSONObject();
        try {
            cam.put("friendly_name", "客厅摄像头");
            cam.put("entity_picture", "/api/camera_proxy/camera.living_cam?token=" + TOKEN);
        } catch (Exception e) { }
        states.put("camera.living_cam", mkState("camera.living_cam", "idle", cam));

        JSONObject temp = new JSONObject();
        try {
            temp.put("friendly_name", "客厅温度");
            temp.put("unit_of_measurement", "°C");
            temp.put("device_class", "temperature");
            temp.put("state_class", "measurement");
        } catch (Exception e) { }
        states.put("sensor.living_temp", mkState("sensor.living_temp", "23.4", temp));

        JSONObject hum = new JSONObject();
        try {
            hum.put("friendly_name", "客厅湿度");
            hum.put("unit_of_measurement", "%");
            hum.put("device_class", "humidity");
        } catch (Exception e) { }
        states.put("sensor.living_humidity", mkState("sensor.living_humidity", "52", hum));

        JSONObject motion = new JSONObject();
        try { motion.put("friendly_name", "客厅人体感应"); motion.put("device_class", "motion"); } catch (Exception e) { }
        states.put("binary_sensor.living_motion", mkState("binary_sensor.living_motion", "off", motion));

        JSONObject master = new JSONObject();
        try {
            master.put("friendly_name", "主卧主灯");
            master.put("brightness", 180);
            master.put("supported_color_modes", new JSONArray().put("brightness"));
        } catch (Exception e) { }
        states.put("light.master_main", mkState("light.master_main", "on", master));

        JSONObject mtemp = new JSONObject();
        try {
            mtemp.put("friendly_name", "主卧温度");
            mtemp.put("unit_of_measurement", "°C");
            mtemp.put("device_class", "temperature");
        } catch (Exception e) { }
        states.put("sensor.master_temp", mkState("sensor.master_temp", "22.8", mtemp));

        JSONObject scene = new JSONObject();
        try { scene.put("friendly_name", "观影模式"); } catch (Exception e) { }
        states.put("scene.movie", mkState("scene.movie", "unknown", scene));

        JSONObject script = new JSONObject();
        try { script.put("friendly_name", "全部关闭"); } catch (Exception e) { }
        states.put("script.all_off", mkState("script.all_off", "off", script));
    }

    /* 合成 12 小时曲线：状态值上下波动，供面板画 sparkline */
    private String historyJson(String path) {
        String eid = "sensor.living_temp";
        int i = path.indexOf("filter_entity_id=");
        if (i >= 0) {
            String rest = path.substring(i + "filter_entity_id=".length());
            int amp = rest.indexOf('&');
            if (amp > 0) rest = rest.substring(0, amp);
            try { eid = java.net.URLDecoder.decode(rest, "UTF-8"); } catch (Exception e) { }
        }
        JSONObject st = states.get(eid);
        double base = 24;
        try { if (st != null) base = Double.parseDouble(st.optString("state", "24")); } catch (Exception e) { }
        JSONArray series = new JSONArray();
        long nowMs = System.currentTimeMillis();
        int n = 24;
        for (int k = 0; k <= n; k++) {
            long t = nowMs - 12L * 3600 * 1000 + (12L * 3600 * 1000) * k / n;
            double wave = Math.sin((k * 1.0 / n) * Math.PI * 2 - 1.2) * 1.6;
            JSONObject pt = new JSONObject();
            try {
                pt.put("entity_id", eid);
                pt.put("state", String.format(Locale.US, "%.1f", base + wave));
                pt.put("last_changed", isoFromMillis(t));
            } catch (Exception e) { }
            series.put(pt);
        }
        JSONArray outer = new JSONArray();
        outer.put(series);
        return outer.toString();
    }

    private static JSONArray rgbToHs(int r, int g, int b) {
        double rf = r / 255.0, gf = g / 255.0, bf = b / 255.0;
        double max = Math.max(rf, Math.max(gf, bf)), min = Math.min(rf, Math.min(gf, bf));
        double d = max - min, h = 0;
        if (d > 0) {
            if (max == rf) h = 60 * (((gf - bf) / d) % 6);
            else if (max == gf) h = 60 * ((bf - rf) / d + 2);
            else h = 60 * ((rf - gf) / d + 4);
        }
        if (h < 0) h += 360;
        double sat = max == 0 ? 0 : d / max * 100;
        JSONArray out = new JSONArray();
        try {
            out.put(Math.round(h * 10) / 10.0);
            out.put(Math.round(sat * 10) / 10.0);
        } catch (Exception e) { }
        return out;
    }

    private static String isoFromMillis(long ms) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f.format(new java.util.Date(ms)) + "Z";
    }

    private String now() {
        // 简单点：不用 X（Android 5.1 的 SimpleDateFormat 不认这个 pattern 字符）
        return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(new Date());
    }

    /* ---------------- 启动 / 停止 ---------------- */

    public void start() {
        running = true;
        Thread t = new Thread(new Runnable() {
            public void run() {
                try {
                    server = new ServerSocket(port, 8, java.net.InetAddress.getByName("127.0.0.1"));
                    Log.i(TAG, "mock HA listening 127.0.0.1:" + port);
                    while (running) {
                        Socket s = server.accept();
                        final Conn c = new Conn(s);
                        conns.add(c);
                        Thread ct = new Thread(c);
                        ct.setDaemon(true);
                        ct.start();
                    }
                } catch (Throwable e) {
                    if (running) Log.w(TAG, "mock HA stopped: " + e);
                }
            }
        });
        t.setDaemon(true);
        t.start();

        // 传感器漂移：每 6 秒改一点温度/湿度并广播，用来验证 state_changed 真的送到了面板
        Thread tick = new Thread(new Runnable() {
            public void run() {
                int n = 0;
                while (running) {
                    try { Thread.sleep(6000); } catch (InterruptedException e) { break; }
                    n++;
                    bumpSensor("sensor.living_temp", 23.4, n);
                    bumpSensor("sensor.living_humidity", 52, n);
                    bumpSensor("sensor.master_temp", 22.8, n);
                }
            }
        });
        tick.setDaemon(true);
        tick.start();
    }

    private void bumpSensor(String eid, double base, int n) {
        JSONObject st = states.get(eid);
        if (st == null) return;
        try {
            double v = base + ((n % 5) - 2) * 0.1;
            st.put("state", String.format(Locale.US, "%.1f", v));
            st.put("last_changed", now());
            Log.i(TAG, "tick " + eid + " = " + st.optString("state"));
            broadcast(eid, st);
        } catch (Exception e) { }
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Throwable t) { }
        synchronized (conns) {
            for (Conn c : conns) c.close();
            conns.clear();
        }
    }

    /* ---------------- 单个连接 ---------------- */

    private class Conn implements Runnable {
        final Socket sock;
        InputStream in;
        OutputStream out;
        boolean authed;
        final List<Integer> subs = new ArrayList<Integer>();

        Conn(Socket s) { this.sock = s; }

        public void run() {
            try {
                sock.setSoTimeout(0);
                in = sock.getInputStream();
                out = sock.getOutputStream();
                if (!handshake()) { close(); return; }
                sendText(authRequired());
                while (running && !sock.isClosed()) {
                    Frame f = readFrame();
                    if (f == null) break;
                    if (f.opcode == 8) break;                 // close
                    if (f.opcode == 9) { sendFrame(10, f.payload); continue; }  // ping -> pong
                    if (f.opcode == 10) continue;             // pong
                    if (f.opcode == 1) handle(f.payload);
                }
            } catch (Throwable e) {
                Log.w(TAG, "conn error: " + e);
            } finally {
                close();
            }
        }

        void close() {
            try { sock.close(); } catch (Throwable t) { }
            conns.remove(this);
        }

        /* HTTP 升级握手 */
        boolean handshake() throws Exception {

            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int b, q1 = -1, q2 = -1, q3 = -1;   // 最近 4 个字节
            while ((b = in.read()) != -1) {
                head.write(b);
                if (b == '\n' && q1 == '\r' && q2 == '\n' && q3 == '\r') break;
                q3 = q2; q2 = q1; q1 = b;
            }
            String req = new String(head.toByteArray(), "UTF-8");
            String first = req.split("\r\n")[0];
            Log.i(TAG, "req: " + first);
            if (req.length() < 400) Log.i(TAG, "head: " + req.replace("\r\n", " | "));
            String key = null;
            for (String line : req.split("\r\n")) {
                int c = line.indexOf(':');
                if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase("Sec-WebSocket-Key")) {
                    key = line.substring(c + 1).trim();
                }
            }
            if (wsDisabled() && first.contains("/api/websocket")) {
                /* 联调开关：只给 REST，不给 WebSocket（普通 HTTP 探活/REST 不受影响） */
                String bad = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                out.write(bad.getBytes("UTF-8"));
                out.flush();
                Log.i(TAG, "wsDisabled: refused websocket upgrade on purpose");
                return false;
            }
            if (first.contains("/api/websocket") && key != null) {
                String accept = b64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
                String resp = "HTTP/1.1 101 Switching Protocols\r\n"
                        + "Upgrade: websocket\r\n"
                        + "Connection: Upgrade\r\n"
                        + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
                out.write(resp.getBytes("UTF-8"));
                out.flush();
                return true;
            }
            // 普通 HTTP 探活：GET /api/
            String token = null;
            for (String line : req.split("\r\n")) {
                int c = line.indexOf(':');
                if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase("Authorization")) {
                    token = line.substring(c + 1).trim();
                }
            }
            String path = first.split(" ").length > 1 ? first.split(" ")[1] : "/";
            String qtok = null;
            int qi = path.indexOf("token=");
            if (qi >= 0) {
                qtok = path.substring(qi + 6);
                int amp = qtok.indexOf('&');
                if (amp > 0) qtok = qtok.substring(0, amp);
            }
            boolean ok = (token != null && token.endsWith(TOKEN)) || TOKEN.equals(qtok);
            String body;
            if (!ok) {
                body = "{\"message\":\"401: Unauthorized\"}";
            } else if (path.startsWith("/api/camera_proxy/")) {
                byte[] img = android.util.Base64.decode(CAM_JPEG_B64, android.util.Base64.DEFAULT);
                String camHdr = "HTTP/1.1 200 OK\r\n"
                        + "Content-Type: image/jpeg\r\n"
                        + "Content-Length: " + img.length + "\r\n"
                        + "Cache-Control: no-store\r\n"
                        + "Connection: close\r\n\r\n";
                out.write(camHdr.getBytes("UTF-8"));
                out.write(img);
                out.flush();
                Log.i(TAG, "camera_proxy 200 " + img.length + "B");
                return false;
            } else if (path.startsWith("/api/history/period")) {
                body = historyJson(path);
                Log.i(TAG, "rest GET history (" + body.length() + " chars)");
            } else if (path.startsWith("/api/states")) {
                JSONArray arr = new JSONArray();
                for (JSONObject s : states.values()) arr.put(s);
                body = arr.toString();
            } else if (path.startsWith("/api/services/")) {
                /* REST 兜底时面板会用 POST /api/services/<domain>/<service> 发服务 */
                String[] seg = path.split("/");
                if (seg.length >= 5) applyRestService(seg[3], seg[4]);
                body = "[]";
            } else {
                body = "{\"message\":\"API running.\"}";
            }
            String resp = "HTTP/1.1 " + (ok ? "200 OK" : "401 Unauthorized") + "\r\n"
                    + "Content-Type: application/json\r\n"
                    + "Content-Length: " + body.getBytes("UTF-8").length + "\r\n"
                    + "Connection: close\r\n\r\n" + body;
            out.write(resp.getBytes("UTF-8"));
            out.flush();
            return false;
        }

        /* 帧编解码 */
        Frame readFrame() throws Exception {
            int b0 = in.read();
            if (b0 < 0) return null;
            int b1 = in.read();
            if (b1 < 0) return null;
            int opcode = b0 & 0x0F;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7F;
            if (len == 126) len = ((in.read() & 0xFF) << 8) | (in.read() & 0xFF);
            else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | (in.read() & 0xFF);
            }
            byte[] mask = new byte[4];
            if (masked) {
                for (int i = 0; i < 4; i++) mask[i] = (byte) in.read();
            }
            byte[] data = new byte[(int) len];
            int off = 0;
            while (off < len) {
                int n = in.read(data, off, (int) len - off);
                if (n < 0) return null;
                off += n;
            }
            if (masked) for (int i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
            Frame f = new Frame();
            f.opcode = opcode;
            f.payload = data;
            return f;
        }

        synchronized void sendFrame(int opcode, byte[] payload) throws Exception {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            o.write(0x80 | opcode);
            int len = payload.length;
            if (len < 126) o.write(len);
            else if (len < 65536) { o.write(126); o.write((len >> 8) & 0xFF); o.write(len & 0xFF); }
            else {
                o.write(127);
                for (int i = 7; i >= 0; i--) o.write((int) (((long) len >> (8 * i)) & 0xFF));
            }
            o.write(payload);
            out.write(o.toByteArray());
            out.flush();
        }

        void sendText(String s) throws Exception {
            sendFrame(1, s.getBytes("UTF-8"));
        }

        /* HA 协议子集 */
        void handle(byte[] payload) throws Exception {
            String raw = new String(payload, "UTF-8");
            JSONObject msg = new JSONObject(raw);
            String type = msg.optString("type", "");
            int id = msg.optInt("id", 0);

            if ("auth".equals(type)) {
                if (TOKEN.equals(msg.optString("access_token", ""))) {
                    authed = true;
                    JSONObject r = new JSONObject();
                    r.put("type", "auth_ok");
                    r.put("ha_version", "2024.1.0");
                    sendText(r.toString());
                } else {
                    JSONObject r = new JSONObject();
                    r.put("type", "auth_invalid");
                    r.put("message", "Invalid access token or password");
                    sendText(r.toString());
                }
                return;
            }
            if (!authed) return;

            if ("get_states".equals(type)) {
                JSONArray arr = new JSONArray();
                for (JSONObject s : states.values()) arr.put(s);
                sendText(result(id, arr));
            } else if ("config/area_registry/list".equals(type)) {
                sendText(result(id, areas()));
            } else if ("config/device_registry/list".equals(type)) {
                sendText(result(id, devices()));
            } else if ("config/entity_registry/list".equals(type)) {
                sendText(result(id, entities()));
            } else if ("subscribe_events".equals(type)) {
                subs.add(id);
                sendText(result(id, null));
            } else if ("unsubscribe_events".equals(type)) {
                sendText(result(id, null));
            } else if ("ping".equals(type)) {
                JSONObject r = new JSONObject();
                r.put("type", "pong");
                r.put("id", id);
                sendText(r.toString());
            } else if ("call_service".equals(type)) {
                applyService(msg.optString("domain", ""), msg.optString("service", ""),
                        msg.optJSONObject("service_data"));
                sendText(result(id, null));
            } else {
                JSONObject r = new JSONObject();
                r.put("id", id);
                r.put("type", "result");
                r.put("success", false);
                JSONObject err = new JSONObject();
                err.put("code", "unknown_command");
                err.put("message", "unsupported: " + type);
                r.put("error", err);
                sendText(r.toString());
            }
        }

        String result(int id, Object payload) {
            JSONObject r = new JSONObject();
            try {
                r.put("id", id);
                r.put("type", "result");
                r.put("success", true);
                if (payload != null) r.put("result", payload);
                else r.put("result", JSONObject.NULL);
            } catch (Exception e) { }
            return r.toString();
        }

        void applyService(String domain, String service, JSONObject data) {
            try {
                String eid = data == null ? null : data.optString("entity_id", null);
                if (eid == null || !states.containsKey(eid)) return;
                JSONObject st = states.get(eid);
                JSONObject attrs = st.optJSONObject("attributes");
                String cur = st.optString("state");
                String next = cur;
                if ("toggle".equals(service)) {
                    if ("on".equals(cur)) next = "off";
                    else if ("off".equals(cur)) next = "on";
                } else if ("turn_on".equals(service)) next = "on";
                else if ("turn_off".equals(service)) next = "off";
                else if ("open_cover".equals(service)) { next = "open"; attrs.put("current_position", 100); }
                else if ("close_cover".equals(service)) { next = "closed"; attrs.put("current_position", 0); }
                else if ("set_cover_position".equals(service)) {
                    int pos = data.optInt("position", 0);
                    attrs.put("current_position", pos);
                    next = pos == 0 ? "closed" : "open";
                } else if ("set_temperature".equals(service)) {
                    if (data != null && data.has("target_temp_low")) attrs.put("target_temp_low", data.optDouble("target_temp_low", 20));
                    if (data != null && data.has("target_temp_high")) attrs.put("target_temp_high", data.optDouble("target_temp_high", 26));
                    if (data == null || !data.has("target_temp_low")) attrs.put("temperature", data.optDouble("temperature", attrs.optDouble("temperature", 24)));
                } else if ("set_hvac_mode".equals(service)) {
                    String m = data.optString("hvac_mode", "off");
                    next = m;
                    attrs.put("hvac_action", "off".equals(m) ? "idle" : m);
                } else if ("trigger".equals(service) && "automation".equals(domain)) {
                    attrs.put("last_triggered", now());
                } else if ("set_fan_mode".equals(service)) {
                    attrs.put("fan_mode", data.optString("fan_mode", "auto"));
                } else if ("brightness".equals("")) {
                    next = cur;
                }
                if (data != null && data.has("brightness_pct")) {
                    attrs.put("brightness", (int) Math.round(data.optDouble("brightness_pct", 100) * 2.55));
                }
                if (data != null && data.has("brightness")) {
                    attrs.put("brightness", data.optInt("brightness", 255));
                }
                if (data != null && data.has("rgb_color")) {
                    JSONArray rgb = data.optJSONArray("rgb_color");
                    if (rgb != null && rgb.length() >= 3) {
                        attrs.put("rgb_color", rgb);
                        attrs.put("hs_color", rgbToHs(rgb.getInt(0), rgb.getInt(1), rgb.getInt(2)));
                        attrs.put("color_mode", "hs");
                    }
                }
                st.put("state", next);
                st.put("last_changed", now());
                broadcast(eid, st);
            } catch (Exception e) {
                Log.w(TAG, "applyService: " + e);
            }
        }
    }

    private JSONArray areas() {
        JSONArray a = new JSONArray();
        try {
            a.put(new JSONObject().put("area_id", "living").put("name", "客厅"));
            a.put(new JSONObject().put("area_id", "master").put("name", "主卧"));
        } catch (Exception e) { }
        return a;
    }

    private JSONArray devices() {
        JSONArray a = new JSONArray();
        try {
            JSONObject d1 = new JSONObject().put("id", "dev_living").put("area_id", "living").put("name", "客厅设备");
            JSONObject d2 = new JSONObject().put("id", "dev_master").put("area_id", "master").put("name", "主卧设备");
            a.put(d1);
            a.put(d2);
        } catch (Exception e) { }
        return a;
    }

    private JSONArray entities() {
        JSONArray a = new JSONArray();
        try {
            a.put(ent("light.living_main", "dev_living", "客厅主灯"));
            a.put(ent("light.living_strip", "dev_living", "客厅灯带"));
            a.put(ent("switch.living_tv", "dev_living", "电视插座"));
            a.put(ent("climate.living_ac", "dev_living", "客厅空调"));
            a.put(ent("climate.living_floor", "dev_living", "客厅地暖"));
            a.put(ent("climate.living_fresh", "dev_living", "客厅新风"));
            a.put(ent("light.living_offline", "dev_living", "客厅落地灯"));
            a.put(ent("automation.morning", "dev_living", "早晨自动开灯"));
            a.put(ent("cover.living_curtain", "dev_living", "客厅窗帘"));
            a.put(ent("camera.living_cam", "dev_living", "客厅摄像头"));
            a.put(ent("sensor.living_temp", "dev_living", "客厅温度"));
            a.put(ent("sensor.living_humidity", "dev_living", "客厅湿度"));
            a.put(ent("binary_sensor.living_motion", "dev_living", "客厅人体感应"));
            a.put(ent("light.master_main", "dev_master", "主卧主灯"));
            a.put(ent("sensor.master_temp", "dev_master", "主卧温度"));
            a.put(ent("scene.movie", null, "观影模式"));
            a.put(ent("script.all_off", null, "全部关闭"));
        } catch (Exception e) { }
        return a;
    }

    private JSONObject ent(String id, String device, String name) {
        JSONObject o = new JSONObject();
        try {
            o.put("entity_id", id);
            if (device != null) o.put("device_id", device);
            o.put("name", name);
            o.put("original_name", name);
        } catch (Exception e) { }
        return o;
    }

    private String authRequired() {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "auth_required");
            o.put("ha_version", "2024.1.0");
        } catch (Exception e) { }
        return o.toString();
    }

    /** 状态变化广播给所有订阅了 state_changed 的连接 */
    private void broadcast(String eid, JSONObject newState) {
        JSONObject data = new JSONObject();
        try {
            data.put("entity_id", eid);
            data.put("old_state", JSONObject.NULL);
            data.put("new_state", newState);
        } catch (Exception e) { }
        JSONObject event = new JSONObject();
        try {
            event.put("event_type", "state_changed");
            event.put("data", data);
            event.put("origin", "LOCAL");
            event.put("time_fired", now());
        } catch (Exception e) { }
        JSONObject msg = new JSONObject();
        synchronized (conns) {
            for (Conn c : conns) {
                if (!c.authed) continue;
                for (Integer sid : c.subs) {
                    try {
                        msg.put("id", sid);
                        msg.put("type", "event");
                        msg.put("event", event);
                        c.sendText(msg.toString());
                    } catch (Throwable t) { }
                }
            }
        }
    }

    /* ---------------- 小工具 ---------------- */

    private static class Frame {
        int opcode;
        byte[] payload;
    }

    private static byte[] sha1(String s) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-1");
        return md.digest(s.getBytes("UTF-8"));
    }

    private static String b64(byte[] b) {
        try {
            return android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP);
        } catch (Throwable t) {
            return "";
        }
    }
}
