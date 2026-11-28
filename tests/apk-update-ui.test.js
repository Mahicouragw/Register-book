// Exercises the REAL update.js UI in jsdom against a fake Android device.
// This is the closest thing to a device test available here: it drives the
// same code path (check → panel → permission → download → install → progress).
// Drives the REAL update.js UI against a fake Android device in jsdom.
// The pure-logic tests in apk-update.test.js cover the decisions; this file
// covers the wiring — panel, permission gate, download, installer hand-off,
// forced mode and every failure path — without needing a phone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: "https://mahicouragw.github.io/Register-book/",
  runScripts: "outside-only"
});
const { window } = dom;

// ---- fake network -------------------------------------------------------
let manifestBody = {
  version_name: "1.0.9",
  version_code: 9,
  title: "Update to the latest version",
  changelog: "Bug fixes, faster performance.\nNew self-update.",
  apk_url: "https://github.com/o/r/releases/download/apk-latest/RegisterBook.apk",
  force_update: false
};
let fetchedUrl = "";
window.fetch = async (url) => {
  fetchedUrl = String(url);
  return { ok: true, status: 200, json: async () => manifestBody, text: async () => "" };
};

// ---- fake Capacitor + native plugin -------------------------------------
const calls = [];
let installed = { versionName: "1.0.8", versionCode: 8 };
let permissionGranted = false;
let downloadProgress = { received: 0, total: -1, percent: -1 };
let progressListener = null;

const plugin = {
  async getAppInfo() {
    calls.push("getAppInfo");
    return { ...installed, packageName: "com.registerbook.community", canInstall: permissionGranted };
  },
  async canInstallPackages() {
    calls.push("canInstallPackages");
    return { canInstall: permissionGranted, sdk: 34 };
  },
  async openInstallSettings() {
    calls.push("openInstallSettings");
    return { opened: true };
  },
  async downloadApk(opts) {
    calls.push("downloadApk:" + opts.url);
    // emulate the native progress events
    if (progressListener) {
      progressListener({ received: 500, total: 2000, percent: 25 });
    }
    if (downloadProgress.total < 0) {
      downloadProgress = { received: 2000, total: 2000, percent: 100 };
    }
    return { path: "/data/user/0/com.registerbook.community/cache/apk/RegisterBook-update.apk", bytes: 2000, fileName: "RegisterBook-update.apk" };
  },
  async installApk(opts) {
    calls.push("installApk:" + opts.path);
    return { installed: true, uri: "content://com.registerbook.community.fileprovider/apk_updates/RegisterBook-update.apk" };
  },
  addListener(event, cb) {
    calls.push("addListener:" + event);
    if (event === "apkDownloadProgress") progressListener = cb;
    return { remove: async () => {} };
  }
};

window.Capacitor = {
  isNativePlatform: () => true,
  Plugins: { ApkUpdater: plugin, App: { addListener: (e, cb) => { calls.push("appListener:" + e); return { remove: async () => {} }; } } }
};
window.RB_CONFIG = { UPDATE_URL: "https://mahicouragw.github.io/Register-book/version.json" };
window.RB_BUILD = {};
window.localStorage.clear();

// ---- load the real file -------------------------------------------------
const src = fs.readFileSync(path.join(ROOT, "update.js"), "utf8");
window.eval(src);

const U = window.RBUpdater;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
}

