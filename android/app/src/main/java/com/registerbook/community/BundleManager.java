package com.registerbook.community;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.zip.ZipFile;

/**
 * BundleManager — Part 2 of the updater: content updates without a new APK.
 *
 * WHAT PROBLEM THIS SOLVES
 * ------------------------
 * The APK is a Capacitor app: the WebView serves the site from the assets packed
 * into the APK, so in the shipped APK the JavaScript and HTML are *frozen* at
 * build time. Fixing a typo in `app.js` therefore used to need a whole new APK,
 * a 4.7 MB download and an installer prompt — for a change that weighs a few
 * kilobytes. That is the pain the owner described.
 *
 * A bundle is a zip of the same web files, published next to the APK and
 * verified against a sha256 in version.json. When it downloads, it is unpacked
 * into a staging directory, checked, and swapped in with a rename. From the next
 * launch, {@link AssetRouter} serves those files instead of the APK's assets.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It cannot change native behaviour. Permissions, plugins, the notification
 * channel, the installer flow: all of that is APK-only, which is why the two
 * paths are kept separate and version.json says which is needed.
 *
 * A bundle is only ever adopted after it passes every check below. A failed or
 * interrupted update leaves the current bundle untouched, and there is always a
 * way back to the assets inside the APK.
 */
final class BundleManager {

    private static final String TAG = "RB-Bundle";

    /** The file inside a bundle that describes it. */
    static final String MANIFEST_NAME = "rb-bundle.json";

    /** Sidecar written next to the active bundle, so startup needs no unzip. */
    private static final String META_NAME = ".bundle.json";

    private BundleManager() {
    }

    // ------------------------------------------------------------------ state

    /** What is currently installed, for the plugin to report to JavaScript. */
    static final class State {
        int version;
        String hash = "";
        int files;
        long bytes;
        String installedAt = "";

        boolean isActive() {
            return version > 0;
        }

        JSONObject toJson() throws Exception {
            JSONObject out = new JSONObject();
            out.put("active", isActive());
            out.put("version", version);
            out.put("hash", hash);
            out.put("files", files);
            out.put("bytes", bytes);
            out.put("installedAt", installedAt);
            return out;
        }
    }

    /**
     * Reads the sidecar of the active bundle.
     *
     * Never throws: a corrupt or missing sidecar simply means "no bundle", and
     * the app runs from the APK's own assets, which is always correct.
     */
    static State currentState(Context context) {
        // Recover the old complete bundle if the process died in the tiny
        // directory-rename window while installing a replacement.
        File current = UpdateStore.bundleCurrent(context.getCacheDir());
        File previous = new File(UpdateStore.bundleRoot(context.getCacheDir()), "previous");
        if (!current.exists() && previous.exists()) previous.renameTo(current);
        else if (current.exists() && previous.exists()) UpdateStore.deleteTree(previous);

        State state = new State();
        File meta = metaFile(context);
        if (!meta.exists()) return state;

        try {
            String text = readText(meta);
            JSONObject json = new JSONObject(text);
            state.version = json.optInt("version", 0);
            state.hash = json.optString("hash", "");
            state.files = json.optInt("files", 0);
            state.bytes = json.optLong("bytes", 0);
            state.installedAt = json.optString("installedAt", "");
        } catch (Exception e) {
            Log.w(TAG, "The bundle metadata is unreadable; falling back to the APK assets", e);
            return new State();
        }

        // The sidecar may outlive the files it describes (a failed delete, a
        // user clearing app storage mid-flight). Only trust it if the tree it
        // points at is actually there.
        if (state.version > 0) {
            File index = new File(UpdateStore.bundleCurrent(context.getCacheDir()), "index.html");
            if (!index.exists() || index.length() <= 0) {
                Log.w(TAG, "Bundle metadata exists but index.html is missing; ignoring it");
                return new State();
            }
        }
        return state;
    }

    /** True when a cached bundle should be served instead of the APK assets. */
    static boolean isActive(Context context) {
        return currentState(context).isActive();
    }

