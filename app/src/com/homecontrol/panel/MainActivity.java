package com.homecontrol.panel;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.io.FileReader;

/**
 * Kiosk shell: a single fullscreen WebView that keeps the screen awake,
 * reloads itself when the page fails, and loads the panel either from the
 * bundled assets or from a dev server URL written to /sdcard/HomeControl/url.txt.
 */
public class MainActivity extends Activity {

    private static final String TAG = "HomePanel";
    private static final String PREFS = "panel";
    private static final String KEY_URL = "url";
    private static final String DEV_URL_FILE = "/sdcard/HomeControl/url.txt";
    private static final String ASSET_PAGE = "file:///android_asset/panel/index.html";

    private WebView web;
    private FrameLayout root;
    private TextView banner;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile long lastBeat = 0L;
    private int retryCount = 0;
    private MockHaServer mockHa;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // wall panel: come up over the keyguard and wake the screen ourselves
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(9, 12, 18));

        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        banner = new TextView(this);
        banner.setTextColor(Color.WHITE);
        banner.setTextSize(18f);
        banner.setGravity(Gravity.CENTER);
        banner.setBackgroundColor(Color.parseColor("#D9000000"));
        banner.setPadding(24, 18, 24, 18);
        banner.setVisibility(View.GONE);
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        blp.gravity = Gravity.BOTTOM;
        root.addView(banner, blp);

        setContentView(root);
        initWebView();
        maybeStartMockHa();
        loadPanel();
        startWatchdog();
    }

    /**
     * 联调用：只有 /sdcard/HomeControl/mockha.enabled 存在时，才在 127.0.0.1:8123
     * 起一个假的 HA，让面板跑一遍真实 WebSocket 路径（局域网不通，只能这样验）。
     */
    private void maybeStartMockHa() {
        try {
            if (MockHaServer.enabled()) {
                mockHa = new MockHaServer(8123);
                mockHa.start();
                Log.i(TAG, "mock HA started for local testing");
            }
        } catch (Throwable t) {
            Log.w(TAG, "mock HA failed: " + t);
        }
    }

    private void initWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= 19) {
            try { WebView.setWebContentsDebuggingEnabled(true); } catch (Throwable t) { }
        }

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, "JS " + cm.message() + " @" + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url == null) return false;
                if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    Log.w(TAG, "cannot open url " + url);
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "page finished: " + url);
                hideBanner();
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.w(TAG, "page error " + errorCode + " " + description + " " + failingUrl);
                scheduleRetry(description);
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
    }

    /** bundled panel by default; an http URL in /sdcard/HomeControl/url.txt overrides it (dev mode) */
    private String resolveUrl() {
        try {
            File f = new File(DEV_URL_FILE);
            if (f.exists()) {
                BufferedReader r = new BufferedReader(new FileReader(f));
                String line = r.readLine();
                r.close();
                if (line != null) {
                    line = line.trim();
                    if (line.startsWith("http://") || line.startsWith("https://") || line.startsWith("file://")) {
                        Log.i(TAG, "url from " + DEV_URL_FILE + ": " + line);
                        return line;
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "cannot read dev url file: " + t.getMessage());
        }
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String u = sp.getString(KEY_URL, "");
        if (u != null && u.length() > 0) {
            Log.i(TAG, "url from prefs: " + u);
            return u;
        }
        return ASSET_PAGE;
    }

    private void loadPanel() {
        String url = resolveUrl();
        Log.i(TAG, "loadPanel " + url);
        lastBeat = System.currentTimeMillis();
        web.loadUrl(url);
    }

    private void scheduleRetry(String description) {
        retryCount++;
        final int n = retryCount;
        String msg = "面板加载失败" + (description == null ? "" : "（" + description + "）") + " · 第 " + n + " 次重试";
        showBanner(msg);
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                loadPanel();
            }
        }, n <= 3 ? 3000L : 10000L);
    }

    private void showBanner(final String text) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                banner.setText(text);
                banner.setVisibility(View.VISIBLE);
            }
        });
    }

    private void hideBanner() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                banner.setVisibility(View.GONE);
            }
        });
    }

    /**
     * Kiosk watchdog: the page pings heartbeat() every few seconds. If the
     * WebView hangs, crashes its renderer, or the network middleware wedges,
     * nothing pings anymore and we reload the page.
     */
    private void startWatchdog() {
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    long beat = lastBeat;
                    if (beat > 0 && System.currentTimeMillis() - beat > 45000L) {
                        Log.w(TAG, "watchdog: no heartbeat for 45s, reloading");
                        retryCount = 0;
                        web.reload();
                        lastBeat = System.currentTimeMillis();
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "watchdog error " + t.getMessage());
                }
                ui.postDelayed(this, 15000L);
            }
        }, 15000L);
    }

    private void goImmersive() {
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        goImmersive();
        lastBeat = System.currentTimeMillis();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    private long lastBack = 0L;

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // wall panel: swallow back/volume-ish keys so nobody drops out of the kiosk.
        // escape hatch: press BACK twice within 1.5s to jump to system settings.
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            long now = System.currentTimeMillis();
            if (now - lastBack < 1500L) {
                lastBack = 0L;
                try {
                    startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS));
                } catch (Throwable t) {
                    Log.w(TAG, "cannot open settings: " + t.getMessage());
                }
            } else {
                lastBack = now;
                showBanner("再按一次返回键进入系统设置");
                ui.postDelayed(new Runnable() {
                    @Override
                    public void run() { hideBanner(); }
                }, 1800L);
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        try {
            if (mockHa != null) mockHa.stop();
        } catch (Throwable t) { }
        try {
            if (web != null) {
                web.removeJavascriptInterface("AndroidBridge");
                web.stopLoading();
                web.destroy();
            }
        } catch (Throwable t) { }
        super.onDestroy();
    }

    /** exposed to the panel as window.AndroidBridge */
    private class Bridge {
        @JavascriptInterface
        public void log(String msg) {
            Log.d(TAG, "JSB " + msg);
        }

        @JavascriptInterface
        public void heartbeat() {
            lastBeat = System.currentTimeMillis();
            if (retryCount > 0) retryCount = 0;
        }

        @JavascriptInterface
        public void reload() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    retryCount = 0;
                    loadPanel();
                }
            });
        }

        @JavascriptInterface
        /** 壳 App 版本号，诊断页直接念给客服听 */
        String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Throwable t) { return "?"; }
        }

        @JavascriptInterface
        public String info() {
            String ua = "";
            try {
                ua = WebSettings.getDefaultUserAgent(MainActivity.this);
            } catch (Throwable t) { }
            ua = ua.replace("\\", "/").replace("\"", "'");
            return "{\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"model\":\"" + Build.MODEL + "\""
                    + ",\"device\":\"" + Build.DEVICE + "\""
                    + ",\"ver\":\"" + appVersion() + "\""
                    + ",\"ua\":\"" + ua + "\"}";
        }

        /** 设备自身的网络身份：上墙后排查「它到底连在哪个网」用得上 */
        @JavascriptInterface
        public String netInfo() {
            String ip = "";
            String ssid = "";
            try {
                java.util.Enumeration<java.net.NetworkInterface> ifs =
                        java.net.NetworkInterface.getNetworkInterfaces();
                while (ifs != null && ifs.hasMoreElements()) {
                    java.net.NetworkInterface ni = ifs.nextElement();
                    if (ni == null || ni.isLoopback() || !ni.isUp()) continue;
                    if (!"wlan0".equals(ni.getName()) && !"eth0".equals(ni.getName())) continue;
                    java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                    while (addrs != null && addrs.hasMoreElements()) {
                        java.net.InetAddress a = addrs.nextElement();
                        if (a instanceof java.net.Inet4Address) ip = a.getHostAddress();
                    }
                }
            } catch (Throwable t) { }
            try {
                android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager)
                        getApplicationContext().getSystemService(WIFI_SERVICE);
                if (wm != null && wm.getConnectionInfo() != null) {
                    String s = wm.getConnectionInfo().getSSID();
                    if (s != null) ssid = s.replace("\"", "").replace("\\", "/");
                }
            } catch (Throwable t) { }
            return "{\"ip\":\"" + ip + "\",\"ssid\":\"" + ssid + "\"}";
        }

        @JavascriptInterface
        public String devUrl() {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            return sp.getString(KEY_URL, "");
        }

        /** last-modified stamp of a file, used by the panel for hot reload during development */
        @JavascriptInterface
        public long mtime(String path) {
            try {
                File f = new File(path);
                return f.exists() ? f.lastModified() : 0L;
            } catch (Throwable t) {
                return 0L;
            }
        }

        /** write a small text config file under /sdcard/HomeControl (panels configures itself without adb) */
        @JavascriptInterface
        public boolean writeText(String path, String content) {
            if (path == null || content == null) return false;
            if (!path.startsWith("/sdcard/HomeControl/")) {
                Log.w(TAG, "writeText denied: " + path);
                return false;
            }
            if (content.length() > 8192) {
                Log.w(TAG, "writeText too large: " + content.length());
                return false;
            }
            java.io.FileOutputStream out = null;
            try {
                File f = new File(path);
                File parent = f.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                out = new java.io.FileOutputStream(f, false);
                out.write(content.getBytes("UTF-8"));
                out.flush();
                Log.i(TAG, "writeText ok: " + path + " (" + content.length() + " chars)");
                return true;
            } catch (Throwable t) {
                Log.w(TAG, "writeText failed: " + t.getMessage());
                return false;
            } finally {
                if (out != null) try { out.close(); } catch (Throwable t) { }
            }
        }

        /** delete a config file under /sdcard/HomeControl (switch the panel back to mock data) */
        @JavascriptInterface
        public boolean removeFile(String path) {
            if (path == null || !path.startsWith("/sdcard/HomeControl/")) {
                Log.w(TAG, "removeFile denied: " + path);
                return false;
            }
            try {
                File f = new File(path);
                if (!f.exists()) return true;
                boolean ok = f.delete();
                Log.i(TAG, "removeFile " + path + " -> " + ok);
                return ok;
            } catch (Throwable t) {
                Log.w(TAG, "removeFile failed: " + t.getMessage());
                return false;
            }
        }

        /** read a small text config file from /sdcard (ha.json etc.) */
        @JavascriptInterface
        public String readText(String path) {
            File f = new File(path);
            if (!f.exists() || f.length() > 65536L) return "";
            BufferedReader r = null;
            try {
                StringBuilder sb = new StringBuilder();
                r = new BufferedReader(new FileReader(f));
                char[] buf = new char[4096];
                int n;
                while ((n = r.read(buf)) > 0) sb.append(buf, 0, n);
                return sb.toString();
            } catch (Throwable t) {
                Log.w(TAG, "readText failed: " + t.getMessage());
                return "";
            } finally {
                if (r != null) try { r.close(); } catch (Throwable t) { }
            }
        }

        /** 调屏幕背光（只作用于本窗口，不需要 WRITE_SETTINGS 权限）。
            负数 = 恢复系统亮度。上墙后夜里整屏压暗但背光还 100% 时太刺眼，也省电。 */
        @JavascriptInterface
        public void setBrightness(float v) {
            final float val = v;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        WindowManager.LayoutParams lp = getWindow().getAttributes();
                        lp.screenBrightness = val < 0 ? -1f : (val < 0.02f ? 0.02f : (val > 1f ? 1f : val));
                        getWindow().setAttributes(lp);
                        Log.i(TAG, "setBrightness " + lp.screenBrightness);
                    } catch (Throwable t) {
                        Log.w(TAG, "setBrightness failed: " + t);
                    }
                }
            });
        }
        private SSLContext trustAllCtx = null;

        /** 局域网自建 HA 常用自签证书：探活/REST 兜底时一律放行 */
        private SSLContext trustAll() throws Exception {
            if (trustAllCtx != null) return trustAllCtx;
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[]{ new X509TrustManager() {
                public void checkClientTrusted(X509Certificate[] chain, String authType) { }
                public void checkServerTrusted(X509Certificate[] chain, String authType) { }
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            } }, new SecureRandom());
            trustAllCtx = ctx;
            return ctx;
        }

        /** 归一化成 http(s) 基地址，并打开连接（支持 https 自签名） */
        private HttpURLConnection openHa(String baseUrl, String token, String method, String path, boolean body)
                throws Exception {
            String u = baseUrl;
            if (!u.startsWith("http://") && !u.startsWith("https://")) {
                u = u.replace("ws://", "http://").replace("wss://", "https://");
            }
            u = u.replace("/api/websocket/", "").replace("/api/websocket", "");
            if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
            if (!path.startsWith("/")) path = "/" + path;
            URL url = new URL(u + path);
            HttpURLConnection c;
            if ("https".equals(url.getProtocol())) {
                HttpsURLConnection h = (HttpsURLConnection) url.openConnection();
                h.setSSLSocketFactory(trustAll().getSocketFactory());
                h.setHostnameVerifier(new HostnameVerifier() {
                    public boolean verify(String host, SSLSession s) { return true; }
                });
                c = h;
            } else {
                c = (HttpURLConnection) url.openConnection();
            }
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            c.setRequestMethod(method);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Content-Type", "application/json");
            if (body) c.setDoOutput(true);
            return c;
        }

        private String restCall(String baseUrl, String token, String method, String path, String payload) {
            HttpURLConnection c = null;
            try {
                c = openHa(baseUrl, token, method, path, payload != null && payload.length() > 0);
                if (payload != null && payload.length() > 0) {
                    OutputStream os = c.getOutputStream();
                    os.write(payload.getBytes("UTF-8"));
                    os.close();
                }
                int code = c.getResponseCode();
                InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = "";
                if (is != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
                    is.close();
                    text = new String(bo.toByteArray(), "UTF-8");
                }
                Log.i(TAG, "rest " + method + " " + path + " -> " + code + " (" + text.length() + " chars)");
                org.json.JSONObject out = new org.json.JSONObject();
                out.put("status", code);
                out.put("body", text);
                return out.toString();
            } catch (Throwable t) {
                Log.w(TAG, "rest failed: " + t);
                try {
                    org.json.JSONObject out = new org.json.JSONObject();
                    out.put("error", t.getClass().getSimpleName());
                    return out.toString();
                } catch (Throwable t2) { return "{\"error\":\"unknown\"}"; }
            } finally {
                if (c != null) try { c.disconnect(); } catch (Throwable t) { }
            }
        }

        /** 异步 REST：WebSocket 不通时兜底，绕开 file:// 的 CORS 限制 */
        @JavascriptInterface
        public void rest(final String cbId, final String baseUrl, final String token,
                         final String method, final String path, final String payload) {
            new Thread(new Runnable() {
                public void run() {
                    final String out = restCall(baseUrl, token, method, path, payload);
                    ui.post(new Runnable() {
                        public void run() {
                            try {
                                if (web != null) {
                                    web.evaluateJavascript("window.__restCb && window.__restCb("
                                            + org.json.JSONObject.quote(cbId) + ","
                                            + org.json.JSONObject.quote(out) + ")", null);
                                }
                            } catch (Throwable t) { Log.w(TAG, "rest cb failed: " + t); }
                        }
                    });
                }
            }).start();
        }
        /** 用原生 HTTP 探一下 HA 是否可达、令牌是否有效（WebView 里做 REST 会被 CORS 拦） */
        @JavascriptInterface
        public String httpProbe(String baseUrl, String token) {
            HttpURLConnection c = null;
            try {
                String u = baseUrl;
                if (!u.startsWith("http://") && !u.startsWith("https://")) {
                    u = u.replace("ws://", "http://").replace("wss://", "https://");
                }
                u = u.replace("/api/websocket", "").replace("/api/websocket/", "");
                if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
                /* 注意：u 只是基地址，/api/ 由 openHa 拼 path 补上；
                   之前这里又拼了一次 "/api/"，实际请求成了 /api//api/（404）。 */
                c = openHa(u, token, "GET", "/api/", false);
                int code = c.getResponseCode();
                Log.i(TAG, "httpProbe " + u + " -> " + code);
                return "{\"status\":" + code + "}";
            } catch (Throwable t) {
                Log.w(TAG, "httpProbe failed: " + t);
                return "{\"error\":\"" + t.getClass().getSimpleName() + "\"}";
            } finally {
                if (c != null) try { c.disconnect(); } catch (Throwable t) { }
            }
        }
        /** 通用 GET（音乐服务这类非 HA 接口）：file:// 里 XHR 会被 CORS 挡，走原生取文本。
            结果异步回 window.__musicHttpCb(cbId, {status|error, body})。 */
        @JavascriptInterface
        public void httpJson(final String cbId, final String url) {
            httpReq(cbId, "GET", url, "{}", "");
        }

        /** 通用请求：method/headers(JSON 对象字符串)/body 都可指定，给道理鱼那种要 POST 登录的接口用。 */
        @JavascriptInterface
        public void httpReq(final String cbId, final String method, final String url,
                            final String headersJson, final String body) {
            new Thread(new Runnable() {
                public void run() {
                    final String out = httpText(url, method, headersJson, body);
                    ui.post(new Runnable() {
                        public void run() {
                            try {
                                if (web != null) {
                                    web.evaluateJavascript("window.__musicHttpCb && window.__musicHttpCb("
                                            + org.json.JSONObject.quote(cbId) + ","
                                            + org.json.JSONObject.quote(out) + ")", null);
                                }
                            } catch (Throwable t) { Log.w(TAG, "httpReq cb failed: " + t); }
                        }
                    });
                }
            }).start();
        }

        private String httpGetText(String url) {
            return httpText(url, "GET", "{}", "");
        }

        private String httpText(String url, String method, String headersJson, String body) {
            HttpURLConnection c = null;
            try {
                URL u = new URL(url);
                if ("https".equals(u.getProtocol())) {
                    HttpsURLConnection h = (HttpsURLConnection) u.openConnection();
                    h.setSSLSocketFactory(trustAll().getSocketFactory());
                    h.setHostnameVerifier(new HostnameVerifier() {
                        public boolean verify(String host, SSLSession s) { return true; }
                    });
                    c = h;
                } else {
                    c = (HttpURLConnection) u.openConnection();
                }
                c.setConnectTimeout(6000);
                c.setReadTimeout(15000);
                c.setRequestMethod(method == null || method.length() == 0 ? "GET" : method);
                c.setRequestProperty("Accept", "application/json, */*");
                c.setRequestProperty("User-Agent", "HomeControl-Panel");
                if (headersJson != null && headersJson.length() > 2) {
                    try {
                        org.json.JSONObject h = new org.json.JSONObject(headersJson);
                        java.util.Iterator<?> it = h.keys();
                        while (it.hasNext()) {
                            String k = String.valueOf(it.next());
                            c.setRequestProperty(k, h.optString(k, ""));
                        }
                    } catch (Throwable t) { Log.w(TAG, "httpText bad headers: " + t); }
                }
                if (body != null && body.length() > 0) {
                    c.setDoOutput(true);
                    byte[] bytes = body.getBytes("UTF-8");
                    c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    c.setFixedLengthStreamingMode(bytes.length);
                    java.io.OutputStream os = c.getOutputStream();
                    os.write(bytes);
                    os.close();
                }
                int code = c.getResponseCode();
                InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = "";
                if (is != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
                    is.close();
                    text = new String(bo.toByteArray(), "UTF-8");
                }
                Log.i(TAG, "httpReq " + method + " -> " + code + " (" + text.length() + " chars) " + url);
                org.json.JSONObject out = new org.json.JSONObject();
                out.put("status", code);
                out.put("body", text);
                return out.toString();
            } catch (Throwable t) {
                Log.w(TAG, "httpReq failed " + url + " : " + t);
                try {
                    org.json.JSONObject out = new org.json.JSONObject();
                    out.put("error", t.getClass().getSimpleName());
                    return out.toString();
                } catch (Throwable t2) { return "{\"error\":\"unknown\"}"; }
            } finally {
                if (c != null) try { c.disconnect(); } catch (Throwable t) { }
            }
        }

        @JavascriptInterface
        public void exitApp() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }
    }
}
