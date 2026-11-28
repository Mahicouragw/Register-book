package com.registerbook.community;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * ApkUpdater — the native half of self-update.
 *
 * THREE JOBS
 * ----------
 *   1. APK updates (Part 1). Download to one fixed file in the app's private
 *      cache, hand it to the installer, then delete it. The user never sees a
 *      file, never picks a folder, and is never left with a stray APK.
 *   2. Content (OTA) updates (Part 2). Fetch a web bundle and swap it in, so a
 *      fix to the site does not need a new APK. See {@link BundleManager}.
 *   3. Storage hygiene. {@link UpdateStore#deleteAllApks} runs at startup and
 *      after every install attempt, so nothing accumulates.
 *
 * WHY THE APK IS DELETED SOON — AND THE ONE HONEST LIMITATION
 * -----------------------------------------------------------
 * An APK cannot delete itself *while* the installer is using it: on Android the
 * installer opens the file through our content:// URI and reads it throughout
 * the session. Deleting it then would fail the install.
 *
 * So the file survives exactly until the next moment we can act:
 *
 *   * the installer returns without upgrading (cancelled, or the user just
 *     pressed Back)  -> deleted immediately, in the activity-result callback
 *   * the app is opened again, now running a newer versionCode -> deleted at
 *     startup by MainActivity, which is step 1 of every launch
 *   * the download is interrupted -> the .part file is deleted in a finally
 *
 * In practice the file lives for one process lifetime and is gone at the next
 * launch, which is what "0 MB wasted" means here.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    private static final String TAG = "RB-Updater";

    /** GitHub redirects a few times; 10 is plenty and stops any redirect loop. */
    private static final int MAX_REDIRECTS = 10;
    private static final int CONNECT_TIMEOUT_MS = 20000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final int BUFFER_SIZE = 32 * 1024;
    private static final String APK_MIME = "application/vnd.android.package-archive";

    /** One download at a time — a second tap must not corrupt the first file. */
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloading = new AtomicBoolean(false);

    // ---------------------------------------------------------------- version

    /**
     * The version of the RUNNING app.
     *
     * The browser can read nothing at all about the native package, so this is
     * the only trustworthy source for "what is installed".
     */
    @PluginMethod
    public void getAppInfo(PluginCall call) {
        try {
            Context ctx = getContext();
            PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long code;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                code = info.getLongVersionCode();
            } else {
                //noinspection deprecation
                code = info.versionCode;
            }
            JSObject out = new JSObject();
            out.put("versionName", info.versionName == null ? "" : info.versionName);
            out.put("versionCode", code);
            out.put("packageName", ctx.getPackageName());
            out.put("canInstall", canInstall(ctx));
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not read the installed version: " + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------- install permission

    /**
     * "Can this app hand an APK to the installer right now?"
     *
     * Android 8.0 (API 26) added the per-app REQUEST_INSTALL_PACKAGES toggle.
     * Before that, installing from anywhere was allowed, so answer true and let
     * the installer decide.
     */
    @PluginMethod
    public void canInstallPackages(PluginCall call) {
        JSObject out = new JSObject();
        out.put("canInstall", canInstall(getContext()));
        out.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(out);
    }

    /**
     * Opens the system screen where the user flips "Allow from this source".
     *
     * We cannot grant this ourselves — by design it is a deliberate user action.
     * update.js re-checks on the App `resume` event when the user comes back.
     */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                JSObject out = new JSObject();
                out.put("opened", false);
                out.put("reason", "android-too-old");
                call.resolve(out);
                return;
            }
            Context ctx = getContext();
            Uri pkgUri = Uri.parse("package:" + ctx.getPackageName());
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, pkgUri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (intent.resolveActivity(ctx.getPackageManager()) != null) {
                ctx.startActivity(intent);
            } else {
                // Some OEM builds only expose the app-details page.
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(fallback);
            }
            JSObject out = new JSObject();
            out.put("opened", true);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not open the install settings screen: " + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------- Part 1: download

    /**
     * Downloads the APK to cache/updates/update.apk.
     *
     * Always exactly that one file: no name from the network, no counter, no
     * second copy. Progress is emitted as `apkDownloadProgress`
     * ({ received, total, percent }) so the WebView can draw a real bar.
     */
    @PluginMethod
    public void downloadApk(final PluginCall call) {
        final String url = call.getString("url", "");
        if (url == null || url.isEmpty()) {
            call.reject("No download URL was given.");
            return;
        }
        if (!url.startsWith("https://")) {
            // An APK over plain http could be swapped in transit; refuse.
            call.reject("The update link must start with https://");
            return;
        }
        if (!downloading.compareAndSet(false, true)) {
            call.reject("An update is already downloading.");
            return;
        }

        final Context ctx = getContext().getApplicationContext();
        final File cacheDir = ctx.getCacheDir();
        if (!UpdateStore.ensureApkDir(cacheDir)) {
            downloading.set(false);
            call.reject("Could not create the download folder on this phone.");
            return;
        }
        final File target = UpdateStore.apkFile(cacheDir);
        final File temp = UpdateStore.apkPartFile(cacheDir);

        pool.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                InputStream in = null;
                OutputStream out = null;
                // Completes only on success; anything else clears the .part file
                // so a retry starts from zero rather than from rubbish.
                boolean finished = false;
                try {
                    emitProgress(0, -1);

                    conn = openFollowingRedirects(url);
                    int status = conn.getResponseCode();
                    if (status != HttpURLConnection.HTTP_OK && status != HttpURLConnection.HTTP_PARTIAL) {
                        call.reject("The update server answered HTTP " + status + " instead of sending the file.");
                        return;
                    }
                    final long total = contentLength(conn);

                    if (temp.exists() && !temp.delete()) {
                        call.reject("Could not clear an old partial download.");
                        return;
                    }

                    in = conn.getInputStream();
                    out = new FileOutputStream(temp);

                    byte[] buffer = new byte[BUFFER_SIZE];
                    long received = 0;
                    long lastEmit = 0;
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        received += read;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit >= 120) {
                            emitProgress(received, total);
                            lastEmit = now;
                        }
                    }
                    out.flush();
                    out.close();
                    out = null;
                    in.close();
                    in = null;

                    if (received <= 0) {
                        //noinspection ResultOfMethodCallIgnored
                        temp.delete();
                        call.reject("The downloaded file was empty — the update link is probably wrong.");
                        return;
                    }
                    // Guard against a truncated transfer reaching the installer.
                    if (total > 0 && received != total) {
                        //noinspection ResultOfMethodCallIgnored
                        temp.delete();
                        call.reject("The download stopped early (" + received + " of " + total + " bytes). Please try again.");
                        return;
                    }

                    // Overwrite the single fixed name. There is no numbered copy
                    // to leave behind, so this is the only APK on disk.
                    if (target.exists() && !target.delete()) {
                        //noinspection ResultOfMethodCallIgnored
                        temp.delete();
                        call.reject("Could not replace the previous download.");
                        return;
                    }
                    if (!temp.renameTo(target)) {
                        //noinspection ResultOfMethodCallIgnored
                        temp.delete();
                        call.reject("Could not save the downloaded file.");
                        return;
                    }

                    emitProgress(received, received > 0 ? received : total);

                    JSObject result = new JSObject();
                    result.put("path", target.getAbsolutePath());
                    result.put("bytes", target.length());
                    result.put("fileName", target.getName());
                    finished = true;
                    call.resolve(result);
                } catch (Exception e) {
                    call.reject("The download failed: " + describe(e));
                } finally {
                    closeQuietly(in);
                    closeQuietly(out);
                    if (conn != null) conn.disconnect();
                    if (!finished) {
                        closeQuietly(out);
                        //noinspection ResultOfMethodCallIgnored
                        if (temp.exists()) temp.delete();
                    }
                    downloading.set(false);
                }
            }
        });
    }

    // ------------------------------------------------ Part 1: install + cleanup

    /**
     * Hands the downloaded APK to the system installer.
     *
     * The install is started with {@code startActivityForResult}, so when the
     * installer returns we know whether the user actually went through with it.
     * If they did not, the APK is deleted on the spot — that is the "cancelled
     * or failed" cleanup the storage rule requires.
     */
    @PluginMethod
    public void installApk(PluginCall call) {
        try {
            final Context ctx = getContext();
            String path = call.getString("path", "");
            File apk = (path == null || path.isEmpty())
                    ? UpdateStore.apkFile(ctx.getCacheDir())
                    : new File(path);

            if (!apk.exists() || apk.length() <= 0) {
                call.reject("The update file is not on this phone yet. Download it again.");
                return;
            }
            if (!canInstall(ctx)) {
                JSObject out = new JSObject();
                out.put("installed", false);
                out.put("needsPermission", true);
                call.resolve(out);
                return;
            }

            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME);
            // Required when launching from a non-Activity context.
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            // This is the flag that lets the INSTALLER process read our file.
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);

            if (intent.resolveActivity(ctx.getPackageManager()) == null) {
                deleteFile(apk.getAbsolutePath());
                JSObject out = new JSObject();
                out.put("installed", false);
                out.put("reason", "no-installer");
                out.put("cleanedUp", true);
                call.resolve(out);
                return;
            }

            // Remember which file we offered, so the result callback can delete
            // exactly that one without trusting a path from JavaScript.
            pendingApk = apk.getAbsolutePath();

            // Resolves only when the installer activity finishes, which is why
            // this method does not call resolve() here. See onInstallResult.
            startActivityForResult(call, intent, "onInstallResult");
        } catch (Exception e) {
            // If the installer could not be launched, no consumer is reading
            // the APK, so remove it immediately instead of leaving cache bloat.
            UpdateStore.deleteAllApks(getContext().getCacheDir());
            call.reject("Could not open the installer: " + describe(e), e);
        }
    }

    /** The APK currently offered to the installer, if any. */
    private volatile String pendingApk;

    /**
     * The installer came back.
     *
     * {@code RESULT_OK} means the package was installed (the process is normally
     * killed and restarted by then, so this branch is a formality). Anything
     * else — cancelled, failed, Back pressed — means the update did not happen,
     * so the APK is useless and goes now.
     */
    @ActivityCallback
    private void onInstallResult(PluginCall call, ActivityResult result) {
        String path = pendingApk;
        pendingApk = null;

        boolean ok = result != null && result.getResultCode() == Activity.RESULT_OK;
        if (ok) {
            // The new APK has replaced ours; nothing here can be read any more.
            UpdateStore.deleteAllApks(getContext().getCacheDir());
        } else {
            // Cancelled or failed. Delete immediately rather than waiting for
            // the next launch, so a user who changed their mind is not left
            // with a 4.7 MB file they never asked to keep.
            deleteFile(path);
        }

        if (call != null) {
            JSObject out = new JSObject();
            out.put("installed", ok);
            out.put("cancelled", !ok);
            out.put("cleanedUp", true);
            call.resolve(out);
        }
    }

    /**
     * Deletes cached APKs. Called by JavaScript after an install succeeds, after
     * the installed version is seen to be at least the downloaded one, and when
     * the panel is dismissed.
     *
     * Startup already does this; exposing it lets the UI keep the promise the
     * moment the condition is met instead of at the next launch.
     */
    @PluginMethod
    public void cleanup(PluginCall call) {
        try {
            UpdateStore.CleanupResult result = UpdateStore.deleteAllApks(getContext().getCacheDir());
            JSObject out = new JSObject();
            out.put("files", result.files);
            out.put("bytes", result.bytes);
            // Everything this subsystem holds, apk and bundle scratch included.
            out.put("totalBytes", UpdateStore.totalBytes(getContext().getCacheDir()));
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not clear the update files: " + describe(e), e);
        }
    }

    /** How much space the updater is responsible for right now. */
    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        try {
            File cacheDir = getContext().getCacheDir();
            JSObject out = new JSObject();
            File apk = UpdateStore.apkFile(cacheDir);
            out.put("apkBytes", apk.exists() ? apk.length() : 0);
            out.put("apkExists", apk.exists());
            out.put("totalBytes", UpdateStore.totalBytes(cacheDir));
            out.put("clean", !apk.exists());
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not read the update storage: " + describe(e), e);
        }
    }

    // ------------------------------------------------------ Part 2: bundle OTA

    /** What content version is on this phone, for the JS layer to compare. */
    @PluginMethod
    public void getBundleInfo(PluginCall call) {
        try {
            call.resolve(BundleManager.currentState(getContext()).toJson());
        } catch (Exception e) {
            call.reject("Could not read the content version: " + describe(e), e);
        }
    }

    /**
     * Downloads and activates a content bundle.
     *
     * Emits `bundleDownloadProgress` while transferring. On success the new
     * files are live from the next launch, which the JS layer states plainly —
     * swapping mid-session would leave half the screen on the old code.
     */
    @PluginMethod
    public void updateBundle(final PluginCall call) {
        final String url = call.getString("url", "");
        final Integer version = call.getInt("version", 0);
        String hash = call.getString("sha256", "");

        if (url == null || url.isEmpty()) {
            call.reject("No bundle URL was given.");
            return;
        }
        if (version == null || version <= 0) {
            call.reject("No bundle version was given.");
            return;
        }
        if (!downloading.compareAndSet(false, true)) {
            call.reject("An update is already downloading.");
            return;
        }

        final Context ctx = getContext().getApplicationContext();
        final String expectedHash = hash == null ? "" : hash.trim();

        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    File zip = BundleManager.download(url, ctx.getCacheDir(),
                            new BundleManager.Progress() {
                                @Override
                                public void onProgress(long received, long total, int percent) {
                                    JSObject p = new JSObject();
                                    p.put("received", received);
                                    p.put("total", total);
                                    p.put("percent", percent);
                                    notifyListeners("bundleDownloadProgress", p);
                                }
                            });

                    BundleManager.State state = BundleManager.install(ctx, zip, version, expectedHash);

                    // The zip has served its purpose; keeping it would double
                    // the space a bundle costs.
                    //noinspection ResultOfMethodCallIgnored
                    UpdateStore.bundleZip(ctx.getCacheDir()).delete();

                    JSObject out = state.toJson();
                    out.put("pendingRestart", true);
                    call.resolve(out);
                } catch (BundleManager.Failure f) {
                    UpdateStore.deleteBundleScratch(ctx.getCacheDir());
                    call.reject(f.getMessage());
                } catch (Exception e) {
                    UpdateStore.deleteBundleScratch(ctx.getCacheDir());
                    call.reject("The content update failed: " + describe(e));
                } finally {
                    downloading.set(false);
                }
            }
        });
    }

    /**
     * Throws away the downloaded bundle and goes back to the files inside the
     * APK. The escape hatch, and what "reset app content" means.
     */
    @PluginMethod
    public void resetBundle(PluginCall call) {
        try {
            BundleManager.reset(getContext());
            JSObject out = new JSObject();
            out.put("active", false);
            out.put("restartRequired", true);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not reset the content: " + describe(e), e);
        }
    }

    // ------------------------------------------------------------------ helpers

    private static boolean canInstall(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        try {
            return ctx.getPackageManager().canRequestPackageInstalls();
        } catch (Exception e) {
            return false;
        }
    }

    private void deleteFile(String path) {
        if (path == null || path.isEmpty()) return;
        try {
            File file = new File(path);
            if (file.exists() && file.delete()) {
                Log.i(TAG, "Deleted the unused update file");
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not delete " + path, e);
        }
    }

    /**
     * Opens the URL and follows redirects by hand.
     *
     * HttpURLConnection does not follow 302 across protocols (GitHub sends the
     * APK from objects.githubusercontent.com, a different host), and following
     * manually keeps control of timeouts and the User-Agent.
     */
    private HttpURLConnection openFollowingRedirects(String url) throws IOException {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            URL parsed = new URL(current);
            HttpURLConnection conn = (HttpURLConnection) parsed.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            // GitHub Releases reject requests with no User-Agent.
            conn.setRequestProperty("User-Agent", "RegisterBook-Updater");
            conn.setRequestProperty("Accept", "application/octet-stream");

            int status = conn.getResponseCode();
            boolean isRedirect =
                status == HttpURLConnection.HTTP_MOVED_PERM ||   // 301
                status == HttpURLConnection.HTTP_MOVED_TEMP ||   // 302
                status == HttpURLConnection.HTTP_SEE_OTHER ||    // 303
                status == 307 || status == 308;                  // TEMP/PERM REDIRECT

            if (!isRedirect) return conn;

            String location = conn.getHeaderField("Location");
            conn.disconnect();
            if (location == null || location.isEmpty()) {
                throw new IOException("The update server redirected without saying where.");
            }
            // A relative Location header is legal — resolve it against the URL.
            current = new URL(parsed, location).toString();
        }
        throw new IOException("Too many redirects — the update link looks wrong.");
    }

    private static long contentLength(HttpURLConnection conn) {
        String value = conn.getHeaderField("Content-Length");
        if (value == null) return -1;
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private void emitProgress(long received, long total) {
        JSObject progress = new JSObject();
        progress.put("received", received);
        progress.put("total", total);
        int percent = -1;
        if (total > 0) {
            percent = (int) Math.min(100, (received * 100) / total);
        }
        progress.put("percent", percent);
        notifyListeners("apkDownloadProgress", progress);
    }

    private static String describe(Exception e) {
        String message = e.getMessage();
        return (message == null || message.isEmpty()) ? e.getClass().getSimpleName() : message;
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            pool.shutdownNow();
        } catch (Exception ignored) {
        }
        super.handleOnDestroy();
    }
}
