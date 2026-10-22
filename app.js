// app.js — RegisterBook Community UI
// Works in two modes: demo (localStorage) and cloud (Supabase). Both use RBStore.
(function () {
  "use strict";

  const S = window.RBStore;
  const U = window.RBUtil;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MONTHS_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const TYPE_ICON = {
    "Medical Checklist": "🩺",
    "Bill Book": "🧾",
    "Attendance Register": "🗓️",
    "Stock Register": "📦",
    "General Register": "📒"
  };
  const LINES_PER_PAGE = 10;

  const state = {
    view: "home",
    reg: { id: null, page: 1, highlightDate: null },
    chatWith: null,
    groupId: null,
    insideSearch: "",
    person: null,
    share: { regId: null, userId: null, groupId: "" },
    addMemberGroupId: null,
    busy: false,
    timer: null,
    booted: false
  };

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(msg, ms) {
    const c = $("#toast");
    if (!c) return;
    const el = document.createElement("div");
    el.className = "toast-item";
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), ms || 2600);
  }
  function todayIso() { return U.isoLocal(new Date()); }
  function fmtFull(d) {
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  function dateInfo(iso) {
    const parts = String(iso || "").split("-").map(Number);
    const y = parts[0], m = parts[1], d = parts[2];
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return {
      y, m, d, monthIdx: (m || 1) - 1, weekdayIdx: dt.getDay(),
      weekday: dt.toLocaleDateString("en-US", { weekday: "long" }),
      month: MONTHS[(m || 1) - 1] || "", monthShort: MONTHS_SHORT[(m || 1) - 1] || "",
      iso
    };
  }
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }
  function fmtDay(iso) {
    try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch (e) { return ""; }
  }
  function typeIcon(t) { return TYPE_ICON[t] || "📒"; }

  window.rbAvatarError = function (img) {
    const span = img && img.parentNode;
    if (!span) return;
    span.textContent = (img.getAttribute("data-initials") || "?").toUpperCase();
    span.style.background = img.getAttribute("data-color") || "#0f766e";
  };
  function avatar(p, cls) {
    const prof = p || {};
    const color = prof.color || U.colorFor(prof.id || prof.name || "x");
    const ini = U.initials(prof.name || prof.email || "?");
    const url = S.imageUrl(prof);
    const klass = "av " + (cls || "");
    if (url) {
      return `<span class="${klass}" style="background:${esc(color)}"><img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-initials="${esc(ini)}" data-color="${esc(color)}" onerror="rbAvatarError(this)"></span>`;
    }
    return `<span class="${klass}" style="background:${esc(color)}">${esc(ini)}</span>`;
  }
  function profileOf(id) { return S.profile(id); }
  function ownerLine(reg) {
    const p = profileOf(reg.ownerId);
    return p;
  }

  // ---------------------------------------------------------------- permissions
  function regById(id) { return S.data.registers.find(r => r.id === id) || null; }
  function canView(reg) { return S.canView(reg); }
  function canEdit(reg) { return S.canEdit(reg); }
  function pageCount(regId) {
    return Math.max(1, Math.ceil(S.entriesOf(regId).length / LINES_PER_PAGE));
  }
  function pageOfEntryIndex(idx) { return Math.floor(idx / LINES_PER_PAGE) + 1; }

  // ---------------------------------------------------------------- search
  function monthIndexFromToken(token) {
    const s = String(token || "").toLowerCase();
    if (s.length < 3) return -1;
    for (let i = 0; i < 12; i++) {
      const full = MONTHS[i].toLowerCase();
      if (full.startsWith(s)) return i;
      if (s === MONTHS_SHORT[i]) return i;
      const limit = full.length >= 6 ? 2 : 1; // June/July must not cross-match
      if (U.levenshtein(s, full) <= limit) return i;
    }
    return -1;
  }
  function weekdayIndexFromToken(token) {
    const s = String(token || "").toLowerCase();
    if (s.length < 3) return -1;
    for (let i = 0; i < 7; i++) {
      const full = WEEKDAYS[i].toLowerCase();
      if (full.startsWith(s) || U.levenshtein(s, full) <= 2) return i;
    }
    return -1;
  }
  function analyzeQuery(raw) {
    const q = String(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
    const out = { raw: q, page: null, day: null, monthIdx: null, year: null, weekdayIdx: null, text: "" };
    if (!q) return out;

    let m = q.match(/^(?:page|pg|p)\s*(\d{1,4})$/);
    if (m) { out.page = Number(m[1]); return out; }

    m = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { out.year = Number(m[1]); out.monthIdx = Number(m[2]) - 1; out.day = Number(m[3]); return out; }

    const tokens = q.split(" ");
    if (tokens.length === 1) {
      const t = tokens[0];
      if (/^\d{1,4}$/.test(t)) {
        const n = Number(t);
        if (n >= 1 && n <= 12) out.monthIdx = n - 1;   // "10" → October
        if (n >= 1 && n <= 31) out.day = n;            // "10" → the 10th
        out.page = n;                                   // "10" → page 10
        return out;
      }
      const mi = monthIndexFromToken(t);
      if (mi >= 0) { out.monthIdx = mi; return out; }
      const wi = weekdayIndexFromToken(t);
      if (wi >= 0) { out.weekdayIdx = wi; return out; }
      out.text = t;
      return out;
    }

    if (tokens.length === 2) {
      const a = tokens[0], b = tokens[1];
      if (/^\d{1,2}$/.test(a)) {
        const mi = monthIndexFromToken(b);
        if (mi >= 0) { out.day = Number(a); out.monthIdx = mi; return out; }
      }
      if (/^\d{1,2}$/.test(b)) {
        const mi = monthIndexFromToken(a);
        if (mi >= 0) { out.day = Number(b); out.monthIdx = mi; return out; }
      }
      if (/^\d{4}$/.test(b)) {
        const mi = monthIndexFromToken(a);
        if (mi >= 0) { out.monthIdx = mi; out.year = Number(b); return out; }
      }
    }
    out.text = q;
    return out;
  }
  function entryMatches(e, qa, indexMap) {
    if (!qa || !qa.raw) return false;
    const info = dateInfo(e.date);
    const idx = indexMap && indexMap.has(e.id)
      ? indexMap.get(e.id)
      : S.entriesOf(e.registerId).findIndex(x => x.id === e.id);
    const page = idx >= 0 ? pageOfEntryIndex(idx) : 1;

    const pageOnly = qa.page !== null && qa.day === null && qa.monthIdx === null && qa.weekdayIdx === null && qa.year === null && !qa.text;
    if (pageOnly) return page === qa.page;

    let hit = false;
    if (qa.page !== null && page === qa.page) hit = true;
    if (qa.day !== null && info.d === qa.day) hit = true;
    if (qa.monthIdx !== null && info.monthIdx === qa.monthIdx) hit = true;
    if (qa.year !== null && info.y === qa.year) hit = true;
    if (qa.weekdayIdx !== null && info.weekdayIdx === qa.weekdayIdx) hit = true;

    if (qa.text) {
      const hay = `${e.text || ""} ${e.note || ""} ${e.amount == null ? "" : e.amount} ${e.qty == null ? "" : e.qty}`.toLowerCase();
      if (hay.includes(qa.text)) hit = true;
      else {
        const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
        const qWords = qa.text.split(/[^a-z0-9]+/).filter(Boolean);
        if (qWords.length && qWords.every(w => words.some(x => x.startsWith(w) || (w.length >= 4 && U.levenshtein(w, x) <= 1)))) hit = true;
      }
    }
    return hit;
  }
  function buildSuggestions(regId, raw) {
    const qa = analyzeQuery(raw);
    const entries = S.entriesOf(regId);
    const empty = { suggestions: [], matched: 0, query: qa };
    if (!qa.raw || !entries.length) return empty;

    const indexOf = new Map(entries.map((e, i) => [e.id, i]));
    const matched = entries.filter(e => entryMatches(e, qa, indexOf));
    const totalPages = Math.max(1, Math.ceil(entries.length / LINES_PER_PAGE));
    const out = [];
    const seen = new Set();
    const push = s => {
      const key = s.label + "|" + s.page + "|" + (s.date || "");
      if (!seen.has(key)) { seen.add(key); out.push(s); }
    };
    const linesOnPage = p => entries.filter((e, i) => pageOfEntryIndex(i) === p).length;

    const pageOnly = qa.page !== null && qa.day === null && qa.monthIdx === null && qa.weekdayIdx === null && qa.year === null && !qa.text;
    if (pageOnly) {
      if (qa.page >= 1 && qa.page <= totalPages) {
        const n = linesOnPage(qa.page - 1);
        push({ label: `Page ${qa.page} • ${n} line${n === 1 ? "" : "s"}`, page: qa.page, date: null, kind: "page" });
      }
    } else {
      const groups = new Map();
      matched.forEach(e => {
        if (!e.date) return;
        const i = indexOf.get(e.id);
        const page = pageOfEntryIndex(i);
        const key = page + "|" + e.date;
        if (!groups.has(key)) groups.set(key, { page, date: e.date, count: 0, sample: e });
        groups.get(key).count++;
      });
      for (const g of groups.values()) {
        const info = dateInfo(g.date);
        push({
          label: `${info.month} ${info.d} — Page ${g.page} • ${g.count} line${g.count === 1 ? "" : "s"}`,
          page: g.page, date: g.date, kind: "date", meta: g.sample.text
        });
      }
      if (qa.page !== null && !qa.text && qa.page >= 1 && qa.page <= totalPages) {
        const n = linesOnPage(qa.page - 1);
        push({ label: `Page ${qa.page} • ${n} line${n === 1 ? "" : "s"}`, page: qa.page, date: null, kind: "page" });
      }
      if (qa.text) {
        const byPage = new Map();
        matched.forEach(e => {
          const i = indexOf.get(e.id);
          const page = pageOfEntryIndex(i);
          if (!byPage.has(page)) byPage.set(page, { count: 0, sample: e });
          byPage.get(page).count++;
        });
        for (const [page, v] of byPage) {
          push({ label: `Page ${page} • ${v.count} matching line${v.count === 1 ? "" : "s"}`, page, date: null, kind: "text", meta: v.sample.text });
        }
      }
    }
    out.sort((a, b) => a.page - b.page || String(a.date || "").localeCompare(String(b.date || "")));
    return { suggestions: out.slice(0, 8), matched: matched.length, query: qa };
  }

  // ---------------------------------------------------------------- shell
  function fillGateChips() {
    const box = $("#gateDemoChips");
    if (!box) return;
    box.innerHTML = S.demoUsers().map(u => `
      <button class="demo-chip" onclick="enterDemo('${u.id}')">
        ${avatar({ id: u.id, name: u.name, color: u.color }, "sm")} ${esc(u.name)}
      </button>`).join("");
  }

  function setHint(html, cls) {
    const el = $("#authHint");
    if (!el) return;
    el.className = "gate-hint" + (cls ? " " + cls : "");
    el.innerHTML = html;
  }
  function defaultGateHint() {
    if (window.RBAuth && window.RBAuth.isConfigured()) {
      setHint("Sign in with Google to sync your books across phones. Or try the demo — no account needed.", "ok");
    } else {
      setHint(`<span class="hint-title">Google login is not connected yet</span>
        config.js still has placeholder values, so Google sign-in will show a friendly message. <b>Demo mode works fully right now.</b>
        <details style="margin-top:6px"><summary>What the owner needs to do</summary>
          <ol>
            <li>Open your <b>RegisterBook</b> Supabase project (not Blind quiz) → Project Settings → API</li>
            <li>Copy the <b>Project URL</b> and <b>publishable / anon key</b> into <code>config.js</code></li>
            <li>Supabase → Authentication → Providers → Google → Enable, paste Client ID + Secret</li>
            <li>Supabase → Authentication → URL Configuration → Site URL + redirect allow-list</li>
          </ol>
        </details>`);
    }
  }
  function showGateError(err) {
    const steps = err && err.steps && err.steps.length
      ? `<ol>${err.steps.map(s => `<li>${s}</li>`).join("")}</ol>`
      : "";
    setHint(`<span class="hint-title">${esc(err.title || "Sign-in problem")}</span>${err.message || ""}${steps}`, "err");
  }
  function showGate(err) {
    const gate = $("#loginGate"), app = $("#appShell");
    if (app) app.classList.remove("show");
    if (gate) gate.classList.remove("hidden");
    if (err) showGateError(err);
    else defaultGateHint();
    state.booted = true;
  }
  function showApp() {
    const gate = $("#loginGate"), app = $("#appShell");
    if (gate) gate.classList.add("hidden");
    if (app) app.classList.add("show");
    document.body.classList.remove("sidebar-open");
  }
  function toggleSidebar(open) {
    document.body.classList.toggle("sidebar-open", !!open);
  }

  // ---------------------------------------------------------------- render: sidebar + topbar
  function renderSidebar() {
    const me = S.me;
    if (!me) return;
    const badge = $("#modeBadge"), badgeM = $("#modeBadgeMobile");
    const demo = S.isDemo();
    if (badge) {
      badge.textContent = demo ? "Demo mode" : "Google account";
      badge.className = "mode-badge " + (demo ? "mode-demo" : "mode-real");
    }
    if (badgeM) {
      badgeM.textContent = demo ? "Demo" : "Google";
      badgeM.className = "mode-badge " + (demo ? "mode-demo" : "mode-real");
    }

    const card = $("#accountCard");
    if (card) {
      card.innerHTML = `
        ${avatar(me, "acct-avatar")}
        <div class="acct-info">
          <div class="acct-name">${esc(me.name)} <span class="${demo ? "demo-badge" : "real-badge"}">${demo ? "Demo" : "Google ✓"}</span></div>
          <div class="acct-email">${esc(me.email || (demo ? "demo account" : ""))}</div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="handleSignOut()">${demo ? "Exit" : "Sign out"}</button>`;
    }

    const switchBox = $("#demoSwitch");
    if (switchBox) switchBox.style.display = demo ? "block" : "none";
    const resetWrap = $("#demoResetWrap");
    if (resetWrap) resetWrap.style.display = demo ? "block" : "none";
    const sel = $("#demoUserSelect");
    if (sel && demo) {
      sel.innerHTML = S.demoUsers().map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(u.email)}</option>`).join("");
      sel.value = me.id;
      sel.onchange = e => enterDemo(e.target.value);
    }

    const counts = {
      countMy: S.myRegisters().length,
      countShared: S.sharedWithMe().length,
      countGroups: S.myGroups().length,
      countPeople: S.pendingIncoming().length ? `${S.pendingIncoming().length} new` : "",
      countChats: S.data.directMessages.length ? String(S.data.directMessages.length) : ""
    };
    Object.keys(counts).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = counts[id];
    });
    const today = $("#todayPreview");
    if (today) today.textContent = fmtFull(new Date());
  }

  const TITLES = {
    home: ["Community Home", "Registers shared with you + your community"],
    myRegisters: ["My Registers", "Every book you created — unlimited pages"],
    shared: ["Shared With Me", "Read & search anything — only the creator can edit"],
    people: ["People & Friends", "Find staff, send requests, then share registers"],
    groups: ["Groups", "Create a group, chat, share a register to everyone at once"],
    chats: ["Private Chats", "1-to-1 messages + demo call screen"],
    registerDetail: ["Register book", "10 lines per page • unlimited pages"]
  };
  function renderTopbar() {
    const t = TITLES[state.view] || TITLES.home;
    const title = $("#topTitle"), sub = $("#topSub");
    if (title) title.textContent = t[0];
    if (sub) sub.textContent = t[1];
    const actions = $("#topActions");
    if (!actions) return;
    let html = "";
    if (state.view === "home" || state.view === "myRegisters") {
      html += `<button class="btn btn-sm btn-primary" onclick="openCreateModal()">+ Create Register</button>`;
    }
    if (state.view === "people") {
      html += `<button class="btn btn-sm btn-primary" onclick="openCreateModal()">+ Create Register</button>`;
    }
    if (state.view === "groups") {
      html += `<button class="btn btn-sm btn-primary" onclick="openGroupModal()">+ Create Group</button>`;
    }
    if (state.view === "registerDetail") {
      html += `<button class="btn btn-sm" onclick="setView('${state.reg.id ? "myRegisters" : "home"}')">← Back to books</button>`;
      const reg = regById(state.reg.id);
      if (reg && canEdit(reg)) {
        html += `<button class="btn btn-sm btn-primary" onclick="openShareModal('${reg.id}')">Share</button>`;
        html += `<button class="btn btn-sm btn-ghost" style="color:#dc2626" onclick="deleteRegister('${reg.id}')">Delete book</button>`;
      }
    }
    if (!S.isDemo() && (state.view === "shared" || state.view === "chats" || state.view === "groups" || state.view === "people")) {
      html += `<button class="btn btn-sm" onclick="manualRefresh()">↻ Refresh</button>`;
    }
    actions.innerHTML = html;
  }

  // ---------------------------------------------------------------- views
  function setView(name) {
    state.view = name;
    showView();
    renderTopbar();
    toggleSidebar(false);
  }
  function showView() {
    $$(".view").forEach(v => { v.style.display = "none"; });
    const target = document.getElementById("view-" + state.view);
    if (target) target.style.display = "block";
    $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === state.view));
  }

  function setupBanner() {
    if (S.isDemo() || !S.setupError) return "";
    return `<div class="card" style="border-color:#fecaca;background:#fef2f2">
      <div class="card-pad">
        <div class="strong" style="color:#991b1b">Database needs one step</div>
        <div class="small" style="color:#7f1d1d;margin-top:4px">${esc(S.setupError)}</div>
        <div class="mt8"><button class="btn btn-sm" onclick="manualRefresh()">↻ Try again</button>
        <a class="btn btn-sm" style="margin-left:6px" href="https://supabase.com/dashboard" target="_blank" rel="noopener">Open Supabase</a></div>
      </div>
    </div>`;
  }

  function registerRow(reg, opts) {
    const entries = S.entriesOf(reg.id);
    const pages = Math.max(1, Math.ceil(entries.length / LINES_PER_PAGE));
    const owner = ownerLine(reg);
    const mine = reg.ownerId === S.me.id;
    const total = reg.type === "Bill Book" ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0) : null;
    const extra = (opts && opts.showOwner) ? ` • by ${esc(owner.name)}` : "";
    return `<div class="list-item" onclick="openRegister('${reg.id}')">
      <div style="width:40px;height:40px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;display:grid;place-items:center;font-size:18px">${typeIcon(reg.type)}</div>
      <div class="flex1">
        <div class="strong">${esc(reg.name)}</div>
        <div class="small muted">${esc(reg.type)}${extra} • ${pages} page${pages === 1 ? "" : "s"} • ${entries.length} line${entries.length === 1 ? "" : "s"}${total !== null ? ` • ₹${total}` : ""}</div>
      </div>
      ${mine ? `<span class="badge badge-green">Owner</span>` : `<span class="badge badge-gray">View only</span>`}
    </div>`;
  }

  function renderHome() {
    const c = $("#view-home");
    if (!c) return;
    const my = S.myRegisters();
    const shared = S.sharedWithMe();
    const groups = S.myGroups();
    const me = S.me;
    c.innerHTML = `
      ${setupBanner()}
      <div class="card" style="background:linear-gradient(120deg,#ecfdf5,#f0f9ff);border-color:#a7f3d0">
        <div class="card-pad">
          <div class="row" style="justify-content:space-between">
            <div>
              <div style="font-size:20px;font-weight:800">Hi ${esc(me.name)} 👋</div>
              <div class="small muted" style="margin-top:2px">Today is <b>${esc(fmtFull(new Date()))}</b> — it is filled in automatically when you write.</div>
            </div>
            <div class="row">
              <button class="btn btn-primary btn-sm" onclick="openCreateModal()">+ Create Register</button>
              <button class="btn btn-sm" onclick="setView('shared')">Shared with me (${shared.length})</button>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-3 mt12">
        <div class="card kpi"><div class="kpi-icon" style="background:#ecfdf5;color:#065f46">📒</div><div class="kpi-num" id="kpiMine">${my.length}</div><div class="kpi-label">My registers</div><div class="small muted mt8">Unlimited books on one phone</div></div>
        <div class="card kpi"><div class="kpi-icon" style="background:#eff6ff;color:#1d4ed8">👁️</div><div class="kpi-num" id="kpiShared">${shared.length}</div><div class="kpi-label">Shared with me (view only)</div><div class="small muted mt8">Search works, edit is blocked</div></div>
        <div class="card kpi"><div class="kpi-icon" style="background:#fef3c7;color:#92400e">👥</div><div class="kpi-num" id="kpiGroups">${groups.length}</div><div class="kpi-label">My groups</div><div class="small muted mt8">${groups.length ? groups.map(g => esc(g.name)).join(", ") : "Create a group to share with everyone"}</div></div>
      </div>

      <div class="grid grid-2 mt12">
        <div class="card">
          <div class="card-head"><h3>Community — shared with me</h3><span class="badge badge-green">${shared.length} book${shared.length === 1 ? "" : "s"}</span></div>
          <div class="list">
            ${shared.length ? shared.slice(0, 5).map(r => registerRow(r, { showOwner: true })).join("") :
              `<div class="empty"><div class="big">No shared books yet</div><div class="small">${S.isDemo() ? "Try the story: switch to Goldfish, share a register with Silverfish, then switch to Silverfish." : "When a colleague shares a register with you it appears here — view only."}</div>${S.isDemo() ? `<button class="btn btn-sm mt8" onclick="demoStory()">Run Goldfish → Silverfish test</button>` : ""}</div>`}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>My registers</h3><button class="btn btn-sm btn-primary" onclick="openCreateModal()">+ Create</button></div>
          <div class="list">
            ${my.length ? my.slice(0, 5).map(r => registerRow(r)).join("") :
              `<div class="empty"><div class="big">You have no registers</div><div class="small">Create one — today's date is filled in automatically.</div><button class="btn btn-sm btn-primary mt8" onclick="openCreateModal()">+ Create register</button></div>`}
          </div>
        </div>
      </div>

      <div class="card mt12">
        <div class="card-head"><h3>How sharing works (view-only)</h3><span class="badge">Enforced in the database</span></div>
        <div class="card-pad small" style="line-height:1.65">
          <b>Goldfish</b> writes 20–30 pages of a medicine checklist and shares it with <b>Silverfish</b>.
          Silverfish can open it, read every page and search by date or month — but <b>cannot add, edit or delete anything</b>,
          because Goldfish is the creator. Row Level Security in Supabase blocks writes from anyone else, so it is not just hidden buttons.
          <div class="mt8 muted">Sharing ways: search a person's name → pick a register → share · share to a whole group · share from a private chat.</div>
        </div>
      </div>`;
  }

  function renderMyRegisters() {
    const c = $("#view-myRegisters");
    if (!c) return;
    const regs = S.myRegisters();
    c.innerHTML = `
      ${setupBanner()}
      <div class="card">
        <div class="card-head"><h3>My Registers — ${regs.length}</h3><button class="btn btn-sm btn-primary" onclick="openCreateModal()">+ Create register</button></div>
        <div class="list">
          ${regs.length ? regs.map(r => registerRow(r)).join("") :
            `<div class="empty"><div class="big">No registers yet</div><div class="small">Create your first book — name + type. The date is automatic.</div><button class="btn btn-primary mt8" onclick="openCreateModal()">+ Create register</button></div>`}
        </div>
      </div>`;
  }

  function renderShared() {
    const c = $("#view-shared");
    if (!c) return;
    const regs = S.sharedWithMe();
    c.innerHTML = `
      ${setupBanner()}
      <div class="card">
        <div class="card-head"><h3>Shared with me — ${regs.length}</h3><span class="badge badge-amber">View only — cannot edit</span></div>
        <div class="list">
          ${regs.length ? regs.map(r => registerRow(r, { showOwner: true })).join("") :
            `<div class="empty"><div class="big">Nothing shared with you yet</div><div class="small">${S.isDemo() ? "Open the medicine checklist as Goldfish and share it with Silverfish, then switch back here as Silverfish." : "Ask a colleague to share a register with you, or accept a friend request first."}</div>${S.isDemo() ? `<button class="btn btn-sm mt8" onclick="demoStory()">Run Goldfish → Silverfish test</button>` : ""}</div>`}
        </div>
      </div>`;
  }

  function personStatusHtml(p) {
    const friend = S.isFriend(p.id);
    const incoming = S.data.friendRequests.find(f => f.toUser === S.me.id && f.fromUser === p.id && f.status === "pending");
    const outgoing = S.data.friendRequests.find(f => f.fromUser === S.me.id && f.toUser === p.id && f.status === "pending");
    if (friend) return `<span class="badge badge-green">Friends</span>`;
    if (incoming) return `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();respondFriend('${incoming.id}','accepted')">Accept request</button>`;
    if (outgoing) return `<span class="badge badge-amber">Request sent</span>`;
    return `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();askFriend('${p.id}')">Add friend</button>`;
  }

  function renderPeople() {
    const c = $("#view-people");
    if (!c) return;
    const incoming = S.pendingIncoming();
    const outgoing = S.pendingOutgoing();
    const friends = S.friends();
    const others = S.otherProfiles();
    const selected = state.person ? S.profile(state.person) : null;
    c.innerHTML = `
      ${setupBanner()}
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>Search people</h3><span class="badge">${others.length} staff</span></div>
          <div class="card-pad">
            <div class="form-row" style="margin:0">
              <label for="peopleSearch">Type a name — suggestions appear</label>
              <div class="suggest-wrap">
                <input id="peopleSearch" placeholder="Try Goldfish, Priya, Rahul…" autocomplete="off" oninput="handlePeopleSearch(this.value)">
                <div id="peopleSuggest" class="suggest-box"></div>
              </div>
              <div class="small muted">Click a suggestion to choose the person.</div>
            </div>
            <div id="peopleSearchResults" class="mt12">
              ${selected ? `
                <div class="card" style="border:1px solid #a7f3d0;background:#ecfdf5">
                  <div class="card-pad">
                    <div class="row">${avatar(selected, "lg")}<div><div class="strong">${esc(selected.name)}</div><div class="small muted">${esc(selected.email)}</div></div><span class="badge">${S.isFriend(selected.id) ? "Friends" : "Staff"}</span></div>
                    <div class="row mt12">
                      ${personStatusHtml(selected)}
                      <button class="btn btn-sm" onclick="openShareModalForUser('${selected.id}')">Share a register →</button>
                      <button class="btn btn-sm" onclick="openChat('${selected.id}')">Message</button>
                    </div>
                  </div>
                </div>` : `<div class="small muted">Search above, or pick someone from “All staff”.</div>`}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Friend requests</h3><span class="badge">${incoming.length} pending</span></div>
          <div class="list">
            ${incoming.length ? incoming.map(fr => {
              const p = S.profile(fr.fromUser);
              return `<div class="list-item" style="cursor:default">${avatar(p)}<div class="flex1"><div class="strong">${esc(p.name)}</div><div class="small muted">wants to be friends • ${fmtDay(fr.createdAt)}</div></div>
                <button class="btn btn-sm btn-primary" onclick="respondFriend('${fr.id}','accepted')">Accept</button>
                <button class="btn btn-sm" onclick="respondFriend('${fr.id}','declined')">Decline</button></div>`;
            }).join("") : `<div class="empty small">No pending requests</div>`}
            ${outgoing.length ? `<div class="card-pad small muted" style="border-top:1px solid #f3f4f6"><b>Sent:</b> ${outgoing.map(fr => esc(S.profile(fr.toUser).name)).join(", ")}</div>` : ""}
          </div>
          <div class="card-pad" style="border-top:1px solid #f3f4f6">
            <div class="strong small">Friends — ${friends.length}</div>
            <div class="inline mt8">
              ${friends.length ? friends.map(p => `<span class="chip">${avatar(p, "sm")}${esc(p.name)}</span>`).join("") : `<span class="small muted">No friends yet. Add someone to share registers.</span>`}
            </div>
          </div>
        </div>
      </div>

      <div class="card mt12">
        <div class="card-head"><h3>All staff</h3><span class="badge">People you can share with</span></div>
        <div class="list">
          ${others.length ? others.map(p => `
            <div class="list-item" onclick="selectPerson('${p.id}')">
              ${avatar(p)}
              <div class="flex1"><div class="strong">${esc(p.name)}</div><div class="small muted">${esc(p.email)}</div></div>
              ${personStatusHtml(p)}
              <button class="btn btn-sm" onclick="event.stopPropagation();openShareModalForUser('${p.id}')">Share →</button>
            </div>`).join("") : `<div class="empty small">No other accounts yet. ${S.isDemo() ? "" : "Invite a colleague to sign in with Google, then refresh."}</div>`}
        </div>
      </div>`;
  }

  function renderGroups() {
    const c = $("#view-groups");
    if (!c) return;
    const groups = S.myGroups();
    const open = state.groupId ? S.data.groups.find(g => g.id === state.groupId) : null;

    if (open) {
      const members = S.groupMembers(open.id).map(profileOf);
      const msgs = S.groupMessages(open.id);
      c.innerHTML = `
        ${setupBanner()}
        <div class="card hide-mobile" style="margin-bottom:12px">
          <div class="card-head"><h3>All groups</h3><button class="btn btn-sm" onclick="closeGroup()">← All groups</button></div>
          <div class="list">${groups.map(g => `<div class="list-item" onclick="openGroup('${g.id}')"><div style="font-size:18px">👥</div><div class="flex1"><div class="strong">${esc(g.name)}</div><div class="small muted">${S.groupMembers(g.id).length} members</div></div></div>`).join("")}</div>
        </div>
        <div class="card">
          <div class="card-head">
            <h3>${esc(open.name)}</h3>
            <span class="badge">${members.length} members</span>
            <button class="btn btn-sm" onclick="openAddMemberModal('${open.id}')">+ Add staff</button>
            <button class="btn btn-sm btn-primary" onclick="openShareToGroupModal('${open.id}')">Share register to group</button>
          </div>
          <div class="card-pad small muted">Members: ${members.map(m => esc(m.name)).join(", ") || "—"}</div>
          <div class="chat-wrap">
            <div class="chat-messages" id="groupMsgs">
              ${msgs.length ? msgs.map(m => {
                const mine = m.senderId === S.me.id;
                const p = profileOf(m.senderId);
                return `<div class="bubble ${mine ? "me" : "them"}">
                  <div style="font-size:11px;opacity:.85;margin-bottom:2px">${esc(p.name)}</div>
                  ${esc(m.text)}
                  <div class="meta">${fmtTime(m.createdAt)}</div>
                </div>`;
              }).join("") : `<div class="small muted" style="text-align:center;padding:20px">No messages yet. Say hi!</div>`}
            </div>
            <div class="chat-input">
              <input id="groupChatInput" placeholder="Message ${esc(open.name)}…" onkeydown="if(event.key==='Enter') sendGroupMsg('${open.id}')">
              <button class="btn btn-primary" onclick="sendGroupMsg('${open.id}')">Send</button>
            </div>
          </div>
        </div>`;
      setTimeout(scrollChats, 30);
      return;
    }

    c.innerHTML = `
      ${setupBanner()}
      <div class="row" style="margin-bottom:12px">
        <button class="btn btn-primary" onclick="openGroupModal()">+ Create group</button>
        <span class="small muted">Add staff, chat, and share a register to the whole group at once.</span>
      </div>
      <div class="card">
        <div class="card-head"><h3>My groups — ${groups.length}</h3></div>
        <div class="list">
          ${groups.length ? groups.map(g => {
            const members = S.groupMembers(g.id).map(profileOf);
            return `<div class="list-item" onclick="openGroup('${g.id}')">
              <div style="width:40px;height:40px;border-radius:10px;background:#eff6ff;display:grid;place-items:center;font-size:18px">👥</div>
              <div class="flex1"><div class="strong">${esc(g.name)}</div><div class="small muted">${members.map(m => esc(m.name)).join(", ") || "No members"}</div></div>
              <span class="badge">${members.length} members</span>
            </div>`;
          }).join("") : `<div class="empty"><div class="big">No groups yet</div><div class="small">Create a group like “Ward Staff”, add staff, then share a register to everyone at once.</div><button class="btn btn-primary mt8" onclick="openGroupModal()">+ Create group</button></div>`}
        </div>
      </div>`;
  }

  function renderChats() {
    const c = $("#view-chats");
    if (!c) return;
    const people = S.otherProfiles();
    const selected = state.chatWith && people.some(p => p.id === state.chatWith) ? S.profile(state.chatWith) : null;

    const rows = people
      .map(p => {
        const msgs = S.messagesBetween(p.id);
        const last = msgs[msgs.length - 1];
        return { p, last, at: last ? new Date(last.createdAt).getTime() : 0, count: msgs.length };
      })
      .sort((a, b) => b.at - a.at);

    const listHtml = `<div class="card ${selected ? "hide-mobile" : ""}">
      <div class="card-head"><h3>Chats</h3><span class="badge">${people.length} people</span></div>
      <div class="list">
        ${rows.length ? rows.map(({ p, last, count }) => `
          <div class="list-item chat-row ${state.chatWith === p.id ? "active" : ""}" onclick="openChat('${p.id}')">
            ${avatar(p)}
            <div class="flex1">
              <div class="strong">${esc(p.name)} ${count ? `<span class="badge badge-gray">${count}</span>` : ""}</div>
              <div class="small muted">${last ? esc(last.text.slice(0, 60)) : "No messages yet — say hi"}</div>
            </div>
            <button class="btn btn-sm" onclick="event.stopPropagation();startCall('${p.id}')">📞</button>
          </div>`).join("") : `<div class="empty small">No other people yet.</div>`}
      </div>
    </div>`;

    const paneHtml = selected ? `<div class="card">
      <div class="chat-head">
        ${avatar(selected)}
        <div><div class="strong">${esc(selected.name)}</div><div class="small muted">${esc(selected.email)}</div></div>
        <div class="spacer"></div>
        <button class="btn btn-sm" onclick="stateChatBack()">← Chats</button>
        <button class="btn btn-sm btn-primary" onclick="startCall('${selected.id}')">📞 Call</button>
        <button class="btn btn-sm" onclick="openShareModalForUser('${selected.id}')">Share register</button>
      </div>
      <div class="chat-wrap">
        <div class="chat-messages" id="chatMsgs">
          ${S.messagesBetween(selected.id).length ? S.messagesBetween(selected.id).map(m => {
            const mine = m.senderId === S.me.id;
            return `<div class="bubble ${mine ? "me" : "them"}">${esc(m.text)}<div class="meta">${fmtTime(m.createdAt)}</div></div>`;
          }).join("") : `<div class="small muted" style="text-align:center;padding:18px">No messages yet. Say hello to ${esc(selected.name)}!</div>`}
        </div>
        <div class="chat-input">
          <input id="chatInput" placeholder="Message ${esc(selected.name)}…" onkeydown="if(event.key==='Enter') sendChat('${selected.id}')">
          <button class="btn btn-primary" onclick="sendChat('${selected.id}')">Send</button>
        </div>
      </div>
    </div>` : `<div class="card"><div class="empty"><div class="big">Select a chat</div><div class="small">Pick a person to message, or press 📞 to see the demo call screen.</div></div></div>`;

    c.innerHTML = `${setupBanner()}<div class="${selected ? "grid grid-2" : ""}">${listHtml}${selected ? paneHtml : ""}</div>`;
    setTimeout(scrollChats, 30);
  }
  function scrollChats() {
    ["chatMsgs", "groupMsgs"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  function renderRegisterDetail() {
    const c = $("#view-registerDetail");
    if (!c) return;
    const reg = regById(state.reg.id);
    if (!reg || !canView(reg)) {
      c.innerHTML = `<div class="card"><div class="empty"><div class="big">Register not available</div><div class="small">It may have been deleted, or the owner removed your access.</div><button class="btn mt8" onclick="setView('home')">← Home</button></div></div>`;
      return;
    }
    const me = S.me;
    const owner = profileOf(reg.ownerId);
    const editable = canEdit(reg);
    const entries = S.entriesOf(reg.id);
    const total = entries.length;
    const totalPages = Math.max(1, Math.ceil(total / LINES_PER_PAGE));
    let page = Math.min(Math.max(1, state.reg.page || 1), totalPages);
    state.reg.page = page;
    const start = (page - 1) * LINES_PER_PAGE;
    const pageEntries = entries.slice(start, start + LINES_PER_PAGE);
    const pageAmount = reg.type === "Bill Book" ? pageEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0) : null;
    const bookAmount = reg.type === "Bill Book" ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0) : null;
    const shares = S.sharesOf(reg.id);

    let rowsHtml = "";
    for (let i = 0; i < LINES_PER_PAGE; i++) {
      const idx = start + i;
      const e = entries[idx];
      const lineNo = idx + 1;
      if (!e) {
        rowsHtml += `<div class="line"><div class="line-num">${lineNo}.</div><div class="line-text small muted">${editable && page === totalPages ? "Write on the next line below…" : ""}</div></div>`;
        continue;
      }
      const info = dateInfo(e.date);
      const hl = state.reg.highlightDate && e.date === state.reg.highlightDate;
      rowsHtml += `<div class="line ${e.done ? "done" : ""} ${hl ? "highlight" : ""}" data-id="${e.id}">
        <div class="line-num">${lineNo}.</div>
        <div class="line-text">
          <div style="font-weight:600">${esc(e.text)}</div>
          ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ""}
          <div class="small muted" style="margin-top:2px">
            ${esc(info.weekday)}, ${esc(info.month)} ${info.d}, ${info.y}
            ${e.qty != null ? ` • Qty: <b>${e.qty}</b>` : ""}
            ${e.amount != null ? ` • ₹<b>${e.amount}</b>` : ""}
          </div>
        </div>
        ${editable ? `<div class="line-actions">
          <button class="btn btn-sm" style="padding:4px 7px" onclick="toggleDone('${e.id}')">${e.done ? "↩ Undo" : "✓ Done"}</button>
          <button class="btn btn-sm" style="padding:4px 7px" onclick="editEntry('${e.id}')">Edit</button>
          <button class="btn btn-sm" style="padding:4px 7px;color:#dc2626" onclick="deleteEntry('${e.id}')">×</button>
        </div>` : `<div class="line-actions" style="opacity:.7;font-size:11px">View only</div>`}
      </div>`;
    }

    const shareChips = shares.map(s => {
      const p = profileOf(s.sharedWithUserId);
      const g = s.groupId ? S.data.groups.find(x => x.id === s.groupId) : null;
      return `<span class="chip ${editable ? "removable" : ""}" ${editable ? `onclick="removeShareConfirm('${s.id}')" title="Remove access"` : ""}>
        ${avatar(p, "sm")}${esc(p.name)}${g ? ` · ${esc(g.name)}` : ""} • view only${editable ? " ✕" : ""}
      </span>`;
    }).join(" ");

    c.innerHTML = `
      <div class="paper">
        <div class="paper-head">
          <div>
            <div class="paper-title">${typeIcon(reg.type)} ${esc(reg.name)}</div>
            <div class="paper-meta">
              <span>${esc(reg.type)}</span>
              <span>• by <b>${esc(owner.name)}</b></span>
              <span>• created ${esc(fmtDay(reg.createdAt))}</span>
              <span>• ${total} line${total === 1 ? "" : "s"} • ${totalPages} page${totalPages === 1 ? "" : "s"} (unlimited)</span>
              ${editable ? `<span class="badge badge-green">Owner — can edit</span>` : `<span class="badge badge-amber">View only</span>`}
            </div>
          </div>
          <div class="paper-tabs">
            <button class="btn btn-sm" onclick="openShareModal('${reg.id}')">Share</button>
            ${editable ? `<button class="btn btn-sm btn-ghost" style="color:#dc2626" onclick="deleteRegister('${reg.id}')">Delete book</button>` : ""}
          </div>
        </div>

        ${editable
          ? `<div class="owner-banner">✍️ You created this register — you can add, edit and delete lines. Anyone you share it with gets <b>view-only</b> access.</div>`
          : `<div class="view-only-banner">👁️ <b>View only</b> — ${esc(owner.name)} created this register. You can read every page and search it, but you cannot add, edit or delete. Only the creator can change it. (Enforced by Row Level Security in Supabase.)</div>`}

        <div class="paper-search">
          <div class="search-wrap">
            <span class="search-ico">🔍</span>
            <input id="insideSearch" class="search-input" placeholder="Search: page 2 · October · octobr · 23 Oct · 10" value="${esc(state.insideSearch)}" oninput="handleInsideSearch(this.value)" autocomplete="off">
            <div id="insideSuggest" class="search-suggest"></div>
          </div>
          <span class="small muted">Smart search — misspellings like “octobr” work.</span>
        </div>

        <div class="paper-body ruled">${rowsHtml}</div>

        <div class="page-bar">
          <button class="btn btn-sm" onclick="changePage(-1)" ${page <= 1 ? "disabled" : ""}>← Previous</button>
          <span class="page-info">Page ${page} of ${totalPages}</span>
          <input id="gotoPage" type="number" min="1" max="${totalPages}" placeholder="Page #" style="width:88px;padding:7px 8px;border:1px solid var(--border);border-radius:8px;min-height:34px">
          <button class="btn btn-sm" onclick="gotoPageInput(${totalPages})">Go</button>
          <button class="btn btn-sm" onclick="changePage(1)" ${page >= totalPages ? "disabled" : ""}>Next →</button>
          ${pageAmount !== null ? `<span class="page-total">Page total: ₹${pageAmount}</span>` : ""}
          ${bookAmount !== null ? `<span class="page-total">Book total: ₹${bookAmount}</span>` : ""}
          <span class="small muted">${total ? `Lines ${start + 1}–${Math.min(start + LINES_PER_PAGE, total)} of ${total}` : "No lines yet"}</span>
        </div>

        ${editable ? `
        <div class="add-line">
          <input type="date" id="newLineDate" value="${todayIso()}" title="Date for this line (today is pre-filled)">
          <textarea id="newLineText" rows="1" placeholder="Write a line… (${esc(fmtFull(new Date()))} is already filled)"></textarea>
          ${reg.type === "Bill Book" ? `<input id="newLineQty" type="number" min="0" step="1" placeholder="Qty"><input id="newLineAmt" type="number" min="0" step="0.01" placeholder="₹ Amount">` : ""}
          <button class="btn btn-primary add-btn" onclick="addLine('${reg.id}')">Add</button>
        </div>
        <div class="small muted" style="padding:0 16px 12px var(--rail)">When a page fills (10 lines), the next line moves to a new page automatically — we tell you.</div>`
        : `<div class="small muted" style="padding:12px 16px 12px var(--rail);background:#fef2f2;border-top:1px solid #fecaca">Editing is disabled — you have view-only access. ${S.isDemo() ? `Switch to ${esc(owner.name)} in the sidebar demo switcher to edit.` : "Only the creator can change this register."}</div>`}
      </div>

      <div class="card mt12">
        <div class="card-head"><h3>Shared with</h3>${editable ? `<button class="btn btn-sm" onclick="openShareModal('${reg.id}')">+ Share this register</button>` : `<span class="badge badge-gray">View only</span>`}</div>
        <div class="card-pad small">
          ${shares.length ? `<div class="inline">${shareChips}</div>` : `<span class="muted">Not shared yet.${editable ? " Use Share to give someone read-only access." : ""}</span>`}
        </div>
      </div>`;
  }

  function renderAll() {
    if (!S.me) return;
    renderSidebar();
    renderHome();
    renderMyRegisters();
    renderShared();
    renderPeople();
    renderGroups();
    renderChats();
    renderRegisterDetail();
    if (state.view === "registerDetail" && !regById(state.reg.id)) state.view = "home";
    renderTopbar();
    showView();
  }

  // ---------------------------------------------------------------- create register
  function openCreateModal() {
    const modal = $("#createModal");
    if (!modal) return;
    $("#newRegName").value = "";
    $("#newRegType").value = "General Register";
    $("#newRegDatePreview").textContent = fmtFull(new Date()) + " — auto-filled for you";
    modal.classList.add("open");
    setTimeout(() => { const el = $("#newRegName"); if (el) el.focus(); }, 60);
  }
  function closeCreateModal() { $("#createModal").classList.remove("open"); }
  async function createRegister() {
    if (state.busy) return;
    const name = $("#newRegName").value.trim();
    const type = $("#newRegType").value;
    if (!name) { toast("Please type a register name"); return; }
    state.busy = true;
    try {
      const reg = await S.createRegister(name, type);
      closeCreateModal();
      state.reg.id = reg.id;
      state.reg.page = 1;
      state.reg.highlightDate = null;
      state.insideSearch = "";
      setView("registerDetail");
      renderAll();
      toast(`“${name}” created ✓ — today's date is already filled`);
    } catch (e) {
      toast(e.message || "Could not create the register");
    } finally {
      state.busy = false;
    }
  }

  // ---------------------------------------------------------------- register detail actions
  function openRegister(id) {
    const reg = regById(id);
    if (!reg) { toast("Register not found"); return; }
    if (!canView(reg)) { toast("You do not have access to this register"); return; }
    state.reg.id = id;
    state.reg.page = 1;
    state.reg.highlightDate = null;
    state.insideSearch = "";
    setView("registerDetail");
    renderRegisterDetail();
    renderTopbar();
    showView();
  }
  function changePage(delta) {
    const total = pageCount(state.reg.id);
    state.reg.page = Math.min(Math.max(1, (state.reg.page || 1) + delta), total);
    state.reg.highlightDate = null;
    renderRegisterDetail();
  }
  function gotoPageInput(max) {
    const inp = $("#gotoPage");
    let v = parseInt(inp && inp.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > max) v = max;
    state.reg.page = v;
    state.reg.highlightDate = null;
    renderRegisterDetail();
  }

  async function addLine(regId) {
    if (state.busy) return;
    const reg = regById(regId);
    if (!reg) return;
    const owner = profileOf(reg.ownerId);
    if (!canEdit(reg)) { toast(`View only — ${owner.name} created this register. Only the creator can add lines.`); return; }
    const txtEl = $("#newLineText");
    const text = txtEl ? txtEl.value.trim() : "";
    if (!text) { toast("Type a line first"); if (txtEl) txtEl.focus(); return; }
    const dateEl = $("#newLineDate");
    const date = (dateEl && dateEl.value) ? dateEl.value : todayIso();
    let qty = null, amount = null;
    if (reg.type === "Bill Book") {
      const q = $("#newLineQty"), a = $("#newLineAmt");
      qty = q && q.value !== "" ? Number(q.value) : null;
      amount = a && a.value !== "" ? Number(a.value) : null;
    }
    const before = S.entriesOf(regId).length;
    state.busy = true;
    try {
      await S.addEntry(regId, { date, text, qty, amount });
      const after = before + 1;
      const pageBefore = Math.max(1, Math.ceil(before / LINES_PER_PAGE));
      const pageAfter = Math.ceil(after / LINES_PER_PAGE);
      state.reg.page = pageAfter;
      state.reg.highlightDate = null;
      state.insideSearch = "";
      if (pageAfter > pageBefore) toast(`Page ${pageBefore} is full — moved to Page ${pageAfter} ✓`);
      else if (after % LINES_PER_PAGE === 0) toast(`Page ${pageAfter} is now full — your next line starts Page ${pageAfter + 1}.`);
      renderAll();
    } catch (e) {
      toast(e.message || "Could not add the line");
    } finally {
      state.busy = false;
    }
  }

  async function toggleDone(entryId) {
    const e = S.data.entries.find(x => x.id === entryId);
    if (!e) return;
    const reg = regById(e.registerId);
    if (!reg || !canEdit(reg)) { toast("View only — cannot change"); return; }
    try {
      await S.updateEntry(entryId, { done: !e.done });
      renderRegisterDetail();
    } catch (err) { toast(err.message); }
  }
  async function editEntry(entryId) {
    const e = S.data.entries.find(x => x.id === entryId);
    if (!e) return;
    const reg = regById(e.registerId);
    if (!reg || !canEdit(reg)) { toast("View only — cannot edit"); return; }
    const next = window.prompt("Edit this line:", e.text);
    if (next === null) return;
    const text = next.trim();
    if (!text) return;
    try {
      await S.updateEntry(entryId, { text });
      renderRegisterDetail();
      toast("Line updated ✓");
    } catch (err) { toast(err.message); }
  }
  async function deleteEntry(entryId) {
    const e = S.data.entries.find(x => x.id === entryId);
    if (!e) return;
    const reg = regById(e.registerId);
    if (!reg || !canEdit(reg)) { toast("View only — cannot delete"); return; }
    if (!window.confirm("Delete this line?")) return;
    try {
      await S.deleteEntry(entryId);
      const total = pageCount(reg.id);
      if (state.reg.page > total) state.reg.page = total;
      renderAll();
      toast("Line deleted");
    } catch (err) { toast(err.message); }
  }
  async function deleteRegister(regId) {
    const reg = regById(regId);
    if (!reg) return;
    if (!canEdit(reg)) { toast("Only the creator can delete this register"); return; }
    if (!window.confirm(`Delete “${reg.name}” and all its pages? This cannot be undone.`)) return;
    try {
      await S.deleteRegister(regId);
      state.reg.id = null;
      setView("myRegisters");
      renderAll();
      toast("Register deleted");
    } catch (err) { toast(err.message); }
  }

  // ---------------------------------------------------------------- inside search
  function handleInsideSearch(q) {
    state.insideSearch = q;
    const box = $("#insideSuggest");
    if (!box) return;
    const regId = state.reg.id;
    if (!q || !q.trim()) { box.classList.remove("open"); box.innerHTML = ""; return; }
    const res = buildSuggestions(regId, q);
    if (!res.matched) {
      box.innerHTML = `<div class="sug-item muted">No matches for “${esc(q)}” — try October, oct, 10, 23 Oct, or page 2</div>`;
      box.classList.add("open");
      return;
    }
    box.innerHTML = res.suggestions.map(s => `
      <div class="sug-item" onclick="jumpToSuggestion(${s.page}, ${s.date ? `'${s.date}'` : "null"})">
        <span>📄 ${esc(s.label)}</span>
        <span class="sug-meta">${esc((s.meta || "").slice(0, 30))}</span>
      </div>`).join("") +
      `<div class="sug-item muted" style="font-size:11px;cursor:default">${res.matched} line${res.matched === 1 ? "" : "s"} match “${esc(q)}”</div>`;
    box.classList.add("open");
  }
  function jumpToSuggestion(page, date) {
    state.reg.page = page;
    state.reg.highlightDate = date || null;
    state.insideSearch = "";
    renderRegisterDetail();
    setTimeout(() => {
      const el = document.querySelector("#view-registerDetail .line.highlight");
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    toast(`Jumped to Page ${page}${date ? " • " + fmtDay(date) : ""}`);
  }

  // ---------------------------------------------------------------- sharing
  function myRegisterOptions(selectedId) {
    const regs = S.myRegisters();
    if (!regs.length) return `<option value="">No registers yet — create one first</option>`;
    return regs.map(r => `<option value="${r.id}" ${r.id === selectedId ? "selected" : ""}>${esc(r.name)} — ${esc(r.type)}</option>`).join("");
  }
  function openShareModal(regId) {
    const regs = S.myRegisters();
    if (!regs.length) { toast("Create a register first, then share it"); return; }
    const reg = (regId && regs.find(r => r.id === regId)) || regs[0];
    state.share = { regId: reg.id, userId: null, groupId: "" };
    const sel = $("#shareRegSelect");
    if (sel) { sel.innerHTML = myRegisterOptions(reg.id); sel.onchange = () => { state.share.regId = sel.value; refreshShareModal(); }; }
    $("#shareRegId").value = reg.id;
    $("#shareRegName").textContent = reg.name;
    $("#shareUserInput").value = "";
    $("#shareUserInput").dataset.userId = "";
    $("#shareGroupSelect").innerHTML = `<option value="">— Pick a group —</option>` + S.myGroups().map(g => `<option value="${g.id}">${esc(g.name)} (${S.groupMembers(g.id).length})</option>`).join("");
    $("#shareGroupSelect").value = "";
    $("#shareGroupSelect").onchange = () => {
      state.share.groupId = $("#shareGroupSelect").value;
      if (state.share.groupId) { state.share.userId = null; $("#shareUserInput").value = ""; }
      renderShareSelected();
    };
    $("#shareSuggest").innerHTML = "";
    $("#shareSuggest").classList.remove("open");
    renderShareSelected();
    refreshShareModal();
    $("#shareModal").classList.add("open");
  }
  function refreshShareModal() {
    const regId = state.share.regId || $("#shareRegId").value;
    const reg = regById(regId);
    if (!reg) return;
    $("#shareRegId").value = reg.id;
    $("#shareRegName").textContent = reg.name;
    const shares = S.sharesOf(reg.id);
    const box = $("#shareExisting");
    if (!box) return;
    box.innerHTML = `<div class="muted" style="font-weight:700;margin-bottom:6px">People with view access (${shares.length})</div>` +
      (shares.length
        ? `<div class="inline">${shares.map(s => {
            const p = profileOf(s.sharedWithUserId);
            return `<span class="chip removable" onclick="removeShareConfirm('${s.id}')" title="Remove access">${avatar(p, "sm")}${esc(p.name)} ✕</span>`;
          }).join("")}</div>`
        : `<div class="muted">Not shared with anyone yet.</div>`);
  }
  function handleShareUserInput(q) {
    const box = $("#shareSuggest");
    if (!box) return;
    if (!q || !q.trim()) { box.classList.remove("open"); box.innerHTML = ""; return; }
    const regId = state.share.regId || $("#shareRegId").value;
    const already = S.sharesOf(regId).map(s => s.sharedWithUserId);
    const people = S.searchPeople(q).filter(p => !already.includes(p.id));
    if (!people.length) {
      box.innerHTML = `<div class="muted" style="padding:9px 10px">No new person found. Check the spelling, or ask them to sign in once.</div>`;
      box.classList.add("open");
      return;
    }
    box.innerHTML = people.map(p => `<div onclick="pickShareUser('${p.id}')">${avatar(p, "sm")}${esc(p.name)} <span class="muted">— ${esc(p.email)}</span></div>`).join("");
    box.classList.add("open");
  }
  function pickShareUser(userId) {
    state.share.userId = userId;
    state.share.groupId = "";
    const g = $("#shareGroupSelect");
    if (g) g.value = "";
    const p = profileOf(userId);
    const input = $("#shareUserInput");
    if (input) { input.value = p.name; input.dataset.userId = userId; }
    const box = $("#shareSuggest");
    if (box) box.classList.remove("open");
    renderShareSelected();
  }
  function renderShareSelected() {
    const box = $("#shareSelected");
    if (!box) return;
    if (state.share.userId) {
      const p = profileOf(state.share.userId);
      box.innerHTML = `<span class="chip">${avatar(p, "sm")}${esc(p.name)} — view only</span> <button class="btn btn-sm" onclick="clearSharePick()">Clear</button>`;
    } else if (state.share.groupId) {
      const g = S.data.groups.find(x => x.id === state.share.groupId);
      box.innerHTML = `<span class="chip">👥 ${esc(g ? g.name : "Group")} — view only for all members</span> <button class="btn btn-sm" onclick="clearSharePick()">Clear</button>`;
    } else {
      box.innerHTML = `<span class="small muted">Pick a person or a group below.</span>`;
    }
  }
  function clearSharePick() {
    state.share.userId = null;
    state.share.groupId = "";
    const i = $("#shareUserInput"); if (i) i.value = "";
    const g = $("#shareGroupSelect"); if (g) g.value = "";
    renderShareSelected();
  }
  async function doShare() {
    if (state.busy) return;
    const sel = $("#shareRegSelect");
    const regId = state.share.regId || (sel && sel.value);
    const reg = regById(regId);
    if (!reg) { toast("Pick a register first"); return; }
    if (!canEdit(reg)) { toast("Only the creator can share this register"); return; }
    const userId = state.share.userId;
    const groupId = state.share.groupId || ($("#shareGroupSelect") ? $("#shareGroupSelect").value : "");
    if (!userId && !groupId) { toast("Pick a person or a group first"); return; }
    state.busy = true;
    try {
      if (userId) {
        const r = await S.shareWithUser(regId, userId);
        toast(r.already ? `Already shared with ${r.name}` : `Shared with ${r.name} — view only ✓`);
        state.share.userId = null;
        const input = $("#shareUserInput"); if (input) input.value = "";
      } else {
        const r = await S.shareWithGroup(regId, groupId);
        toast(r.already ? `Already shared with ${r.name}` : `Shared to ${r.name} — ${r.added} staff get view-only access ✓`);
        state.share.groupId = "";
        const g = $("#shareGroupSelect"); if (g) g.value = "";
      }
      renderShareSelected();
      refreshShareModal();
      renderAll();
    } catch (e) {
      toast(e.message || "Could not share");
    } finally {
      state.busy = false;
    }
  }
  async function removeShareConfirm(shareId) {
    const s = S.data.shares.find(x => x.id === shareId);
    if (!s) return;
    const p = profileOf(s.sharedWithUserId);
    if (!window.confirm(`Remove ${p.name}'s view access?`)) return;
    try {
      await S.removeShare(shareId);
      toast("Access removed");
      refreshShareModal();
      renderAll();
    } catch (e) { toast(e.message); }
  }
  function openShareModalForUser(userId) {
    const regs = S.myRegisters();
    if (!regs.length) { toast("Create a register first, then share it"); return; }
    const reg = regById(state.reg.id) && S.myRegisters().some(r => r.id === state.reg.id) ? regById(state.reg.id) : regs[0];
    openShareModal(reg.id);
    pickShareUser(userId);
  }
  function openShareToGroupModal(groupId) {
    const regs = S.myRegisters();
    if (!regs.length) { toast("Create a register first, then share it"); return; }
    const reg = regById(state.reg.id) && S.myRegisters().some(r => r.id === state.reg.id) ? regById(state.reg.id) : regs[0];
    openShareModal(reg.id);
    state.share.userId = null;
    state.share.groupId = groupId;
    const g = $("#shareGroupSelect");
    if (g) g.value = groupId;
    renderShareSelected();
  }
  function closeShareModal() { $("#shareModal").classList.remove("open"); }

  // ---------------------------------------------------------------- people
  function handlePeopleSearch(q) {
    state.person = null;
    const box = $("#peopleSuggest");
    const results = $("#peopleSearchResults");
    if (results) results.innerHTML = `<div class="small muted">Search above, or pick someone from “All staff”.</div>`;
    if (!box) return;
    if (!q || !q.trim()) { box.classList.remove("open"); box.innerHTML = ""; return; }
    const people = S.searchPeople(q);
    if (!people.length) {
      box.innerHTML = `<div style="padding:9px 10px;color:var(--muted)">No one found for “${esc(q)}”.</div>`;
      box.classList.add("open");
      return;
    }
    box.innerHTML = people.map(p => `<div onclick="selectPerson('${p.id}')">${avatar(p, "sm")}${esc(p.name)} <span class="muted">— ${esc(p.email)}</span></div>`).join("");
    box.classList.add("open");
  }
  function selectPerson(userId) {
    state.person = userId;
    const input = $("#peopleSearch");
    if (input) input.value = S.profile(userId).name;
    const box = $("#peopleSuggest");
    if (box) box.classList.remove("open");
    renderPeople();
    const el = $("#peopleSearchResults");
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  async function askFriend(userId) {
    try {
      const res = await S.sendFriendRequest(userId);
      if (res.already === "friends") toast("You are already friends");
      else if (res.already === "pending") toast("Request already sent");
      else toast(`Friend request sent to ${S.profile(userId).name} ✓`);
      renderAll();
    } catch (e) { toast(e.message); }
  }
  async function respondFriend(id, status) {
    try {
      await S.respondFriendRequest(id, status);
      toast(status === "accepted" ? "Friend request accepted ✓" : "Request declined");
      renderAll();
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- groups
  function openGroupModal() {
    $("#newGroupName").value = "";
    const others = S.otherProfiles();
    $("#newGroupMembers").innerHTML = others.length
      ? others.map(p => `<label class="member-row"><input type="checkbox" value="${p.id}"> ${avatar(p, "sm")} ${esc(p.name)}</label>`).join("")
      : `<div class="small muted">No other people yet.</div>`;
    $("#groupModal").classList.add("open");
  }
  function closeGroupModal() { $("#groupModal").classList.remove("open"); }
  async function createGroup() {
    if (state.busy) return;
    const name = $("#newGroupName").value.trim();
    if (!name) { toast("Type a group name"); return; }
    const ids = Array.from(document.querySelectorAll("#newGroupMembers input:checked")).map(x => x.value);
    state.busy = true;
    try {
      const g = await S.createGroup(name, ids);
      closeGroupModal();
      state.groupId = g.id;
      setView("groups");
      renderAll();
      toast(`Group “${name}” created ✓`);
    } catch (e) {
      toast(e.message || "Could not create the group");
    } finally {
      state.busy = false;
    }
  }
  function openGroup(id) {
    state.groupId = id;
    setView("groups");
    renderAll();
  }
  function closeGroup() {
    state.groupId = null;
    setView("groups");
    renderAll();
  }
  async function sendGroupMsg(groupId) {
    const inp = $("#groupChatInput");
    if (!inp || !inp.value.trim()) return;
    const text = inp.value.trim();
    inp.value = "";
    try {
      await S.sendGroupMessage(groupId, text);
      renderGroups();
      scrollChats();
    } catch (e) {
      toast(e.message || "Message not sent");
      inp.value = text;
    }
  }
  function openAddMemberModal(groupId) {
    state.addMemberGroupId = groupId;
    $("#addMemberGroupId").value = groupId;
    $("#addMemberInput").value = "";
    $("#addMemberSuggest").innerHTML = "";
    $("#addMemberSuggest").classList.remove("open");
    renderAddMemberList("");
    $("#addMemberModal").classList.add("open");
  }
  function closeAddMemberModal() { $("#addMemberModal").classList.remove("open"); }
  function renderAddMemberList(q) {
    const groupId = state.addMemberGroupId;
    const inGroup = S.groupMembers(groupId);
    let people = S.otherProfiles().filter(p => !inGroup.includes(p.id));
    if (q && q.trim()) people = S.searchPeople(q).filter(p => !inGroup.includes(p.id));
    const box = $("#addMemberList");
    if (!box) return;
    box.innerHTML = people.length
      ? people.map(p => `<label class="member-row"><input type="checkbox" value="${p.id}" onchange="toggleAddMember('${p.id}', this.checked)"> ${avatar(p, "sm")} ${esc(p.name)}</label>`).join("")
      : `<div class="small muted" style="padding:6px">Everyone is already in this group.</div>`;
  }
  function handleAddMemberSearch(q) {
    renderAddMemberList(q);
    const box = $("#addMemberSuggest");
    if (box) { box.classList.remove("open"); box.innerHTML = ""; }
  }
  async function toggleAddMember(userId, checked) {
    if (!checked) return;
    try {
      await S.addGroupMember(state.addMemberGroupId, userId);
      toast(`${S.profile(userId).name} added to the group ✓`);
      closeAddMemberModal();
      renderAll();
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- chats
  function openChat(userId) {
    state.chatWith = userId;
    state.view = "chats";
    renderChats();
    renderTopbar();
    showView();
    scrollChats();
    setTimeout(() => { const el = $("#chatInput"); if (el && window.innerWidth > 900) el.focus(); }, 40);
  }
  function stateChatBack() {
    state.chatWith = null;
    renderChats();
  }
  async function sendChat(userId) {
    const inp = $("#chatInput");
    if (!inp || !inp.value.trim()) return;
    const text = inp.value.trim();
    inp.value = "";
    try {
      await S.sendDirectMessage(userId, text);
      renderChats();
      scrollChats();
    } catch (e) {
      toast(e.message || "Message not sent");
      inp.value = text;
    }
  }

  // ---------------------------------------------------------------- demo call (clearly labelled)
  let callTimer = null, callSec = 0;
  function startCall(userId) {
    const p = profileOf(userId);
    const overlay = $("#callOverlay");
    if (!overlay) return;
    $("#callAvatar").innerHTML = avatar(p);
    $("#callName").textContent = p.name;
    $("#callStatus").textContent = "Calling…";
    overlay.style.display = "flex";
    callSec = 0;
    clearInterval(callTimer);
    callTimer = setInterval(() => {
      callSec++;
      const m = String(Math.floor(callSec / 60)).padStart(2, "0");
      const s = String(callSec % 60).padStart(2, "0");
      const el = $("#callStatus");
      if (el) el.textContent = `${m}:${s} — demo screen (no audio)`;
    }, 1000);
    setTimeout(() => {
      const el = $("#callStatus");
      if (el && callSec < 2) el.textContent = "Ringing… (demo — no audio)";
    }, 1200);
  }
  function endCall() {
    clearInterval(callTimer);
    const overlay = $("#callOverlay");
    if (overlay) overlay.style.display = "none";
    toast("Call ended — this was a demo screen. Real WebRTC calling is the next step.");
  }

  // ---------------------------------------------------------------- owner setup guide
  function copyText(text, label) {
    const done = () => toast((label || "Copied") + " ✓");
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
        return;
      }
    } catch (e) { /* fall through */ }
    fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    } catch (e) { toast("Copy not allowed — select the text manually"); }
  }
  function copyRow(label, value) {
    return `<div class="copy-row">
      <div class="copy-label">${esc(label)}</div>
      <div class="copy-value">${esc(value)}</div>
      <button class="btn btn-sm" onclick="copyText('${esc(value).replace(/'/g, "\\'")}', '${esc(label)}')">Copy</button>
    </div>`;
  }
  function openSetupModal() {
    const modal = $("#setupModal");
    if (!modal) return;
    const configured = !!(window.RBAuth && window.RBAuth.isConfigured());
    const ref = configured && window.RBAuth.projectRef ? window.RBAuth.projectRef() : "<your-project-ref>";
    const origin = window.location.origin;
    const pageUrl = origin + window.location.pathname;
    const siteUrl = (window.RB_CONFIG && window.RB_CONFIG.SITE_URL) || "https://mahicouragw.github.io/Register-book/";
    const redirectUri = `https://${ref}.supabase.co/auth/v1/callback`;

    const status = $("#setupStatus");
    if (status) {
      status.innerHTML = configured
        ? `<div class="gate-hint ok"><span class="hint-title">Supabase is configured ✓</span>
            Project ref <code>${esc(ref)}</code> · mode: <b>${S.isDemo() ? "demo (sign in with Google for cloud)" : "Google account"}</b>.
            ${S.setupError ? `<div class="mt8" style="color:#991b1b">${esc(S.setupError)}</div>` : ""}</div>`
        : `<div class="gate-hint err"><span class="hint-title">Supabase is not connected yet</span>
            config.js still has REPLACE placeholders. Google sign-in shows a friendly message; demo mode works fully.</div>`;
    }

    const body = $("#setupBody");
    if (!body) return;
    body.innerHTML = `
      <ol class="setup-steps">
        <li>
          <b>Project URL + publishable key → <code>config.js</code></b>
          <div class="small muted">Open <a href="https://supabase.com/dashboard/project/${configured ? esc(ref) : "_/settings/api"}" target="_blank" rel="noopener">Project Settings → API</a>, copy the <b>Project URL</b> and the <b>publishable / anon</b> key (never the secret/service_role key).</div>
          ${configured ? copyRow("Project URL", (window.RB_CONFIG && window.RB_CONFIG.SUPABASE_URL) || "") : `<div class="small">Values are not set yet.</div>`}
        </li>
        <li>
          <b>Create the tables + security rules</b>
          <div class="small muted">Open the <a href="https://supabase.com/dashboard/project/${configured ? esc(ref) : "_"}/sql/new" target="_blank" rel="noopener">SQL Editor</a>, paste all of <code>supabase/migrations.sql</code> from this repo and press <b>Run</b>. The last query should list <b>9 tables</b>, all with <code>rowsecurity = true</code>.</div>
        </li>
        <li>
          <b>Supabase Auth → URL Configuration</b>
          <div class="small muted">Page: <a href="https://supabase.com/dashboard/project/${configured ? esc(ref) : "_"}/auth/url-configuration" target="_blank" rel="noopener">Authentication → URL Configuration</a>. Set the Site URL, then add these to Redirect URLs:</div>
          ${copyRow("Site URL", siteUrl)}
          ${copyRow("Redirect URL (this page)", pageUrl)}
          ${pageUrl !== siteUrl ? copyRow("Redirect URL (preview)", "Add this page + /** as well") : ""}
        </li>
        <li>
          <b>Google Cloud Console → OAuth client (you paste the secret yourself)</b>
          <div class="small muted">Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console → Credentials</a> → <b>Create credentials → OAuth client ID → Web application</b>, then add:</div>
          ${copyRow("Authorized JavaScript origin", origin)}
          ${copyRow("Authorized redirect URI", redirectUri)}
        </li>
        <li>
          <b>Supabase → Providers → Google → Enable</b>
          <div class="small muted">Open <a href="https://supabase.com/dashboard/project/${configured ? esc(ref) : "_"}/auth/providers" target="_blank" rel="noopener">Authentication → Providers → Google</a>, turn it on and paste the <b>Client ID</b> and <b>Client Secret</b> there. Never send the secret in chat.</div>
        </li>
        <li>
          <b>GitHub Pages</b>
          <div class="small muted">After merging, open <a href="https://github.com/Mahicouragw/Register-book/settings/pages" target="_blank" rel="noopener">Settings → Pages</a> → <b>Deploy from a branch</b> → <code>main</code> → <code>/ (root)</code> → Save. The site is then at <a href="${esc(siteUrl)}" target="_blank" rel="noopener">${esc(siteUrl)}</a>.</div>
        </li>
      </ol>
      <div class="card" style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:6px">
        <div class="strong">Connection check</div>
        <div class="small muted">Tests this phone's link to Supabase and tells you exactly what is missing.</div>
        <button class="btn btn-sm btn-primary mt8" onclick="runDiagnostics()">Run connection check</button>
        <div id="diagBox" class="mt8"></div>
      </div>
      <div class="small muted mt12">Rule of thumb: the <b>publishable/anon</b> key is public and may live in <code>config.js</code>. The <b>service_role</b> key and the Google <b>Client Secret</b> must only ever be pasted into the Supabase dashboard.</div>`;
    modal.classList.add("open");
  }
  async function runDiagnostics() {
    const box = $("#diagBox");
    if (!box) return;
    box.innerHTML = '<div class="small muted">Checking…</div>';
    const cfg = window.RB_CONFIG || {};
    const lines = [];
    const ok = t => lines.push("PASS  " + t);
    const bad = t => lines.push("FAIL  " + t);

    if (cfg.isConfigured && cfg.isConfigured()) ok("config.js: project URL + publishable key are set");
    else bad("config.js: still has REPLACE placeholders");

    const base = String(cfg.SUPABASE_URL || "").replace(/\/$/, "");
    const key = String(cfg.SUPABASE_ANON_KEY || "");
    lines.push("Project: " + (base || "(none)"));
    lines.push("This page: " + window.location.origin + window.location.pathname);

    if (base) {
      try {
        const res = await fetch(base + "/auth/v1/settings", { headers: { apikey: key } });
        if (res && res.ok) {
          const st = await res.json();
          const google = st && st.external ? st.external.google : undefined;
          if (google === true) ok("Supabase auth reachable — Google provider is ON");
          else if (google === false) bad("Supabase auth reachable — Google provider is OFF (Supabase → Authentication → Providers → Google → Enable → Save)");
          else lines.push("WARN  Supabase auth reachable, provider list not understood");
        } else {
          bad("Supabase auth returned HTTP " + (res ? res.status : "?"));
        }
      } catch (e) {
        bad("Cannot reach " + base + " from this browser (" + (e && e.message ? e.message : "network") + ")");
      }
      try {
        const res2 = await fetch(base + "/rest/v1/rb_profiles?select=id&limit=1", {
          headers: { apikey: key, Authorization: "Bearer " + key }
        });
        if (res2 && (res2.status === 401 || res2.status === 403)) {
          ok("Database reachable and locked to signed-out visitors (correct)");
        } else if (res2 && res2.ok) {
          const rows = await res2.json();
          ok("Database reachable — rb_profiles answered (" + (Array.isArray(rows) ? rows.length : 0) + " rows visible while signed out, 0 expected)");
        } else if (res2 && res2.status === 404) {
          bad("Table rb_profiles not found — run supabase/migrations.sql in the SQL Editor");
        } else {
          bad("Database check returned HTTP " + (res2 ? res2.status : "?"));
        }
      } catch (e) {
        bad("Database check failed (" + (e && e.message ? e.message : "network") + ")");
      }
    }

    lines.push("Google redirect URI: https://" + (cfg.projectRef ? cfg.projectRef() : "…") + ".supabase.co/auth/v1/callback");
    lines.push("Signed in as: " + (S.me ? S.me.name + (S.isDemo() ? " (demo mode)" : " (Google)") : "nobody"));
    if (S.setupError) bad("Database error: " + S.setupError);

    const failed = lines.filter(l => l.startsWith("FAIL")).length;
    const head = failed
      ? `<div class="gate-hint err" style="margin:0 0 8px"><b>${failed} thing${failed > 1 ? "s" : ""} need${failed > 1 ? "" : "s"} fixing</b> — see FAIL lines below.</div>`
      : `<div class="gate-hint ok" style="margin:0 0 8px"><b>Everything checks out ✓</b> — tap Continue with Google.</div>`;
    box.innerHTML = head + `<pre class="diag">${esc(lines.join("\n"))}</pre>` +
      `<button class="btn btn-sm mt8" onclick="copyText(document.querySelector('.diag').textContent, 'Check report')">Copy report</button>`;
  }
  function closeSetupModal() {
    const modal = $("#setupModal");
    if (modal) modal.classList.remove("open");
  }

  // ---------------------------------------------------------------- auth actions
  async function handleGoogleLogin() {
    setHint("Opening Google…", "ok");
    const res = await window.RBAuth.signInGoogle();
    if (!res.ok) { showGateError(res.error); return; }
    setHint("Connecting to Google… if nothing happens, check the popup/redirect settings.", "ok");
  }
  async function handleSignOut() {
    clearInterval(state.timer);
    await window.RBAuth.signOut();
    state.chatWith = null;
    state.groupId = null;
    state.person = null;
    state.reg = { id: null, page: 1, highlightDate: null };
    showGate();
    defaultGateHint();
  }
  function enterDemo(userId) {
    clearInterval(state.timer);
    const me = S.initDemo(userId);
    state.reg = { id: null, page: 1, highlightDate: null };
    state.chatWith = null;
    state.groupId = null;
    state.person = null;
    state.insideSearch = "";
    showApp();
    renderAll();
    setView("home");
    toast(`Demo mode — signed in as ${me.name}`);
  }
  async function demoStory() {
    const reg = S.data.registers.find(r => r.ownerId === "goldfish" && /medicine/i.test(r.name)) || S.data.registers.find(r => r.ownerId === "goldfish");
    if (!reg) { toast("Demo data missing"); return; }
    try {
      const r = await S.shareWithUser(reg.id, "silverfish");
      toast(r.already ? "Already shared with Silverfish — switch to Silverfish to check view-only" : "Shared Goldfish's checklist with Silverfish ✓");
      enterDemo("silverfish");
      setTimeout(() => setView("shared"), 120);
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- refresh / boot
  async function manualRefresh() {
    if (S.isDemo()) { renderAll(); toast("Demo data refreshed"); return; }
    try {
      await S.refresh();
      renderAll();
      toast("Refreshed ✓");
    } catch (e) { toast(e.message || "Refresh failed"); }
  }
  function autoRefreshTick() {
    if (S.isDemo() || document.hidden) return;
    if (document.querySelector(".modal.open")) return;
    const a = document.activeElement;
    if (a && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return;
    S.refresh().then(() => renderAll()).catch(() => {});
  }
  function startAutoRefresh() {
    clearInterval(state.timer);
    if (S.isDemo()) return;
    state.timer = setInterval(autoRefreshTick, 20000);
  }

  async function boot() {
    fillGateChips();
    const today = $("#todayPreview");
    if (today) today.textContent = fmtFull(new Date());

    if (window.RBAuth) {
      window.RBAuth.onChange(async (event, session) => {
        if (event === "SIGNED_IN" && session && !S.isDemo()) { await loadCloudAndShow(); }
        if (event === "SIGNED_OUT") { showGate(); }
      });
    }

    const res = await window.RBAuth.init();
    if (res.urlError && !res.session) {
      showGate(res.urlError);
      return;
    }
    if (res.session) {
      const ok = await loadCloudAndShow();
      if (!ok) {
        showGate({
          title: "Signed in, but the database is not ready",
          message: S.setupError || "Unknown database error.",
          steps: [
            `Open <a href="https://supabase.com/dashboard" target="_blank" rel="noopener">Supabase</a> → SQL Editor`,
            "Paste the contents of <code>supabase/migrations.sql</code> from this repo and press Run",
            "Come back and refresh this page"
          ]
        });
      }
      return;
    }

    // no Supabase session: restore demo if the person chose it before
    let demo = null;
    try { demo = localStorage.getItem("rb_demo_user"); } catch (e) {}
    if (demo && S.demoUsers().some(u => u.id === demo)) {
      S.initDemo(demo);
      showApp();
      renderAll();
      setView("home");
      startAutoRefresh();
      return;
    }
    showGate();
  }

  let loadingCloud = false;
  async function loadCloudAndShow() {
    if (loadingCloud) return true;
    loadingCloud = true;
    let ok = false;
    try {
      ok = await S.initCloud();
    } finally {
      loadingCloud = false;
    }
    if (!ok) return false;
    showApp();
    renderAll();
    setView("home");
    startAutoRefresh();
    return true;
  }

  // ---------------------------------------------------------------- expose
  Object.assign(window, {
    setView, openCreateModal, closeCreateModal, createRegister,
    openRegister, changePage, gotoPageInput, addLine, toggleDone, editEntry, deleteEntry, deleteRegister,
    handleInsideSearch, jumpToSuggestion,
    openShareModal, closeShareModal, handleShareUserInput, pickShareUser, clearSharePick, doShare, removeShareConfirm,
    openShareModalForUser, openShareToGroupModal,
    handlePeopleSearch, selectPerson, askFriend: askFriend, sendFriendRequest: askFriend, respondFriend,
    openGroupModal, closeGroupModal, createGroup, openGroup, closeGroup, sendGroupMsg,
    openAddMemberModal, closeAddMemberModal, handleAddMemberSearch, toggleAddMember,
    openChat, sendChat, stateChatBack, startCall, endCall,
    handleGoogleLogin, handleSignOut, enterDemo, demoStory,
    handleFriend: respondFriend,
    toast, toggleSidebar, manualRefresh,
    openSetupModal, closeSetupModal, copyText, runDiagnostics
  });

  // small aliases used by inline handlers in older docs
  window.confirmDemoReset = function () {
    if (!S.isDemo()) return;
    if (!window.confirm("Reset all demo data back to the original story?")) return;
    S.resetDemo();
    renderAll();
    toast("Demo data reset ✓");
  };

  document.addEventListener("DOMContentLoaded", boot);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) autoRefreshTick();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      ["createModal", "shareModal", "groupModal", "addMemberModal"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove("open");
      });
      document.body.classList.remove("sidebar-open");
    }
  });

  // hook for automated tests
  window.__RB = {
    get data() { return S.data; },
    get state() { return state; },
    store: S,
    canEdit,
    canView,
    analyzeQuery,
    buildSuggestions,
    renderAll,
    setView,
    enterDemo,
    boot
  };
})();
