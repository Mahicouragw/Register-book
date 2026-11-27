// Locks in the Android app behaviour the owner asked for:
//   1. "Continue with Google" in the APK opens Chrome, and the login comes
//      back into the app (deep link → session), so the person lands in the
//      app already signed in with their name.
//   2. The app declares every permission it needs: notifications,
//      microphone, camera (calls), internet, vibration, audio routing.
//   3. The notification permission is requested at runtime in the APK.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ------------------------------------------------------------ 1. native login
test("AndroidManifest: deep link brings the Google login back into the app", () => {
  const m = read("android/app/src/main/AndroidManifest.xml");
  assert.ok(m.includes('android:scheme="com.registerbook.community"'), "custom scheme declared");
  assert.ok(m.includes('android:host="auth"'), "auth host declared");
  assert.ok(m.includes("android.intent.action.VIEW"), "VIEW action for the redirect");
  assert.ok(m.includes("android.intent.category.BROWSABLE"), "BROWSABLE so Chrome can open it");
});

test("auth.js: APK login opens Chrome and returns via the deep link", () => {
  const auth = read("auth.js");
  assert.ok(auth.includes("isNativePlatform"), "detects the APK");
  assert.ok(auth.includes("skipBrowserRedirect"), "gets the login URL instead of redirecting in the web view");
  assert.ok(auth.includes("browser.open"), "opens Chrome for the login");
  assert.ok(auth.includes("appUrlOpen"), "listens for the login coming back");
  assert.ok(auth.includes("exchangeCodeForSession"), "exchanges the code for a session");
  assert.ok(auth.includes("setSession"), "handles the token form too");
  assert.ok(auth.includes("handleNativeReturn"), "the return handler exists");
  // ...and the web flow is untouched
  assert.ok(auth.includes("window.location.origin + window.location.pathname"), "website still redirects to itself");
});

test("config.js: native redirect address matches the manifest", () => {
  const cfg = read("config.js");
  assert.ok(cfg.includes('NATIVE_REDIRECT: "com.registerbook.community://auth"'), "redirect address in config");
  const m = read("android/app/src/main/AndroidManifest.xml");
  assert.ok(m.includes("com.registerbook.community"), "same scheme in the manifest");
});

// ------------------------------------------------------------ 2. permissions
test("AndroidManifest: every permission the app needs is declared", () => {
  const m = read("android/app/src/main/AndroidManifest.xml");
  const need = [
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.RECORD_AUDIO",
    "android.permission.CAMERA",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.VIBRATE",
    "android.permission.BLUETOOTH",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.WAKE_LOCK"
  ];
  for (const p of need) {
    assert.ok(m.includes(p), `declares ${p}`);
  }
});

// ------------------------------------------------------------ 3. runtime prompt
test("push.js: APK asks for the notification permission at runtime", () => {
  const push = read("push.js");
  assert.ok(push.includes("requestPermissions"), "asks Android for the permission");
  assert.ok(push.includes("requestNativePermission"), "the native request helper exists");
  assert.ok(push.includes("FCM_ENABLED"), "FCM registration waits for Firebase setup");
  assert.ok(push.includes("isNativePlatform"), "detects the APK");
});

test("APK build: CI uses Java 21 and the plugins are registered", () => {
  const wf = read(".github/workflows/build-apk.yml");
  assert.ok(wf.includes("java-version: 21"), "Capacitor 8 needs Java 21");
  const settings = read("android/capacitor.settings.gradle");
  for (const p of ["capacitor-app", "capacitor-browser", "capacitor-push-notifications"]) {
    assert.ok(settings.includes(p), `plugin registered: ${p}`);
  }
  const pkg = JSON.parse(read("package.json"));
  for (const p of ["@capacitor/app", "@capacitor/browser", "@capacitor/push-notifications"]) {
    assert.ok(pkg.dependencies[p] || pkg.devDependencies[p], `dependency present: ${p}`);
  }
});