    /**
     * Absolute path for a request path, if the active bundle has that file.
     *
     * This is the hot path: every resource the WebView loads calls it, on a
     * background thread. It does one stat() and returns; it never unzips and
     * never parses JSON, because the sidecar is cached in memory by the caller.
     */
    static File resolve(Context context, String requestPath) {
        String clean = sanitize(requestPath);
        if (clean.isEmpty()) return null;

        File root = UpdateStore.bundleCurrent(context.getCacheDir());
        if (!root.isDirectory()) return null;

        // Resolve against the canonical root and require containment, so a
        // crafted path can never read outside the bundle (e.g. ../shared_prefs).
        try {
            File candidate = new File(root, clean).getCanonicalFile();
            String base = root.getCanonicalPath();
            if (!candidate.getPath().startsWith(base + File.separator)) return null;
            return candidate.isFile() ? candidate : null;
        } catch (IOException e) {
            return null;
        }
    }

    // -------------------------------------------------------------- activate

    /** Result of a failed update, with enough detail to show the user. */
    static final class Failure extends Exception {
        Failure(String message) {
            super(message);
        }
    }

    /**
     * Verifies and installs a downloaded bundle.
     *
     * Order matters and each step is a guard:
     *
     *   1. the zip opens at all (a truncated transfer is not a zip)
     *   2. its manifest parses and declares the same version we were promised
     *   3. every file it claims is present, and the whole tree hashes to the
     *      sha256 published in version.json
     *   4. only then is the staging tree swapped in
     *
     * Anything failing before step 4 leaves the running bundle untouched, so a
     * bad release can never brick the app.
     *
     * @param zip        the downloaded archive
     * @param version    the bundle_version we expect
     * @param sha256hex  the expected hash from version.json, or "" to skip
     */
    static State install(Context context, File zip, int version, String sha256hex) throws Exception {
        if (zip == null || !zip.isFile() || zip.length() == 0) {
            throw new Failure("The downloaded bundle is empty.");
        }

        File cacheDir = context.getCacheDir();
        File next = UpdateStore.bundleNext(cacheDir);

        // A previous attempt may have died mid-unpack.
        UpdateStore.deleteTree(next);

        JSONObject manifest;
        try (ZipFile zf = new ZipFile(zip)) {
            if (zf.getEntry(MANIFEST_NAME) == null) {
                throw new Failure("That file is not a RegisterBook bundle (" + MANIFEST_NAME + " is missing).");
            }
            manifest = new JSONObject(readEntry(zf, MANIFEST_NAME));
        } catch (Failure f) {
            throw f;
        } catch (Exception e) {
            throw new Failure("The bundle could not be opened: " + e.getMessage());
        }

        int declared = manifest.optInt("bundle_version", 0);
        if (declared != version) {
            throw new Failure("The bundle says version " + declared + " but " + version + " was advertised. Try again later.");
        }

        List<String> files = readFileList(manifest);
        if (files.isEmpty()) {
            throw new Failure("The bundle lists no files.");
        }
        if (!files.contains("index.html")) {
            throw new Failure("The bundle has no index.html, so it could not start the app.");
        }

        // ---- unpack, then verify what actually landed ----------------------
        int written;
        try {
            written = UpdateStore.unzip(zip, next);
        } catch (Exception e) {
            UpdateStore.deleteTree(next);
            throw new Failure("The bundle could not be unpacked: " + e.getMessage());
        }

        for (String name : files) {
            File f = new File(next, name);
            if (!f.isFile()) {
                UpdateStore.deleteTree(next);
                throw new Failure("The bundle is missing " + name + ".");
            }
        }

        if (sha256hex != null && sha256hex.length() > 0) {
            String actual = hashFiles(next, files);
            if (!actual.equalsIgnoreCase(sha256hex)) {
                UpdateStore.deleteTree(next);
                throw new Failure("The bundle did not match its checksum, so it was discarded. Nothing was changed.");
            }
        }

        // Do NOT change `current` while the app is running. The router serves
        // that exact directory for the lifetime of this WebView; changing it
        // now would mix old and new assets in one session. Store the verified
        // complete tree + sidecar in `next`; MainActivity activates it before
        // the WebView is created on the next launch.
        State state = new State();
        state.version = version;
        state.hash = sha256hex == null ? "" : sha256hex;
        state.files = written;
        state.bytes = UpdateStore.sizeOf(next);
        state.installedAt = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
                .format(new java.util.Date());
        try {
            UpdateStore.writeTextAtomically(new File(next, META_NAME), state.toJson().toString());
        } catch (IOException e) {
            UpdateStore.deleteTree(next);
            throw new Failure("The bundle could not be recorded: " + e.getMessage());
        }

        Log.i(TAG, "Verified bundle v" + version + " and queued it for the next launch");
        return state;
    }

