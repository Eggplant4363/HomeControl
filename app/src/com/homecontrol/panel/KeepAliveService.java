// KeepAliveService: 前台服务，让面板进程不被系统回收。
//
// 平板2（MI PAD 2, Android 5.1 / MIUI）的日志显示：进程既没有崩溃也没有自己退出
// （没有 [exit] 行、没有 Java 崩溃、内存不高），而是被系统在后台直接杀掉——
// 表现为「老是自动退出」。Android 5.1 上后台应用会被省电策略回收；
// startForeground 把进程提为前台，系统不会杀它。
package com.homecontrol.panel;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

public class KeepAliveService extends Service {
    private static final String TAG = "HomePanel";
    private static final int NOTIF_ID = 4101;
    private static final String CHANNEL = "keepalive";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "中控屏保活",
                    NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification n;
        if (Build.VERSION.SDK_INT >= 26) {
            n = new Notification.Builder(this, CHANNEL)
                    .setContentTitle("中控屏运行中")
                    .setContentText("保持面板常驻，防止系统回收（请勿手动划掉）")
                    .setSmallIcon(android.R.drawable.ic_menu_info_details)
                    .build();
        } else {
            n = new Notification.Builder(this)
                    .setContentTitle("中控屏运行中")
                    .setContentText("保持面板常驻，防止系统回收（请勿手动划掉）")
                    .setSmallIcon(android.R.drawable.ic_menu_info_details)
                    .build();
        }
        n.flags |= Notification.FLAG_NO_CLEAR;
        try {
            startForeground(NOTIF_ID, n);
            Log.i(TAG, "keep-alive foreground service started");
        } catch (Throwable t) {
            Log.w(TAG, "keep-alive startForeground failed: " + t.getMessage());
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "keep-alive service stopped");
        super.onDestroy();
    }
}
