package com.homecontrol.panel;

import android.content.Context;
import android.os.Debug;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileWriter;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 面板自己的运行日志：写到 /sdcard/HomeControl/logs/panel.log，方便老平板（MI PAD 2 / 5.1）
 * 「自动闪退」时还能拿到一点现场——logcat 环形缓冲一重启就没了，也没有 root 读不了 dropbox。
 *
 * 记什么：启动/前台/后台/退出这类生命周期、WebView 的 JS 控制台报错、页面加载失败、
 * 内存水位（每 5 分钟一次 + 掉到后台时）、未捕获异常（写 crash.log）。
 * 一次开机一条 boot 行、一次正常退出一条 exit 行：下次启动时如果最后一条不是 exit，
 * 说明上次是「异常退出」（被系统杀 / WebView 原生崩溃 / 直接闪退），这就是要上传的现场。
 *
 * 刻意用同步追加写（一次 write + flush，单行几十字节）：量很小，崩溃时最后几行必须已经落盘，
 * 异步缓冲等于白记。目录建不出来（没给存储权限等）时全部降级成空操作，绝不能因为记日志把面板搞崩。
 */
public final class PanelLog {
    private static final String TAG = "PanelLog";
    private static final long MAX_BYTES = 256L * 1024L;   /* 单个文件上限，超了轮转 */
    private static final int KEEP = 3;                    /* panel.log + panel.1.log + panel.2.log */
    private static final String[] PENDING_MARKS = { "crash.log", "exit.log" };