    /**
     * Activates a fully verified staged bundle. Called before Bridge/WebView
     * creation on cold start, never from the running updater. The same-volume
     * directory renames keep the old complete content available for rollback if
     * activation fails or the process is killed in the middle.
     */
    static void activatePending(Context context) {
        File cacheDir = context.getCacheDir();
        File next = UpdateStore.bundleNext(cacheDir);
        File nextIndex = new File(next, "index.html");
        File nextMeta = new File(next, META_NAME);
        if (!nextIndex.isFile() || !nextMeta.isFile()) {
            // This is an interrupted download/unpack, not a committed update.
            UpdateStore.deleteTree(next);
            return;
        }

        File current = UpdateStore.bundleCurrent(cacheDir);
        File previous = new File(UpdateStore.bundleRoot(cacheDir), "previous");
        UpdateStore.deleteTree(previous);
        boolean hadCurrent = current.exists();
        try {
            if (hadCurrent && !current.renameTo(previous)) {
                throw new IOException("Could not stage the existing bundle");
            }
            if (!next.renameTo(current)) {
                if (hadCurrent) previous.renameTo(current);
                throw new IOException("Could not activate the verified bundle");
            }
            UpdateStore.deleteTree(previous);
            Log.i(TAG, "Activated the staged content bundle before WebView startup");
        } catch (Exception e) {
            if (!current.exists() && previous.exists()) previous.renameTo(current);
            Log.e(TAG, "Could not activate the staged bundle; keeping the previous content", e);
        }
    }

    /** Removes the cached bundle, restoring the APK's own assets. */
    static void reset(Context context) {
        UpdateStore.deleteBundle(context.getCacheDir());
        Log.i(TAG, "Cached bundle removed; the APK assets are in use again");
    }

    // -------------------------------------------------------------- internals

    private static File metaFile(Context context) {
        return new File(UpdateStore.bundleCurrent(context.getCacheDir()), META_NAME);
    }

    /**
     * Normalises a request path into a bundle-relative one.
     *
     * The WebView asks for things like "/app.js" or "/" — the first maps to a
     * file, the second to index.html. Query strings and fragments are already
     * stripped by the router.
     */
    static String sanitize(String requestPath) {
        String path = requestPath == null ? "" : requestPath;
        if (path.startsWith("/")) path = path.substring(1);
        if (path.isEmpty() || path.endsWith("/")) path = path + "index.html";
        // A decoded %2F can smuggle a separator past the browser's own check.
        path = path.replace('\\', '/');
        if (path.contains("..")) return "";
        return path;
    }

