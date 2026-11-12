package com.homecontrol.panel;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * TLS 策略。两类主机，两套规则：
 * <ul>
 * <li>局域网（IP 字面量 / localhost）：自建 HA 常用自签证书，一律放行 —— 信任边界就是这台设备
 * 所在的网络，中间人得先能在内网里。</li>
 * <li>域名（如 <c>*.cchong.cc</c>）：证书必须<b>真正校验</b>。MI PAD 2 的 Android 5.1 信任库里
 * 没有 Let's Encrypt 的 ISRG 根证书，所以把根证书打进 <c>assets/certs/</c> 自己当信任锚再验一遍；
 * 验不过就抛异常。之前这里是「信任所有证书」，道理鱼的账号密码就在那条通道上，
 * 任何中间人都能把它截走。</li>
 * </ul>
 * WebView 自己的网络栈（负一屏音频流）用不了这里的锚，所以那边只在 SSL_UNTRUSTED（缺根证书）
 * 且主机是面板自己配置的服务器时放行，其余一律 cancel。
 */
public class TlsPolicy {

    private static final String TAG = "HomePanel";
    /** 打进 APK 的信任锚（源文件在 app/certs/，build.ps1 复制进 assets/certs/） */
    private static final String[] ANCHORS = { "certs/isrgrootx1.pem", "certs/isrg-root-x2.pem" };

    private final X509TrustManager platform;                 // 系统默认信任库
    private final List<X509Certificate> roots;               // 自带信任锚
    private SSLContext strictCtx = null;

    public TlsPolicy(Context ctx) {
        X509TrustManager tm = null;
        try {
            TrustManagerFactory f = TrustManagerFactory.getInstance(
                    TrustManagerFactory.getDefaultAlgorithm());
            f.init((java.security.KeyStore) null);   // null = 系统默认信任库
            for (TrustManager t : f.getTrustManagers()) {
                if (t instanceof X509TrustManager) { tm = (X509TrustManager) t; break; }
            }
        } catch (Throwable t) {
            Log.w(TAG, "platform trust store unavailable: " + t.getMessage());
        }
        platform = tm;
        roots = loadRoots(ctx);
        Log.i(TAG, "tls anchors: " + roots.size());
    }

    private static List<X509Certificate> loadRoots(Context ctx) {
        List<X509Certificate> out = new ArrayList<X509Certificate>();
        try {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            AssetManager am = ctx.getAssets();
            for (String name : ANCHORS) {
                InputStream in = null;
                try {
                    in = am.open(name);
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                    out.add((X509Certificate) cf.generateCertificate(
                            new ByteArrayInputStream(bos.toByteArray())));
                } catch (Throwable t) {
                    Log.w(TAG, "anchor missing: " + name + " " + t.getMessage());
                } finally {
                    if (in != null) try { in.close(); } catch (Throwable t) { }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "tls anchors unavailable: " + t.getMessage());
        }
        return out;
    }

    /** IP 字面量（IPv4/IPv6，含 ::1）或 localhost —— 局域网信任边界 */
    public static boolean isPrivateHost(String host) {
        if (host == null || host.length() == 0) return false;
        String h = host.toLowerCase();
        if ("localhost".equals(h)) return true;
        if (h.matches("^\\d{1,3}(\\.\\d{1,3}){3}$")) return true;
        if (h.indexOf(':') >= 0 && h.matches("^[0-9a-f:.]+$")) return true;
        return false;
    }

    /** 域名连接用的 SSLContext：系统信任库优先，失败再用自带锚补验一次 */
    /** 真验证用的 SSLContext（系统信任库 + 自带 ISRG 锚），缓存一次 */
    public SSLContext context() throws Exception {
        if (strictCtx != null) return strictCtx;
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{ new Anchored() }, new SecureRandom());
        strictCtx = ctx;
        return ctx;
    }

    private class Anchored implements X509TrustManager {
        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType)
                throws CertificateException {
            if (platform != null) {
                try {
                    platform.checkServerTrusted(chain, authType);
                    return;
                } catch (CertificateException e) {
                    // 多半是「设备信任库里没有这根证书」，换自带的锚再验一次；
                    // 其它原因（过期、域名不匹配由主机名校验负责）会在下面的验链里同样失败。
                    Log.d(TAG, "platform rejected (" + e.getMessage() + "), retry with bundled anchors");
                }
            }
            verifyAgainstRoots(chain);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType)
                throws CertificateException {
            if (platform != null) platform.checkClientTrusted(chain, authType);
            else throw new CertificateException("no client CA available");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return roots.toArray(new X509Certificate[roots.size()]);
        }
    }

    /** 逐级验签名，最后一环必须落在自带根证书上；有效期也一并检查 */
    private void verifyAgainstRoots(X509Certificate[] chain) throws CertificateException {
        if (chain == null || chain.length == 0) throw new CertificateException("empty cert chain");
        for (X509Certificate c : chain) c.checkValidity();
        for (int i = 0; i < chain.length; i++) {
            X509Certificate c = chain[i];
            if (i + 1 < chain.length) {
                try {
                    c.verify(chain[i + 1].getPublicKey());
                } catch (Throwable t) {
                    throw new CertificateException("chain broken under " + c.getIssuerDN());
                }
                continue;
            }
            // 最后一环：必须由某个自带根证书签发
            for (X509Certificate root : roots) {
                try {
                    c.verify(root.getPublicKey());
                    return;
                } catch (Throwable t) { /* 试下一个锚 */ }
            }
            throw new CertificateException("untrusted root: " + c.getIssuerDN());
        }
    }
}
