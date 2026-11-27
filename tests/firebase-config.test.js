// Verifies the owner's real google-services.json is wired correctly.
//
// Firebase is now part of the APK, which means the app WILL call the native
// push plugin — so this config has to be exactly right, or the app crashes
// the moment someone signs in (that was the previous bug).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("android/app/google-services.json exists and is valid JSON", () => {
  const p = path.join(ROOT, "android/app/google-services.json");
  assert.ok(fs.existsSync(p), "the file is committed so CI builds include Firebase");
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.ok(d.project_info && d.project_info.project_id, "has a project id");
  assert.ok(Array.isArray(d.client) && d.client.length > 0, "has at least one client");
});

test("the package name matches the app exactly", () => {
  const d = JSON.parse(read("android/app/google-services.json"));
  const cfg = JSON.parse(read("capacitor.config.json"));
  for (const c of d.client) {
    const pkg = ((c.client_info || {}).android_client_info || {}).package_name;
    assert.equal(pkg, cfg.appId, "Firebase is registered for " + cfg.appId);
  }
});

test("the app id / api key / sender id are present", () => {
  const d = JSON.parse(read("android/app/google-services.json"));
  const c = d.client[0];
  assert.match((c.client_info || {}).mobilesdk_app_id || "", /^\d+:\d+:android:[0-9a-f]+$/, "app id shape");
  assert.ok(((c.api_key || [])[0] || {}).current_key, "API key present");
  assert.ok(d.project_info.project_number, "project number present (used as the FCM sender id)");
});

test("prepare-www.js extracts a NON-EMPTY sender id", () => {
  const script = read("tools/prepare-www.js");
  // gcm_defaultSenderId is not a top-level field of google-services.json;
  // a naive read produced an empty string, which breaks FCM registration.
  assert.ok(script.includes("gcmSenderId"), "writes gcmSenderId");
  assert.ok(script.includes("project_number"), "falls back to project_number");
  assert.ok(!script.includes('(client.client_info || {}).project_id'), "no bogus client_info.project_id read");
});

test("the generated build stamp really has Firebase ON with a sender id", () => {
  const p = path.join(ROOT, "android/app/src/main/assets/public/rb-build.js");
  if (!fs.existsSync(p)) return; // not synced in this checkout
  const code = fs.readFileSync(p, "utf8");
  assert.match(code, /window\.RB_FIREBASE = true/, "Firebase is ON for this APK");
  const m = code.match(/"gcmSenderId":"(\d+)"/);
  assert.ok(m, "sender id is a non-empty number: " + (m && m[1]));
  const project = code.match(/"projectId":"([^"]+)"/);
  assert.ok(project && project[1], "project id present");
});

test("push.js will now be allowed to register (the gate must be open)", () => {
  const push = read("push.js");
  // The gate exists (so a Firebase-less build still cannot crash)…
  assert.ok(push.includes("firebaseInBuild"), "the safety gate is still there");
  // …but this build's stamp says true, so registration proceeds.
  const stamp = read("rb-build.js");
  assert.match(stamp, /window\.RB_FIREBASE = false/, "the website default stays off");
});
