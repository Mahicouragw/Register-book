// Regression tests for the APK crash right after Google sign-in.
//
// REPORTED: after picking the Google account, Chrome came back to the app,
// "Completing sign-in" appeared, then the app CRASHED / was thrown to the
// Android home screen.
//
// ROOT CAUSE: app.js calls RBPush.registerFcm() at the end of
// loadCloudAndShow() — i.e. exactly when the login completes. That reached
// @capacitor/push-notifications' register(), whose Android code calls
// FirebaseMessaging.getInstance() on the main thread. The APK was built
// WITHOUT android/app/google-services.json, so Firebase is not initialized
// there and that call throws — killing the process. The JS try/catch cannot
// stop a native main-thread throw.
//
// FIX: tools/prepare-www.js stamps what the build contains into
// www/rb-build.js (window.RB_FIREBASE), and push.js refuses to touch the
// push plugin unless the stamp says Firebase is really in the APK.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ------------------------------------------------------------------ 1. safety
test("push.js: FCM registration never runs in a build without Firebase", () => {
  const push = read("push.js");
  const fn = push.slice(push.indexOf("async function registerFcm"), push.indexOf("// ------------------------------------------------------------ capability"));

  assert.ok(fn.includes("firebaseInBuild"), "checks the build stamp first");
  // The gate must come BEFORE the plugin is obtained/registered.
  const gate = fn.indexOf("firebaseInBuild()");
  const plugin = fn.indexOf('nativePlugin("PushNotifications")');
  assert.ok(gate > 0 && plugin > gate, "the stamp is checked before the plugin is touched");

  assert.ok(push.includes("window.RB_FIREBASE"), "reads window.RB_FIREBASE");
  assert.ok(fn.includes("already-tried"), "only ever tries once per launch");
});

test("push.js: registration is wrapped so a rejection cannot escape", () => {
  const push = read("push.js");
  const fn = push.slice(push.indexOf("async function registerFcm"), push.indexOf("// ------------------------------------------------------------ capability"));
  assert.ok(fn.includes("try {"), "has a try block around register()");
  assert.ok(fn.includes("catch (e)"), "and catches it");
});

test("app.js: the post-login FCM call cannot take the app down", () => {
  const app = read("app.js");
  const call = app.slice(app.indexOf("window.RBPush.registerFcm()"), app.indexOf("window.RBPush.registerFcm()") + 200);
  assert.ok(call.includes(".catch("), "the promise is caught: " + call.replace(/\s+/g, " ").slice(0, 90));
});

// ------------------------------------------------------- 2. the build stamp
test("prepare-www.js: stamps whether Firebase is in this APK", () => {
  const script = read("tools/prepare-www.js");
  assert.ok(script.includes("google-services.json"), "looks for google-services.json");
  assert.ok(script.includes("window.RB_FIREBASE"), "writes window.RB_FIREBASE");
  assert.ok(script.includes("window.RB_FIREBASE_CONFIG"), "exposes the public Firebase config");
  assert.ok(script.includes("rb-build.js"), "writes it to rb-build.js");
});

test("rb-build.js: the website default keeps the APK path switched off", () => {
  const stamp = read("rb-build.js");
  assert.match(stamp, /window\.RB_FIREBASE = false/, "defaults to off");
  assert.match(stamp, /window\.RB_BUILD\s*=/, "declares the build object");
});

test("index.html: rb-build.js loads before the app scripts", () => {
  const html = read("index.html");
  const build = html.indexOf('src="rb-build.js"');
  const push = html.indexOf('src="push.js"');
  const app = html.indexOf('src="app.js"');
  assert.ok(build > 0, "rb-build.js is included");
  assert.ok(build < push, "loads before push.js");
  assert.ok(build < app, "loads before app.js");
});

test("the APK bundle actually contains the stamp", () => {
  const bundled = path.join(ROOT, "android/app/src/main/assets/public/rb-build.js");
  if (!fs.existsSync(bundled)) return; // not synced yet in this checkout
  const code = fs.readFileSync(bundled, "utf8");
  assert.match(code, /window\.RB_FIREBASE = (true|false)/, "the APK has a concrete answer");
});

test("sw.js: the version was bumped so installed apps pick the fix up", () => {
  const v = read("sw.js").match(/const VERSION = "([^"]+)"/);
  assert.ok(v && v[1] >= "rb-2026-11-27c", "cache bumped: " + (v && v[1]));
});

