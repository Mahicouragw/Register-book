// Regression tests for the two notification bugs the owner hit inside the APK:
//
//   1. "I turned notifications ON, closed the app, reopened it, and Settings
//      says they are off again." — the app kept the permission in a module
//      variable that started at "default" and was never read back from Android,
//      so every cold start forgot the answer.
//
//   2. A notification sent while the app was closed never appeared. The FCM SDK
//      draws those itself, on a channel named in the manifest; that channel was
//      never declared and never created, so Android dropped them silently.
//
// These run the real push.js against a fake Capacitor bridge, so they test the
// code that ships rather than a copy of it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const PUSH_SRC = fs.readFileSync(path.join(ROOT, "push.js"), "utf8");

/** Loads push.js into a sandbox with a stubbed Capacitor + PushNotifications. */
function loadPush(opts) {
  const o = opts || {};
  const calls = { createChannel: [], requestPermissions: 0, checkPermissions: 0, register: 0 };

  const pushNotifications = {
    async checkPermissions() {
      calls.checkPermissions++;
      return { receive: o.checkResult || "prompt" };
    },
    async requestPermissions() {
      calls.requestPermissions++;
      return { receive: o.requestResult || "granted" };
    },
    async createChannel(ch) {
      calls.createChannel.push(ch);
    },
    async register() {
      calls.register++;
      return undefined;
    },
    async addListener() { return { remove() {} }; }
  };

  const win = {
    RB_CONFIG: { FCM_ENABLED: true, SUPABASE_URL: "https://x.supabase.co" },
    RB_FIREBASE: o.firebase === false ? false : true,
    RBStore: o.store || {
      isDemo: () => false,
      me: { id: "u1" },
      data: { notifications: [] },
      notifyRemote: async () => ({ ok: true, delivered: 1 })
    },
    Capacitor: {
      isNativePlatform: () => (o.native === false ? false : true),
      Plugins: { PushNotifications: o.plugin === null ? undefined : pushNotifications }
    },
    Notification: { permission: "granted", requestPermission: async () => "granted" },
    addEventListener() {},
    matchMedia: () => ({ addEventListener() {}, addListener() {} }),
    navigator: { serviceWorker: undefined },
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {} }), body: { appendChild() {} }, addEventListener() {} },
    crypto: { getRandomValues: (a) => a },
    console,
    setTimeout, clearTimeout, Promise, Date, JSON, Math, String, Number, Object, Array, Error
  };
  win.window = win;
  win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(PUSH_SRC, win, { filename: "push.js" });
  return { win, calls, push: win.RBPush };
}

test("push.js loads and exposes the native lifecycle", () => {
  const { push } = loadPush();
  assert.ok(push, "window.RBPush must exist");
  assert.strictEqual(typeof push.initNative, "function", "initNative must be exposed so startup can read the phone");
  assert.strictEqual(typeof push.refreshNativeState, "function", "refreshNativeState must be exposed so Settings re-reads");
});

test("a granted phone reports ON after a cold start", async () => {
  // This is the bug: reopen the app, Android already granted, but the app had
  // no memory of asking, so Settings showed "Notifications are off".
  const { push, calls } = loadPush({ checkResult: "granted" });

  // Fresh module state reads as off — that is the un-fixed behaviour.
  assert.strictEqual(push.statusText().state, "default");

  await push.initNative();

  assert.strictEqual(calls.checkPermissions, 1, "the phone must actually be asked");
  assert.strictEqual(push.statusText().state, "granted", "Settings must show ON, matching the phone");
  assert.match(push.statusText().title, /are ON/i);
  assert.strictEqual(calls.requestPermissions, 0, "startup must never pop the permission dialog");
});

test("a blocked phone reports BLOCKED after a cold start", async () => {
  const { push } = loadPush({ checkResult: "denied" });
  await push.initNative();
  assert.strictEqual(push.statusText().state, "denied");
  assert.match(push.statusText().title, /blocked/i);
});

