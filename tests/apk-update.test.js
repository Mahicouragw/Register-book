// Tests for the built-in APK self-update (update.js + the Android plugin).
//
// These run in Node with no Android device, so they cover the two things that
// actually break self-updaters:
//   1. the decision logic — is this really a newer version, is the manifest
//      valid, must the user be forced
//   2. the wiring — manifest permissions, FileProvider paths, the plugin being
//      registered, and the CI publishing version.json
//
// The one thing they cannot cover is the download/install itself, which needs
// a real device; the plugin is written so that every failure path resolves
// with a readable message instead of crashing.
//
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

const L = require(path.join(ROOT, "update.js"));

// --------------------------------------------------------------- versions

test("version strings are parsed the way Android numbers them", () => {
  assert.deepEqual(L.parseVersion("1.0.9"), { major: 1, minor: 0, patch: 9, raw: "1.0.9" });
  assert.deepEqual(L.parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, raw: "1.2.3" });
  assert.deepEqual(L.parseVersion(" 2.0 "), { major: 2, minor: 0, patch: 0, raw: "2.0" });
  assert.equal(L.parseVersion(""), null);
  assert.equal(L.parseVersion(null), null);
  assert.equal(L.parseVersion("banana"), null);
});

test("version comparison catches the 1.0.9 → 1.0.10 trap", () => {
  // A string compare would say 1.0.10 < 1.0.9 and never offer the update.
  assert.ok(L.compareVersions("1.0.10", "1.0.9") > 0);
  assert.ok(L.compareVersions("1.0.9", "1.0.10") < 0);
  assert.equal(L.compareVersions("1.0.9", "1.0.9"), 0);
  assert.ok(L.compareVersions("2.0", "1.9.9") > 0);
  // Unparsable input is never treated as newer.
  assert.equal(L.compareVersions("banana", "1.0.9"), 0);
});

test("only a genuinely newer build triggers the update", () => {
  const installed = { versionName: "1.0.8", versionCode: 8 };

  // the case that matters: the APK the owner already has must NOT nag
  assert.equal(L.isNewer({ versionName: "1.0.8", versionCode: 8 }, installed), false);
  assert.equal(L.isNewer({ versionName: "1.0.9", versionCode: 9 }, installed), true);
  assert.equal(L.isNewer({ versionName: "1.0.7", versionCode: 7 }, installed), false);

  // versionCode is the authority in BOTH directions: Android refuses to
  // install over an equal code ("App not installed"), so a renamed build with
  // the same code must never be offered.
  assert.equal(L.isNewer({ versionName: "9.9.9", versionCode: 8 }, installed), false);
  assert.equal(L.isNewer({ versionName: "1.0.9", versionCode: 8 }, installed), false);

  // The name is only used when a code is missing entirely.
  assert.equal(L.isNewer({ versionName: "1.0.9" }, { versionName: "1.0.8" }), true);
  assert.equal(L.isNewer({ versionName: "1.0.8" }, { versionName: "1.0.8" }), false);
  // ...and an unusable code (0/NaN/"") must not short-circuit the compare
  assert.equal(L.isNewer({ versionName: "1.0.9", versionCode: 0 }, installed), true);

  assert.equal(L.isNewer(null, installed), false);
  assert.equal(L.isNewer({ versionName: "1.0.9", versionCode: 9 }, null), false);
});

// --------------------------------------------------------------- manifests

test("a well-formed version.json is accepted", () => {
  const res = L.parseManifest(JSON.parse(read("version.json")));
  assert.equal(res.ok, true, res.reason);
  assert.equal(typeof res.update.versionCode, "number");
  assert.match(res.update.apkUrl, /^https:\/\/.+\.apk$/);
  assert.equal(typeof res.update.forceUpdate, "boolean");
});

