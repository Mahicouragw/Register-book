// RegisterBook — Supabase Config
// REPLACE THESE TWO VALUES with your NEW RegisterBook project.
// You will create a NEW project (do NOT reuse Blind-Quiz zchircgdkyjnowqcdwvf).
// Dashboard → Project Settings → API → copy URL + anon public key.
// Then paste below and redeploy.
window.RB_CONFIG = {
  // Example: "https://abcdefghijkl.supabase.co"
  SUPABASE_URL: "https://REPLACE_WITH_NEW_REGISTERBOOK_URL.supabase.co",
  // Example anon key: "eyJh..." (publishable, public — safe in browser)
  SUPABASE_ANON_KEY: "REPLACE_WITH_NEW_ANON_KEY",
  // For redirect allow-list check
  SITE_URL: "https://mahicouragw.github.io/Register-book/",
  // Helper: is config still placeholder?
  isConfigured() {
    return this.SUPABASE_URL && !this.SUPABASE_URL.includes("REPLACE") && this.SUPABASE_ANON_KEY && !this.SUPABASE_ANON_KEY.includes("REPLACE");
  }
};
