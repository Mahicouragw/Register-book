package com.registerbook.community;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * UpdateStore — every file the updater touches, in one place.
 *
 * WHY THIS CLASS EXISTS
 * ---------------------
 * Storage hygiene is a *file layout* rule, so it must be impossible to break it
 * by writing a path in the wrong place. Nothing else in the app constructs an
 * update path; everything goes through here.
 *
 * The two update kinds live in two sibling directories under the app's private
 * cache, which Android may reclaim on its own if it ever needs the space:
 *
 *   cache/updates/update.apk            the pending APK        (Part 1)
 *   cache/updates/bundle/current/       the live web bundle   (Part 2)
 *   cache/updates/bundle/next/          a bundle being staged
 *   cache/updates/bundle/download.zip   the transfer in flight
 *
 * Nothing here is ever in the public Downloads folder, so the user's file
 * manager never shows it, and a downloaded APK cannot be read by other apps.
 *
 * ONE NAME, ALWAYS
 * ----------------
 * The APK is always {@code update.apk}. There is no numbering scheme, so a
 * second attempt overwrites the first instead of leaving
 * {@code update(1).apk}, {@code update(2).apk} behind. A transfer is written to
 * {@code update.apk.part} and only renamed on success, so a half-download can
 * never be mistaken for a complete one.
 */
final class UpdateStore {

    /** The single APK filename. Never derived from the network or the user. */
    static final String APK_NAME = "update.apk";

    private static final String ROOT = "updates";
    private static final String BUNDLE_DIR = "bundle";
    private static final String BUNDLE_CURRENT = "current";
    private static final String BUNDLE_NEXT = "next";
    private static final String BUNDLE_ZIP = "download.zip";

    private UpdateStore() {
    }

    // ------------------------------------------------------------------- apk

    static File updatesRoot(File cacheDir) {
        return new File(cacheDir, ROOT);
    }

    static File apkDir(File cacheDir) {
        // The required fixed location: cacheDir/updates/update.apk
        return updatesRoot(cacheDir);
    }

    /** The one and only place the pending APK lives. */
    static File apkFile(File cacheDir) {
        return new File(apkDir(cacheDir), APK_NAME);
    }

    /**
     * The staging file for an in-flight transfer.
     *
     * Kept distinct from {@link #apkFile} so a truncated download is never
     * offered to the installer, and so the cleanup sweep can delete it by
     * extension without touching the completed file.
     */
    static File apkPartFile(File cacheDir) {
        return new File(apkDir(cacheDir), APK_NAME + ".part");
    }

    static boolean ensureApkDir(File cacheDir) {
        File dir = apkDir(cacheDir);
        return dir.exists() || dir.mkdirs();
    }

    // ---------------------------------------------------------------- bundle

    static File bundleRoot(File cacheDir) {
        return new File(updatesRoot(cacheDir), BUNDLE_DIR);
    }

    /** The directory currently being served to the WebView. */
    static File bundleCurrent(File cacheDir) {
        return new File(bundleRoot(cacheDir), BUNDLE_CURRENT);
    }

    /** Where a verified download is unpacked before it is swapped in. */
    static File bundleNext(File cacheDir) {
        return new File(bundleRoot(cacheDir), BUNDLE_NEXT);
    }

    static File bundleZip(File cacheDir) {
        return new File(bundleRoot(cacheDir), BUNDLE_ZIP);
    }

    /** Where the sidecar metadata lives, e.g. {@code current/.bundle.json}. */
    static File bundleMeta(File cacheDir) {
        return new File(bundleCurrent(cacheDir), ".bundle.json");
    }

    // --------------------------------------------------------------- cleanup

    /**
     * Deletes every APK artifact under cache/updates.
     *
     * Called at app start, after a successful install, and whenever the
     * installer is cancelled. It is deliberately blunt: *any* file whose name
     * ends in .apk or .apk.part goes, including files an older version of this
     * plugin left in cache/apk/.
     *
     * @return how many files were removed, and how many bytes were reclaimed
     */
    static CleanupResult deleteAllApks(File cacheDir) {
        List<File> roots = new ArrayList<>(Arrays.asList(
                apkDir(cacheDir),
                // Where the previous release of this plugin downloaded to.
                new File(cacheDir, "apk")
        ));

        int files = 0;
        long bytes = 0;
        for (File root : roots) {
            if (root == null || !root.exists()) continue;
            File[] children = root.listFiles();
            if (children == null) continue;
            for (File child : children) {
                if (!child.isFile()) continue;
                String name = child.getName().toLowerCase();
                if (!name.endsWith(".apk") && !name.endsWith(".apk.part")) continue;
                long size = child.length();
                if (child.delete()) {
                    files++;
                    bytes += size;
                }
            }
        }
        return new CleanupResult(files, bytes);
    }

