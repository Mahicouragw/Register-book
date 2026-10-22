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
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
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
    cleanUrl
  };
})();
