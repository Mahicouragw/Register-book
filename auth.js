// auth.js — Supabase Auth for RegisterBook
// Never stores secrets — only publishable anon key from config.js
let supa = null;
let currentAuthUser = null;

function initSupabase() {
  if (!window.RB_CONFIG || !window.RB_CONFIG.isConfigured()) {
    console.warn("[Auth] Supabase not configured yet — demo mode only. Replace config.js values.");
    return null;
  }
  if (supa) return supa;
  try {
    supa = window.supabase.createClient(window.RB_CONFIG.SUPABASE_URL, window.RB_CONFIG.SUPABASE_ANON_KEY);
    return supa;
  } catch (e) {
    console.error("[Auth] Failed to create Supabase client", e);
    return null;
  }
}

async function refreshAuthUI() {
  const gate = document.getElementById("loginGate");
  const app = document.getElementById("appShell");
  const card = document.getElementById("accountCard");
  const googleBtn = document.getElementById("googleLoginBtn");
  const authHint = document.getElementById("authHint");
  const modeBadge = document.getElementById("modeBadge");

  // If we have a real Supabase session, show real user
  if (supa) {
    const { data } = await supa.auth.getSession();
    const session = data?.session;
    if (session && session.user) {
      currentAuthUser = session.user;
      const meta = session.user.user_metadata || {};
      card.innerHTML = `
        <img src="${meta.avatar_url || meta.picture || 'https://i.pravatar.cc/100?u='+encodeURIComponent(session.user.email)}" class="acct-avatar" alt="">
        <div class="acct-info">
          <div class="acct-name">${escapeHtml(meta.full_name || meta.name || session.user.email.split('@')[0])} <span class="real-badge">Google ✓</span></div>
          <div class="acct-email">${escapeHtml(session.user.email)}</div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="handleSignOut()">Sign out</button>
      `;
      modeBadge.textContent = "Real account";
      modeBadge.className = "mode-badge mode-real";
      if (gate) gate.style.display = "none";
      if (app) app.style.display = "flex";
      // Load Supabase data then render
      if (typeof loadFromSupabase === "function") await loadFromSupabase(session.user);
      if (typeof renderAll === "function") renderAll();
      return;
    }
  }

  // Check demo session (localStorage)
  const demoUserId = localStorage.getItem("rb_demo_user");
  if (demoUserId && typeof getDemoUser === "function" && getDemoUser(demoUserId)) {
    currentAuthUser = null;
    const u = getDemoUser(demoUserId);
    card.innerHTML = `
      <img src="${u.avatar}" class="acct-avatar" alt="">
      <div class="acct-info">
        <div class="acct-name">${escapeHtml(u.name)} <span class="demo-badge">Demo</span></div>
        <div class="acct-email">${escapeHtml(u.email)}</div>
      </div>
      <button class="btn btn-sm btn-ghost" onclick="exitDemo()">Exit demo</button>
    `;
    modeBadge.textContent = "Demo mode";
    modeBadge.className = "mode-badge mode-demo";
    if (gate) gate.style.display = "none";
    if (app) app.style.display = "flex";
    return;
  }

  // Not logged in — show gate
  currentAuthUser = null;
  if (gate) gate.style.display = "flex";
  if (app) app.style.display = "none";
  if (authHint) {
    if (!window.RB_CONFIG.isConfigured()) {
      authHint.innerHTML = `⚠️ Google login not connected yet. Create your NEW Supabase project (name it <b>RegisterBook</b>), then tell the builder. Demo mode works now — click “Try the demo”.<br>
      <details style="margin-top:6px"><summary>Setup steps (you do this)</summary>
        <ol style="text-align:left;margin:6px 0 0 18px;line-height:1.5">
          <li>Google Cloud Console → Create OAuth Client → Authorized redirect: <code>https://&lt;YOUR_NEW_REF&gt;.supabase.co/auth/v1/callback</code></li>
          <li>JS origins: <code>https://mahicouragw.github.io</code> + your preview URL</li>
          <li>Supabase Dashboard → Auth → Providers → Google → Enable → paste Client ID & Secret</li>
          <li>Supabase Auth → URL Config → Site URL: <code>https://mahicouragw.github.io/Register-book/</code> → Add redirect allow-list: that URL + preview/localhost</li>
        </ol>
      </details>`;
    } else {
      authHint.textContent = "Sign in with Google to sync across phones. Or try demo — no account needed.";
    }
  }
}

async function handleGoogleLogin() {
  const hint = document.getElementById("authHint");
  if (!window.RB_CONFIG.isConfigured()) {
    if (hint) hint.innerHTML = `Google login is not set up yet — config.js still has REPLACE placeholders. Create your NEW RegisterBook Supabase project and update config.js. For now use <b>Try the demo</b> below.`;
    return;
  }
  initSupabase();
  if (!supa) {
    if (hint) hint.textContent = "Supabase client failed to init. Check config.js values.";
    return;
  }
  const redirectTo = window.location.href.split("?")[0].split("#")[0];
  const { error } = await supa.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo }
  });
  if (error) {
    if (hint) hint.textContent = "Google login error: " + error.message;
    console.error(error);
  }
}

async function handleSignOut() {
  if (supa) await supa.auth.signOut();
  currentAuthUser = null;
  localStorage.removeItem("rb_demo_user");
  await refreshAuthUI();
  // reload to clear state
  if (typeof resetDemoView === "function") resetDemoView();
}

function enterDemo(userId) {
  if (!userId) userId = "mahi";
  localStorage.setItem("rb_demo_user", userId);
  if (typeof ensureDemoData === "function") ensureDemoData();
  refreshAuthUI().then(() => {
    if (typeof renderAll === "function") renderAll();
  });
}

function exitDemo() {
  localStorage.removeItem("rb_demo_user");
  refreshAuthUI();
}

function getCurrentAuthUser() { return currentAuthUser; }
function getSupabase() { return supa || initSupabase(); }

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Init on load
document.addEventListener("DOMContentLoaded", async () => {
  initSupabase();
  if (supa) {
    supa.auth.onAuthStateChange(async (_event, _session) => {
      await refreshAuthUI();
    });
    // handle redirect callback params
  }
  // small delay to let app.js define helpers
  setTimeout(refreshAuthUI, 100);
});