test("bad manifests are rejected with a readable reason, never thrown", () => {
  const cases = [
    [null, /not valid JSON/],
    [{}, /version_name is missing/],
    [{ version_name: "abc", version_code: 2, apk_url: "https://x/y.apk" }, /not a version number/],
    [{ version_name: "1.0.2", apk_url: "https://x/y.apk" }, /version_code/],
    [{ version_name: "1.0.2", version_code: 1.5, apk_url: "https://x/y.apk" }, /whole number/],
    [{ version_name: "1.0.2", version_code: 2 }, /apk_url is missing/],
    // plain http would let the APK be swapped in transit
    [{ version_name: "1.0.2", version_code: 2, apk_url: "http://x/y.apk" }, /https/],
    [{ version_name: "1.0.2", version_code: 2, apk_url: "https://x/y.zip" }, /\.apk/]
  ];
  for (const [input, pattern] of cases) {
    const res = L.parseManifest(input);
    assert.equal(res.ok, false, "should reject: " + JSON.stringify(input));
    assert.match(res.reason, pattern);
  }
});

test("optional manifest fields get safe defaults", () => {
  const res = L.parseManifest({
    version_name: "2.0.0",
    version_code: 20,
    apk_url: "https://example.com/app.apk"
  });
  assert.equal(res.ok, true);
  assert.equal(res.update.title, "Update to the latest version");
  assert.equal(res.update.changelog, "");
  // absent force_update must mean "the user may postpone"
  assert.equal(res.update.forceUpdate, false);
});

test("force_update is only honoured as a real boolean", () => {
  const base = { version_name: "2.0.0", version_code: 20, apk_url: "https://e.com/a.apk" };
  assert.equal(L.parseManifest({ ...base, force_update: true }).update.forceUpdate, true);
  assert.equal(L.parseManifest({ ...base, force_update: "true" }).update.forceUpdate, false);
  assert.equal(L.parseManifest({ ...base, force_update: 1 }).update.forceUpdate, false);
});

// --------------------------------------------------------------- messages

test("progress reads as a percentage, and as MB when the size is unknown", () => {
  assert.equal(L.progressLabel(0, 1000), "0%");
  assert.equal(L.progressLabel(500, 1000), "50%");
  assert.equal(L.progressLabel(1000, 1000), "100%");
  // no Content-Length: never show "NaN%" or a stuck 0%
  assert.equal(L.progressLabel(2 * 1024 * 1024, -1), "2.0 MB");
  assert.equal(L.progressLabel(0, 0), "0.0 MB");
  // a misbehaving server cannot push the bar past 100%
  assert.equal(L.progressLabel(5000, 1000), "100%");
});

test("download failures are translated into something a person can act on", () => {
  assert.match(L.friendlyDownloadError("HTTP 404"), /not working \(HTTP 404\)/);
  assert.match(L.friendlyDownloadError("The download failed: timeout"), /check your internet/);
  assert.match(L.friendlyDownloadError("ENOSPC: no space left"), /not enough free space/);
  assert.match(L.friendlyDownloadError("The downloaded file was empty"), /empty/);
  assert.match(L.friendlyDownloadError("The download stopped early"), /stopped early/);
  assert.match(L.friendlyDownloadError("HTTP 503"), /server had a problem/);
  // an unknown message is still shown, not swallowed
  assert.match(L.friendlyDownloadError("weird thing"), /weird thing/);
  assert.equal(L.friendlyDownloadError(""), "The update could not be downloaded.");
});

test("the installed version is described unambiguously", () => {
  assert.equal(L.describeVersion("1.0.9", 9), "1.0.9 (code 9)");
  assert.equal(L.describeVersion("1.0.9", null), "1.0.9");
  assert.equal(L.describeVersion("", 3), "unknown (code 3)");
});

// ------------------------------------------------------- Android wiring

test("the manifest declares everything the installer needs", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  assert.match(manifest, /android\.permission\.INTERNET/);
  // the provider must exist, be private, and publish its paths
  assert.match(manifest, /androidx\.core\.content\.FileProvider/);
  assert.match(manifest, /android:authorities="\$\{applicationId\}\.fileprovider"/);
  assert.match(manifest, /android:exported="false"/);
  assert.match(manifest, /android:grantUriPermissions="true"/);
  assert.match(manifest, /@xml\/file_paths/);
});

