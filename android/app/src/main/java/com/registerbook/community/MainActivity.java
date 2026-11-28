package com.registerbook.community;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * The notification channel every RegisterBook push is posted on.
     *
     * This string must match, character for character:
     *   - android:value of com.google.firebase.messaging.default_notification_channel_id
     *     in AndroidManifest.xml, and
     *   - the default in supabase/functions/src/_shared/fcm.js (the server).
     *
     * If the three ever drift apart, Android silently drops every notification
     * that arrives while the app is closed — the failure the owner reported.
     */
    private static final String CHANNEL_ID = "registerbook_default";
    private static final String CHANNEL_NAME = "Messages and calls";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        createNotificationChannel();
    }

    /**
     * Creates the channel up front, at app start, rather than waiting for the
     * first push.
     *
     * FCM can only display a notification on a channel that already exists, and
     * it does so before any of our code runs. Creating it here guarantees it is
     * there on the very first closed-app push instead of only after the user
     * has opened Settings once.
     *
     * Re-creating an existing channel is a no-op, EXCEPT that Android ignores
     * any attempt to raise importance after the user has lowered it. That is
     * deliberate platform behaviour and must not be worked around.
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(
                "Messages, friend requests, group invites and calls from RegisterBook.");
        channel.enableVibration(true);
        channel.enableLights(true);
        channel.setShowBadge(true);
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);

        // Same default sound the web Push path uses.
        AudioAttributes audio = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build();
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), audio);

        nm.createNotificationChannel(channel);
    }
}