    private static List<String> readFileList(JSONObject manifest) {
        List<String> out = new ArrayList<>();
        JSONArray array = manifest.optJSONArray("files");
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            String name = array.optString(i, "");
            if (name.isEmpty() || name.contains("..") || name.startsWith("/")) continue;
            out.add(name);
        }
        return out;
    }

    /**
     * The hash published in version.json.
     *
     * It is computed over the files the manifest lists, in the order the
     * manifest lists them, as {@code name + "\0" + sha256(bytes) + "\n"}.
     * {@code tools/make-bundle.js} produces exactly this, and the test suite
     * checks a bundle built by the real tool against this implementation so the
     * two can never drift.
     */
    static String hashFiles(File root, List<String> files) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (String name : files) {
            File file = new File(root, name);
            String fileHash = sha256Hex(file);
            digest.update(name.getBytes("UTF-8"));
            digest.update((byte) 0);
            digest.update(fileHash.getBytes("UTF-8"));
            digest.update((byte) '\n');
        }
        return toHex(digest.digest());
    }

    static String sha256Hex(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return toHex(digest.digest());
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        return sb.toString();
    }

    private static String readEntry(ZipFile zf, String name) throws IOException {
        try (InputStream in = zf.getInputStream(zf.getEntry(name))) {
            return readAll(in);
        }
    }

    private static String readText(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            return readAll(in);
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8 * 1024];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        return out.toString("UTF-8");
    }

    // ------------------------------------------------------------------ fetch

    /**
     * Downloads a bundle to cache/updates/bundle/download.zip.
     *
     * Same redirect handling and streaming discipline as the APK download: the
     * file is written straight to disk, never buffered in memory, and a failed
     * transfer leaves nothing behind.
     */
    static File download(String url, File cacheDir, Progress progress) throws IOException {
        if (url == null || !url.startsWith("https://")) {
            throw new IOException("The bundle link must start with https://");
        }
        File zip = UpdateStore.bundleZip(cacheDir);
        File dir = zip.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs()) {
            throw new IOException("Could not create the bundle folder on this phone.");
        }
        File part = new File(zip.getAbsolutePath() + ".part");

        HttpURLConnection conn = null;
        InputStream in = null;
        OutputStream out = null;
        boolean ok = false;
        try {
            conn = openFollowingRedirects(url);
            int status = conn.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException("The bundle server answered HTTP " + status + ".");
            }
            long total = contentLength(conn);
            in = conn.getInputStream();
            out = new FileOutputStream(part);

            byte[] buffer = new byte[32 * 1024];
            long received = 0;
            int read;
            int lastPercent = -10;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                received += read;
                if (progress != null && total > 0) {
                    int percent = (int) Math.min(100, (received * 100) / total);
                    if (percent >= lastPercent + 5) {
                        lastPercent = percent;
                        progress.onProgress(received, total, percent);
                    }
                }
            }
            out.flush();
            out.close();
            out = null;

            if (received <= 0) throw new IOException("The downloaded bundle was empty.");
            if (total > 0 && received != total) {
                throw new IOException("The bundle download stopped early (" + received + " of " + total + " bytes).");
            }

            if (zip.exists()) {
                //noinspection ResultOfMethodCallIgnored
                zip.delete();
            }
            if (!part.renameTo(zip)) throw new IOException("Could not save the downloaded bundle.");
            ok = true;
            return zip;
        } finally {
            closeQuietly(in);
            closeQuietly(out);
            if (conn != null) conn.disconnect();
            if (!ok && part.exists()) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
            }
        }
    }

    interface Progress {
        void onProgress(long received, long total, int percent);
    }

    private static HttpURLConnection openFollowingRedirects(String url) throws IOException {
        String current = url;
        for (int hop = 0; hop <= 10; hop++) {
            URL parsed = new URL(current);
            HttpURLConnection conn = (HttpURLConnection) parsed.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(30000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", "RegisterBook-Updater");
            conn.setRequestProperty("Accept", "application/zip,application/octet-stream,*/*");

            int status = conn.getResponseCode();
            boolean redirect = status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
            if (!redirect) return conn;

            String location = conn.getHeaderField("Location");
            conn.disconnect();
            if (location == null || location.isEmpty()) {
                throw new IOException("The bundle server redirected without saying where.");
            }
            current = new URL(parsed, location).toString();
        }
        throw new IOException("Too many redirects — the bundle link looks wrong.");
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

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
        }
    }

    /** Debug helper: the manifest of the active bundle, or null. */
    static JSONObject activeManifest(Context context) {
        File current = UpdateStore.bundleCurrent(context.getCacheDir());
        File manifest = new File(current, MANIFEST_NAME);
        if (!manifest.isFile()) return null;
        try {
            return new JSONObject(readText(manifest));
        } catch (Exception e) {
            return null;
        }
    }

    /** Keys of a JSON object, for tolerant parsing of a manifest from the network. */
    static List<String> keysOf(JSONObject json) {
        List<String> out = new ArrayList<>();
        if (json == null) return out;
        Iterator<String> it = json.keys();
        while (it.hasNext()) out.add(it.next());
        return out;
    }
}
