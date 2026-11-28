package com.registerbook.community;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.ProcessedRoute;
import com.getcapacitor.RouteProcessor;

import java.io.File;

/**
 * AssetRouter — decides, for every asset the WebView loads, whether it comes
 * from the APK or from a downloaded bundle.
 *
 * HOW CAPACITOR LETS US DO THIS
 * -----------------------------
 * Capacitor serves the app through a virtual https:// server: it intercepts
 * every request in {@code BridgeWebViewClient.shouldInterceptRequest} and, if a
 * {@link RouteProcessor} was supplied to the Bridge, asks it to map the request
 * path onto a real file ("routed file"). Returning the path of a file inside our
 * cache, with {@code isAsset=false}, makes Capacitor read that file instead of
 * the one inside the APK.
 *
 * That is the whole mechanism behind a content update: same URL, different bytes.
 * No server to run, no manifest to rewrite, and if a file is absent from the
 * bundle the request falls through to the APK's own copy — so a partial bundle
 * degrades to the shipped app instead of a blank screen.
 *
 * SAFETY RAILS
 * ------------
 *  * A bundle is only used if its metadata sidecar says it was fully installed.
 *  * {@code index.html} must exist, or the bundle is ignored entirely.
 *  * A startup counter: if the app fails to report a successful start after
 *    using a bundle, the next launch discards it. That is the way out of a bad
 *    release without asking the user to uninstall anything.
 *  * Everything is re-checked in {@link #refresh}; a bundle installed while the
 *    app is running is picked up on the next launch, never mid-session (a
 *    half-swapped bundle produces a half-old, half-new UI).
 */
final class AssetRouter implements RouteProcessor {

    private static final String TAG = "RB-AssetRouter";

    /** Prefs holding the boot watchdog state. */
    private static final String PREFS = "rb_update_guard";
    private static final String KEY_PENDING_BOOT = "pendingBundleBoot";
    private static final String KEY_BOOT_ATTEMPTS = "bundleBootAttempts";

    /** How many launches a new bundle gets to prove it can start. */
    private static final int MAX_BOOT_ATTEMPTS = 2;

    private final Context appContext;

    /** Cached so the hot path never touches the disk for the sidecar. */
    private volatile boolean active;
    private volatile String basePath;

    AssetRouter(Context context) {
        this.appContext = context.getApplicationContext();
        refresh();
    }

    /**
     * Re-reads the installed bundle. Called once at startup and after an
     * install; deliberately not on every request.
     */
    synchronized void refresh() {
        File current = UpdateStore.bundleCurrent(appContext.getCacheDir());
        boolean usable = BundleManager.isActive(appContext)
                && new File(current, "index.html").isFile();

        if (!usable) {
            if (active) Log.i(TAG, "No usable bundle; serving the APK assets");
            active = false;
            basePath = null;
            return;
        }
        basePath = current.getAbsolutePath();
        active = true;
        Log.i(TAG, "Serving the downloaded bundle from " + basePath);
    }

    boolean isServingBundle() {
        return active;
    }

    /** The directory being served, or null when the APK assets are in use. */
    String servingPath() {
        return active ? basePath : null;
    }

    /**
     * The hook Capacitor calls for every asset request.
     *
     * Returning {@code null} means "not mine": Capacitor then serves the file
     * from the APK exactly as it always did. That is the safe answer, so every
     * uncertain case returns null.
     */
    @Override
    public ProcessedRoute process(String base, String path) {
        if (!active) return null;

        File dir = basePath == null ? null : new File(basePath);
        if (dir == null) return null;

        String relative = BundleManager.sanitize(path);
        if (relative.isEmpty()) return null;

        // Containment: the resolved file must stay inside the bundle folder.
        try {
            File candidate = new File(dir, relative).getCanonicalFile();
            String root = dir.getCanonicalPath();
            if (!candidate.getPath().startsWith(root + File.separator)) return null;
            if (!candidate.isFile() || candidate.length() <= 0) return null;

            ProcessedRoute route = new ProcessedRoute();
            route.setPath(candidate.getAbsolutePath());
            // false => read this as a plain file, not as an asset inside the APK
            route.setAsset(false);
            route.setIgnoreAssetPath(true);
            return route;
        } catch (Exception e) {
            Log.w(TAG, "Could not resolve " + path + " from the bundle", e);
            return null;
        }
    }

    // ------------------------------------------------------------ boot guard

    /**
     * Called once the WebView has actually finished loading and the app has
     * reported itself healthy.
     *
     * If a bundle was in use for this launch, it is now proven good: promote it
     * and forget the attempt count.
     */
    void markHealthy() {
        try {
            SharedPreferences prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (prefs.getInt(KEY_BOOT_ATTEMPTS, 0) == 0) return;
            prefs.edit().putInt(KEY_BOOT_ATTEMPTS, 0).putString(KEY_PENDING_BOOT, "").apply();
            Log.i(TAG, "The bundle started cleanly; it is now the active content");
        } catch (Exception e) {
            Log.w(TAG, "Could not clear the boot guard", e);
        }
    }

    /**
     * Counts a launch that used a bundle, and throws the bundle away once it has
     * failed to start more times than {@link #MAX_BOOT_ATTEMPTS}.
     *
     * This runs BEFORE the WebView is created, so a discard takes effect on this
     * very launch: the user sees the APK's own copy instead of a white screen.
     */
    void recordBootAttempt() {
        if (!active) return;
        try {
            SharedPreferences prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            int attempts = prefs.getInt(KEY_BOOT_ATTEMPTS, 0) + 1;
            if (attempts > MAX_BOOT_ATTEMPTS) {
                Log.w(TAG, "The bundle failed to start " + MAX_BOOT_ATTEMPTS + " times; discarding it");
                BundleManager.reset(appContext);
                prefs.edit().putInt(KEY_BOOT_ATTEMPTS, 0).putString(KEY_PENDING_BOOT, "").apply();
                refresh();
                return;
            }
            prefs.edit()
                    .putInt(KEY_BOOT_ATTEMPTS, attempts)
                    .putString(KEY_PENDING_BOOT, basePath == null ? "" : basePath)
                    .apply();
        } catch (Exception e) {
            Log.w(TAG, "Could not update the boot guard", e);
        }
    }
}