test("the answer is re-read every time, not cached from startup", async () => {
  // The owner can go into Android Settings and change it, then come back.
  let answer = "denied";
  const calls = { checkPermissions: 0, createChannel: [], requestPermissions: 0, register: 0 };
  const pushNotifications = {
    async checkPermissions() { calls.checkPermissions++; return { receive: answer }; },
    async requestPermissions() { calls.requestPermissions++; return { receive: "granted" }; },
    async createChannel(ch) { calls.createChannel.push(ch); },
    async register() { calls.register++; },
    async addListener() { return { remove() {} }; }
  };
  const win = {
    RB_CONFIG: { FCM_ENABLED: true }, RB_FIREBASE: true,
    RBStore: { isDemo: () => false, me: { id: "u1" }, data: { notifications: [] }, notifyRemote: async () => ({ ok: true }) },
    Capacitor: { isNativePlatform: () => true, Plugins: { PushNotifications: pushNotifications } },
    addEventListener() {}, matchMedia: () => ({ addEventListener() {}, addListener() {} }),
    navigator: {}, document: { getElementById: () => null, addEventListener() {} },
    console, setTimeout, clearTimeout
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(PUSH_SRC, win, { filename: "push.js" });

  await win.RBPush.initNative();
  assert.strictEqual(win.RBPush.statusText().state, "denied");

  answer = "granted";
  await win.RBPush.refreshNativeState();
  assert.strictEqual(win.RBPush.statusText().state, "granted", "must reflect the change made in Android Settings");
  assert.ok(calls.checkPermissions >= 2, "each refresh must ask the phone again");
});

test("startup creates the notification channel the server sends to", async () => {
  const { push, calls } = loadPush({ checkResult: "granted" });
  await push.initNative();

  assert.strictEqual(calls.createChannel.length >= 1, true, "the channel must exist before a push can use it");
  const ch = calls.createChannel[0];
  assert.strictEqual(ch.id, "registerbook_default");
  assert.ok(ch.name, "a channel needs a user-visible name");
  assert.strictEqual(ch.importance, 5, "IMPORTANCE_HIGH, so a push shows a banner");
});

test("the permission prompt also creates the channel first", async () => {
  const { push, calls } = loadPush({ checkResult: "prompt", requestResult: "granted" });
  const res = await push.enable();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(calls.requestPermissions, 1);
  assert.ok(calls.createChannel.length >= 1, "channel before prompt, so the first push already lands");
  assert.strictEqual(calls.createChannel[0].id, "registerbook_default");
});

test("the channel id is the same everywhere it is written down", () => {
  const CHANNEL = "registerbook_default";

  // Server: the id inside every FCM notification payload.
  const fcm = fs.readFileSync(path.join(ROOT, "supabase", "functions", "_shared", "fcm.js"), "utf8");
  assert.match(fcm, new RegExp('channelId\\s*\\|\\|\\s*"' + CHANNEL + '"'),
    "rb-notify must send the channel the app creates");

  // App: created at runtime by the JS side.
  assert.match(PUSH_SRC, new RegExp('CHANNEL_ID\\s*=\\s*"' + CHANNEL + '"'));

  // Native: created at app start.
  const activity = fs.readFileSync(path.join(
    ROOT, "android/app/src/main/java/com/registerbook/community/MainActivity.java"), "utf8");
  assert.match(activity, new RegExp('CHANNEL_ID\\s*=\\s*"' + CHANNEL + '"'));
  assert.match(activity, /createNotificationChannel\(\)/, "it must actually be created on start");

  // Manifest: the id the FCM SDK uses to draw a closed-app push by itself.
  const manifest = fs.readFileSync(path.join(ROOT, "android/app/src/main/AndroidManifest.xml"), "utf8");
  assert.match(manifest, /com\.google\.firebase\.messaging\.default_notification_channel_id/,
    "without this meta-data Android drops closed-app notifications");
  assert.match(manifest, new RegExp('android:value="' + CHANNEL + '"'),
    "the manifest value must match the channel that is created");
});

test("the manifest's notification icon and colour resources exist", () => {
  const manifest = fs.readFileSync(path.join(ROOT, "android/app/src/main/AndroidManifest.xml"), "utf8");

  const icon = manifest.match(/default_notification_icon"\s*\n?\s*android:resource="@drawable\/([a-z0-9_]+)"/);
  assert.ok(icon, "a monochrome notification icon must be declared");
  const iconPath = path.join(ROOT, "android/app/src/main/res/drawable", icon[1] + ".xml");
  assert.ok(fs.existsSync(iconPath), "declared drawable " + icon[1] + " is missing: " + iconPath);

  const color = manifest.match(/default_notification_color"\s*\n?\s*android:resource="@color\/([a-z0-9_]+)"/);
  assert.ok(color, "a notification colour must be declared");
  const colorsXml = fs.readFileSync(path.join(ROOT, "android/app/src/main/res/values/colors.xml"), "utf8");
  assert.match(colorsXml, new RegExp('<color name="' + color[1] + '">'), "declared colour " + color[1] + " is missing");
});

test("MainActivity still registers its own plugin and stays valid Java", () => {
  const java = fs.readFileSync(path.join(
    ROOT, "android/app/src/main/java/com/registerbook/community/MainActivity.java"), "utf8");

  assert.match(java, /registerPlugin\(ApkUpdaterPlugin\.class\)/, "the updater plugin must keep working");
  assert.match(java, /super\.onCreate\(savedInstanceState\)/, "the bridge must still be created");
  // Structural check only: no JDK in this environment.
  const opens = (java.match(/\{/g) || []).length;
  const closes = (java.match(/\}/g) || []).length;
  assert.strictEqual(opens, closes, "unbalanced braces in MainActivity.java");
  assert.match(java, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.O/, "channels only exist on Android 8+");
});

test("status text never promises push the build cannot deliver", async () => {
  const { push } = loadPush({ checkResult: "granted", firebase: false });
  await push.initNative();
  const st = push.statusText();
  assert.strictEqual(st.state, "granted");
  assert.match(st.body, /not configured in this build/i,
    "without google-services.json the wording must not claim closed-app delivery");
});

test("enable() does not claim success when registration failed", async () => {
  // Firebase is in the build, but the plugin has no register() — so nothing
  // reached the server. Reporting a flat "✓" here is what made the owner think
  // notifications worked when they did not.
  const broken = {
    async checkPermissions() { return { receive: "granted" }; },
    async requestPermissions() { return { receive: "granted" }; },
    async createChannel() {},
    async addListener() { return { remove() {} }; }
  };
  const win = {
    RB_CONFIG: { FCM_ENABLED: true }, RB_FIREBASE: true,
    RBStore: { isDemo: () => false, me: { id: "u1" }, data: { notifications: [] }, notifyRemote: async () => ({ ok: true }) },
    Capacitor: { isNativePlatform: () => true, Plugins: { PushNotifications: broken } },
    addEventListener() {}, matchMedia: () => ({ addEventListener() {}, addListener() {} }),
    navigator: {}, document: { getElementById: () => null, addEventListener() {} },
    console, setTimeout, clearTimeout
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(PUSH_SRC, win, { filename: "push.js" });

  const res = await win.RBPush.enable();
  assert.strictEqual(res.ok, true, "the phone really did grant it");
  assert.ok(res.warning, "but it must admit the push service was never registered");
  assert.match(res.warning, /no-plugin|register/i);
});

test("Settings actually calls the native read instead of trusting memory", () => {
  // The original bug was not only that the state was wrong: nothing ever asked
  // the phone. A fix that adds initNative() but never wires it up would look
  // correct in push.js and still show "off" forever.
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

  const fn = app.slice(app.indexOf("function renderNotificationSettings()"));
  assert.ok(fn.length > 0, "renderNotificationSettings must exist");

  assert.match(fn, /refreshNativeState\(\)/,
    "opening Settings must re-read the permission from Android");
  assert.match(fn, /\.then\(/,
    "the redraw must happen after the phone answers, not before");
  assert.match(fn, /P\.isNative\(\)/,
    "and only inside the APK — the website uses the browser's own state");
});

test("startup reads the native state once, and only prompts on a tap", () => {
  const push = PUSH_SRC;
  // initNative must exist and must be distinct from the prompt path.
  assert.match(push, /async function initNative\(\)/);
  assert.match(push, /async function refreshNativeState\(\)/);

  const init = push.slice(push.indexOf("async function initNative()"));
  const body = init.slice(0, init.indexOf("\n  }\n"));
  assert.doesNotMatch(body, /requestNativePermission\(\)/,
    "launch must never pop the Android permission dialog");
  assert.match(body, /syncNativePermission\(\)/, "it reads the state instead");
});

test("every Android resource touched here is well-formed XML", () => {
  // A stray "--" inside an XML comment is illegal and breaks the Gradle build
  // with a message that does not name the file. Check it here instead.
  // (No XML parser dependency: the files are small and the shapes are simple.)
  const files = [
    "android/app/src/main/AndroidManifest.xml",
    "android/app/src/main/res/drawable/ic_stat_registerbook.xml",
    "android/app/src/main/res/values/colors.xml"
  ];
  for (const rel of files) {
    const xml = fs.readFileSync(path.join(ROOT, rel), "utf8");
    // Comments must not contain "--".
    const comments = xml.match(/<!--[\s\S]*?-->/g) || [];
    for (const c of comments) {
      const inner = c.slice(4, -3);
      assert.ok(!inner.includes("--"), `${rel}: XML comments may not contain "--" (found in: ${c.slice(0, 60)}...)`);
    }
    // Every comment must be closed.
    const opens = (xml.match(/<!--/g) || []).length;
    const closes = (xml.match(/-->/g) || []).length;
    assert.strictEqual(opens, closes, `${rel}: unclosed comment`);
    // Root element present.
    assert.match(xml, /<\?xml version="1\.0" encoding="utf-8"\?>/, `${rel}: missing XML declaration`);
  }
});