    /** Deletes the in-flight bundle zip and any half-unpacked staging tree. */
    static void deleteBundleScratch(File cacheDir) {
        deleteQuietly(bundleZip(cacheDir));
        deleteTree(bundleNext(cacheDir));
    }

    /**
     * Removes the cached bundle entirely, restoring the assets baked into the
     * APK. Used by "reset the app content" and by the crash-loop escape hatch.
     */
    static void deleteBundle(File cacheDir) {
        deleteQuietly(bundleZip(cacheDir));
        deleteTree(bundleNext(cacheDir));
        deleteTree(bundleCurrent(cacheDir));
    }

    /** Total bytes currently held by everything this subsystem wrote. */
    static long totalBytes(File cacheDir) {
        return sizeOf(updatesRoot(cacheDir));
    }

    static long sizeOf(File file) {
        if (file == null || !file.exists()) return 0;
        if (file.isFile()) return file.length();
        File[] children = file.listFiles();
        if (children == null) return 0;
        long total = 0;
        for (File child : children) total += sizeOf(child);
        return total;
    }

    static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    // ------------------------------------------------------------- zip / swap

    /**
     * Unpacks a verified bundle zip into {@code dest}, refusing anything that
     * would escape it.
     *
     * A zip entry can be named {@code ../../shared_prefs/x.xml}; writing that
     * naively would let a malicious bundle overwrite app-private files. So each
     * entry is canonicalised and must stay inside {@code dest}. Symlinks,
     * absolute paths and nested roots are rejected outright.
     *
     * @return the number of files written
     */
    static int unzip(File zip, File dest) throws IOException {
        String destBase = dest.getCanonicalPath();
        int written = 0;

        try (ZipInputStream in = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry entry;
            byte[] buffer = new byte[32 * 1024];
            while ((entry = in.getNextEntry()) != null) {
                String name = entry.getName();

                if (name.contains("..") || name.startsWith("/") || name.startsWith("\\")) {
                    throw new IOException("Unsafe path in the bundle: " + name);
                }
                File out = new File(dest, name);
                String canonical = out.getCanonicalPath();
                if (!canonical.equals(destBase) && !canonical.startsWith(destBase + File.separator)) {
                    throw new IOException("The bundle tries to write outside its folder: " + name);
                }

                if (entry.isDirectory()) {
                    if (!out.exists() && !out.mkdirs()) {
                        throw new IOException("Could not create " + name);
                    }
                    continue;
                }

                File parent = out.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new IOException("Could not create the folder for " + name);
                }

                try (OutputStream os = new FileOutputStream(out)) {
                    int read;
                    while ((read = in.read(buffer)) != -1) os.write(buffer, 0, read);
                }
                written++;
            }
        }
        return written;
    }

    /** Recursively moves {@code from} onto {@code to}, replacing what is there. */
    static void moveTree(File from, File to) throws IOException {
        if (to.exists()) deleteTree(to);
        File parent = to.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Could not create " + parent.getAbsolutePath());
        }

        // Same-volume rename is atomic and instant; fall back to a copy only if
        // the platform refuses it.
        if (from.renameTo(to)) return;

        if (!from.isDirectory()) {
            copyFile(from, to);
            return;
        }
        File[] children = from.listFiles();
        if (!to.exists() && !to.mkdirs()) throw new IOException("Could not create " + to.getAbsolutePath());
        if (children != null) {
            for (File child : children) moveTree(child, new File(to, child.getName()));
        }
    }

    private static void copyFile(File from, File to) throws IOException {
        try (InputStream in = new FileInputStream(from);
             OutputStream out = new FileOutputStream(to)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
    }

    /**
     * Writes text to a file in one step, replacing whatever was there.
     *
     * Used for the bundle metadata sidecar. Written through a temp file and
     * renamed so a crash mid-write cannot leave half a JSON object, which would
     * make the next launch think the bundle was corrupt.
     */
    static void writeTextAtomically(File target, String text) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Could not create " + parent.getAbsolutePath());
        }
        File temp = new File(target.getAbsolutePath() + ".tmp");
        try (RandomAccessFile raf = new RandomAccessFile(temp, "rw")) {
            raf.setLength(0);
            raf.write(text.getBytes("UTF-8"));
            raf.getFD().sync();
        }
        if (target.exists()) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
        }
        if (!temp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw new IOException("Could not save " + target.getName());
        }
    }

    // ---------------------------------------------------------------- results

    /** How much junk the sweep removed, so the UI can say so honestly. */
    static final class CleanupResult {
        final int files;
        final long bytes;

        CleanupResult(int files, long bytes) {
            this.files = files;
            this.bytes = bytes;
        }
    }
}
