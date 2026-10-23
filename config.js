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
// Project: "RegisterBook" (ref tmkpdvljhnlnvbckbnsc, Mumbai ap-south-1).
// While the values below still contain REPLACE, Google login shows a friendly
// "not connected yet" message and the full demo mode keeps working.
window.RB_CONFIG = {
  SUPABASE_URL: "https://tmkpdvljhnlnvbckbnsc.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_A1EprlCSXwkWPY7Aboww5A_DuTSoJ9x",

  // Where the app lives (used in the setup instructions shown in the app)
  SITE_URL: "https://mahicouragw.github.io/Register-book/",

  // ------------------------------------------------------------ Web Push
  // The PUBLIC half of the VAPID key pair. It is meant to be published: the
  // browser uses it to create a push subscription.
  //
  // The matching PRIVATE key lives only as a Supabase secret called
  //   RB_VAPID_PRIVATE_KEY
  // inside the rb-notify Edge Function. It is not in this repo and must never
  // be pasted into Git or into chat.
  VAPID_PUBLIC_KEY: "BOulBV26fO2TPgsIOQw6uHVhM04OAio62acpiSpi69HuinwNVh6nsyZZzspPRAcureEdj1wVTsnyNbfpdarI5Sk",

  // Web Push needs a mailto/https contact address for the VAPID claim.
  VAPID_SUBJECT: "mailto:numbersareplaying@gmail.com",

  // Names of the Edge Functions (they live in supabase/functions/).
  EDGE_NOTIFY: "rb-notify",
  EDGE_DELETE_ACCOUNT: "rb-delete-account",

  // True only when both public values are filled in
  isConfigured() {
    const url = String(this.SUPABASE_URL || "");
    const key = String(this.SUPABASE_ANON_KEY || "");
    return !!url && !!key && !/REPLACE/i.test(url) && !/REPLACE/i.test(key);
  },

  // The rb-notify Edge Function URL, or "" when the project is not set up.
  edgeUrl(name) {
    if (!this.isConfigured()) return "";
    const base = String(this.SUPABASE_URL).replace(/\/+$/, "");
    return `${base}/functions/v1/${name || this.EDGE_NOTIFY}`;
  },

  // Project ref parsed from the URL (used to show exact dashboard links)
  projectRef() {
    try { return new URL(this.SUPABASE_URL).host.split(".")[0]; } catch (e) { return ""; }
  }
};