// ------------------------------------ 3. the sign-in completion still works
test("app boots in the APK web view with Firebase OFF and does not touch push", async () => {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {});
  const dom = new JSDOM(read("index.html"), {
    url: "https://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;

  let registerCalls = 0;
  w.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    Plugins: {
      Browser: { open: async () => {}, close: async () => {} },
      App: { addListener: () => ({ remove() {} }), getLaunchUrl: async () => ({ url: "" }) },
      // The plugin that used to kill the app when called.
      PushNotifications: {
        addListener: () => ({}),
        register: async () => { registerCalls++; throw new Error("Default FirebaseApp is not initialized in this process"); }
      }
    },
    getLaunchUrl: () => {}
  };
  w.fetch = async () => ({ ok: true, json: async () => ({ external: { google: true } }) });

  for (const f of ["vendor/supabase.js", "rb-build.js", "config.js", "notify.js", "auth.js", "store.js", "qbooks.js", "qbooks-ui.js", "push.js", "rtc.js", "app.js"]) {
    w.eval(read(f));
  }
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await new Promise(r => setTimeout(r, 600));

  // This is the exact call that crashed the phone after login.
  const res = await w.RBPush.registerFcm();
  console.log("registerFcm result:", JSON.stringify(res));
  assert.equal(registerCalls, 0, "the native push plugin was never called");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-firebase-in-build");

  // And with Firebase genuinely off, the app must still be alive and usable.
  assert.ok(w.RBAuth, "app scripts still loaded");
  assert.equal(w.RBAuth.isNative(), true, "still detects the APK");
  dom.window.close();
});

test("a build WITH Firebase does attempt registration (once)", async () => {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {});
  const dom = new JSDOM(read("index.html"), {
    url: "https://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;

  let registerCalls = 0;
  w.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    Plugins: {
      Browser: { open: async () => {}, close: async () => {} },
      App: { addListener: () => ({ remove() {} }), getLaunchUrl: async () => ({ url: "" }) },
      PushNotifications: {
        addListener: () => ({}),
        register: async () => { registerCalls++; }
      }
    },
    getLaunchUrl: () => {}
  };
  w.fetch = async () => ({ ok: true, json: async () => ({ external: { google: true } }) });

  for (const f of ["vendor/supabase.js", "rb-build.js", "config.js", "notify.js", "auth.js", "store.js", "qbooks.js", "qbooks-ui.js", "push.js", "rtc.js", "app.js"]) {
    w.eval(read(f));
  }
  w.RB_FIREBASE = true; // simulate an APK that WAS built with google-services.json
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await new Promise(r => setTimeout(r, 400));

  const first = await w.RBPush.registerFcm();
  const second = await w.RBPush.registerFcm();
  console.log("with firebase:", JSON.stringify(first), "/ again:", JSON.stringify(second));
  assert.equal(first.ok, true, "registers when Firebase is really there");
  assert.equal(registerCalls, 1, "registers exactly once per launch");
  assert.equal(second.reason, "already-tried");
  dom.window.close();
});

// ------------------------------------------- 4. the workflow that ships it
test("the APK workflow is valid YAML with the release+signing steps", () => {
  const yaml = require("js-yaml");
  const doc = yaml.load(read(".github/workflows/build-apk.yml"));
  const steps = doc.jobs["build-apk"].steps;
  const names = steps.map(s => s.name || s.uses).join(" | ");

  assert.ok(names.includes("assembleRelease") || read(".github/workflows/build-apk.yml").includes("assembleRelease"),
    "builds a release APK");
  assert.equal(doc.permissions.contents, "write", "can create the Release");
  assert.ok(names.includes("Publish as a GitHub Release"), "publishes the .apk for one-tap download");
  assert.ok(names.includes("Configure signing and version"), "signs it and bumps versionCode");

  // A step may not use secrets.* inside an `if:` — that invalidates the whole
  // workflow and GitHub creates no jobs at all (this happened once).
  for (const s of steps) {
    if (typeof s.if === "string") {
      assert.ok(!s.if.includes("secrets."), "no secrets.* in an if: expression -> " + s.name);
    }
  }
});

test("the APK workflow signs with a key that survives between builds", () => {
  const wf = read(".github/workflows/build-apk.yml");
  // A fixed cache key, not a hash of a file that does not exist yet.
  assert.ok(wf.includes("rb-signing-key-v1"), "signing key cached under a fixed key");
  assert.ok(!wf.includes("hashFiles('android/app/registerbook.jks')"), "not keyed by a missing file");
  assert.ok(wf.includes("registerbook.jks"), "the keystore path is used");
});

test("the APK workflow raises versionCode so Android accepts the update", () => {
  const wf = read(".github/workflows/build-apk.yml");
  assert.ok(wf.includes("versionCode"), "versionCode is patched");
  assert.ok(wf.includes("github.run_number"), "it uses the increasing run number");
});
