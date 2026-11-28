// Regression tests for "Could not send: Failed to fetch".
//
// The app (Android WebView, origin https://localhost) posts to the rb-notify
// Edge Function (origin https://<ref>.supabase.co). That is a cross-origin
// request, so EVERY response — not only the OPTIONS preflight — must carry
// Access-Control-Allow-Origin, or the browser discards the reply and fetch()
// rejects with the opaque message "Failed to fetch". The preflight already
// had the header, which is why the request looked allowed but never arrived.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

const FUNCTIONS = ["rb-notify", "rb-delete-account", "rb-turn-credentials"];

for (const fn of FUNCTIONS) {
  test(`${fn}: CORS headers on the actual response, not just the preflight`, () => {
    const src = read(`supabase/functions/src/${fn}.ts`);
    assert.ok(src.includes("CORS_HEADERS"), "defines a reusable CORS_HEADERS object");
    assert.match(src, /"Access-Control-Allow-Origin": "\*"/, "sends the origin header");
    assert.match(src, /"Access-Control-Allow-Headers"[^}]*apikey/s, "allows the apikey header");

    // The JSON responses (success AND failure) must spread CORS_HEADERS.
    const jsonBlock = src.slice(src.indexOf("JSON_HEADERS"), src.indexOf("JSON_HEADERS") + 300);
    assert.ok(jsonBlock.includes("...CORS_HEADERS"), "JSON responses inherit the CORS headers");

    // And OPTIONS must not hand-maintain a second copy that can drift.
    assert.ok(
      src.includes('return new Response("ok", { status: 200, headers: CORS_HEADERS });'),
      "preflight reuses the same headers"
    );
  });

  test(`${fn}: the BUILT file also carries CORS`, () => {
    const built = `supabase/functions/${fn}/index.ts`;
    if (!fs.existsSync(path.join(ROOT, built))) return; // not built in this checkout

    const wrapper = read(built);
    assert.ok(wrapper.includes("Access-Control-Allow-Origin"), "origin header present in the deployable file");
    assert.ok(wrapper.includes("Access-Control-Allow-Methods"), "methods present");

    // And the code that really runs must spread the same headers, so a 4xx
    // stays readable instead of surfacing as "Failed to fetch".
    const { deployedSource } = require("./helpers/deployed-body");
    const body = deployedSource(fn);
    assert.ok(body.includes("Access-Control-Allow-Origin"), "origin header inside the deployed body");
    assert.ok(body.includes("...CORS_HEADERS"), "spread into the JSON responses");
  });
}

test("the JSON error path is covered too (a 4xx must still be readable)", () => {
  const src = read("supabase/functions/src/rb-notify.ts");
  const fail = src.slice(src.indexOf("function fail"), src.indexOf("function fail") + 160);
  assert.ok(fail.includes("json("), "fail() goes through json(), so it inherits the headers");
});

test("the APK allow-lists Supabase so native requests are not blocked", () => {
  const cfg = JSON.parse(read("capacitor.config.json"));
  assert.ok(cfg.server && Array.isArray(cfg.server.allowNavigation), "allowNavigation exists");
  assert.ok(
    cfg.server.allowNavigation.some(h => h.includes("supabase.co")),
    "supabase.co is allowed"
  );
  assert.ok(
    cfg.server.allowNavigation.some(h => h.includes("google.com")),
    "google.com is allowed (the login round trip)"
  );
});

// ---------------------------------------------------------------------------
// The Edge runtime in this project cannot reach the `jsr:` registry: every
// function that imported `jsr:@supabase/supabase-js@2` died at start-up with
// "BOOT_ERROR: Function failed to start" and answered 503 to everything.
// `npm:@supabase/supabase-js@2` works. Pin it so a regenerated build cannot
// quietly reintroduce the dead import.
test("edge functions import supabase-js from npm, not the dead jsr registry", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  // rb-notify is wrapped (gzip bundle), so read the body that really runs.
  const { deployedSource } = require("./helpers/deployed-body");
  const bodies = {
    "rb-notify": deployedSource("rb-notify"),
    "rb-delete-account": fs.readFileSync(
      path.join(root, "supabase/functions/rb-delete-account/index.ts"), "utf8"),
    "rb-turn-credentials": fs.readFileSync(
      path.join(root, "supabase/functions/rb-turn-credentials/index.ts"), "utf8")
  };
  for (const [name, code] of Object.entries(bodies)) {
    assert.doesNotMatch(code, /jsr:@supabase/, `${name} must not import from jsr:`);
    if (/createClient\s*\(/.test(code)) {
      assert.match(code, /npm:@supabase\/supabase-js@2/,
        `${name} must import supabase-js from npm — this is what broke as "createClient is not defined"`);
    }
  }
});

test("the source files use the same working registry as the build output", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  for (const name of ["rb-notify", "rb-delete-account", "rb-turn-credentials"]) {
    const src = fs.readFileSync(path.join(root, "supabase/functions/src", name + ".ts"), "utf8");
    assert.doesNotMatch(src, /jsr:@supabase/, `src/${name}.ts must not import from jsr:`);
  }
});
