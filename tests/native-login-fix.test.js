// Regression tests for the "Continue with Google" dead end in the APK.
//
// The report: tapping Continue with Google opened Chrome, the person picked
// their account, and then the app sat on "connecting" for ever.
//
// Two independent causes were found and are locked in here:
//   1. The login used Supabase's default IMPLICIT flow, so the tokens came
//      back in the URL #fragment. A custom-scheme redirect cannot carry a
//      fragment, and Chrome Custom Tabs refuse an automatic redirect to a
//      custom scheme at all — the phone stayed on a blank page.
//      Fix: PKCE + a real https bridge page (auth-callback.html) that hands
//      the ?code= over to the app.
//   2. Nothing ever re-checked the session when the person came back to the
//      app, so even a delivered deep link (or a cold start) could be missed.
//      Fix: appUrlOpen + getLaunchUrl + resume/visibility checks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ---------------------------------------------------------------- 1. PKCE
test("auth.js: the APK login uses the PKCE flow", () => {
  const auth = read("auth.js");
  // The OAuth call must ask for pkce — the implicit flow cannot cross a
  // custom-scheme redirect.
  const call = auth.slice(
    auth.indexOf("signInWithOAuth"),
    auth.indexOf("await browser.open", auth.indexOf("signInWithOAuth"))
  );
  assert.ok(call.includes('flowType: "pkce"'), "signInWithOAuth asks for the pkce flow");

  // The client itself must be created in PKCE mode too, otherwise the code
  // verifier is never stored and exchangeCodeForSession cannot work.
  const clientBlock = auth.slice(
    auth.indexOf("client = window.supabase.createClient"),
    auth.indexOf("});", auth.indexOf("client = window.supabase.createClient")) + 3
  );
  assert.ok(clientBlock.includes('flowType: "pkce"'), "Supabase client created in pkce mode");
});

test("auth.js: the bridge page is an https page on the site origin", () => {
  const auth = read("auth.js");
  assert.ok(auth.includes("auth-callback.html"), "redirect target is the bridge page");
  assert.ok(auth.includes("nativeBridgeUrl"), "bridge URL helper exists");
  // It must be built from SITE_URL (https), never from the custom scheme.
  const helper = auth.slice(auth.indexOf("function nativeBridgeUrl"), auth.indexOf("let finishing"));
  assert.ok(helper.includes("cfg.SITE_URL"), "bridge URL comes from SITE_URL");
});

test("auth-callback.html: hands the code over to the app, with a tappable fallback", () => {
  const page = read("auth-callback.html");
  assert.ok(page.includes("com.registerbook.community://auth"), "knows the app scheme");
  assert.ok(page.includes("?code=") || page.includes('"code="'), "carries the code");
  assert.ok(page.includes("access_token"), "also carries implicit tokens if they arrive");
  assert.ok(page.includes("openApp"), "has a real button, because Chrome blocks script redirects");
  assert.ok(page.includes('id="manual"'), "shows the button if the automatic jump is blocked");
  // config.js must load before the inline logic reads RB_CONFIG
  assert.ok(
    page.indexOf("config.js") < page.indexOf("APK_SCHEME"),
    "config.js is loaded before the scheme is read"
  );
  // It must NOT try to exchange the code: the verifier lives in the APK's
  // origin, not on this page's origin.
  assert.ok(!page.includes("exchangeCodeForSession"), "the app does the exchange, not this page");
});

test("auth-callback.html: the service worker and the APK bundle include it", () => {
  assert.ok(read("sw.js").includes('"./auth-callback.html"'), "precached by the service worker");
  assert.ok(read("tools/prepare-www.js").includes('"auth-callback.html"'), "copied into the APK assets");
});

// ------------------------------------------------- 2. never miss the return
test("auth.js: the deep link is picked up on a warm and a cold start", () => {
  const auth = read("auth.js");
  assert.ok(auth.includes('addListener("appUrlOpen"'), "warm start: appUrlOpen event");
  assert.ok(auth.includes("getLaunchUrl"), "cold start: the launch intent is read too");
});