test("the update flow works end to end against a fake device", async () => {
  // 1. installed version comes from the native package, not the web bundle
  const v = await U.installedVersion();
  check("installed version read from the package manager", v.versionCode === 8 && v.versionName === "1.0.8", JSON.stringify(v));

  // 2. a newer manifest is detected and the panel opens
  const res = await U.check({ manual: true });
  check("newer version detected", res.ok && res.available === true, JSON.stringify({ ok: res.ok, available: res.available }));
  check("manifest URL was fetched", fetchedUrl.endsWith("/version.json"), fetchedUrl);
  const panel = window.document.getElementById("updatePanel");
  check("panel exists and is open", !!panel && panel.classList.contains("open"));
  check("panel heading is the required wording",
    window.document.getElementById("updateTitle").textContent === "Update to the latest version");
  const notes = window.document.getElementById("updateNotes").textContent;
  check("changelog renders both lines", /Bug fixes/.test(notes) && /self-update/.test(notes), notes);
  const versions = window.document.getElementById("updateVersions").textContent;
  check("both versions are shown", /1\.0\.8/.test(versions) && /1\.0\.9/.test(versions), versions);
  check("Later button is offered when not forced", window.document.getElementById("updateLater").style.display !== "none");
  check("close button is offered when not forced", window.document.getElementById("updateClose").style.display !== "none");

  // 3. Update without permission → sent to settings, no download yet
  calls.length = 0;
  await window.document.getElementById("updateGo").onclick();
  await new Promise(r => setTimeout(r, 50));
  check("asks for the install permission first", calls.includes("canInstallPackages"), calls.join(","));
  check("opens the system settings screen", calls.includes("openInstallSettings"));
  check("does NOT download before permission", !calls.some(c => c.startsWith("downloadApk")), calls.join(","));
  check("explains what to do", /Allow from this source/.test(window.document.getElementById("updateMsg").textContent),
    window.document.getElementById("updateMsg").textContent);

  // 4. grant the permission, update again → download then install
  permissionGranted = true;
  calls.length = 0;
  await window.document.getElementById("updateGo").onclick();
  await new Promise(r => setTimeout(r, 80));
  check("downloads after permission", calls.some(c => c.startsWith("downloadApk:")), calls.join(","));
  check("hands the file to the installer", calls.some(c => c.startsWith("installApk:")), calls.join(","));
  check("installer path is the downloaded file", calls.some(c => c.includes("/cache/apk/RegisterBook-update.apk")));
  check("progress reached 100%", U.state.progress.percent === 100, JSON.stringify(U.state.progress));
  check("user is told to follow the installer", /installer/i.test(window.document.getElementById("updateMsg").textContent),
    window.document.getElementById("updateMsg").textContent);

  // 5. equal version → no panel (the bug the tests caught earlier)
  window.document.getElementById("updatePanel").classList.remove("open");
  manifestBody = { ...manifestBody, version_code: 8, version_name: "1.0.8" };
  installed = { versionName: "1.0.8", versionCode: 8 };
  U.state.installed = null;
  const same = await U.check({ manual: true });
  check("same version is not an update", same.ok && same.available === false, JSON.stringify(same));
  check("panel stays closed", !window.document.getElementById("updatePanel").classList.contains("open"));

  // 6. offline → no crash, honest message
  window.fetch = async () => { throw new Error("network down"); };
  const off = await U.check({ manual: true });
  check("offline check does not throw", off.ok === false, JSON.stringify(off));
  check("offline message is calm", /Could not check|timed out/.test(U.state.message), U.state.message);

  // 7. forced update removes every escape
  window.fetch = async (url) => {
    fetchedUrl = String(url);
    return { ok: true, status: 200, json: async () => manifestBody, text: async () => "" };
  };
  manifestBody = {
    version_name: "2.0.0", version_code: 20, apk_url: "https://e.com/a.apk", force_update: true, changelog: "Critical fix"
  };
  installed = { versionName: "1.0.8", versionCode: 8 };
  U.state.installed = null;
  await U.check({ manual: true });
  check("forced update opens the panel", window.document.getElementById("updatePanel").classList.contains("open"));
  check("forced: no Later button", window.document.getElementById("updateLater").style.display === "none");
  check("forced: no close button", window.document.getElementById("updateClose").style.display === "none");
  // and a user close attempt is ignored
  U.closePanel(true);
  check("forced: close is refused", window.document.getElementById("updatePanel").classList.contains("open"));

  // 8. a broken manifest never crashes and is reported
  manifestBody = { version_name: "2.0.0", version_code: 20, apk_url: "http://insecure/a.apk" };
  U.state.installed = null;
  window.document.getElementById("updatePanel").classList.remove("open");
  const bad = await U.check({ manual: true });
  check("http apk_url is rejected", bad.ok === false && /https/.test(bad.reason), JSON.stringify(bad));
  check("broken manifest: panel not opened", !window.document.getElementById("updatePanel").classList.contains("open"));

  const failed = results.filter(r => !r.pass);
  // Fail the test with every broken expectation listed at once.
  assert.deepEqual(failed, [], "failed checks: " + failed.map(f => f.name + " [" + f.detail + "]").join("; "));
  assert.equal(results.length, 28, "all flow checks ran");
});
