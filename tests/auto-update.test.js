// Locks in the three things the owner asked for in this round:
//   1. The login gate is clean — no extra links/pages on the sign-in screen.
//   2. The app updates itself — a new service worker reloads the open page,
//      and the browser is asked to check for a new version regularly.
//   3. The Android APK build is wired up (Capacitor + GitHub Actions).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ------------------------------------------------------------ 1. clean login
test("login gate: no extra links or footer pages on the sign-in screen", () => {
  const html = read("index.html");
  const gate = html.slice(html.indexOf('id="loginGate"'), html.indexOf('id="appShell"'));
  assert.ok(gate.length > 0, "login gate section found");
  assert.ok(!gate.includes("terms.html"), "no Terms link on the gate");
  assert.ok(!gate.includes("privacy.html"), "no Privacy link on the gate");
  assert.ok(!gate.includes("gate-foot"), "no marketing footer on the gate");
  assert.ok(!gate.includes("openSetupModal"), "no setup-guide button on the gate");
  // ...but the essentials are still there
  assert.ok(gate.includes("handleGoogleLogin"), "Google button is on the gate");
  assert.ok(gate.includes("enterDemo"), "demo button is on the gate");
  assert.ok(gate.includes("gateDemoChips"), "demo people chips are on the gate");
});

test("Terms and Privacy are still reachable from Settings", () => {
  const app = read("app.js");
  assert.ok(app.includes("terms.html"), "Settings links to Terms");
  assert.ok(app.includes("privacy.html"), "Settings links to Privacy");
});

// ------------------------------------------------------------ 2. auto-update
test("service worker: version is bumped and every app file is cached", () => {
  const sw = read("sw.js");
  const m = sw.match(/const VERSION = "([^"]+)"/);
  assert.ok(m, "sw.js has a VERSION");
  assert.match(m[1], /^rb-\d{4}-\d{2}-\d{2}[a-z]$/, "version follows rb-YYYY-MM-DDx");
  const html = read("index.html");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(x => x[1]);
  for (const s of scripts) {
    assert.ok(sw.includes("./" + s), `sw.js caches ${s}`);
  }
  assert.ok(sw.includes("skipWaiting"), "new worker activates immediately");
});

test("app reloads itself when a new version takes over", () => {
  const app = read("app.js");
  assert.ok(app.includes("controllerchange"), "listens for the new worker taking control");
  assert.ok(app.includes("setupAutoUpdate"), "auto-update wiring exists");
  assert.ok(app.includes("reg.update()"), "asks the browser to check for a new version");
  assert.ok(app.includes("5 * 60 * 1000"), "checks every 5 minutes");
  assert.ok(app.includes("visibilitychange"), "checks again when the tab comes back");
  assert.ok(app.includes("location.reload"), "reloads into the new version");
  // ...but a first-ever install must not reload
  assert.ok(app.includes("hadController"), "first install does not trigger a reload");
});

// ------------------------------------------------------------ 3. APK build
test("Android APK: Capacitor config, www prep and CI workflow are wired", () => {
  const cfg = JSON.parse(read("capacitor.config.json"));
  assert.equal(cfg.appId, "com.registerbook.community");
  assert.equal(cfg.appName, "RegisterBook");
  assert.equal(cfg.webDir, "www");

  const prep = read("tools/prepare-www.js");
  assert.ok(prep.includes("index.html"), "www prep copies the site");
  assert.ok(prep.includes("vendor/supabase.js"), "www prep copies the bundled library");

  const wf = read(".github/workflows/build-apk.yml");
  assert.ok(wf.includes("assembleRelease"), "CI builds a signed release APK");
  assert.ok(wf.includes("signingConfigs"), "the APK is signed, so it can update in place");
  assert.ok(wf.includes("action-gh-release"), "CI publishes the .apk to a Release (one tap, no zip)");
  assert.ok(wf.includes("RegisterBook.apk"), "the released file is named RegisterBook.apk");
  assert.ok(wf.includes("branches: [main]"), "CI runs on every push to main");

  assert.ok(fs.existsSync(path.join(ROOT, "android", "app", "build.gradle")), "android project exists");
  assert.ok(fs.existsSync(path.join(ROOT, "android", "gradlew")), "gradle wrapper exists");
});
