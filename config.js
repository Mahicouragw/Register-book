// RegisterBook — Supabase config (PUBLIC values only)
//
// Fill these two values from your NEW RegisterBook Supabase project:
//   Supabase Dashboard → Project Settings → API
//     • Project URL        (looks like https://abcdefghijk.supabase.co)
//     • publishable / anon key  (safe to publish in the browser)
//
// NEVER put a service_role / secret key in this file, in Git, or in chat.
// Do NOT use the Blind-Quiz project (zchircgdkyjnowqcdwvf).
//
// While the values below still contain REPLACE, Google login shows a friendly
// "not connected yet" message and the full demo mode keeps working.
window.RB_CONFIG = {
  SUPABASE_URL: "https://REPLACE_WITH_NEW_REGISTERBOOK_URL.supabase.co",
  SUPABASE_ANON_KEY: "REPLACE_WITH_NEW_ANON_KEY",

  // Where the app lives (used in the setup instructions shown in the app)
  SITE_URL: "https://mahicouragw.github.io/Register-book/",

  // True only when both public values are filled in
  isConfigured() {
    const url = String(this.SUPABASE_URL || "");
    const key = String(this.SUPABASE_ANON_KEY || "");
    return !!url && !!key && !/REPLACE/i.test(url) && !/REPLACE/i.test(key);
  },

  // Project ref parsed from the URL (used to show exact dashboard links)
  projectRef() {
    try { return new URL(this.SUPABASE_URL).host.split(".")[0]; } catch (e) { return ""; }
  }
};
