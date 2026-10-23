// Tests for the real-config behaviour of auth.js:
//  • configured project → gate says "Connected ✓"
//  • Google provider still off → friendly, click-by-click message (no JSON page)
//  • Google provider on → the OAuth redirect is started
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function boot({ googleEnabled, fetchFails = false, realConfig = true }) {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "https://mahicouragw.github.io/Register-book/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  let navigatedTo = null;
  w.fetch = async (url) => {
    if (fetchFails) throw new Error("network blocked");
    if (String(url).includes("/auth/v1/settings")) {
      return { ok: true, status: 200, json: async () => ({ external: { google: !!googleEnabled, email: true } }) };
    }
    if (String(url).includes("/rest/v1/")) {
      return { ok: false, status: 401, json: async () => ({ message: "permission denied" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  // minimal supabase client stub
  w.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithOAuth: async ({ provider, options }) => {
          navigatedTo = `https://tmkpdvljhnlnvbckbnsc.supabase.co/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(options.redirectTo)}`;
          return { data: {}, error: null };
        },
        signOut: async () => ({})
      },
      from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) })
    })
  };
  if (realConfig) {
    w.eval(fs.readFileSync(path.join(ROOT, "config.js"), "utf8"));
  } else {
    w.RB_CONFIG = { SUPABASE_URL: "https://REPLACE.supabase.co", SUPABASE_ANON_KEY: "REPLACE", isConfigured: () => false, SITE_URL: "https://x", projectRef: () => "" };
  }
  w.eval(fs.readFileSync(path.join(ROOT, "notify.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "auth.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "store.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "push.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "rtc.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
  return { dom, w, doc: w.document, nav: () => navigatedTo };
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test("config.js carries the real project URL and only a publishable key", () => {
  const src = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  assert.match(src, /https:\/\/tmkpdvljhnlnvbckbnsc\.supabase\.co/);
  assert.match(src, /sb_publishable_/);
  // only inspect real string literals, not warning comments
  const literals = [...src.matchAll(/"([^"]*)"/g)].map(m => m[1]);
  assert.ok(literals.some(v => /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(v)), "project URL literal present");
  assert.ok(!literals.some(v => /^eyJ/.test(v)), "no legacy JWT key literal in the repo");
  assert.ok(!literals.some(v => /sb_secret_/.test(v)), "no secret key literal in the repo");
  assert.ok(!literals.some(v => /service_role/.test(v)), "no service_role key literal in the repo");
  assert.equal(/REPLACE_WITH_NEW/.test(src), false, "placeholders are gone");
});

test("configured project: login gate says it is connected", async () => {
  const { dom, w, doc } = boot({ googleEnabled: true });
  await w.__RB.boot();
  const hint = doc.getElementById("authHint");
  assert.equal(w.RBAuth.isConfigured(), true);
  assert.match(hint.textContent, /Sign in with Google to sync/i);
  assert.equal(hint.classList.contains("ok"), true);
  dom.window.close();
});

test("Google provider still off: friendly steps instead of a JSON error page", async () => {
  const { dom, w, doc, nav } = boot({ googleEnabled: false });
  await w.__RB.boot();
  doc.getElementById("googleLoginBtn").click();
  await tick(30);
  const hint = doc.getElementById("authHint");
  assert.match(hint.textContent, /Google sign-in is not switched on yet/i);
  assert.match(hint.textContent, /project and database are connected/i);
  assert.match(hint.textContent, /Providers → Google/i);
  assert.equal(hint.classList.contains("err"), true);
  const links = [...hint.querySelectorAll("a")].map(a => a.href);
  assert.ok(links.some(h => h.includes("console.cloud.google.com")), "Google Cloud link shown");
  assert.ok(links.some(h => h.includes("/auth/providers")), "Supabase provider link shown");
  assert.match(hint.textContent, /https:\/\/tmkpdvljhnlnvbckbnsc\.supabase\.co\/auth\/v1\/callback/, "exact redirect URI shown");
  assert.equal(nav(), null, "no navigation happened");
  dom.window.close();
});

test("Google provider on: OAuth redirect is started with the right redirect_to", async () => {
  const { dom, w, doc, nav } = boot({ googleEnabled: true });
  await w.__RB.boot();
  doc.getElementById("googleLoginBtn").click();
  await tick(30);
  const url = nav();
  assert.ok(url, "signInWithOAuth was called");
  assert.match(decodeURIComponent(url), /redirect_to=https:\/\/mahicouragw\.github\.io\/Register-book\//);
  dom.window.close();
});

test("settings probe failing (offline) does not block sign-in", async () => {
  const { dom, w, doc, nav } = boot({ googleEnabled: false, fetchFails: true });
  await w.__RB.boot();
  doc.getElementById("googleLoginBtn").click();
  await tick(30);
  assert.ok(nav(), "still attempts the OAuth redirect when the probe fails");
  dom.window.close();
});

test("demo still works with the real config present", async () => {
  const { dom, w, doc } = boot({ googleEnabled: false });
  await w.__RB.boot();
  doc.querySelector('#gateDemoChips .demo-chip[onclick*="goldfish"]').click();
  await tick(30);
  assert.equal(w.RBStore.isDemo(), true);
  assert.equal(doc.getElementById("appShell").classList.contains("show"), true);
  assert.match(doc.getElementById("accountCard").textContent, /Goldfish/);
  dom.window.close();
});

test("connection check: reports the Google provider as OFF and the DB as locked", async () => {
  const { dom, w, doc } = boot({ googleEnabled: false });
  await w.__RB.boot();
  w.openSetupModal();
  await w.runDiagnostics();
  await tick(20);
  const report = doc.querySelector("#diagBox .diag").textContent;
  assert.match(report, /PASS {2}config\.js/);
  assert.match(report, /FAIL {2}.*Google provider is OFF/, "provider OFF is reported");
  assert.match(report, /PASS {2}Database reachable and locked/, "anon access blocked is reported as correct");
  assert.match(report, /auth\/v1\/callback/, "exact redirect URI included");
  assert.match(doc.getElementById("diagBox").textContent, /1 thing needs fixing/);
  dom.window.close();
});

test("connection check: all green when the provider is ON", async () => {
  const { dom, w, doc } = boot({ googleEnabled: true });
  await w.__RB.boot();
  w.openSetupModal();
  await w.runDiagnostics();
  await tick(20);
  const report = doc.querySelector("#diagBox .diag").textContent;
  assert.match(report, /PASS {2}Supabase auth reachable — Google provider is ON/);
  assert.doesNotMatch(report, /FAIL/);
  assert.match(doc.getElementById("diagBox").textContent, /Everything checks out/);
  dom.window.close();
});

test("connection check: unreachable network is reported clearly", async () => {
  const { dom, w, doc } = boot({ googleEnabled: false, fetchFails: true });
  await w.__RB.boot();
  w.openSetupModal();
  await w.runDiagnostics();
  await tick(20);
  const report = doc.querySelector("#diagBox .diag").textContent;
  assert.match(report, /FAIL {2}Cannot reach .* from this browser/);
  assert.match(report, /FAIL {2}Database check failed/);
  dom.window.close();
});

test("cloud init with no session falls back to the gate (not a fake login)", async () => {
  const { dom, w, doc } = boot({ googleEnabled: false });
  await w.__RB.boot();
  assert.equal(doc.getElementById("appShell").classList.contains("show"), false);
  assert.equal(doc.getElementById("loginGate").classList.contains("hidden"), false);
  dom.window.close();
});