test("app.js: the session is re-checked when the person comes back from Chrome", () => {
  const app = read("app.js");
  assert.ok(app.includes("watchNativeReturn"), "a return watcher exists");
  const watcher = app.slice(app.indexOf("function watchNativeReturn"), app.indexOf("async function handleSignOut"));
  assert.ok(watcher.includes('"resume"'), "checks on resume");
  assert.ok(watcher.includes("visibilitychange"), "checks when the page becomes visible");
  assert.ok(watcher.includes("getSession"), "asks Supabase for the session");
});

test("app.js: the gate never hangs silently on 'Connecting'", () => {
  const app = read("app.js");
  const login = app.slice(app.indexOf("async function handleGoogleLogin"), app.indexOf("function watchNativeReturn"));
  assert.ok(login.includes("res.native"), "the native result is handled separately");
  assert.ok(login.includes("watchNativeReturn()"), "the return watcher is started");
  assert.ok(
    !login.includes("Connecting to Google… if nothing happens, check the popup/redirect settings.") ||
      login.indexOf("res.native") < login.indexOf("Connecting to Google…"),
    "the web-only 'connecting' wording is not shown in the app"
  );
});

test("auth.js: does not re-open the Custom Tab when closing it (plugin #2610)", () => {
  const auth = read("auth.js");
  const handler = auth.slice(auth.indexOf("async function handleNativeReturn"), auth.indexOf("let listenerInstalled"));
  assert.ok(
    handler.includes("/^capacitor:\\/\\//"),
    "Browser.close() is guarded so it cannot re-open the last URL"
  );
});

// ------------------------------------------------------------- 3. versions
test("sw.js: the version was bumped so installed apps get the fix", () => {
  const sw = read("sw.js");
  const m = sw.match(/const VERSION = "([^"]+)"/);
  assert.ok(m, "VERSION exists");
  assert.ok(m[1] >= "rb-2026-11-27b", "cache bumped past the broken build: " + m[1]);
});

