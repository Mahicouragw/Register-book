package com.registerbook.community;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * ApkUpdater — the native half of the built-in self-update.
 *
 * The JavaScript side (update.js) decides *whether* an update exists and shows
 * the panel. This plugin does the three things only native code can do:
 *
 *   1. report the version that is actually installed (versionName/versionCode
 *      from the package manager, not from the web bundle)
 *   2. report/set "allow installing from this app" (Android 8.0+)
 *   3. download the .apk with progress and hand it to the Android package
 *      installer through a FileProvider content:// URI
 *
 * Why a FileProvider URI and not a file:// path:
 *   Since Android 7.0 (API 24) a file:// URI triggers
 *   FileUriExposedException. The installer must receive a content:// URI and
 *   the grant must be explicit (FLAG_GRANT_READ_URI_PERMISSION), otherwise the
 *   installer process cannot read our cache and the install silently fails.
 *
 * Why a plain HttpURLConnection instead of a library:
 *   The APK comes from GitHub Releases, which redirects (302) to a CDN. A
 *   manual redirect follow lets us carry the progress callback across hops and
 *   keeps the plugin dependency-free. We never buffer the whole file in memory.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

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
     * Note: the browser can read nothing at all about the native package, so
     * this is the only trustworthy source for "what is installed".
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
     * Before that, installing from anywhere was allowed, so we answer true and
     * let the installer decide.
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
     * We cannot grant this ourselves — by design it is a deliberate user
     * action. The app must therefore come back to the foreground and re-check;
     * update.js does that on the App `resume` event.
     */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                // Nothing to allow before Android 8.0.
                JSObject out = new JSObject();
                out.put("opened", false);
                out.put("reason", "android-too-old");
                call.resolve(out);
                return;
            }
            Context ctx = getContext();
            Uri pkgUri = Uri.parse("package:" + ctx.getPackageName());
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, pkgUri);
            // The settings screen lives in another app, so the flag is required.
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

    // ---------------------------------------------------------------- download

    /**
     * Downloads the APK to the app's own cache directory.
     *
     * Progress is emitted as `apkDownloadProgress` events:
     *   { received, total, percent }   total/percent are -1 when unknown
     * so the WebView can draw a real progress bar. Every byte comes from the
     * network here; nothing is buffered in memory.
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

        final String fileName = sanitizeFileName(call.getString("fileName", "RegisterBook-update.apk"));
        // Download into fileprovider root: getCacheDir()/apk, declared in file_paths.xml
        final File dir = new File(getContext().getCacheDir(), "apk");
        final boolean okDir = dir.exists() || dir.mkdirs();
        if (!okDir) {
            downloading.set(false);
            call.reject("Could not create the download folder on this phone.");
            return;
        }
        // Reuse one name so an interrupted attempt never fills the cache.
        final File target = new File(dir, fileName);
        final File temp = new File(dir, fileName + ".part");

        pool.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                InputStream in = null;
                FileOutputStream out = null;
                // Completes only on success. Anything else (including an early
                // reject) falls out of the try, and the finally block then
                // removes the half-written .part file so a retry starts clean.
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

                    // A partially downloaded file from an earlier run is useless.
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
                        // Emitting per chunk would flood the bridge on fast
                        // links; ~1% steps (or every 0.5%) is smooth and cheap.
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
                        temp.delete();
                        call.reject("The downloaded file was empty — the update link is probably wrong.");
                        return;
                    }
                    // Guard against a truncated transfer being handed to the
                    // installer: if the server told us the size, it must match.
                    if (total > 0 && received != total) {
                        temp.delete();
                        call.reject("The download stopped early (" + received + " of " + total + " bytes). Please try again.");
                        return;
                    }

                    if (target.exists() && !target.delete()) {
                        temp.delete();
                        call.reject("Could not replace the previous download.");
                        return;
                    }
                    if (!temp.renameTo(target)) {
                        temp.delete();
                        call.reject("Could not save the downloaded file.");
                        return;
                    }

                    emitProgress(received, received > 0 ? received : total);

                    JSObject out2 = new JSObject();
                    out2.put("path", target.getAbsolutePath());
                    out2.put("bytes", target.length());
                    out2.put("fileName", target.getName());
                    finished = true;
                    call.resolve(out2);
                } catch (Exception e) {
                    call.reject("The download failed: " + describe(e));
                } finally {
                    closeQuietly(in);
                    closeQuietly(out);
                    if (conn != null) conn.disconnect();
                    // A rejected/failed attempt must not leave rubbish behind.
                    if (!finished) {
                        closeQuietly(out);
                        if (temp.exists()) temp.delete();
                    }
                    downloading.set(false);
                }
            }
        });
    }

    // ----------------------------------------------------------------- install

    /**
     * Hands a downloaded APK to the system package installer.
     *
     * This is the step that replaced "open your browser and find the file":
     * the phone shows the installer sheet and the user only taps Update/Install.
     */
    @PluginMethod
    public void installApk(PluginCall call) {
        try {
            String path = call.getString("path", "");
            if (path == null || path.isEmpty()) {
                // Fall back to the file we just downloaded.
                path = new File(new File(getContext().getCacheDir(), "apk"), "RegisterBook-update.apk").getAbsolutePath();
            }
            File apk = new File(path);
            if (!apk.exists() || apk.length() <= 0) {
                call.reject("The update file is not on this phone yet. Download it again.");
                return;
            }
            if (!canInstall(getContext())) {
                // Do not throw a SecurityException at the user; tell the JS
                // layer so it can send them to the settings screen.
                JSObject out = new JSObject();
                out.put("installed", false);
                out.put("needsPermission", true);
                call.resolve(out);
                return;
            }

            Context ctx = getContext();
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME);
            // Without FLAG_ACTIVITY_NEW_TASK the intent would be launched from a
            // non-Activity context and Android would refuse it.
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            // This is the flag that lets the INSTALLER process read our file.
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // Some OEM installers only offer "share" without this one.
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);

            if (intent.resolveActivity(ctx.getPackageManager()) == null) {
                JSObject out = new JSObject();
                out.put("installed", false);
                out.put("reason", "no-installer");
                call.resolve(out);
                return;
            }

            ctx.startActivity(intent);

            JSObject out = new JSObject();
            out.put("installed", true);
            out.put("uri", uri.toString());
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not open the installer: " + describe(e), e);
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

    /**
     * Opens the URL and follows redirects by hand.
     *
     * HttpURLConnection does not follow 302 across protocols (GitHub sends the
     * APK from objects.githubusercontent.com, a different host), and by
     * following manually we keep control of timeouts and the User-Agent.
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

    private static String sanitizeFileName(String name) {
        String base = name == null ? "" : name;
        // Strip any directory part so the caller cannot escape the cache dir.
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^A-Za-z0-9._-]", "_");
        if (!base.toLowerCase().endsWith(".apk")) base = base + ".apk";
        if (base.isEmpty() || base.equals(".apk")) base = "RegisterBook-update.apk";
        return base;
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
