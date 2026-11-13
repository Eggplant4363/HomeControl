package com.homecontrol.panel;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Rect;
import android.media.AudioManager;
import android.net.Uri;
import android.net.http.SslError;
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
import android.webkit.SslErrorHandler;
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
import java.util.Collections;
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
    /** 面板自己的配置目录：文件读写只允许落在这里（桥暴露给网页，不能当任意文件读写口） */
    private static final String CONFIG_DIR = "/sdcard/HomeControl/";
    /** 开发/联调开关：没有这个文件就是正式包——不开 CDP 调试口、不读 url.txt、不起假 HA */
    private static final String DEBUG_FLAG = "/sdcard/HomeControl/debug.flag";
    /** 看门狗：收到过心跳后 45s 无心跳算卡死；从未收到过心跳时用更宽的门槛（首帧实测可 35s） */
    private static final long BEAT_STALL_MS = 45000L;
    private static final long FIRST_BEAT_MS = 180000L;
    /** 加载失败自动重试的次数上限，超过就停在错误页等人处理，别整夜重试耗屏耗电 */
    private static final int MAX_RETRY = 10;
    /** 离家熄屏的兜底等待（面板没传值时用这个）：没人碰屏幕这么久就自己熄灭 */
    private static final int AWAY_OFF_MS = 4000;

    private WebView web;
    private FrameLayout root;
    private TextView banner;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile long lastBeat = 0L;
    private volatile long loadedAt = 0L;
    private volatile boolean everBeat = false;
    private int retryCount = 0;
    /** 假 HA 服务器只在 debug 源码目录里（app/src_debug/），正式包里这个类根本不存在，所以用反射 */
    private Object mockHa;
    private TlsPolicy tls;
    /** 离家熄屏/在家亮屏：当前策略（true=该亮着），以及熄屏前原来的屏幕超时 */
    private volatile boolean screenHome = true;
    private android.os.PowerManager.WakeLock wakeLock;
    private volatile boolean blackout = false;

    /**
     * 全黑兜底：有的 MIUI 不认我们写的屏幕超时（它有自己的省电策略），这时把页面压成纯黑
     * 并把背光压到最低 —— 视觉上等同于熄屏。回家时还原。
     */
    private void setBlackout(final boolean on) {
        blackout = on;
        try {
            if (web != null) {
                web.evaluateJavascript(
                        "void (window.__hcBlackout && window.__hcBlackout(" + on + "))", null);
            }
        } catch (Throwable t) {
            Log.w(TAG, "blackout js failed: " + t);
        }
        setScreenBrightness(on ? 0.02f : -1f);
        Log.i(TAG, "blackout: " + (on ? "on" : "off"));
    }

    /** 只作用本窗口的屏幕亮度（不影响系统）；-1 = 恢复自动 */
    private void setScreenBrightness(float v) {
        try {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.screenBrightness = v < 0 ? -1f : (v < 0.02f ? 0.02f : (v > 1f ? 1f : v));
            getWindow().setAttributes(lp);
        } catch (Throwable t) {
            Log.w(TAG, "setScreenBrightness failed: " + t);
        }
    }

    private int savedScreenOffMs = -1;
    /** 设备原来的「充电时保持唤醒」值（墙机常插着电，不清掉它永远不会熄屏） */
    private int savedStayOn = -1;
    private static final String KEY_STAY_ON = "stay_on_while_plugged_in";
    /** 原生请求共用的两条线程：以前每个请求都 new Thread（自注册 5 个 POST + 兜底轮询 + 封面，
     * 全是新线程 + 一次完整 TCP/TLS 握手，老机器上 0.3~1.5s）。长请求最多占一条，剩下的排队。 */
    private final java.util.concurrent.ExecutorService netPool =
            java.util.concurrent.Executors.newFixedThreadPool(2);

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
        applyGestureExclusion();
        maybeStartMockHa();
        loadPanel();
        startWatchdog();
    }

    /** 开发/联调开关：debug.flag 存在才放开调试能力（CDP、url.txt、假 HA） */
    private static long debugCheckedAt = 0L;
    private static boolean debugCached = false;

    /** debug.flag 的 stat 缓存：boot 路径上这个判断要跑三次，每次都是一次 /sdcard stat。
        60 秒 TTL —— push.ps1 改开关最迟 60 秒生效，重装/重启立刻生效。 */
    private static boolean debugEnabled() {
        long now = System.currentTimeMillis();
        if (now - debugCheckedAt > 60000L) {
            debugCached = new File(DEBUG_FLAG).exists();
            debugCheckedAt = now;
        }
        return debugCached;
    }

    /**
     * 联调用：debug 包（debug.flag + mockha.enabled 都在）才在 127.0.0.1:8123
     * 起一个假的 HA，让面板跑一遍真实 WebSocket 路径（局域网不通，只能这样验）。
     * MockHaServer 只存在于 app/src_debug/，正式包里反射拿不到这个类，假服务不进 dex。
     */
    private void maybeStartMockHa() {
        if (!debugEnabled()) return;
        try {
            Class<?> c = Class.forName("com.homecontrol.panel.MockHaServer");
            Boolean enabled = (Boolean) c.getMethod("enabled").invoke(null);
            if (enabled == null || !enabled.booleanValue()) return;
            Object srv = c.getConstructor(int.class).newInstance(8123);
            c.getMethod("start").invoke(srv);
            mockHa = srv;
            Log.i(TAG, "mock HA started for local testing");
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
        // Android 9+ 的 WebView 在系统夜间模式下会「强制变暗」（force dark），把我们的明亮皮肤
        // 直接画成深色（模拟器 Android 11 实测）。皮肤由面板自己管，所以关掉它。
        if (Build.VERSION.SDK_INT >= 28) {
            try { s.setForceDark(WebSettings.FORCE_DARK_OFF); } catch (Throwable t) { }
        }
        // CDP 调试口只给开发包：正式包开着它，同网段任何进程连 :9222 就能往页面里注入 JS，
        // 连带桥（文件读写、REST 代理）变成攻击面。tools/push.ps1 开发部署时会写 debug.flag。
        if (Build.VERSION.SDK_INT >= 19 && debugEnabled()) {
            try { WebView.setWebContentsDebuggingEnabled(true); } catch (Throwable t) { }
        }
        // TlsPolicy 不在这里建：系统信任库初始化 + 解析两个 PEM 锚要 100~300ms，开机那一页
        // 可能根本不需要 https。第一次真用到（applyTls）才建。
        tls = null;

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

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // 这台平板的 WebView（Chromium 57 / Android 5.1）信任库里没有 Let's Encrypt 的 ISRG 根证书，
                // 负一屏的音频流与 WebSocket 走 WebView 自己的网络栈（Java 桥管不到它），不在这里放行就播不了歌、
                // 也没有实时推送（REST 兜底还能活，但慢 11s 起首帧）。
                // 放行只限「面板自己配置的服务器 + 局域网」这个范围——错误码不看：同一张证书在 https 页面里报 2
                // （不受信任），在 WebSocket 握手里报 3，Chromium 57 的分类不可靠，护栏是主机白名单本身。
                // URL 指向没配过的第三方站点一律 cancel —— 那才是中间人/劫持的形状（实测 badssl 被 cancel）。
                String url = error.getUrl();
                if (sslHostAllowed(url)) {
                    Log.w(TAG, "ssl error proceed " + error.getPrimaryError() + " " + url);
                    handler.proceed();
                    return;
                }
                Log.w(TAG, "ssl error cancel " + error.getPrimaryError() + " " + url);
                handler.cancel();
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
    }

    /**
     * 负一屏（音乐页）是「从左边缘往右滑」拉出来的，但 Android 10+ 的手势导航把左边缘
     * 那一条留给了系统返回，平板 5（Android 13）上从边上滑就成了返回。这里把左侧一条
     * 56dp 宽的竖带排除在系统手势之外，滑动就会落到 WebView 里交给面板自己判断。
     * 返回手势在右边缘仍然可用；老系统（MI PAD 2 的 5.1）没有这个 API，跳过。
     */
    private void applyGestureExclusion() {
        if (Build.VERSION.SDK_INT < 29 || web == null) return;
        web.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            @Override
            public void onLayoutChange(View v, int left, int top, int right, int bottom,
                                       int oldLeft, int oldTop, int oldRight, int oldBottom) {
                int band = (int) (56 * getResources().getDisplayMetrics().density);
                // 系统对每个边缘允许排除的区域有上限（200dp），超出会被忽略。
                int cap = (int) (200 * getResources().getDisplayMetrics().density);
                if (band > cap) band = cap;
                if (band <= 0 || bottom <= 0) return;
                try {
                    web.setSystemGestureExclusionRects(
                            Collections.singletonList(new Rect(0, 0, band, bottom)));
                } catch (Throwable t) {
                    Log.w(TAG, "gesture exclusion failed: " + t.getMessage());
                }
            }
        });
    }

    /** bundled panel by default; an http URL in url.txt overrides it, but only in dev mode
        (debug.flag) — a world-readable file must not be able to aim the kiosk at any site. */
    private String resolveUrl() {
        try {
            File f = new File(DEV_URL_FILE);
            if (debugEnabled() && f.exists()) {
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

    /* 配置文件里的地址主机名：结果按「两个配置文件的长度之和」缓存 —— 配置没变就零 IO。
       onReceivedSslError 跑在 UI 线程上，平板 2 每个新连接（WS 握手 / 每条音频流 / 封面）都要走
       一遍这条路，以前每次都要读两个文件 + 现编正则（10~40ms）。取主机改成手工扫字符串，不写正则。 */
    private java.util.Set<String> hostCache = null;
    private long hostStamp = -1L;

    /** 面板自己配置的服务器主机（ha.json 的 url、music.json 的 baseUrl/base），WebView 放行 SSL 只用它 */
    private java.util.Set<String> configuredHosts() {
        long stamp = fileLen(CONFIG_DIR + "ha.json") + 7L * fileLen(CONFIG_DIR + "music.json");
        java.util.Set<String> cached = hostCache;
        if (cached != null && hostStamp == stamp) return cached;
        java.util.Set<String> set = new java.util.HashSet<String>();
        addHost(set, readConfig(CONFIG_DIR + "ha.json"), "url");
        String music = readConfig(CONFIG_DIR + "music.json");
        /* 音乐页存的字段叫 baseUrl；早先这里读的是 "base"，道理鱼的主机因此一直没进白名单，
           音频流在 WebView 里被 cancel 掉（平板 2 上表现为「播放失败（音频地址不可达）」）。
           老键 "base" 也一起读，兼容早先写错字段的平板。 */
        addHost(set, music, "baseUrl");
        addHost(set, music, "base");
        String pageHost = schemeHost(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, ""));
        if (pageHost != null && pageHost.length() > 0) set.add(pageHost.toLowerCase());
        hostCache = set;
        hostStamp = stamp;
        return set;
    }

    private static long fileLen(String p) {
        try { return new File(p).length(); } catch (Throwable t) { return 0L; }
    }

    /** 从一段 JSON 文本里取某个字段的地址主机名：手工找 "key": 后的引号值，交给 schemeHost */
    private static void addHost(java.util.Set<String> set, String text, String key) {
        if (text == null || text.length() == 0) return;
        String q = String.valueOf('"');
        String form = q + key + q + ":";
        int i = text.indexOf(form);
        if (i < 0) {
            form = q + key + q + " :";
            i = text.indexOf(form);
        }
        if (i < 0) return;
        int v = text.indexOf(q, i + form.length());
        if (v < 0) return;
        int from = v + 1;
        int to = from;
        while (to < text.length() && to - from < 80) {
            char c = text.charAt(to);
            if (c == '"' || c == '\n' || c == '\r') break;
            to++;
        }
        String host = schemeHost(text.substring(from, to));
        if (host != null && host.length() > 0) set.add(host.toLowerCase());
    }

    /**
     * 运行时放行过的域名主机：原生桥（httpReq/httpBinary/httpProbe）已经用 TlsPolicy
     * **真验过**证书 + 主机名的那些主机，WebView 的音频流/封面也必然是同一个主机。
     * 音乐服务器只在 localStorage 里配过（没落盘 music.json）时，配置白名单读不到它，
     * 靠这里补上——护栏仍然是「我们自己的证书校验通过过」，不是信任所有证书。
     */
    private final java.util.Set<String> verifiedHosts = new java.util.HashSet<String>();

    private void rememberVerifiedHost(String url) {
        if (url == null || !url.startsWith("https://")) return;   // 只有 https 需要这条通道
        String host = schemeHost(url);
        if (host == null || host.length() == 0) return;
        if (TlsPolicy.isPrivateHost(host)) return;      // 局域网本来就一直放行
        synchronized (verifiedHosts) {
            String lower = host.toLowerCase();
            if (verifiedHosts.size() >= 8 && !verifiedHosts.contains(lower)) return;
            if (verifiedHosts.contains(lower)) return;
            verifiedHosts.add(lower);
            Log.i(TAG, "ssl allow (verified by bridge): " + host);
        }
    }

    /** WebView 的 SSL 放行范围：局域网、面板自己配置的服务器主机，或原生桥真验过的主机 */
    private boolean sslHostAllowed(String url) {
        String host = schemeHost(url);
        if (host == null || host.length() == 0) return false;
        if (TlsPolicy.isPrivateHost(host)) return true;
        if (configuredHosts().contains(host.toLowerCase())) return true;
        synchronized (verifiedHosts) {
            return verifiedHosts.contains(host.toLowerCase());
        }
    }

    /**
     * 取 URL 的主机名。java.net.URL 不认 ws:/wss:（WebSocket 的地址它解析不了，直接抛异常），
     * 所以手工切：scheme 白名单 → 去掉 userinfo → 截到第一个 /?# → 去掉端口（IPv6 的括号保留外层形式再剥）。
     */
    private static String schemeHost(String url) {
        if (url == null) return null;
        int i = url.indexOf("://");
        if (i <= 0) return null;
        String scheme = url.substring(0, i).toLowerCase();
        if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("ws") && !scheme.equals("wss")) return null;
        String rest = url.substring(i + 3);
        int end = rest.length();
        for (int j = 0; j < rest.length(); j++) {
            char c = rest.charAt(j);
            if (c == '/' || c == '?' || c == '#') { end = j; break; }
        }
        String hostPort = rest.substring(0, end);
        int at = hostPort.lastIndexOf('@');
        if (at >= 0) hostPort = hostPort.substring(at + 1);
        if (hostPort.startsWith("[")) {
            int close = hostPort.indexOf(']');
            if (close > 0) return hostPort.substring(1, close);   // IPv6：[::1]:8123
        }
        int colon = hostPort.indexOf(':');
        if (colon > 0) hostPort = hostPort.substring(0, colon);
        return hostPort;
    }

    /** 读自己的配置文件（白名单内），失败返回 "" */
    private String readConfig(String path) {
        String canon = safeConfigPath(path);
        if (canon == null) return "";
        File f = new File(canon);
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
            return "";
        } finally {
            if (r != null) try { r.close(); } catch (Throwable t) { }
        }
    }

    /** 配置目录的规范路径（/sdcard 在 Android 上是 symlink，会解析成 /storage/emulated/0） */
    private static String configRoot() {
        if (configCanon == null) {
            try {
                String c = new File(CONFIG_DIR).getCanonicalPath();
                if (!c.endsWith("/")) c = c + "/";
                configCanon = c;
            } catch (Throwable t) {
                configCanon = CONFIG_DIR;
            }
        }
        return configCanon;
    }
    private static volatile String configCanon = null;

    /** 只允许面板配置目录里的路径：规范化后再判前缀，挡住 ../ 和 symlink 逃逸 */
    private static String safeConfigPath(String path) {
        if (path == null) return null;
        try {
            String canon = new File(path).getCanonicalPath();
            return canon.startsWith(configRoot()) ? canon : null;
        } catch (Throwable t) {
            return null;
        }
    }

    private void loadPanel() {
        String url = resolveUrl();
        Log.i(TAG, "loadPanel " + url);
        long now = System.currentTimeMillis();
        lastBeat = now;
        loadedAt = now;
        everBeat = false;
        web.loadUrl(url);
    }

    private void scheduleRetry(String description) {
        retryCount++;
        final int n = retryCount;
        if (n > MAX_RETRY) {
            showBanner("面板加载失败" + (description == null ? "" : "（" + description + "）")
                    + " · 已停止自动重试（连按两次返回键进系统设置检查网络与 url.txt）");
            Log.w(TAG, "load failed " + n + " times, giving up");
            return;
        }
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
     * 屏幕熄灭（含 Doze）时 WebView 的 JS 定时器被系统冻结，心跳一定停 —— 那不是卡死，
     * 之前每 45s 重载一次，整夜白耗电（Pad 5 实测：静置时 watchdog 每 45s reload 一次）。
     */
    private void startWatchdog() {
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    if (isFinishing()) return;      /* 别给一个正在销毁的 Activity 续期 */
                    long now = System.currentTimeMillis();
                    if (!screenInteractive()) {
                        lastBeat = now;   // 熄屏期间不算卡死，醒来后 onResume 会重新计时
                        ui.postDelayed(this, 30000L);   /* 熄屏时 30 秒醒一次就够，但别再彻底停下 */
                        return;
                    }
                    if (!everBeat) {
                        // 这一页还没给过心跳：首帧可能很慢（实测 first states 可 35s），门槛放宽
                        if (loadedAt > 0 && now - loadedAt > FIRST_BEAT_MS) {
                            Log.w(TAG, "watchdog: no heartbeat since load, reloading");
                            retryCount = 0;
                            loadedAt = now;
                            web.reload();
                        }
                        return;
                    }
                    if (now - lastBeat > BEAT_STALL_MS) {
                        Log.w(TAG, "watchdog: no heartbeat for " + BEAT_STALL_MS / 1000 + "s, reloading");
                        retryCount = 0;
                        lastBeat = now;
                        web.reload();
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "watchdog error " + t.getMessage());
                }
                ui.postDelayed(this, 15000L);
            }
        }, 15000L);
    }

    /** 屏幕是否亮着（API 20+ 用 isInteractive，老系统退回 isScreenOn） */
    private boolean screenInteractive() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return true;
            if (Build.VERSION.SDK_INT >= 20) return pm.isInteractive();
            return pm.isScreenOn();
        } catch (Throwable t) {
            return true;
        }
    }

    private android.os.PowerManager power() {
        return (android.os.PowerManager) getSystemService(POWER_SERVICE);
    }

    /** 能不能改屏幕超时：Android 6+ 是特殊权限（要用户在本机授权），5.x 装包时就有 */
    private boolean settingsWritable() {
        try {
            if (Build.VERSION.SDK_INT >= 23) return android.provider.Settings.System.canWrite(this);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 人回家了：重新常亮 + 主动把屏幕叫醒（屏幕熄着时光加 KEEP_SCREEN_ON 不会亮，必须唤醒一次） */
    private void wakeScreen() {
        try {
            android.os.PowerManager pm = power();
            if (pm == null) return;
            if (wakeLock == null) {
                /* ON_AFTER_SLEEP / isAcquired 不在公开 API 里（android.jar 里没有），只用 FULL_WAKE_LOCK + 唤醒标志 */
                wakeLock = pm.newWakeLock(android.os.PowerManager.FULL_WAKE_LOCK
                        | android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP, "hc:home");
            }
            if (!wakeLock.isHeld()) {
                /* acquire(ms) 要 API 21+；5.1 上退到一参 acquire，必须自己定时释放，不然常亮锁一直留着 */
                if (Build.VERSION.SDK_INT >= 21) {
                    wakeLock.acquire(3000L);
                } else {
                    final android.os.PowerManager.WakeLock wl = wakeLock;
                    wakeLock.acquire();
                    ui.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                if (wl.isHeld()) wl.release();
                            } catch (Throwable t) { }
                        }
                    }, 2500L);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "wake failed: " + t);
        }
    }

    private void setScreenTimeout(int ms) {
        if (!settingsWritable()) {
            Log.w(TAG, "screen timeout not writable（需要在本机设置里允许修改系统设置）");
            return;
        }
        try {
            if (savedScreenOffMs < 0) {
                savedScreenOffMs = android.provider.Settings.System
                        .getInt(getContentResolver(), android.provider.Settings.System.SCREEN_OFF_TIMEOUT, 60000);
            }
            android.provider.Settings.System.putInt(
                    getContentResolver(), android.provider.Settings.System.SCREEN_OFF_TIMEOUT, ms);
            Log.i(TAG, "screen timeout -> " + ms + "ms");
        } catch (Throwable t) {
            Log.w(TAG, "set screen timeout failed: " + t);
        }
    }

    /** goToSleep 是 @hide + 签名级权限，普通应用调不到；能调就立刻熄，调不到靠短超时自己灭 */
    private void tryGoToSleep() {
        try {
            android.os.PowerManager pm = power();
            java.lang.reflect.Method m = pm.getClass().getMethod("goToSleep", long.class);
            m.invoke(pm, System.currentTimeMillis());
            Log.i(TAG, "screen off via goToSleep");
        } catch (Throwable t) {
            Log.i(TAG, "goToSleep unavailable, relying on screen timeout");
        }
    }

    /**
     * 离家熄屏 / 在家亮屏（面板按 HA 的 person.* 调桥 setScreenPolicy）。
     * 亮屏：窗口保持常亮 + 唤醒屏幕 + 还原原来的屏幕超时；
     * 熄屏：取消常亮，把屏幕超时压到 offMs（没人碰就自己熄灭），能拿到权限就直接熄。
     */
    private void applyScreenPolicy(final boolean home, final int offMs) {
        screenHome = home;
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (home) {
                        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        setBlackout(false);
                        wakeScreen();
                        if (settingsWritable()) {
                            if (savedScreenOffMs >= 0) {
                                android.provider.Settings.System.putInt(getContentResolver(),
                                        android.provider.Settings.System.SCREEN_OFF_TIMEOUT, savedScreenOffMs);
                                Log.i(TAG, "screen timeout restored " + savedScreenOffMs + "ms");
                                savedScreenOffMs = -1;
                            }
                            if (savedStayOn >= 0) {
                                android.provider.Settings.System.putInt(getContentResolver(), KEY_STAY_ON, savedStayOn);
                                Log.i(TAG, "stay-on restored " + savedStayOn);
                                savedStayOn = -1;
                            }
                        }
                    } else {
                        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        /* 墙机常年插着电：「充电时保持唤醒」不清掉的话，超时设多短都不会灭屏 */
                        if (settingsWritable()) {
                            try {
                                if (savedStayOn < 0) {
                                    savedStayOn = android.provider.Settings.System
                                            .getInt(getContentResolver(), KEY_STAY_ON, 0);
                                }
                                android.provider.Settings.System.putInt(getContentResolver(), KEY_STAY_ON, 0);
                            } catch (Throwable t) {
                                Log.w(TAG, "stay-on not writable: " + t);
                            }
                        }
                        setScreenTimeout(offMs > 0 ? offMs : AWAY_OFF_MS);
                        tryGoToSleep();
                        /* 有些 MIUI 不认我们写的超时（它有自己的省电策略），过一会儿检查一次：
                           屏幕还亮着就把面板压成全黑 + 背光最低，效果等同于熄屏 */
                        final int waitMs = (offMs > 0 ? offMs : AWAY_OFF_MS) + 1500;
                        ui.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                if (isFinishing() || screenHome) return;
                                if (screenInteractive()) {
                                    Log.i(TAG, "screen timeout not honored -> blackout 全黑兜底");
                                    setBlackout(true);
                                }
                            }
                        }, waitMs);
                    }
                    Log.i(TAG, "screen policy: " + (home ? "home 亮屏" : "away 熄屏"));
                } catch (Throwable t) {
                    Log.w(TAG, "screen policy failed: " + t);
                }
            }
        });
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
        ui.removeCallbacksAndMessages(null);        /* 看门狗/重试/横幅的 pending 回调全部作废 */
        try { netPool.shutdownNow(); } catch (Throwable t) { }
        try {
            if (mockHa != null) mockHa.getClass().getMethod("stop").invoke(mockHa);
        } catch (Throwable t) { }
        try {
            if (web != null) {
                web.removeJavascriptInterface("AndroidBridge");
                web.stopLoading();
                web.destroy();
            }
        } catch (Throwable t) { }
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable t) { }
        /* 面板退掉了就别把设备留在「短熄屏 + 不保持唤醒」上：还原原来的两项设置 */
        try {
            if (settingsWritable()) {
                if (savedScreenOffMs >= 0) {
                    android.provider.Settings.System.putInt(getContentResolver(),
                            android.provider.Settings.System.SCREEN_OFF_TIMEOUT, savedScreenOffMs);
                    savedScreenOffMs = -1;
                }
                if (savedStayOn >= 0) {
                    android.provider.Settings.System.putInt(getContentResolver(), KEY_STAY_ON, savedStayOn);
                    savedStayOn = -1;
                }
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
            everBeat = true;
            if (retryCount > 0) retryCount = 0;
        }

        /** 系统媒体音量的比例 0..1（拿不到返回 -1，前端自己退回） */
        @JavascriptInterface
        public float getVolume() {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (am == null) return -1f;
            int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            if (max <= 0) return -1f;
            return am.getStreamVolume(AudioManager.STREAM_MUSIC) / (float) max;
        }

        /** 直接拧系统媒体音量；flag 0 = 不弹系统的音量条 */
        @JavascriptInterface
        public void setVolume(float v) {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (am == null) return;
            int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            if (max <= 0) return;
            int level = Math.round(v * max);
            if (level < 0) level = 0;
            if (level > max) level = max;
            try {
                am.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0);
                Log.d(TAG, "JSB system volume " + level + "/" + max);
            } catch (Exception e) {
                Log.w(TAG, "setVolume failed " + e);
            }
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

        /** 当前系统「自动锁屏」值（毫秒），回归脚本用它核对策略真的生效 */
        @JavascriptInterface
        public String screenTimeout() {
            try {
                return String.valueOf(android.provider.Settings.System.getInt(
                        getContentResolver(), android.provider.Settings.System.SCREEN_OFF_TIMEOUT, -1));
            } catch (Throwable t) {
                return "-1";
            }
        }

        /** 现在是不是走在全黑兜底上（回归脚本用来区分「真灭屏」与「全黑」） */
        @JavascriptInterface
        public boolean blackoutState() {
            return blackout;
        }

        /** 全黑状态下被碰一下：醒过来。遮罩吞掉点击，不会穿透到下面的卡片误触开关。 */
        @JavascriptInterface
        public void wakeBlackout() {
            ui.post(new Runnable() {
                public void run() { setBlackout(false); }
            });
        }

        /** 设备自身的网络身份：上墙后排查「它到底连在哪个网」用得上 */
        @JavascriptInterface
        public String netInfo() {
            long now = System.currentTimeMillis();
            if (netInfoCache != null && now - netInfoAt < 60000L) return netInfoCache;
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
            netInfoCache = "{\"ip\":\"" + ip + "\",\"ssid\":\"" + ssid + "\"}";
            netInfoAt = now;
            return netInfoCache;
        }
        private String netInfoCache = null;
        private long netInfoAt = 0L;

        /** 电池状态：注册成 HA 实体时上报电量。sticky intent，不用注册 receiver */
        @JavascriptInterface
        public String battery() {
            int level = -1, scale = 100, status = 0;
            try {
                android.content.Intent bi = getApplicationContext().registerReceiver(
                        null, new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
                if (bi != null) {
                    level = bi.getIntExtra("level", -1);
                    scale = bi.getIntExtra("scale", 100);
                    status = bi.getIntExtra("status", 0);
                }
            } catch (Throwable t) { }
            int pct = (level < 0 || scale <= 0) ? -1 : Math.round(level * 100f / scale);
            boolean charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING
                    || status == android.os.BatteryManager.BATTERY_STATUS_FULL;
            return "{\"level\":" + pct + ",\"charging\":" + (charging ? "true" : "false") + "}";
        }


        @JavascriptInterface
        public String devUrl() {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            return sp.getString(KEY_URL, "");
        }

        /** last-modified stamp of a config file, used by the panel for hot reload during development */
        @JavascriptInterface
        public long mtime(String path) {
            String canon = safeConfigPath(path);
            if (canon == null) { Log.w(TAG, "mtime denied: " + path); return 0L; }
            try {
                File f = new File(canon);
                return f.exists() ? f.lastModified() : 0L;
            } catch (Throwable t) {
                return 0L;
            }
        }

        /** write a small text config file under /sdcard/HomeControl (panels configures itself without adb) */
        @JavascriptInterface
        public boolean writeText(String path, String content) {
            if (path == null || content == null) return false;
            String canon = safeConfigPath(path);
            if (canon == null) {
                Log.w(TAG, "writeText denied: " + path);
                return false;
            }
            if (content.length() > 8192) {
                Log.w(TAG, "writeText too large: " + content.length());
                return false;
            }
            java.io.FileOutputStream out = null;
            try {
                File f = new File(canon);
                File parent = f.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                out = new java.io.FileOutputStream(f, false);
                out.write(content.getBytes("UTF-8"));
                out.flush();
                Log.i(TAG, "writeText ok: " + canon + " (" + content.length() + " chars)");
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
            String canon = safeConfigPath(path);
            if (canon == null) {
                Log.w(TAG, "removeFile denied: " + path);
                return false;
            }
            try {
                File f = new File(canon);
                if (!f.exists()) return true;
                boolean ok = f.delete();
                Log.i(TAG, "removeFile " + canon + " -> " + ok);
                return ok;
            } catch (Throwable t) {
                Log.w(TAG, "removeFile failed: " + t.getMessage());
                return false;
            }
        }

        /** read a small text config file from /sdcard/HomeControl (ha.json, music.json) */
        @JavascriptInterface
        public String readText(String path) {
            String canon = safeConfigPath(path);
            if (canon == null) {
                Log.w(TAG, "readText denied: " + path);
                return "";
            }
            return readConfig(canon);
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
        /** 离家熄屏 / 在家亮屏：面板按 HA 的 person.* 决定，offMs 是没人碰屏幕多久后熄灭 */
        @JavascriptInterface
        public void setScreenPolicy(boolean home, int offMs) {
            applyScreenPolicy(home, offMs);
        }

        /** 能不能改屏幕超时（Android 6+ 要用户授权）；面板设置里据此提示 */
        @JavascriptInterface
        public boolean screenWritable() {
            return MainActivity.this.settingsWritable();
        }

        /** 跳到系统设置里的「修改系统设置」授权页（Android 6+ 改屏幕超时必须先授权） */
        @JavascriptInterface
        public void openWriteSettings() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_WRITE_SETTINGS);
                        i.setData(Uri.fromParts("package", getPackageName(), null));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                        Log.i(TAG, "opened WRITE_SETTINGS grant page");
                    } catch (Throwable t) {
                        Log.w(TAG, "openWriteSettings failed: " + t);
                    }
                }
            });
        }
        /** 懒建：第一次域名请求时才付信任库初始化的钱（以前 onCreate 里同步建，boot 白等 100~300ms） */
        private TlsPolicy tlsPolicy() {
            TlsPolicy t = tls;
            if (t == null) {
                synchronized (MainActivity.this) {
                    if (tls == null) tls = new TlsPolicy(MainActivity.this);
                }
            }
            return tls;
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

        /** https 的 TLS 策略：局域网（IP 字面量/localhost）自建自签放行；域名必须真验（见 TlsPolicy） */
        private void applyTls(HttpsURLConnection h, String host) throws Exception {
            if (TlsPolicy.isPrivateHost(host)) {
                h.setSSLSocketFactory(trustAll().getSocketFactory());
                h.setHostnameVerifier(new HostnameVerifier() {
                    public boolean verify(String h2, SSLSession s) { return true; }
                });
            } else {
                h.setSSLSocketFactory(tlsPolicy().context().getSocketFactory());
                // 域名连接保持默认主机名校验，不放开
            }
        }

        /** 归一化成 http(s) 基地址，并打开连接（局域网支持 https 自签名） */
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
                applyTls(h, url.getHost());
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

        /** 响应声明的长度（没声明给 4096），给 BAOS 一个靠谱的初值 */
        private int contentLength(HttpURLConnection c) {
            int len = c.getContentLength();
            return len > 0 && len < 8000000 ? len : 4096;
        }

        /** 封面缩到 ≤max 边长再编码：50KB 原图 base64 后 ~67KB，缓存 60 张就是 ~120MB，2GB 平板吃不消 */
        private byte[] downscale(byte[] raw, int max) {
            try {
                android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
                int side = Math.max(o.outWidth, o.outHeight);
                if (side <= 0) return raw;
                int sample = 1;
                while (side / sample > max) sample *= 2;
                if (sample <= 1) return raw;
                o.inJustDecodeBounds = false;
                o.inSampleSize = sample;
                android.graphics.Bitmap bm = android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
                if (bm == null) return raw;
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(64 * 1024);
                bm.compress(android.graphics.Bitmap.CompressFormat.JPEG, 78, out);
                bm.recycle();
                byte[] small = out.toByteArray();
                return small.length > 0 && small.length < raw.length ? small : raw;
            } catch (Throwable t) {
                Log.w(TAG, "downscale failed: " + t.getMessage());
                return raw;
            }
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
                if (code >= 200 && code < 400) rememberVerifiedHost(baseUrl);   /* HA 域名验过也放行（WebView 的 WS/REST 走同一主机） */
                InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = "";
                if (is != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream(contentLength(c) + 64);
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
            netPool.execute(new Runnable() {
                public void run() {
                    final String out = restCall(baseUrl, token, method, path, payload);
                    ui.post(new Runnable() {
                        public void run() {
                            try {
                                if (web != null) {
                                    web.evaluateJavascript("window.__restCb && window.__restCb("
                                            + org.json.JSONObject.quote(cbId) + ","
                                            + out + ")", null);
                                }
                            } catch (Throwable t) { Log.w(TAG, "rest cb failed: " + t); }
                        }
                    });
                }
            });
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
                /* 同步桥调用会冻结页面里的 JS：超时压到 2.5 秒，卡死最长 5 秒而不是 12 秒 */
                c.setConnectTimeout(2500);
                c.setReadTimeout(2500);
                int code = c.getResponseCode();
                if (code >= 200 && code < 400) rememberVerifiedHost(u);   /* 开机探活验过的主机也记下来 */
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
            netPool.execute(new Runnable() {
                public void run() {
                    final String out = httpText(url, method, headersJson, body);
                    ui.post(new Runnable() {
                        public void run() {
                            try {
                                if (web != null) {
                                    web.evaluateJavascript("window.__musicHttpCb && window.__musicHttpCb("
                                            + org.json.JSONObject.quote(cbId) + ","
                                            + out + ")", null);
                                }
                            } catch (Throwable t) { Log.w(TAG, "httpReq cb failed: " + t); }
                        }
                    });
                }
            });
        }

        private String httpGetText(String url) {
            return httpText(url, "GET", "{}", "");
        }

        /** 取二进制并转 base64（道理鱼的封面要 Authorization 头，<img> 加不了头，只能这样绕）。
            结果异步回 window.__musicBinaryCb(cbId, {status|error, mime, b64})。上限 1.5MB。 */
        @JavascriptInterface
        public void httpBinary(final String cbId, final String method, final String url,
                               final String headersJson) {
            netPool.execute(new Runnable() {
                public void run() {
                    final String out = httpBytes(url, method, headersJson);
                    ui.post(new Runnable() {
                        public void run() {
                            try {
                                if (web != null) {
                                    web.evaluateJavascript("window.__musicBinaryCb && window.__musicBinaryCb("
                                            + org.json.JSONObject.quote(cbId) + ","
                                            + out + ")", null);
                                }
                            } catch (Throwable t) { Log.w(TAG, "httpBinary cb failed: " + t); }
                        }
                    });
                }
            });
        }

        private String httpBytes(String url, String method, String headersJson) {
            HttpURLConnection c = null;
            try {
                URL u = new URL(url);
                if ("https".equals(u.getProtocol())) {
                    HttpsURLConnection h = (HttpsURLConnection) u.openConnection();
                    applyTls(h, u.getHost());
                    c = h;
                } else {
                    c = (HttpURLConnection) u.openConnection();
                }
                c.setConnectTimeout(6000);
                c.setReadTimeout(15000);
                c.setRequestMethod(method == null || method.length() == 0 ? "GET" : method);
                c.setRequestProperty("Accept", "*/*");
                c.setRequestProperty("User-Agent", "HomeControl-Panel");
                if (headersJson != null && headersJson.length() > 2) {
                    try {
                        org.json.JSONObject h = new org.json.JSONObject(headersJson);
                        java.util.Iterator<?> it = h.keys();
                        while (it.hasNext()) {
                            String k = String.valueOf(it.next());
                            c.setRequestProperty(k, h.optString(k, ""));
                        }
                    } catch (Throwable t) { Log.w(TAG, "httpBytes bad headers: " + t); }
                }
                int code = c.getResponseCode();
                /* 原生桥这次请求是 TlsPolicy 真验过证书 + 主机名的：把这个域名记进运行时放行集，
                   WebView 自己的音频流（同一个主机）就能放行。 */
                if (code >= 200 && code < 300) rememberVerifiedHost(url);
                String mime = c.getContentType() == null ? "application/octet-stream" : c.getContentType();
                String b64 = "";
                int total = 0;
                if (code >= 200 && code < 300) {
                    InputStream is = c.getInputStream();
                    ByteArrayOutputStream bo = new ByteArrayOutputStream(contentLength(c) + 64);
                    byte[] buf = new byte[8192];
                    int n;
                    boolean truncated = false;
                    while (is != null && (n = is.read(buf)) > 0) {
                        total += n;
                        if (total > 1500000) { truncated = true; break; }   /* 太大就不要了，别把半张图当成功 */
                        bo.write(buf, 0, n);
                    }
                    if (is != null) try { is.close(); } catch (Throwable t) { }
                    if (truncated) {
                        Log.w(TAG, "httpBinary truncated: " + url + " (" + total + " bytes)");
                        return "{\"error\":\"too-large\"}";
                    }
                    byte[] raw = bo.toByteArray();
                    if (mime != null && mime.startsWith("image/") && raw.length > 120000) {
                        raw = downscale(raw, 512);
                        mime = "image/jpeg";   /* 重编码过就是 JPEG，别让 JS 按原 mime 解 */
                    }
                    b64 = android.util.Base64.encodeToString(raw, android.util.Base64.NO_WRAP);
                }
                Log.i(TAG, "httpBinary " + url + " -> " + code + " (" + total + " bytes, " + b64.length() + " b64) " + mime);
                org.json.JSONObject out = new org.json.JSONObject();
                out.put("status", code);
                out.put("mime", mime);
                out.put("b64", b64);
                return out.toString();
            } catch (Throwable t) {
                Log.w(TAG, "httpBinary failed " + url + " : " + t);
                try {
                    org.json.JSONObject out = new org.json.JSONObject();
                    out.put("error", t.getClass().getSimpleName());
                    return out.toString();
                } catch (Throwable t2) { return "{\"error\":\"unknown\"}"; }
            } finally {
                if (c != null) try { c.disconnect(); } catch (Throwable t) { }
            }
        }

        private String httpText(String url, String method, String headersJson, String body) {
            HttpURLConnection c = null;
            try {
                URL u = new URL(url);
                if ("https".equals(u.getProtocol())) {
                    HttpsURLConnection h = (HttpsURLConnection) u.openConnection();
                    applyTls(h, u.getHost());
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
                if (code >= 200 && code < 400) rememberVerifiedHost(url);   /* 登录/曲目/歌词验过的主机也放行音频流 */
                InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = "";
                if (is != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream(contentLength(c) + 64);
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

        /* ---------------- 自升级：检查 / 下载 / 安装 ----------------
           JS 侧（panel/js/update.js）只负责状态机和文案，网络与安装都在这儿做：
           检查走 httpText（和道理鱼那套通用请求同一条通道，TLS 策略一致），
           下载把字节写到 cache/upd/，安装交给系统安装器（APK 通过 UpdateProvider 以 content:// 交付）。 */

        private void postJs(String js) {
            final String s = js;
            ui.post(new Runnable() {
                public void run() {
                    try {
                        if (web != null) web.evaluateJavascript(s, null);
                    } catch (Throwable t) { Log.w(TAG, "postJs failed: " + t); }
                }
            });
        }

        private String cbJs(String fn, String cbId, String payload) {
            return "window." + fn + " && window." + fn + "("
                    + org.json.JSONObject.quote(cbId) + ","
                    + org.json.JSONObject.quote(payload) + ")";
        }

        private String errJson(String msg) {
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("error", msg);
                return o.toString();
            } catch (Throwable t) { return "{\"error\":\"unknown\"}"; }
        }

        /** 取 GitHub Release 的 JSON（结果异步回 window.__hcUpdNetCb(cbId, {status|error, body})） */
        @JavascriptInterface
        public void updNet(final String cbId, final String url, final String headersJson) {
            netPool.execute(new Runnable() {
                public void run() {
                    final String out = httpText(url, "GET", headersJson, "");
                    Log.i(TAG, "updNet " + url + " -> " + (out.length() > 200 ? out.substring(0, 200) : out));
                    postJs(cbJs("__hcUpdNetCb", cbId, out));
                }
            });
        }

        /** 下载 APK：过程回 __hcUpdProg(cbId, pct)，结束回 __hcUpdDone(cbId, {path,bytes} | {error}) */
        @JavascriptInterface
        public void updDownload(final String cbId, final String url, final String fileName) {
            netPool.execute(new Runnable() {
                public void run() {
                    final String out = updFetch(cbId, url, fileName);
                    postJs(cbJs("__hcUpdDone", cbId, out));
                }
            });
        }

        /** 把 APK 落到 cache/upd/。先写 .part 再改名，中途断了不会留下半个可安装包 */
        private String updFetch(String cbId, String url, String fileName) {
            HttpURLConnection c = null;
            java.io.FileOutputStream fos = null;
            File tmp = null;
            try {
                String name = fileName == null ? "" : fileName.replaceAll("[^A-Za-z0-9._-]", "_");
                if (name.length() == 0) name = "update.apk";
                if (!name.toLowerCase().endsWith(".apk")) name = name + ".apk";
                File dir = UpdateProvider.dir(MainActivity.this);
                File outFile = new File(dir, name);
                tmp = new File(dir, name + ".part");

                URL u = new URL(url);
                if ("https".equals(u.getProtocol())) {
                    HttpsURLConnection h = (HttpsURLConnection) u.openConnection();
                    applyTls(h, u.getHost());
                    c = h;
                } else {
                    c = (HttpURLConnection) u.openConnection();
                }
                c.setInstanceFollowRedirects(true);      /* GitHub 会 302 到 objects.githubusercontent.com */
                c.setConnectTimeout(8000);
                c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", "HomeControl-Panel");
                c.setRequestProperty("Accept", "application/octet-stream");
                int code = c.getResponseCode();
                if (code < 200 || code >= 300) return errJson("HTTP " + code);
                String ctype = c.getContentType();
                if (ctype != null && ctype.indexOf("html") > -1) return errJson("下载到的是网页不是安装包");

                int total = c.getContentLength();
                InputStream is = c.getInputStream();
                fos = new java.io.FileOutputStream(tmp);
                byte[] buf = new byte[16384];
                int n;
                long got = 0;
                int lastPct = -1;
                boolean apkMagic = false;
                while ((n = is.read(buf)) > 0) {
                    if (!apkMagic) {
                        /* 头两个字节必须是 "PK"：代理/镜像把 404 页当 200 返回时在这里拦住 */
                        if (got == 0 && buf[0] == 0x50 && (n < 2 || buf[1] == 0x4B)) apkMagic = true;
                        else if (got == 0) return errJson("下载到的不是 APK（开头不是 ZIP）");
                    }
                    got += n;
                    if (got > 200L * 1024 * 1024) return errJson("安装包太大（超过 200MB）");
                    fos.write(buf, 0, n);
                    if (total > 0) {
                        int pct = (int) (got * 100 / total);
                        if (pct != lastPct) {
                            lastPct = pct;
                            postJs("window.__hcUpdProg && window.__hcUpdProg("
                                    + org.json.JSONObject.quote(cbId) + "," + pct + ")");
                        }
                    }
                }
                if (is != null) try { is.close(); } catch (Throwable t) { }
                fos.close();
                fos = null;
                if (got < 50000) return errJson("安装包只有 " + got + " 字节，不像完整的 APK");
                if (outFile.exists()) outFile.delete();
                if (!tmp.renameTo(outFile)) return errJson("落盘失败（改名被拒）");
                Log.i(TAG, "updDownload done " + outFile + " (" + got + " bytes)");
                org.json.JSONObject out = new org.json.JSONObject();
                out.put("path", outFile.getAbsolutePath());
                out.put("bytes", got);
                out.put("name", outFile.getName());
                return out.toString();
            } catch (Throwable t) {
                Log.w(TAG, "updDownload failed " + url + " : " + t);
                return errJson(t.getClass().getSimpleName() + ": " + t.getMessage());
            } finally {
                if (fos != null) try { fos.close(); } catch (Throwable t) { }
                if (c != null) try { c.disconnect(); } catch (Throwable t) { }
                if (tmp != null && tmp.exists() && !tmp.getName().endsWith(".apk")) {
                    try { tmp.delete(); } catch (Throwable t) { }
                }
            }
        }

        /** 拉起系统安装器（APK 通过 UpdateProvider 的 content:// 交付） */
        @JavascriptInterface
        public void updInstall(final String cbId, final String path) {
            ui.post(new Runnable() {
                public void run() {
                    String out;
                    try { out = doInstall(path); } catch (Throwable t) {
                        Log.w(TAG, "updInstall failed: " + t);
                        out = errJson("install: " + t);
                    }
                    try {
                        if (web != null) {
                            web.evaluateJavascript("window.__hcUpdDone && window.__hcUpdDone("
                                    + org.json.JSONObject.quote(cbId) + ","
                                    + out + ")", null);
                        }
                    } catch (Throwable t) { Log.w(TAG, "updInstall cb failed: " + t); }
                }
            });
        }

        private String doInstall(String path) {
            File f = new File(path == null ? "" : path);
            if (!f.isFile()) return errJson("安装包不见了，重新下载一次");
            /* 注意：不要在这里用 canRequestPackageInstalls() 提前拦。
               本项目 targetSdk=22，MIUI 13（Android 13）上这个 API 明明 appops 已 allow
               仍然返回 false，提前拦会把本来能装的路径堵死。先试装，全都起不来时再判是不是权限问题。 */
            boolean permOk = Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls();
            String mime = "application/vnd.android.package-archive";
            /* MI PAD 2（Android 5.1 / MIUI）上实测：ACTION_VIEW + content:// 没有任何 Activity 接
               （ActivityNotFoundException），但 ACTION_INSTALL_PACKAGE 一直能用；file:// 到 7.0 才被禁。
               所以按「插件本义 → VIEW，content → 外部缓存 file」顺序试，全都失败才报错。 */
            String[] actions = new String[] { Intent.ACTION_INSTALL_PACKAGE, Intent.ACTION_VIEW };
            Throwable last = null;
            for (int a = 0; a < actions.length; a++) {
                for (int u = 0; u < 2; u++) {
                    if (u == 1 && Build.VERSION.SDK_INT >= 24) continue;   /* file:// 从 Android 7 起不给外用 */
                    File src = f;
                    if (u == 1) {
                        src = stageForInstaller(f);
                        if (src == null) continue;
                    }
                    Uri uri = (u == 1) ? Uri.fromFile(src) : UpdateProvider.uriFor(f.getName());
                    Intent i = new Intent(actions[a]);
                    i.setDataAndType(uri, mime);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivity(i);
                        Log.i(TAG, "updInstall " + actions[a] + " " + uri + " -> installer");
                        return "{\"ok\":true}";
                    } catch (Throwable t) {
                        last = t;
                        Log.w(TAG, "updInstall " + actions[a] + " failed: " + t);
                    }
                }
            }
            if (!permOk) return errJson("need_permission");
            return errJson("没有安装器能打开安装包" + (last == null ? "" : "（" + last.getClass().getSimpleName() + "）"));
        }

        /** 把 cache 里的安装包复制到外部私有目录，给「只能用 file://」的老安装器用 */
        private File stageForInstaller(File src) {
            try {
                File dir = new File(getExternalFilesDir(null), "upd");
                if (!dir.isDirectory() && !dir.mkdirs()) return null;
                File out = new File(dir, src.getName());
                if (out.length() == src.length() && out.length() > 0) return out;
                java.io.InputStream in = new java.io.FileInputStream(src);
                java.io.OutputStream os = new java.io.FileOutputStream(out);
                try {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    os.flush();
                } finally {
                    try { in.close(); } catch (Throwable t) { }
                    try { os.close(); } catch (Throwable t) { }
                }
                return out;
            } catch (Throwable t) {
                Log.w(TAG, "stageForInstaller failed: " + t);
                return null;
            }
        }

        /** 打开「安装未知应用」的系统设置（只有 API 26+ 需要/才有这一页） */
        @JavascriptInterface
        public void updPerm() {
            ui.post(new Runnable() {
                public void run() {
                    try {
                        Intent i;
                        if (Build.VERSION.SDK_INT >= 26) {
                            i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName()));
                        } else {
                            i = new Intent(android.provider.Settings.ACTION_SECURITY_SETTINGS);
                        }
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                        Log.i(TAG, "updPerm -> " + i.getAction());
                    } catch (Throwable t) { Log.w(TAG, "updPerm failed: " + t); }
                }
            });
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