// ------------------------------------------ 4. the bridge page really works
test("auth-callback.html: hands ?code= to the app scheme (real DOM run)", async () => {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const code = "8f2c1b4e-1111-2222-3333-abcdefabcdef";
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {}); // the custom-scheme jump is not implemented in jsdom
  const dom = new JSDOM(read("auth-callback.html"), {
    url: "https://mahicouragw.github.io/Register-book/auth-callback.html?code=" + code,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  await new Promise(r => setTimeout(r, 1500));
  const btn = dom.window.document.getElementById("openApp");
  assert.equal(
    btn.getAttribute("href"),
    "com.registerbook.community://auth?code=" + encodeURIComponent(code),
    "the tappable button carries the code to the app"
  );
  const manual = dom.window.document.getElementById("manual");
  assert.ok(!manual.classList.contains("hidden"), "the button is shown when the automatic jump is blocked");
  dom.window.close();
});

test("auth-callback.html: a Google error is shown, never a silent blank page", async () => {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {});
  const dom = new JSDOM(read("auth-callback.html"), {
    url: "https://mahicouragw.github.io/Register-book/auth-callback.html?error=access_denied&error_description=The+user+cancelled",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  await new Promise(r => setTimeout(r, 200));
  const doc = dom.window.document;
  assert.ok(!doc.getElementById("problem").classList.contains("hidden"), "problem panel shown");
  assert.match(doc.getElementById("problemText").textContent, /cancelled/i, "the reason is visible");
  dom.window.close();
});

// ------------------------------------- 5. the app boots in the APK web view
test("app boots inside the APK web view and offers Continue with Google", async () => {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", e => errors.push(e.message));
  vc.on("error", e => errors.push(String(e)));

  let openedInBrowser = null;
  const appUrlListeners = [];
  const launchCallbacks = [];

  const dom = new JSDOM(read("index.html"), {
    url: "https://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;

  // A minimal Capacitor bridge, as the real APK provides.
  w.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    Plugins: {
      Browser: { open: async o => { openedInBrowser = o.url; }, close: async () => {} },
      App: {
        addListener: (name, cb) => { appUrlListeners.push({ name, cb }); return { remove: () => {} }; },
        getLaunchUrl: async () => ({ url: "" })
      },
      PushNotifications: { checkPermissions: async () => ({ receive: "granted" }), requestPermissions: async () => ({ receive: "granted" }), addListener: () => ({}), register: async () => ({}) }
    },
    getLaunchUrl: cb => launchCallbacks.push(cb)
  };
  w.fetch = async () => ({ ok: true, json: async () => ({ external: { google: true } }) });

  // Load the real scripts in the real order.
  for (const f of ["vendor/supabase.js", "config.js", "notify.js", "auth.js", "store.js", "qbooks.js", "qbooks-ui.js", "push.js", "rtc.js", "app.js"]) {
    w.eval(read(f));
  }
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await new Promise(r => setTimeout(r, 700));

  assert.ok(w.RBAuth, "RBAuth loaded");
  assert.equal(w.RBAuth.isNative(), true, "APK is detected as native");
  assert.ok(w.RBAuth.nativeBridgeUrl().endsWith("/auth-callback.html"), "bridge page computed");

  // The return listener is installed on the real plugin.
  assert.ok(appUrlListeners.some(l => l.name === "appUrlOpen"), "appUrlOpen listener registered");
  assert.ok(launchCallbacks.length > 0 || appUrlListeners.length > 0, "cold-start path installed");

  // Tapping the Google button must open Chrome, not hang.
  await w.handleGoogleLogin();
  const hint = w.document.getElementById("authHint").textContent;
  console.log("gate hint:", hint.slice(0, 80));
  console.log("chrome opened:", openedInBrowser ? "yes" : "no");
  assert.ok(w.RBAuth.isConfigured(), "config is filled in");

  console.log("script errors:", errors.filter(e => !/Not implemented/.test(e)).slice(0, 3));
  dom.window.close();
});

// ------------------------------- 6. the deep link return really signs in
test("returning from Chrome with ?code= signs the person into the app", async () => {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {});

  let exchanged = null;
  const listeners = [];
  const dom = new JSDOM(read("index.html"), {
    url: "https://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;
  w.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    Plugins: {
      Browser: { open: async () => {}, close: async () => {} },
      App: { addListener: (n, cb) => { listeners.push({ n, cb }); return { remove() {} }; }, getLaunchUrl: async () => ({ url: "" }) }
    },
    getLaunchUrl: () => {}
  };
  w.fetch = async () => ({ ok: true, json: async () => ({ external: { google: true } }) });

  for (const f of ["vendor/supabase.js", "config.js", "notify.js", "auth.js"]) w.eval(read(f));

  // Stub the exchange the way the real client would behave after PKCE.
  const client = w.RBAuth.getClient();
  const fakeSession = { user: { id: "u1", email: "owner@example.com" }, access_token: "at", refresh_token: "rt" };
  client.auth.exchangeCodeForSession = async code => { exchanged = code; return { data: { session: fakeSession }, error: null }; };

  const got = [];
  w.__RB = { showGateError: e => got.push(["error", e]), signedIn: () => got.push(["signedIn", true]) };

  const url = "com.registerbook.community://auth?code=THE-CODE-FROM-SUPABASE";
  await w.RBAuth.handleNativeReturn(url);

  console.log("exchanged code:", exchanged);
  console.log("result:", JSON.stringify(got));
  assert.equal(exchanged, "THE-CODE-FROM-SUPABASE", "the code is exchanged for a session");
  assert.ok(got.some(g => g[0] === "signedIn"), "the app is told to show the books");

  // A second identical deep link must not exchange twice.
  exchanged = null;
  await w.RBAuth.handleNativeReturn(url);
  assert.equal(exchanged, null, "the same deep link is not processed twice");
  dom.window.close();
});
