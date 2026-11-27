// auth.js — Supabase Auth (Google) for RegisterBook
// Only the publishable (anon) key from config.js is used. No secrets here.
(function () {
  "use strict";
  const cfg = window.RB_CONFIG || {};
  let client = null;
  let initError = "";

  function isConfigured() {
    const url = String(cfg.SUPABASE_URL || "");
    const key = String(cfg.SUPABASE_ANON_KEY || "");
    return !!url && !!key && !/REPLACE/i.test(url) && !/REPLACE/i.test(key);
  }

  // ------------------------------------------------------------ Android app
  // Inside the APK (Capacitor), Google refuses OAuth in the built-in web
  // view. So login runs in Chrome, and control comes back to the app:
  //
  //   app  --Browser.open-->  Chrome Custom Tab
  //        Supabase /authorize -> accounts.google.com -> user picks account
  //        Supabase /callback  -> 302 to auth-callback.html (our own page!)
  //   auth-callback.html     -> 302 to com.registerbook.community://auth?code=...
  //   Android starts MainActivity (singleTask) + drops the Custom Tab
  //   app  --App 'appUrlOpen' / getLaunchUrl-->  exchangeCodeForSession
  //
  // WHY the intermediate page: Chrome Custom Tabs BLOCK an automatic
  // (server 302 / JavaScript) jump straight from a web page to a custom
  // scheme like com.registerbook.community://. That block is exactly what
  // made the phone sit on "connecting" forever. auth-callback.html is a
  // real https page AND, being on the same origin as the app, it is the
  // only place where the PKCE verifier (kept in this web view's
  // localStorage) also exists — so the exchange is guaranteed to work.
  function isNative() {
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === "function") {
        return !!window.Capacitor.isNativePlatform();
      }
      // Fallback: the native web view is served from https://localhost
      // (or capacitor://localhost). The website is never on that host.
      const host = String(location.hostname || "");
      return (location.protocol === "capacitor:" || host === "localhost") &&
        !!(window.Capacitor && (window.Capacitor.Plugins || typeof window.Capacitor.getPlugin === "function"));
    } catch (e) { return false; }
  }
  function nativePlugin(name) {
    try {
      const cap = window.Capacitor;
      if (cap && cap.Plugins && cap.Plugins[name]) return cap.Plugins[name];
      if (cap && typeof cap.getPlugin === "function") return cap.getPlugin(name) || null;
    } catch (e) {}
    return null;
  }
  function nativeRedirect() {
    return String(cfg.NATIVE_REDIRECT || "com.registerbook.community://auth");
  }
  // The https page that bounces the browser back into the app.
  function nativeBridgeUrl() {
    const base = String(cfg.SITE_URL || "").replace(/\/+$/, "");
    return base ? base + "/auth-callback.html" : "";
  }

  let finishing = false;   // an exchange is in flight — avoid doing it twice
  let lastHandled = "";    // the deep link we already looked at

  function gateHint(html) {
    try {
      const el = document.getElementById("authHint");
      if (el) {
        el.className = "gate-hint ok";
        el.innerHTML = html;
      }
    } catch (e) {}
  }

  // Called when Chrome returns the login to the app (deep link), both from
  // App 'appUrlOpen' (warm start) and getLaunchUrl (cold start).
  // Handles the PKCE code (?code=...) and the implicit tokens (#access_token).
  async function handleNativeReturn(url) {
    if (!url || finishing) return;
    const c = getClient();
    if (!c) return;
    if (url === lastHandled) return;
    lastHandled = url;
    finishing = true;
    gateHint("Completing sign-in…");

    const browser = nativePlugin("Browser");
    // Do NOT call Browser.close() here: on Android the deep link already
    // removed the Custom Tab, and close() would re-open it (plugin #2610).
    if (browser && typeof browser.close === "function" && /^capacitor:\/\//.test(location.protocol)) {
      try { await browser.close(); } catch (e) {}
    }

    let parsed = null;
    try { parsed = new URL(url); } catch (e) { finishing = false; return; }
    const params = parsed.searchParams;
    const hashParams = new URLSearchParams((parsed.hash || "").replace(/^#/, ""));

    const err = params.get("error") || hashParams.get("error");
    if (err) {
      finishing = false;
      const desc = params.get("error_description") || hashParams.get("error_description") || err;
      if (window.__RB && typeof window.__RB.showGateError === "function") {
        window.__RB.showGateError(friendly({ message: desc, code: err }));
      }
      return;
    }

    let session = null;
    const code = params.get("code") || hashParams.get("code");
    if (code && typeof c.auth.exchangeCodeForSession === "function") {
      try {
        const res = await c.auth.exchangeCodeForSession(code);
        session = res && res.data ? res.data.session : null;
      } catch (e) { session = null; }
      if (!session) {
        // Try the other storage area: Chrome hands the code straight to the
        // app only if the intermediate page redirect already happened; if it
        // came from a browser where the verifier was never stored, the
        // resetPasswordForEmail-less fallback is not possible — tell the truth.
        const after = await getSession();
        session = after || null;
      }
    }
    if (!session) {
      // A bare "com.registerbook.community://auth" (no ?code=) also arrives
      // when the intermediate page already finished the login on its origin.
      // getSession() above may have returned nothing in that case only
      // because storage had not been written yet — check once more below.
      const accessToken = hashParams.get("access_token") || params.get("access_token");
      const refreshToken = hashParams.get("refresh_token") || params.get("refresh_token");
      if (accessToken && refreshToken && typeof c.auth.setSession === "function") {
        try {
          const res = await c.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          session = res && res.data ? res.data.session : null;
        } catch (e) { session = null; }
      }
    }
    finishing = false;
    if (session) {
      gateHint("Signed in — opening your books…");
      // onAuthStateChange in app.js also calls this; it is guarded against
      // being run twice (loadingCloud flag).
      if (window.__RB && typeof window.__RB.signedIn === "function") window.__RB.signedIn();
    } else if (window.__RB && typeof window.__RB.showGateError === "function") {
      window.__RB.showGateError({
        title: "Google finished, but the app could not finish signing in",
        message: "The login code did not match this phone's sign-in attempt. Tap “Continue with Google” once more.",
        steps: []
      });
    }
  }

  let listenerInstalled = false;
  function listenNativeReturn() {
    if (!isNative()) return;
    const app = nativePlugin("App");
    if (!app || typeof app.addListener !== "function") return;
    if (listenerInstalled) return;
    listenerInstalled = true;
    try {
      app.addListener("appUrlOpen", ev => {
        const url = ev && (ev.url || ev.href || "");
        if (url) handleNativeReturn(url);
      });
    } catch (e) {}
    // Cold start: the app was killed while Chrome had the login. The URL is
    // not delivered as an event, it is the launch intent.
    try {
      if (window.Capacitor && typeof window.Capacitor.getLaunchUrl === "function") {
        window.Capacitor.getLaunchUrl((res, err2) => {
          if (!err2 && res && res.url) handleNativeReturn(res.url);
        }, {});
      } else if (typeof app.getLaunchUrl === "function") {
        app.getLaunchUrl().then(res => { if (res && res.url) handleNativeReturn(res.url); }).catch(() => {});
      }
    } catch (e) {}
  }

  function projectRef() {
    try { return new URL(cfg.SUPABASE_URL).host.split(".")[0]; } catch (e) { return "<YOUR_PROJECT_REF>"; }
  }

  function getClient() {
    if (client) return client;
    if (!isConfigured()) return null;
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      initError = "The bundled Supabase library (vendor/supabase.js) did not load.";
      return null;
    }
    try {
      const native = isNative();
      const bridge = nativeBridgeUrl();
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // PKCE everywhere. In the APK the code is exchanged explicitly in
          // handleNativeReturn(), so let the library parse the URL only on
          // the intermediate page (the one host that has the verifier).
          flowType: "pkce",
          detectSessionInUrl: !native || (!!bridge && location.href.indexOf(bridge) === 0)
        }
      });
      return client;
    } catch (e) {
      initError = e && e.message ? e.message : String(e);
      return null;
    }
  }

  function cleanUrl() {
    try {
      const base = window.location.origin + window.location.pathname;
      window.history.replaceState(null, "", base);
    } catch (e) { /* ignore */ }
  }

  function friendly(err) {
    const raw = (err && (err.message || err.error_description || err.msg)) || String(err || "");
    const code = (err && (err.code || err.error)) || "";
    const all = (raw + " " + code).toLowerCase();
    const ref = projectRef();
    const providerUrl = `https://supabase.com/dashboard/project/${ref}/auth/providers`;

    if (all.includes("provider is not enabled") || all.includes("unsupported provider") || all.includes("validation_failed")) {
      return {
        kind: "provider",
        title: "Google sign-in isn't switched on in Supabase yet",
        message: "Your site and database are ready, but the Google provider has not been enabled in the Supabase dashboard yet. Demo mode works right now.",
        steps: [
          `Open <a href="${providerUrl}" target="_blank" rel="noopener">Supabase → Authentication → Providers → Google</a>`,
          "Turn on <b>Enable Sign in with Google</b>",
          "Paste your Google <b>Client ID</b> and <b>Client Secret</b> (you create them in Google Cloud Console — the button below shows exactly how)"
        ]
      };
    }
    if (all.includes("redirect_uri_mismatch") || all.includes("redirect url") || all.includes("invalid redirect")) {
      return {
        kind: "redirect",
        title: "The Google redirect address does not match",
        message: `Google must allow exactly: <code>https://${ref}.supabase.co/auth/v1/callback</code>. Also add this site to Supabase → Authentication → URL Configuration.`,
        steps: [
          `Google Cloud Console → <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a> → your Web OAuth client`,
          `Authorized redirect URI: <code>https://${ref}.supabase.co/auth/v1/callback</code>`,
          `Authorized JavaScript origin: <code>${window.location.origin}</code>`,
          `Supabase → <a href="https://supabase.com/dashboard/project/${ref}/auth/url-configuration" target="_blank" rel="noopener">Authentication → URL Configuration</a> → add this page to Redirect URLs`
        ]
      };
    }
    if (all.includes("missing oauth secret") || all.includes("client secret") || all.includes("client id")) {
      return {
        kind: "secret",
        title: "Google Client ID / Secret is missing in Supabase",
        message: "Paste them yourself in the Supabase dashboard — never share the secret in chat.",
        steps: [
          `Create the OAuth client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console → Credentials</a>`,
          `Open <a href="${providerUrl}" target="_blank" rel="noopener">Supabase → Authentication → Providers → Google</a>`,
          "Paste Client ID and Client Secret there, then Save"
        ]
      };
    }
    if (all.includes("access_denied")) {
      return { kind: "cancelled", title: "Sign-in cancelled", message: "You closed the Google window before finishing. Tap “Continue with Google” again when ready." };
    }
    if (all.includes("invalid api key") || all.includes("no api key") || all.includes("api key")) {
      return {
        kind: "config",
        title: "The Supabase publishable key looks wrong",
        message: "Copy the Project URL and the publishable (anon) key from Supabase → Project Settings → API into config.js, then redeploy.",
        steps: []
      };
    }
    return { kind: "unknown", title: "Google sign-in could not start", message: raw || "Unknown error.", steps: [] };
  }

  function parseUrlError() {
    let params = null;
    if (window.location.hash && window.location.hash.length > 1) {
      params = new URLSearchParams(window.location.hash.slice(1));
    }
    const search = new URLSearchParams(window.location.search || "");
    const err = (params && params.get("error")) || search.get("error");
    if (!err) return null;
    const desc = (params && params.get("error_description")) || search.get("error_description") || "";
    const code = (params && params.get("error_code")) || "";
    cleanUrl();
    return friendly({ message: desc || err, code: code || err });
  }

  async function getSession() {
    const c = getClient();
    if (!c) return null;
    try {
      const { data, error } = await c.auth.getSession();
      if (error) return null;
      return data.session || null;
    } catch (e) { return null; }
  }

  async function signInGoogle() {
    if (!isConfigured()) {
      return {
        ok: false,
        error: {
          kind: "not-configured",
          title: "Google login is not connected yet",
          message: "config.js still has placeholder values. Create the new RegisterBook Supabase project, paste its URL and publishable key into config.js, then Google sign-in starts working.",
          steps: [
            "Open <a href=\"https://supabase.com/dashboard\" target=\"_blank\" rel=\"noopener\">supabase.com/dashboard</a> and select your <b>RegisterBook</b> project (not Blind quiz)",
            "Project Settings → API → copy <b>Project URL</b> and <b>publishable/anon key</b>",
            "Send those two public values to me so I can put them in config.js",
            "Then enable Google in Authentication → Providers (the page will show the exact clicks)"
          ]
        }
      };
    }
    const c = getClient();
    if (!c) {
      return { ok: false, error: { kind: "lib", title: "Supabase library did not load", message: initError || "vendor/supabase.js is missing.", steps: [] } };
    }
    // Ask Supabase which providers are enabled. If Google is off, show the exact
    // steps instead of navigating the phone to a raw JSON error page.
    try {
      const base = String(cfg.SUPABASE_URL).replace(/\/$/, "");
      const res = await fetch(base + "/auth/v1/settings", {
        headers: { apikey: String(cfg.SUPABASE_ANON_KEY || "") }
      });
      if (res && res.ok) {
        const settings = await res.json();
        const external = (settings && settings.external) || {};
        if (external.google === false) {
          return {
            ok: false,
            error: {
              kind: "provider",
              title: "Google sign-in is not switched on yet",
              message: "Your Supabase project and database are connected ✓ — only the Google provider is still off. Demo mode works right now.",
              steps: [
                `Create the OAuth client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console → Credentials</a> (Web application). Redirect URI: <code>https://${projectRef()}.supabase.co/auth/v1/callback</code>`,
                `Open <a href="https://supabase.com/dashboard/project/${projectRef()}/auth/providers" target="_blank" rel="noopener">Supabase → Authentication → Providers → Google</a> and turn it <b>on</b>`,
                "Paste the Client ID and Client Secret there (only in the Supabase dashboard) and press Save",
                "Come back and tap “Continue with Google” again"
              ]
            }
          };
        }
      }
    } catch (e) { /* offline / blocked — fall through to the normal redirect */ }

    // ---- Android app: open Chrome for the login, return via deep link ----
    if (isNative()) {
      const browser = nativePlugin("Browser");
      if (!browser || typeof browser.open !== "function") {
        return { ok: false, error: { kind: "lib", title: "Browser plugin missing", message: "The APK is missing the Browser plugin. Rebuild the APK (npx cap sync android).", steps: [] } };
      }
      try {
        // flowType "pkce" is essential: the plain (implicit) flow returns the
        // tokens in the #fragment of the URL, which a server-side 302 to a
        // custom scheme can never carry — the phone would sit on a blank
        // page forever. With PKCE Supabase sends ?code=... instead.
        const { data, error } = await c.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: nativeRedirect(),
            skipBrowserRedirect: true,
            flowType: "pkce",
            queryParams: { prompt: "select_account" }
          }
        });
        if (error) return { ok: false, error: friendly(error) };
        if (!data || !data.url) return { ok: false, error: friendly(new Error("Supabase did not return a login URL.")) };
        // Remember what we asked Supabase for, so Settings → Diagnostics can
        // show it if the login ever stalls again.
        try {
          localStorage.setItem("rb_last_oauth", JSON.stringify({
            at: new Date().toISOString(),
            redirectTo: nativeRedirect(),
            bridge: nativeBridgeUrl(),
            flow: "pkce",
            url: String(data.url).slice(0, 400)
          }));
        } catch (e) {}
        await browser.open({ url: data.url });
        return { ok: true, native: true };
      } catch (e) {
        return { ok: false, error: friendly(e) };
      }
    }

    try {
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await c.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, queryParams: { prompt: "select_account" } }
      });
      if (error) return { ok: false, error: friendly(error) };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: friendly(e) };
    }
  }

  async function signOut() {
    const c = getClient();
    if (c) {
      try { await c.auth.signOut(); } catch (e) { /* ignore */ }
    }
    try { localStorage.removeItem("rb_demo_user"); } catch (e) {}
  }

  function onChange(cb) {
    const c = getClient();
    if (!c) return function () {};
    const { data } = c.auth.onAuthStateChange((event, session) => {
      setTimeout(() => cb(event, session), 0);
    });
    return function () { if (data && data.subscription) data.subscription.unsubscribe(); };
  }

  async function init() {
    listenNativeReturn();
    const urlError = parseUrlError();
    const c = getClient();
    if (!c) return { client: null, session: null, urlError };
    const session = await getSession();
    return { client: c, session, urlError };
  }

  window.RBAuth = {
    isConfigured,
    getClient,
    getSession,
    signInGoogle,
    signOut,
    onChange,
    init,
    friendly,
    projectRef,
    cleanUrl,
    isNative,
    nativeBridgeUrl,
    handleNativeReturn
  };
})();