test("file_paths.xml exposes the update cache folder", () => {
  const paths = read("android/app/src/main/res/xml/file_paths.xml");
  // the plugin downloads to getCacheDir()/apk
  assert.match(paths, /<cache-path[^>]*name="apk_updates"[^>]*path="apk\/"/);
  // the pre-existing image paths must not be dropped
  assert.match(paths, /name="my_cache_images"/);
});

test("the plugin is registered before the bridge starts", () => {
  const main = read("android/app/src/main/java/com/registerbook/community/MainActivity.java");
  assert.match(main, /registerPlugin\(ApkUpdaterPlugin\.class\)/);
  // registerPlugin must run BEFORE super.onCreate, or Capacitor's bridge will
  // already have been built without the plugin.
  assert.ok(
    main.indexOf("registerPlugin(") < main.indexOf("super.onCreate("),
    "registerPlugin must come before super.onCreate"
  );
});

test("the plugin announces its name to JavaScript", () => {
  const java = read("android/app/src/main/java/com/registerbook/community/ApkUpdaterPlugin.java");
  assert.match(java, /@CapacitorPlugin\(name = "ApkUpdater"\)/);
  // The install permission is an app-op checked with canRequestPackageInstalls(),
  // not a runtime grant, so it must NOT be declared as a Capacitor @Permission
  // (that path is for dangerous runtime permissions like CAMERA).
  assert.ok(!java.includes("@Permission("), "no bogus runtime permission declaration");
  assert.ok(java.includes("canRequestPackageInstalls"), "it checks the app-op instead");
  // the four methods update.js calls must all be exposed
  for (const m of ["getAppInfo", "canInstallPackages", "openInstallSettings", "downloadApk", "installApk"]) {
    assert.match(java, new RegExp("@PluginMethod\\s+public void " + m), m + " is a PluginMethod");
  }
});

