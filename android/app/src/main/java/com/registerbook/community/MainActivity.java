package com.registerbook.community;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * MainActivity — app startup, and the two things that can only be decided here:
 * the notification channel, and where the WebView's files come from.
 *
 * STARTUP ORDER MATTERS
 * ---------------------
 * {@code super.onCreate} creates the Bridge and the WebView, which immediately
 * begins loading index.html. Anything that decides *which* files it loads must
 * therefore happen before that call. So the order is:
 *
 *   1. sweep leftover APKs and half-downloaded bundles   (cleanup)
 *   2. count this launch against the bundle boot guard   (self-heal)
 *   3. hand the Bridge a RouteProcessor                  (APK assets or bundle)
 *   4. super.onCreate                                    (WebView starts)
 *   5. create the notification channel                   (needs no WebView)
 *
 * Step 1 is the "0 MB wasted" guarantee: it runs on every launch, before
 * anything else, so an APK left over from an interrupted install is gone before
 * the user can notice it.
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "RB-MainActivity";

    /**
     * The notification channel every RegisterBook push is posted on.
     *
     * This string must match, character for character:
     *   - android:value of com.google.firebase.messaging.default_notification_channel_id
     *     in AndroidManifest.xml
     *   - the default in supabase/functions/src/_shared/fcm.js (the server)
     *   - CHANNEL_ID in push.js
     *
     * If they drift apart, Android silently drops every notification that
     * arrives while the app is closed.
     */
    private static final String CHANNEL_ID = "registerbook_default";
    private static final String CHANNEL_NAME = "Messages and calls";

    /** Decides per request whether a file comes from the APK or a downloaded bundle. */
    private AssetRouter router;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the app's own plugins BEFORE the bridge is created, so the
        // JavaScript side can call Capacitor.Plugins.ApkUpdater immediately.
        registerPlugin(ApkUpdaterPlugin.class);

        // ---- 1. reclaim APK storage and activate queued OTA content --------
        sweepUpdateFiles();
        BundleManager.activatePending(this);
        // The committed bundle is now current. The transfer zip is never needed
        // after activation; keep only the active tree.
        //noinspection ResultOfMethodCallIgnored
        UpdateStore.bundleZip(getCacheDir()).delete();

        // ---- 2. decide which content to serve ------------------------------
        router = new AssetRouter(this);
        router.recordBootAttempt();
        bridgeBuilder.setRouteProcessor(router);

        // A bundle only counts as good once the page has actually finished
        // loading with it. This fires from BridgeWebViewClient at 100%, which
        // is the difference between "a WebView exists" and "the app started".
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                notifyContentHealthy();
            }
        });

        super.onCreate(savedInstanceState);

        // ---- 3. the notification channel (needs no WebView) ----------------
        createNotificationChannel();
    }

    /**
     * Deletes leftover update files from any previous run.
     *
     * Runs before the WebView exists, so it cannot be delayed by the page
     * loading and cannot race a download (downloads only start when the user
     * taps Update).
     *
     * What goes:
     *   - every .apk / .apk.part under cache/updates/apk and the old cache/apk
     * Bundle activation and its scratch cleanup run separately, after this APK
     * sweep and before the WebView is created.
     *
     * What stays: the ACTIVE bundle, which is the app's current content. It is
     * removed separately, by resetBundle or by the boot guard.
     */
    private void sweepUpdateFiles() {
        try {
            UpdateStore.CleanupResult apks = UpdateStore.deleteAllApks(getCacheDir());
            if (apks.files > 0) {
                Log.i(TAG, "Cleared " + apks.files + " leftover update file(s), "
                        + (apks.bytes / 1024) + " KB reclaimed");
            }
        } catch (Exception e) {
            // Never let housekeeping stop the app from starting.
            Log.w(TAG, "Could not clear the update cache", e);
        }
    }

    /**
     * Called once the page has loaded, so a bundle that got us here is proven
     * good and stops counting against the boot guard.
     */
    private void notifyContentHealthy() {
        if (router != null) router.markHealthy();
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
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);

        // Same default sound the web Push path uses.
        AudioAttributes audio = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build();
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), audio);

        nm.createNotificationChannel(channel);
    }
}
