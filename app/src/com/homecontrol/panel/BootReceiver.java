package com.homecontrol.panel;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Starts the panel automatically after the tablet boots (wall panel must come up by itself). */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "HomePanel";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        Log.i(TAG, "boot receiver: " + action);
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            try {
                Intent i = new Intent(context, MainActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                context.startActivity(i);
            } catch (Throwable t) {
                Log.w(TAG, "cannot start panel on boot: " + t.getMessage());
            }
        }
    }
}