test("the installer intent is configured correctly for Android 7+", () => {
  const java = read("android/app/src/main/java/com/registerbook/community/ApkUpdaterPlugin.java");
  // a file:// URI throws FileUriExposedException on API 24+
  assert.match(java, /FileProvider\.getUriForFile/);
  assert.match(java, /application\/vnd\.android\.package-archive/);
  assert.match(java, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(java, /FLAG_ACTIVITY_NEW_TASK/);
  assert.match(java, /Intent\.ACTION_VIEW/);
  // Android 8.0+ needs the per-app allow, so it must be checked, not assumed
  assert.match(java, /canRequestPackageInstalls/);
  assert.match(java, /Settings\.ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
  // downloads are only accepted over https
  assert.match(java, /startsWith\("https:\/\/"\)/);
});

test("the plugin refuses unsafe file names and truncated downloads", () => {
  const java = read("android/app/src/main/java/com/registerbook/community/ApkUpdaterPlugin.java");
  // a caller-supplied name must not be able to escape the cache dir
  assert.match(java, /sanitizeFileName/);
  assert.match(java, /lastIndexOf\('\/'\)/);
  // a short transfer must never be handed to the installer
  assert.match(java, /received != total/);
  assert.match(java, /\.part/);
});

// ------------------------------------------------------- JavaScript wiring

test("update.js is loaded by the page and cached by the service worker", () => {
  const html = read("index.html");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.includes("update.js"), "index.html loads update.js");
  // it must come after config.js (it reads UPDATE_URL) and before app.js
  assert.ok(scripts.indexOf("update.js") > scripts.indexOf("config.js"));
  assert.ok(scripts.indexOf("update.js") < scripts.indexOf("app.js"));

  const sw = read("sw.js");
  assert.ok(sw.includes('"./update.js"'), "sw.js caches update.js");
});

test("update.js is copied into the APK", () => {
  const prep = read("tools/prepare-www.js");
  assert.ok(prep.includes('"update.js"'), "prepare-www.js ships update.js");
});

test("the app boots the updater and Settings can check manually", () => {
  const app = read("app.js");
  assert.ok(app.includes("window.RBUpdater.init()"), "boot() starts the updater");
  assert.ok(app.includes("checkForUpdate"), "Settings has a manual check");
  assert.ok(app.includes(".check({ manual: true })"), "the manual check is manual");
  assert.ok(app.includes("appVersionBadge"), "Settings shows the installed version");
});

test("the update check never runs on the website", () => {
  const js = read("update.js");
  // a PWA has no APK to install; the service worker owns web updates
  assert.match(js, /if \(!isNative\(\)\) \{\s*state\.status = "web";/);
  assert.match(js, /isNativePlatform/);
});

test("the check has a hard timeout and never throws when offline", () => {
  const js = read("update.js");
  assert.match(js, /AbortController/);
  assert.match(js, /setTimeout\(\(\) => controller\.abort\(\)/);
  assert.match(js, /clearTimeout\(timer\)/);
  // every failure path returns an object instead of rejecting
  assert.match(js, /catch \(e\) \{[\s\S]{0,200}return \{ ok: false, reason:/);
});

test("the panel offers Update and Later, and forces when asked", () => {
  const js = read("update.js");
  assert.match(js, /"Update to the latest version"/);
  assert.match(js, /updateLater/);
  assert.match(js, /updateGo/);
  // a forced update hides both escapes
  assert.match(js, /later\.style\.display = u\.forceUpdate \? "none"/);
  assert.match(js, /close\.style\.display = u\.forceUpdate \? "none"/);
  // and closePanel refuses to close it on a user action
  assert.match(js, /if \(forced && fromUser && state\.status !== "ready"\) return;/);
});

test("after the settings screen the update resumes on App resume", () => {
  const js = read("update.js");
  assert.match(js, /addListener\("resume"/);
  assert.match(js, /pendingInstallPermission/);
});

// ------------------------------------------------------------- publishing

test("CI writes version.json from the real APK and commits it", () => {
  const wf = read(".github/workflows/build-apk.yml");
  // read the version from the built APK, not from a guess
  assert.match(wf, /\$AAPT2" dump badging/);
  assert.ok(wf.includes("Read the built version from the APK"));
  assert.ok(wf.includes("Write version.json"));
  // the manifest must point at the same asset the release publishes
  const vj = JSON.parse(read("version.json"));
  assert.ok(wf.includes(vj.apk_url), "version.json apk_url matches the workflow");
  assert.ok(wf.includes("RegisterBook.apk"));
  // committing version.json must not re-trigger the build
  assert.ok(wf.includes("[skip ci]"), "the version.json commit skips CI");
});

test("the CI versionCode stays ahead of the installed APK", () => {
  const wf = read(".github/workflows/build-apk.yml");
  // run numbers keep increasing, so every release is a real upgrade
  assert.match(wf, /versionCode " \+ build_number/);
  // the committed manifest must not announce a version older than the last
  // build (run 9 produced code 9)
  const vj = JSON.parse(read("version.json"));
  assert.ok(vj.version_code >= 9, "version.json is at least the last build");
});

test("the update URL is https and matches the published site", () => {
  const cfg = read("config.js");
  const m = cfg.match(/UPDATE_URL:\s*"([^"]+)"/);
  assert.ok(m, "config.js has UPDATE_URL");
  assert.match(m[1], /^https:\/\//);
  assert.match(m[1], /\/Register-book\/version\.json$/);
  // keep it in step with SITE_URL
  const site = cfg.match(/SITE_URL:\s*"([^"]+)"/)[1].replace(/\/+$/, "");
  assert.equal(m[1], site + "/version.json");
});

test("an older APK running this page degrades gracefully, never silently", () => {
  const js = read("update.js");
  // The WebView loads the live site, so a new page can run inside an old APK
  // that has no native plugin. Every call must be guarded.
  assert.match(js, /typeof p\.downloadApk !== "function"/);
  assert.match(js, /typeof p\.installApk !== "function"/);
  assert.match(js, /typeof p\.openInstallSettings === "function"/);
  assert.match(js, /typeof p\.canInstallPackages !== "function"/);
  // and the user is told what to do instead of seeing a dead button
  assert.match(js, /cannot install updates by itself/);
});