    private static final Object LOCK = new Object();
    private static final SimpleDateFormat STAMP =
            new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US);

    private static File dir;
    private static boolean dead = false;        /* 目录用不了就永久降级 */
    private static boolean installed = false;
    private static Thread.UncaughtExceptionHandler prevHandler;

    private PanelLog() {
    }

    /** 由 MainActivity.onCreate 调用一次：装未捕获异常钩子 + 写 boot 行 */
    public static void init(Context ctx) {
        synchronized (LOCK) {
            try {
                File base = new File(HOME(ctx));
                if (!base.exists()) base.mkdirs();
                File d = new File(base, "logs");
                if (!d.exists()) d.mkdirs();
                if (!d.isDirectory() || !d.canWrite()) {
                    dead = true;
                    Log.w(TAG, "log dir not writable: " + d);
                    return;
                }
                dir = d;
            } catch (Throwable t) {
                dead = true;
                Log.w(TAG, "log dir failed: " + t);
                return;
            }
            if (!installed) {
                installed = true;
                prevHandler = Thread.getDefaultUncaughtExceptionHandler();
                Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
                    @Override
                    public void uncaughtException(Thread th, Throwable ex) {
                        try {
                            write("fatal", "uncaught in " + (th == null ? "?" : th.getName())
                                    + ": " + ex);
                            writeStack("crash", ex);
                            dumpMemory("crash");
                        } catch (Throwable ignored) {
                        }
                        if (prevHandler != null) prevHandler.uncaughtException(th, ex);
                    }
                });
            }
        }
    }

    /** /sdcard 在 5.1 上就是外部存储根；与 MainActivity 的配置目录保持一致 */
    private static String HOME(Context ctx) {
        String s = null;
        try {
            s = android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
        } catch (Throwable t) {
        }
        if (s == null || s.length() == 0) s = "/sdcard";
        return s + "/HomeControl";
    }

    public static File logFile() {
        File d = dir;
        return d == null ? null : new File(d, "panel.log");
    }

    public static File crashFile() {
        File d = dir;
        return d == null ? null : new File(d, "crash.log");
    }

    /** 一行日志：`11-21 00:12:33.412 [tag] 内容` */
    public static void write(String tag, String msg) {
        if (dead) return;
        synchronized (LOCK) {
            File f = logFile();
            if (f == null) return;
            try {
                rotateLocked();
                FileWriter w = new FileWriter(f, true);
                try {
                    w.write(STAMP.format(new Date()));
                    w.write(" [");
                    w.write(tag == null ? "-" : tag);
                    w.write("] ");
                    w.write(msg == null ? "" : msg);
                    w.write('\n');
                    w.flush();
                } finally {
                    w.close();
                }
            } catch (Throwable t) {
                dead = true;
                Log.w(TAG, "write failed: " + t);
            }
        }
    }

    /** 把异常栈写成多行（进 crash.log，同时进 panel.log 一份摘要） */
    public static void writeStack(String tag, Throwable ex) {
        if (ex == null) return;
        StringWriter sw = new StringWriter();
        ex.printStackTrace(new PrintWriter(sw));
        String[] lines = sw.toString().split("\n");
        File f = crashFile();
        if (f == null || dead) return;
        synchronized (LOCK) {
            try {
                FileWriter w = new FileWriter(f, true);
                try {
                    w.write("===== " + STAMP.format(new Date()) + " " + tag + " =====\n");
                    for (int i = 0; i < lines.length && i < 80; i++) {
                        w.write(lines[i]);
                        w.write('\n');
                    }
                    w.flush();
                } finally {
                    w.close();
                }
            } catch (Throwable t) {
                dead = true;
                Log.w(TAG, "stack write failed: " + t);
            }
        }
    }

    /** 内存水位：Java 堆 + 原生堆。老平板闪退多半是这里先出问题 */
    public static void dumpMemory(String tag) {
        try {
            Runtime rt = Runtime.getRuntime();
            long max = rt.maxMemory();
            long total = rt.totalMemory();
            long used = total - rt.freeMemory();
            long nativeHeap = -1L;
            try {
                nativeHeap = Debug.getNativeHeapAllocatedSize();
            } catch (Throwable t) {
            }
            write(tag == null ? "mem" : tag + ".mem",
                    "java " + kb(used) + "/" + kb(max) + " (total " + kb(total) + ")"
                            + " native " + (nativeHeap < 0 ? "?" : kb(nativeHeap))
                            + " threads " + Thread.activeCount());
        } catch (Throwable t) {
            /* 记不了就算了 */
        }
    }

    private static String kb(long v) {
        return (v / 1024L) + "K";
    }

    /** 超过上限就 panel.log -> panel.1.log -> ...（老的直接丢） */
    private static void rotateLocked() {
        File f = logFile();
        if (f == null || !f.exists() || f.length() < MAX_BYTES) return;
        for (int i = KEEP - 1; i >= 1; i--) {
            File from = new File(dir, "panel" + (i == 1 ? "" : "." + (i - 1)) + ".log");
            if (i == 1) from = f;
            File to = new File(dir, "panel." + i + ".log");
            if (!from.exists()) continue;
            if (to.exists()) to.delete();
            if (!from.renameTo(to)) {
                /* 改名失败（被占）：直接清空，宁可丢历史也不能无限涨 */
                from.delete();
            }
        }
    }

    /** 读最近 maxBytes 字节：panel.log 尾部 + 上次崩溃栈 + 内存行 */
    public static String tail(int maxBytes) {
        if (dead) return "";
        File f = logFile();
        StringBuilder sb = new StringBuilder();
        if (f != null && f.exists()) {
            sb.append(readTail(f, maxBytes));
        }
        File c = crashFile();
        if (c != null && c.exists()) {
            sb.append("\n----- crash.log -----\n");
            sb.append(readTail(c, Math.max(4096, maxBytes / 2)));
        }
        return sb.toString();
    }

    private static String readTail(File f, int maxBytes) {
        FileInputStream in = null;
        try {
            long len = f.length();
            long skip = len > maxBytes ? len - maxBytes : 0L;
            in = new FileInputStream(f);
            if (skip > 0) in.getChannel().position(skip);
            BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString();
        } catch (Throwable t) {
            return "(读日志失败: " + t + ")\n";
        } finally {
            try {
                if (in != null) in.close();
            } catch (Throwable t) {
            }
        }
    }

    /** 上次是不是异常退出：最后一条 boot/exit 判断 + crash.log 是否还没上传过 */
    public static boolean crashPending() {
        if (dead) return false;
        File c = crashFile();
        if (c == null || !c.exists() || c.length() == 0L) return lastExitDirty();
        File sent = new File(dir, "crash.sent");
        return !sent.exists() || sent.lastModified() < c.lastModified();
    }

    /** 正常退出会写一条 [exit]；没有就是被系统杀掉或崩掉了 */
    private static boolean lastExitDirty() {
        String t = tail(2048);
        int i = t.lastIndexOf("] boot:");
        int j = t.lastIndexOf("] exit:");
        if (j >= 0 && j > i) return false;
        if (i < 0) return false;        /* 还没有 boot 行（刚装上第一次跑）不算 */
        return true;
    }

    public static void markCrashSent() {
        if (dead) return;
        synchronized (LOCK) {
            try {
                File sent = new File(dir, "crash.sent");
                FileWriter w = new FileWriter(sent, false);
                try {
                    w.write(STAMP.format(new Date()));
                    w.write('\n');
                } finally {
                    w.close();
                }
            } catch (Throwable t) {
            }
        }
    }

    public static void clear() {
        if (dead) return;
        synchronized (LOCK) {
            try {
                File[] fs = dir.listFiles();
                if (fs == null) return;
                for (int i = 0; i < fs.length; i++) {
                    String n = fs[i].getName();
                    if (n.endsWith(".log")) fs[i].delete();
                }
            } catch (Throwable t) {
            }
        }
    }

    /** 给面板桥用的 JSON 摘要（不转义内容，内容只走 tail 的纯文本通道） */
    public static String snapshotJson() {
        File f = logFile();
        long size = f != null && f.exists() ? f.length() : 0L;
        boolean crash = crashFile() != null && crashFile().exists()
                && crashFile().length() > 0L;
        return "{\"dir\":\"" + (dir == null ? "" : esc(dir.getAbsolutePath())) + "\""
                + ",\"size\":" + size
                + ",\"crashFile\":" + crash
                + ",\"pending\":" + (crashPending() ? "true" : "false")
                + "}";
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "/").replace("\"", "'");
    }
}
