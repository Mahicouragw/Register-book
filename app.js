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
    invite: { groupId: null, userId: null, code: "" },
    call: null,
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

  // ---------------------------------------------------------------- render: header + topbar
  // ---------------------------------------------------------------- render: header
  function renderHeader() {
    const me = S.me;
    if (!me) return;
    const demo = S.isDemo();
    const badge = $("#modeBadge");
    if (badge) {
      badge.textContent = demo ? "Demo" : "Google";
      badge.className = "mode-badge " + (demo ? "mode-demo" : "mode-real");
    }
    const unread = (S.unreadNotifications ? S.unreadNotifications() : []).length;
    const invites = (S.incomingInvites ? S.incomingInvites() : []).length;
    const n = unread + invites;
    const bell = $("#bellCount");
    if (bell) {
      bell.textContent = n > 99 ? "99+" : String(n);
      bell.hidden = n === 0;
    }
    const bb = $("#bellBtn");
    if (bb) bb.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications, none unread");
    const today = $("#todayPreview");
    if (today) today.textContent = fmtFull(new Date());
  }

  const TITLES = {
    home: ["Home", "Today, your books, and what is new for you"],
    library: ["Library", "My register books + books shared with me"],
    community: ["Community", "People, friends, groups and chats"],
    settings: ["Settings", "Your account, notifications and legal"],
    inbox: ["Notifications", "Messages, friend requests, group invites and calls"],
    registerDetail: ["Register book", "10 lines per page • unlimited pages"],
    qbookEditor: ["Question book", "Write your questions • add pages any time"],
    qbookAnswer: ["Answer book", "Answer on the lined pages • save and continue later"],
    qbookResults: ["Completed book", "Every original question with the answer given"]
  };
  function renderTopbar() {
    const t = TITLES[state.view] || TITLES.home;
    const title = $("#topTitle"), sub = $("#topSub");
    if (title) title.textContent = t[0];
    if (sub) sub.textContent = t[1];
    const actions = $("#topActions");
    if (!actions) return;
    let html = "";
    if (state.view === "library") {
      html += `<button class="btn btn-sm btn-primary" onclick="openCreateModal()">+ Create Register</button>`;
    }
    if (state.view === "community" && !state.groupId) {
      html += `<button class="btn btn-sm btn-primary" onclick="openGroupModal()">+ Create Group</button>`;
    }
    if (state.view === "inbox") {
      html += `<button class="btn btn-sm" onclick="markAllNotificationsRead()">Mark all read</button>`;
    }
    if (state.view === "qbookEditor" || state.view === "qbookAnswer" || state.view === "qbookResults") {
      html += `<button class="btn btn-sm" onclick="setView('library')">← Back to library</button>`;
    }
    if (state.view === "registerDetail") {
      html += `<button class="btn btn-sm" onclick="backToLibrary()">← Back to books</button>`;
      const reg = regById(state.reg.id);
      if (reg && canEdit(reg)) {
        html += `<button class="btn btn-sm btn-primary" onclick="openShareModal('${reg.id}')">Share</button>`;
        html += `<button class="btn btn-sm btn-ghost" style="color:#dc2626" onclick="deleteRegister('${reg.id}')">Delete book</button>`;
      }
    }
    if (!S.isDemo() && (state.view === "community" || state.view === "library" || state.view === "inbox")) {
      html += `<button class="btn btn-sm" onclick="manualRefresh()">↻ Refresh</button>`;
    }
    actions.innerHTML = html;
    const bar = $("#subbar");
    if (bar) bar.style.display = "flex";
  }

  // Which tab is "current" when a sub-screen (inbox, a register, a chat) is open.
  function tabForView(name) {
    if (name === "registerDetail") return "library";
    if (name === "qbookEditor" || name === "qbookAnswer" || name === "qbookResults") return "library";
    if (name === "inbox") return "home";
    return name;
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
    const tab = tabForView(state.view);
    $$(".tab").forEach(n => {
      const on = n.dataset.view === tab;
      n.classList.toggle("active", on);
      n.setAttribute("aria-selected", on ? "true" : "false");
    });
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  function backToLibrary() {
    state.reg = { id: null, page: 1, highlightDate: null };
    state.insideSearch = "";
    setView("library");
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

  // ---------------------------------------------------------------- notification rows
  function notifIcon(t) {
    return t === "call" ? "📞" : t === "friend" ? "🧑‍🤝‍🧑" : t === "invite" ? "👥" : t === "system" ? "🔔" : "💬";
  }
  function notifActionsHtml(n) {
    const d = n.data || {};
    if (n.type === "friend") {
      return `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();actFriend('${esc(d.requestId || n.id)}','accepted')">Accept</button>
              <button class="btn btn-sm" onclick="event.stopPropagation();actFriend('${esc(d.requestId || n.id)}','declined')">Decline</button>`;
    }
    if (n.type === "invite") {
      return `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();joinGroup('${esc(d.code || "")}')">Join</button>
              <button class="btn btn-sm" onclick="event.stopPropagation();declineGroupInvite('${esc(d.code || "")}')">Decline</button>`;
    }
    if (n.type === "call") {
      return `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();answerCall('${esc(d.callId || "")}')">Answer</button>
              <button class="btn btn-sm" onclick="event.stopPropagation();declineCall('${esc(d.callId || "")}')">Decline</button>`;
    }
    return `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();openNotification('${esc(n.id)}')">Open</button>`;
  }
  function notifRow(n) {
    return `<div class="list-item ${n.read ? "" : "unread"}" onclick="openNotification('${esc(n.id)}')">
      <div style="width:40px;height:40px;border-radius:10px;background:${n.read ? "#f3f4f6" : "#ecfdf5"};display:grid;place-items:center;font-size:18px">${notifIcon(n.type)}</div>
      <div class="flex1">
        <div class="strong">${esc(n.title)}</div>
        <div class="small muted">${esc(n.body || "")}${n.body ? " • " : ""}${esc(fmtDay(n.createdAt))}</div>
      </div>
      <div class="row" style="gap:6px">${notifActionsHtml(n)}</div>
    </div>`;
  }
  function inviteRow(inv) {
    const g = S.data.groups.find(x => x.id === inv.groupId);
    const from = profileOf(inv.createdBy);
    return `<div class="list-item unread">
      <div style="width:40px;height:40px;border-radius:10px;background:#eff6ff;display:grid;place-items:center;font-size:18px">👥</div>
      <div class="flex1">
        <div class="strong">You're invited to ${esc(g ? g.name : "a group")}</div>
        <div class="small muted">From ${esc(from.name)} • ${esc(fmtDay(inv.createdAt))}</div>
      </div>
      <div class="row" style="gap:6px">
        <button class="btn btn-sm btn-primary" onclick="joinGroup('${esc(inv.code)}')">Join</button>
        <button class="btn btn-sm" onclick="declineGroupInvite('${esc(inv.code)}')">Decline</button>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- HOME
  function renderHome() {
    const c = $("#view-home");
    if (!c) return;
    const me = S.me;
    const my = S.myRegisters();
    const unread = S.unreadNotifications ? S.unreadNotifications() : [];
    const invites = S.incomingInvites ? S.incomingInvites() : [];
    const newCount = unread.length + invites.length;
    const now = new Date();

    c.innerHTML = `
      ${setupBanner()}

      <div class="card hero">
        <div class="hero-date" id="todayPreview">${esc(fmtFull(now))}</div>
        <div class="hero-hi">Hello, ${esc(me.name)} 👋</div>
        <div class="hero-sub">Write a line and today's date is saved for you automatically.</div>
        <button class="btn btn-primary btn-xl btn-block" onclick="openCreateModal()">＋ Create a register book</button>
      </div>

      ${newCount ? `
      <div class="card mt12">
        <div class="card-head">
          <h3>New for you</h3>
          <span class="badge badge-green">${newCount} new</span>
          <button class="btn btn-sm" onclick="openInbox()">Open inbox</button>
        </div>
        <div class="list">
          ${invites.map(inviteRow).join("")}
          ${unread.slice(0, 4).map(notifRow).join("")}
        </div>
      </div>` : `
      <div class="card mt12">
        <div class="card-head"><h3>New for you</h3><span class="badge badge-gray">Nothing new</span></div>
        <div class="card-pad small muted">Messages, friend requests, group invites and calls land here — and on your lock screen if you switch notifications on in Settings.</div>
      </div>`}

      <div class="card mt12">
        <div class="card-head">
          <h3>My books</h3>
          <span class="badge">${my.length}</span>
          <button class="btn btn-sm" onclick="setView('library')">See all →</button>
        </div>
        <div class="list">
          ${my.length ? my.slice(0, 4).map(r => registerRow(r)).join("")
            : `<div class="empty"><div class="big">No books yet</div><div class="small">Tap the big green button above to create your first register.</div></div>`}
        </div>
      </div>`;
  }

  function renderMyRegisters() {
    const c = $("#view-myRegisters");
    if (!c) return;
    const regs = S.myRegisters();
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>My register books — ${regs.length}</h3>
          <span class="badge badge-green">OWNER — you can edit</span>
          <button class="btn btn-sm btn-primary" onclick="openCreateModal()">+ Create register</button>
        </div>
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
      <div class="card mt12">
        <div class="card-head">
          <h3>Shared with me — ${regs.length}</h3>
          <span class="badge badge-amber">VIEW-ONLY — you can read and search, not edit</span>
        </div>
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
      <div class="section-title">People &amp; friends</div>
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
            <button class="btn btn-sm btn-primary" onclick="openInviteModal('${open.id}')">Invite people</button>
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

    const pendingInvites = S.incomingInvites ? S.incomingInvites() : [];
    c.innerHTML = `
      <div class="section-title">Groups</div>
      <div class="card">
        <div class="card-head"><h3>Join a group</h3><span class="badge">Invite code</span></div>
        <div class="card-pad">
          <label class="small" for="joinCodeInput">Paste the invite code a colleague sent you (or open their invite link)</label>
          <div class="row mt8">
            <input id="joinCodeInput" class="code-input" placeholder="e.g. ABCD2345" autocomplete="off" maxlength="24">
            <button class="btn btn-primary" onclick="joinGroup(document.getElementById('joinCodeInput').value)">Join group</button>
          </div>
          <div class="small muted mt8">Groups are private — nobody can see a group they have not been invited to.</div>
        </div>
      </div>

      ${pendingInvites.length ? `
      <div class="card mt12">
        <div class="card-head"><h3>Invites waiting for you</h3><span class="badge badge-green">${pendingInvites.length}</span></div>
        <div class="list">${pendingInvites.map(inviteRow).join("")}</div>
      </div>` : ""}

      <div class="row mt12" style="margin-bottom:12px">
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
            <button class="btn btn-sm" onclick="event.stopPropagation();startCall('${p.id}','audio')" aria-label="Audio call ${esc(p.name)}">📞 Audio</button>
            <button class="btn btn-sm" onclick="event.stopPropagation();startCall('${p.id}','video')" aria-label="Video call ${esc(p.name)}">🎥 Video</button>
          </div>`).join("") : `<div class="empty small">No other people yet.</div>`}
      </div>
    </div>`;

    const paneHtml = selected ? `<div class="card">
      <div class="chat-head">
        ${avatar(selected)}
        <div><div class="strong">${esc(selected.name)}</div><div class="small muted">${esc(selected.email)}</div></div>
        <div class="spacer"></div>
        <button class="btn btn-sm" onclick="stateChatBack()">← Chats</button>
        <button class="btn btn-sm btn-primary" onclick="startCall('${selected.id}','audio')">📞 Audio call</button>
        <button class="btn btn-sm btn-primary" onclick="startCall('${selected.id}','video')">🎥 Video call</button>
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
    </div>` : `<div class="card"><div class="empty"><div class="big">Select a chat</div><div class="small">Pick a person to message. The 📞 Audio and 🎥 Video buttons place a real call over the internet.</div></div></div>`;

    c.innerHTML = `<div class="section-title">Private chats</div><div class="${selected ? "grid grid-2" : ""}">${listHtml}${selected ? paneHtml : ""}</div>`;
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
          <label class="sr-only" for="newLineText">Write a line</label>
          <textarea id="newLineText" class="add-line-main" rows="2" placeholder="Write a line…" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addLine('${reg.id}')}"></textarea>
          ${reg.type === "Bill Book" ? `<input id="newLineQty" type="number" min="0" step="1" placeholder="Qty" aria-label="Quantity"><input id="newLineAmt" type="number" min="0" step="0.01" placeholder="₹ Amount" aria-label="Amount in rupees">` : ""}
          <button class="btn btn-primary add-btn add-btn-xl" onclick="addLine('${reg.id}')">＋ Add line</button>
          <div class="add-line-foot">
            <button type="button" class="link-btn" id="lineDateToggle" onclick="toggleLineDate()" aria-expanded="false" aria-controls="lineDateWrap">Use a different date?</button>
          </div>
          <div class="add-line-date" id="lineDateWrap" hidden>
            <label for="newLineDate">Date for this line (only if you are writing up an older day)</label>
            <input type="date" id="newLineDate" value="${todayIso()}">
            <button class="btn btn-sm" onclick="useTodayForLine()">Back to today</button>
          </div>
        </div>
        <div class="small muted" style="padding:0 16px 12px var(--rail)">Today's date is saved automatically. When a page fills (10 lines), the next line moves to a new page — we tell you.</div>`
        : `<div class="small muted" style="padding:12px 16px 12px var(--rail);background:#fef2f2;border-top:1px solid #fecaca">Editing is disabled — you have view-only access. ${S.isDemo() ? `Switch to ${esc(owner.name)} in Settings → Demo switcher to edit.` : "Only the creator can change this register."}</div>`}
      </div>

      <div class="card mt12">
        <div class="card-head"><h3>Shared with</h3>${editable ? `<button class="btn btn-sm" onclick="openShareModal('${reg.id}')">+ Share this register</button>` : `<span class="badge badge-gray">View only</span>`}</div>
        <div class="card-pad small">
          ${shares.length ? `<div class="inline">${shareChips}</div>` : `<span class="muted">Not shared yet.${editable ? " Use Share to give someone read-only access." : ""}</span>`}
        </div>
      </div>`;
  }

  // The question-book screens live in qbooks-ui.js. They are optional, so the
  // rest of the app keeps working even if that file failed to load.
  function renderQuestionBooks() {
    if (window.RBQBooksUI && window.RBQBooksUI.render) window.RBQBooksUI.render();
  }
  function refreshQuestionBookScreens() {
    if (window.RBQBooksUI && window.RBQBooksUI.refresh) window.RBQBooksUI.refresh();
  }

  function renderAll() {
    if (!S.me) return;
    renderHeader();
    renderHome();
    renderMyRegisters();
    renderShared();
    renderPeople();
    renderGroups();
    renderChats();
    renderInbox();
    renderSettings();
    renderRegisterDetail();
    if (state.view === "registerDetail" && !regById(state.reg.id)) state.view = "home";
    renderQuestionBooks();
    refreshQuestionBookScreens();
    renderTopbar();
    showView();
  }

  // ---------------------------------------------------------------- INBOX
  function openInbox() {
    state.view = "inbox";
    renderInbox();
    renderTopbar();
    showView();
  }
  function renderInbox() {
    const c = $("#view-inbox");
    if (!c) return;
    const list = S.notifications ? S.notifications() : [];
    const invites = S.incomingInvites ? S.incomingInvites() : [];
    c.innerHTML = `
      ${invites.length ? `
      <div class="card">
        <div class="card-head"><h3>Group invites</h3><span class="badge badge-green">${invites.length} waiting</span></div>
        <div class="list">${invites.map(inviteRow).join("")}</div>
      </div>` : ""}

      <div class="card ${invites.length ? "mt12" : ""}">
        <div class="card-head">
          <h3>Notifications</h3>
          <span class="badge">${list.filter(n => !n.read).length} unread</span>
          <button class="btn btn-sm" onclick="markAllNotificationsRead()">Mark all read</button>
        </div>
        <div class="list">
          ${list.length ? list.map(notifRow).join("")
            : `<div class="empty"><div class="big">Nothing here yet</div><div class="small">Messages, friend requests, group invites and calls will appear here — and on your lock screen when notifications are on.</div></div>`}
        </div>
      </div>

      <div class="card mt12">
        <div class="card-head"><h3>Make notifications work while the app is closed</h3></div>
        <div class="card-pad small">
          <button class="btn btn-sm btn-primary" onclick="setView('settings')">Open notification settings</button>
          <div class="mt8 muted">On iPhone you must first use Share → Add to Home Screen, then open the app from the new icon.</div>
        </div>
      </div>`;
  }
  async function markAllNotificationsRead() {
    if (!S.markAllNotificationsRead) return;
    await S.markAllNotificationsRead();
    renderAll();
    toast("All notifications marked as read");
  }
  async function openNotification(id) {
    const n = S.data.notifications.find(x => x.id === id);
    if (!n) return;
    if (!n.read) await S.markNotificationRead(id);
    const d = n.data || {};
    if (n.type === "message" && d.senderId) { setView("community"); openChat(d.senderId); renderAll(); return; }
    if (n.type === "friend") { setView("community"); renderAll(); return; }
    if (n.type === "invite" && d.code) { showJoinInvite(d.code); return; }
    if (n.type === "call") { setView("community"); renderAll(); return; }
    setView("home");
    renderAll();
  }
  async function actFriend(requestId, status) {
    try {
      await S.respondFriendRequest(requestId, status);
      toast(status === "accepted" ? "Friend request accepted ✓" : "Friend request declined");
      renderAll();
    } catch (e) { toast(e.message || "Could not update the request"); }
  }
  async function joinGroup(code) {
    const cleaned = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!cleaned) { toast("Type the invite code first"); return; }
    try {
      const gid = await S.acceptInvite(cleaned);
      toast("You joined the group ✓");
      closeJoinModal();
      state.groupId = gid;
      renderAll();
      setView("community");
    } catch (e) { toast(e.message || "Could not join the group"); }
  }
  async function declineGroupInvite(code) {
    try {
      await S.declineInvite(String(code || "").trim().toUpperCase());
      toast("Invite declined");
      renderAll();
    } catch (e) { toast(e.message || "Could not decline the invite"); }
  }
  async function answerCall(callId) {
    if (!callId) { toast("That call has already ended"); return; }
    setView("community");
    openCallScreen({ name: profileOf((S.data.calls.find(c => c.id === callId) || {}).callerId || "").name, kind: "audio", direction: "in" });
    try { await window.RBRtc.answer(callId); }
    catch (e) { showCallError(e.message || "Could not answer the call"); }
  }
  async function declineCall(callId) {
    try {
      await window.RBRtc.decline(callId);
      toast("Call declined");
      hideCallScreen();
    } catch (e) { toast(e.message || "Could not decline"); }
  }

  // ---------------------------------------------------------------- SETTINGS
  function renderSettings() {
    const c = $("#view-settings");
    if (!c) return;
    const me = S.me;
    const demo = S.isDemo();
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>My account</h3>
          ${demo ? `<span class="badge badge-amber">Demo account</span>` : `<span class="badge badge-green">Google account ✓</span>`}
        </div>
        <div class="card-pad">
          <div class="account-card" id="accountCard">
            ${avatar(me, "acct-avatar")}
            <div class="acct-info">
              <div class="acct-name">${esc(me.name)} <span class="${demo ? "demo-badge" : "real-badge"}">${demo ? "Demo" : "Google ✓"}</span></div>
              <div class="acct-email">${esc(me.email || (demo ? "demo account" : ""))}</div>
            </div>
          </div>
          <button class="btn btn-danger btn-block mt12" onclick="handleSignOut()">${demo ? "Exit demo mode" : "Sign out of Google"}</button>
        </div>
      </div>

      <div class="card mt12">
        <div class="card-head"><h3>Notifications</h3><span class="badge badge-gray" id="notifStateBadge">…</span></div>
        <div class="card-pad" id="notifBody"></div>
      </div>

      <div class="card mt12">
        <div class="card-head"><h3>Legal &amp; help</h3></div>
        <div class="card-pad">
          <div class="row">
            <a class="btn btn-sm" href="terms.html" target="_blank" rel="noopener">📄 Terms &amp; Conditions</a>
            <a class="btn btn-sm" href="privacy.html" target="_blank" rel="noopener">🔒 Privacy Policy</a>
          </div>
        </div>
      </div>

      <div class="card mt12" style="border-color:#fecaca">
        <div class="card-head"><h3 style="color:#991b1b">Delete my account</h3></div>
        <div class="card-pad">
          <div class="small">Permanently removes your account, your books and your messages. Nothing can be undone.</div>
          <div class="row mt8">
            <button class="btn btn-sm" onclick="downloadMyBooks()">⬇ Download my books first</button>
            <button class="btn btn-sm" style="color:#dc2626;border-color:#fecaca" onclick="openDeleteModal()">Delete my account…</button>
          </div>
        </div>
      </div>

      ${demo ? `
      <div class="card mt12">
        <div class="demo-switch" id="demoSwitch">
          <label for="demoUserSelect">Demo — switch account to test sharing</label>
          <select id="demoUserSelect" class="demo-select" aria-label="Demo user"></select>
          <div class="help-text">Try the story: create as <b>Goldfish</b>, share, then switch to <b>Silverfish</b> — Silverfish can read &amp; search but cannot edit.</div>
          <div class="row mt8">
            <button class="btn btn-sm btn-ghost" onclick="confirmDemoReset()">↺ Reset demo data</button>
            <button class="btn btn-sm" onclick="simulateIncomingCall('audio')">📞 Preview incoming call screen</button>
          </div>
        </div>
      </div>` : ""}`;
    wireSettings();
  }

  function wireSettings() {
    const sel = $("#demoUserSelect");
    if (sel && S.isDemo()) {
      sel.innerHTML = S.demoUsers().map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(u.email)}</option>`).join("");
      sel.value = S.me.id;
      sel.onchange = e => enterDemo(e.target.value);
    }
    renderNotificationSettings();
  }

  function renderNotificationSettings() {
    const box = $("#notifBody");
    if (!box) return;
    const P = window.RBPush;
    const st = P ? P.statusText() : { state: "unsupported", title: "Notifications are not available", body: "This browser cannot receive web push.", canEnable: false };
    const badge = $("#notifStateBadge");
    if (badge) {
      badge.textContent = st.state === "granted" ? "ON" : st.state === "denied" ? "BLOCKED" : "OFF";
      badge.className = "badge " + (st.state === "granted" ? "badge-green" : st.state === "denied" ? "badge-red" : "badge-gray");
    }
    box.innerHTML = `
      <div class="notif-state ${esc(st.state)}">
        <div class="strong">${esc(st.title)}</div>
        <div class="small muted mt8">${esc(st.body)}</div>
        ${st.howTo ? `<div class="small mt8 how-to"><b>How:</b> ${esc(st.howTo)}</div>` : ""}
      </div>
      <div class="row mt12">
        ${st.canEnable ? `<button class="btn btn-primary" onclick="switchNotifications(true)">Switch notifications ON</button>` : ""}
        ${st.state === "granted" ? `<button class="btn" onclick="switchNotifications(false)">Switch notifications OFF</button>` : ""}
        <button class="btn" onclick="sendTestNotification()">Send test notification</button>
      </div>
      <div id="notifResult" class="small mt8" aria-live="polite"></div>
      <div class="small muted mt12 limits">
        <b>Honest limits.</b> Android Chrome delivers push from a normal tab, and better once you
        “Add to Home Screen”. <b>iPhone Safari only delivers web push after Share → Add to Home Screen</b>
        (iOS 16.4 or newer); inside a normal Safari tab Apple blocks it, so this screen says so
        instead of pretending it works.
      </div>`;
  }

  async function switchNotifications(on) {
    const set = t => { const b = $("#notifResult"); if (b) b.textContent = t; };
    set("Working…");
    const P = window.RBPush;
    if (!P) { set("Push is not available in this browser."); return; }
    const res = on ? await P.enable() : await P.disable();
    if (!res.ok) {
      set(res.message || "Could not change notifications.");
      toast(res.message || "Could not change notifications");
    } else {
      set(on ? "Notifications are ON ✓ — press “Send test notification” to prove it." : "Notifications are OFF.");
    }
    renderNotificationSettings();
    renderHeader();
  }

  async function sendTestNotification() {
    const set = t => { const b = $("#notifResult"); if (b) b.textContent = t; };
    set("Sending…");
    const res = await window.RBPush.sendTest();
    set(res.message || (res.ok ? "Sent ✓" : "Failed"));
    if (res.ok) renderAll();
  }

  // ---------------------------------------------------------------- delete account
  function downloadMyBooks() {
    if (!S.exportMyBooks) return;
    const text = S.exportMyBooks();
    try {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "registerbook-my-books.txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("Download started ✓");
    } catch (e) {
      const w = window.open("", "_blank");
      if (w) { w.document.write("<pre>" + esc(text) + "</pre>"); }
      else toast("Could not download — your browser blocked it");
    }
  }
  function openDeleteModal() {
    const body = $("#deleteBody"), m = $("#deleteModal");
    if (!body || !m) return;
    const sum = S.accountSummary ? S.accountSummary() : {};
    body.innerHTML = `
      <div class="danger-note"><b>This cannot be undone.</b> Everything below is deleted for ever:</div>
      <ul class="delete-list">
        <li><b>${sum.registers || 0}</b> register book(s) you created</li>
        <li><b>${sum.lines || 0}</b> lines you wrote inside them</li>
        <li><b>${sum.shares || 0}</b> share(s) — <b>books you shared will disappear for the other staff too</b></li>
        <li><b>${sum.groups || 0}</b> group(s) you created and <b>${sum.memberships || 0}</b> group membership(s)</li>
        <li><b>${sum.messages || 0}</b> private message(s) and <b>${sum.groupMessages || 0}</b> group message(s)</li>
        <li>your profile (Google name, email and photo) and your friend connections</li>
      </ul>
      <div class="row"><button class="btn btn-sm" onclick="downloadMyBooks()">⬇ Download my books first</button></div>
      <hr class="hr">
      <div class="form-row">
        <label for="deleteConfirm">Type <b>DELETE</b> to confirm</label>
        <input id="deleteConfirm" placeholder="DELETE" autocomplete="off" autocapitalize="characters">
      </div>
      <div class="row">
        <button class="btn btn-danger" onclick="confirmDeleteAccount()">Delete my account</button>
        <button class="btn" onclick="closeDeleteModal()">Cancel</button>
      </div>
      <div id="deleteResult" class="small mt8" aria-live="polite"></div>`;
    m.classList.add("open");
  }
  function closeDeleteModal() { const m = $("#deleteModal"); if (m) m.classList.remove("open"); }
  async function confirmDeleteAccount() {
    const inp = $("#deleteConfirm");
    if (!inp || String(inp.value).trim().toUpperCase() !== "DELETE") { toast('Please type DELETE to confirm'); return; }
    const set = t => { const b = $("#deleteResult"); if (b) b.textContent = t; };
    set("Working…");
    if (S.isDemo()) {
      await S.requestAccountDeletion("demo mode");
      set("Demo mode: deletion is recorded as a request only. Real deletion needs a signed-in Google account and the rb-delete-account Edge Function.");
      return;
    }
    const res = await S.deleteAccountNow();
    if (!res.ok) {
      try { await S.requestAccountDeletion("edge function unavailable: " + (res.reason || "")); } catch (e) {}
      set("Real deletion needs admin rights that the browser must never hold. Your request has been RECORDED and is awaiting processing — your data is NOT deleted yet. Reason: " + (res.reason || "unknown"));
      return;
    }
    set("Account deleted ✓ Signing out…");
    toast("Your account and data were deleted");
    setTimeout(async () => {
      try { await window.RBAuth.signOut(); } catch (e) {}
      closeDeleteModal();
      showGate();
      defaultGateHint();
    }, 1400);
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

  // ---------------------------------------------------------------- group invites
  function openInviteModal(groupId) {
    const m = $("#inviteModal");
    if (!m) return;
    const g = S.data.groups.find(x => x.id === groupId);
    state.invite = { groupId, userId: null, code: "" };
    $("#inviteGroupId").value = groupId;
    $("#inviteGroupName").textContent = g ? g.name : "this group";
    $("#inviteUserInput").value = "";
    $("#inviteSelected").innerHTML = `<span class="small muted">No one picked yet — search above, or copy an invite link below.</span>`;
    $("#inviteSuggest").classList.remove("open");
    $("#inviteLinkBox").hidden = true;
    m.classList.add("open");
    renderInviteExisting();
  }
  function closeInviteModal() { const m = $("#inviteModal"); if (m) m.classList.remove("open"); }

  function handleInviteUserInput(q) {
    const box = $("#inviteSuggest");
    if (!box) return;
    const members = S.groupMembers(state.invite.groupId);
    const list = S.searchPeople(q).filter(p => members.indexOf(p.id) < 0);
    if (!String(q || "").trim() || !list.length) { box.classList.remove("open"); box.innerHTML = ""; return; }
    box.innerHTML = list.slice(0, 8).map(p =>
      `<div onclick="pickInviteUser('${p.id}')">${avatar(p, "sm")}<span>${esc(p.name)}</span><span class="sug-meta">${esc(p.email || "")}</span></div>`
    ).join("");
    box.classList.add("open");
  }
  function pickInviteUser(userId) {
    state.invite.userId = userId;
    const p = S.profile(userId);
    const sel = $("#inviteSelected");
    if (sel) sel.innerHTML = `<span class="chip">${avatar(p, "sm")}${esc(p.name)}</span> <button class="btn btn-sm btn-ghost" onclick="clearInvitePick()">✕</button>`;
    const box = $("#inviteSuggest"); if (box) box.classList.remove("open");
    const inp = $("#inviteUserInput"); if (inp) inp.value = p.name;
  }
  function clearInvitePick() {
    state.invite.userId = null;
    const sel = $("#inviteSelected");
    if (sel) sel.innerHTML = `<span class="small muted">No one picked yet.</span>`;
    const inp = $("#inviteUserInput"); if (inp) inp.value = "";
  }
  async function sendInvite() {
    if (state.busy) return;
    if (!state.invite.userId) { toast("Search for a person first, then press Send invite"); return; }
    state.busy = true;
    try {
      const inv = await S.invitePersonToGroup(state.invite.groupId, state.invite.userId);
      const p = S.profile(state.invite.userId);
      toast(`Invite sent to ${p.name} ✓ — they will see it in their notifications`);
      clearInvitePick();
      renderInviteExisting();
      await S.refresh().catch(() => {});
      renderAll();
    } catch (e) {
      toast(e.message || "Could not send the invite");
    } finally { state.busy = false; }
  }
  async function makeInviteLink() {
    if (state.busy) return;
    state.busy = true;
    try {
      const inv = await S.createGroupInviteLink(state.invite.groupId);
      const url = window.RBNotifyText
        ? window.RBNotifyText.joinUrl((window.RB_CONFIG && window.RB_CONFIG.SITE_URL) || (location.origin + location.pathname), inv.code)
        : (location.origin + location.pathname + "#join=" + inv.code);
      state.invite.code = inv.code;
      const box = $("#inviteLinkBox"), val = $("#inviteLinkValue");
      if (val) val.textContent = url;
      if (box) box.hidden = false;
      copyText(url, "Invite link");
      renderInviteExisting();
    } catch (e) {
      toast(e.message || "Could not create the invite link");
    } finally { state.busy = false; }
  }
  function copyInviteLink() {
    const val = $("#inviteLinkValue");
    if (val) copyText(val.textContent, "Invite link");
  }
  function renderInviteExisting() {
    const c = $("#inviteExisting");
    if (!c) return;
    const list = S.invitesForGroup ? S.invitesForGroup(state.invite.groupId) : [];
    if (!list.length) { c.innerHTML = `<span class="muted">No invites sent yet.</span>`; return; }
    c.innerHTML = `<div class="small"><b>Invites:</b></div>` + list.map(i => {
      const who = i.invitedUserId ? profileOf(i.invitedUserId).name : "anyone with the link";
      return `<div class="small" style="padding:4px 0;border-bottom:1px solid #f3f4f6">
        ${esc(who)} — <span class="badge ${i.status === "pending" ? "badge-amber" : i.status === "accepted" ? "badge-green" : "badge-gray"}">${esc(i.status)}</span>
        <code>${esc(i.code)}</code>
      </div>`;
    }).join("");
  }

  // ---------------------------------------------------------------- join by link
  function closeJoinModal() { const m = $("#joinModal"); if (m) m.classList.remove("open"); }
  async function showJoinInvite(code) {
    const m = $("#joinModal"), b = $("#joinBody");
    if (!m || !b) return;
    const clean = String(code || "").trim().toUpperCase();
    b.innerHTML = `<div class="small muted">Loading the invite…</div>`;
    m.classList.add("open");
    let info = null;
    try {
      if (S.previewInvite) info = await S.previewInvite(clean);
    } catch (e) { /* fall through */ }
    if (!info) {
      b.innerHTML = `<div class="empty">
        <div class="big">Invite not found</div>
        <div class="small">The code <code>${esc(clean)}</code> is not valid, or it has already been used.
        Ask the person who invited you for a fresh link.</div>
        <div class="mt8"><button class="btn" onclick="closeJoinModal()">Close</button></div>
      </div>`;
      return;
    }
    b.innerHTML = `
      <div class="join-card">
        <div style="font-size:40px;text-align:center" aria-hidden="true">👥</div>
        <div class="section-title" style="text-align:center;margin-top:6px">You're invited to ${esc(info.groupName || "a group")}</div>
        <div class="small muted" style="text-align:center">${esc(info.fromName || "A colleague")} invited you · ${info.memberCount || 0} member(s)</div>
        ${String(info.status) !== "pending" ? `<div class="badge badge-gray mt8" style="display:block;text-align:center">This invite was already ${esc(info.status)}</div>` : ""}
        <div class="small muted mt12">Joining lets you read every register shared with this group (view-only — only the creator can edit).</div>
      </div>
      <div class="row mt12">
        <button class="btn btn-primary btn-block" onclick="joinGroup('${esc(info.code)}')">Join group</button>
        <button class="btn btn-block" onclick="declineGroupInvite('${esc(info.code)}')">Decline</button>
      </div>`;
  }

  // ---------------------------------------------------------------- real calls (WebRTC)
  let callTimer = null, callSec = 0;

  function openCallScreen(o) {
    const overlay = $("#callOverlay");
    if (!overlay) return;
    state.call = { name: o.name || "—", kind: o.kind || "audio", direction: o.direction || "out", peerId: o.peerId || null };
    const av = $("#callAvatar"); if (av) av.innerHTML = o.avatarHtml || "";
    const nm = $("#callName"); if (nm) nm.textContent = o.name || "—";
    const st = $("#callStatus"); if (st) st.textContent = o.direction === "in" ? "Incoming call…" : "Calling…";
    showCallError("");
    overlay.style.display = "flex";
    updateCallScreen(o.direction === "in" ? "incoming" : "outgoing");
  }

  function updateCallScreen(phase) {
    const overlay = $("#callOverlay");
    if (!overlay || overlay.style.display === "none") return;
    const st = $("#callStatus"), acts = $("#callActions");
    const kind = (state.call && state.call.kind) || "audio";
    const vid = $("#remoteVideo"), self = $("#localVideo");
    const card = overlay.querySelector(".call-card");
    if (card) card.classList.toggle("has-video", kind === "video");
    if (self) self.style.display = (kind === "video" && (phase === "connecting" || phase === "connected")) ? "block" : "none";
    if (vid) vid.style.display = kind === "video" ? "block" : "none";
    clearInterval(callTimer);

    if (phase === "outgoing") {
      if (st) st.textContent = "Ringing… waiting for them to answer";
      if (acts) acts.innerHTML = `<button class="btn-call btn-end" onclick="endCall()" aria-label="Cancel the call">📞</button>`;
    } else if (phase === "incoming") {
      if (st) st.textContent = "Incoming " + kind + " call";
      if (acts) acts.innerHTML = `
        <button class="btn-call btn-accept" onclick="answerCurrentCall()" aria-label="Answer the call">📞</button>
        <button class="btn-call btn-end" onclick="endCall()" aria-label="Decline the call">✕</button>`;
    } else if (phase === "connecting") {
      if (st) st.textContent = "Connecting…";
      if (acts) acts.innerHTML = callControlButtons();
    } else if (phase === "connected") {
      callSec = 0;
      if (st) st.textContent = "Connected — 00:00";
      callTimer = setInterval(() => {
        callSec++;
        const m = String(Math.floor(callSec / 60)).padStart(2, "0");
        const sec = String(callSec % 60).padStart(2, "0");
        if (st) st.textContent = "Connected — " + m + ":" + sec;
      }, 1000);
      if (acts) acts.innerHTML = callControlButtons();
    } else if (phase === "ended") {
      if (st) st.textContent = "Call ended";
      if (acts) acts.innerHTML = `<button class="btn-call btn-end" onclick="hideCallScreen()" aria-label="Close the call screen">✕</button>`;
    }
  }

  function callControlButtons() {
    const R = window.RBRtc || {};
    const kind = (state.call && state.call.kind) || "audio";
    return `<button class="btn-call btn-mic ${R.muted ? "off" : ""}" onclick="toggleCallMute()" aria-label="${R.muted ? "Unmute microphone" : "Mute microphone"}">${R.muted ? "🔇" : "🎙️"}</button>
      ${kind === "video" ? `<button class="btn-call btn-mic ${R.cameraOff ? "off" : ""}" onclick="toggleCallCamera()" aria-label="${R.cameraOff ? "Turn camera on" : "Turn camera off"}">${R.cameraOff ? "🚫" : "🎥"}</button>` : ""}
      <button class="btn-call btn-end" onclick="endCall()" aria-label="End the call">📞</button>`;
  }

  function showCallError(msg) {
    const el = $("#callError");
    if (el) el.innerHTML = msg ? esc(msg) : "";
  }
  function hideCallScreen() {
    clearInterval(callTimer);
    const o = $("#callOverlay");
    if (o) o.style.display = "none";
    const v = $("#remoteVideo"), l = $("#localVideo");
    if (v) { try { v.pause(); } catch (e) {} v.srcObject = null; }
    if (l) { try { l.pause(); } catch (e) {} l.srcObject = null; }
    showCallError("");
    state.call = null;
  }

  async function startCall(userId, kind) {
    const p = profileOf(userId);
    openCallScreen({ name: p.name, avatarHtml: avatar(p), kind: kind || "audio", direction: "out", peerId: userId });
    try {
      await window.RBRtc.call(userId, kind || "audio");
    } catch (e) {
      showCallError(e.message || "Could not start the call");
      updateCallScreen("ended");
    }
  }
  function answerCurrentCall() {
    const id = window.RBRtc.callId;
    if (!id) { showCallError("That call is no longer available."); return; }
    window.RBRtc.answer(id).catch(e => showCallError(e.message || "Could not answer the call"));
  }
  async function endCall() {
    clearInterval(callTimer);
    const R = window.RBRtc;
    if (!R) { hideCallScreen(); return; }
    if (R.phase === "incoming") { try { await R.decline(); } catch (e) {} }
    else { try { await R.hangup(); } catch (e) {} }
    hideCallScreen();
  }
  function toggleCallMute() {
    const m = window.RBRtc.toggleMute();
    toast(m ? "Microphone muted" : "Microphone on");
    updateCallScreen(window.RBRtc.phase);
  }
  function toggleCallCamera() {
    const off = window.RBRtc.toggleCamera();
    toast(off ? "Camera off" : "Camera on");
    updateCallScreen(window.RBRtc.phase);
  }
  function simulateIncomingCall(kind) {
    const R = window.RBRtc;
    if (!R) return;
    R.simulateIncoming(kind);
    const other = S.otherProfiles()[0] || profileOf("goldfish");
    openCallScreen({ name: other.name, avatarHtml: avatar(other), kind, direction: "in" });
  }
  // called when a ringing call row arrives while the app is open
  function incomingCallFromRow(call) {
    if (!call || !window.RBRtc) return;
    if (!window.RBRtc.incomingCall(call)) return;
    const p = profileOf(call.callerId);
    openCallScreen({ name: p.name, avatarHtml: avatar(p), kind: call.kind || "audio", direction: "in" });
    if (window.RBPush) window.RBPush.ting();
  }

  // ---------------------------------------------------------------- writing date (optional)
  function toggleLineDate() {
    const w = $("#lineDateWrap"), t = $("#lineDateToggle");
    if (!w) return;
    const open = w.hasAttribute("hidden");
    if (open) w.removeAttribute("hidden"); else w.setAttribute("hidden", "");
    if (t) {
      t.setAttribute("aria-expanded", open ? "true" : "false");
      t.textContent = open ? "Hide the date box" : "Use a different date?";
    }
    if (open) { const d = $("#newLineDate"); if (d) d.focus(); }
  }
  function useTodayForLine() {
    const d = $("#newLineDate");
    if (d) d.value = todayIso();
    const w = $("#lineDateWrap"); if (w) w.setAttribute("hidden", "");
    const t = $("#lineDateToggle");
    if (t) { t.setAttribute("aria-expanded", "false"); t.textContent = "Use a different date?"; }
    toast("Back to today's date ✓");
  }

  // ---------------------------------------------------------------- copy + diagnostics
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
  // Headless on purpose: the owner-facing "set-up guide" is gone, but support
  // can still call runDiagnostics() from the browser console. If a #diagBox
  // exists it renders there; otherwise the report goes to the console.
  async function runDiagnostics() {
    const box = $("#diagBox");
    if (box) box.innerHTML = '<div class="small muted">Checking…</div>';
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
    const report = lines.join("\n");
    if (box) {
      box.innerHTML = head + `<pre class="diag">${esc(report)}</pre>` +
        `<button class="btn btn-sm mt8" onclick="copyText(document.querySelector('.diag').textContent, 'Check report')">Copy report</button>`;
    } else {
      console.log(report);
    }
    return report;
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
    stopRealtime();
    if (window.RBRtc) window.RBRtc.reset();
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
      setTimeout(() => setView("library"), 120);
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- realtime (app is open)
  let rtChannels = [];
  function stopRealtime() {
    const c = window.RBAuth && window.RBAuth.getClient ? window.RBAuth.getClient() : null;
    if (!c) return;
    rtChannels.forEach(ch => { try { c.removeChannel(ch); } catch (e) {} });
    rtChannels = [];
  }
  function startRealtime() {
    const c = window.RBAuth && window.RBAuth.getClient ? window.RBAuth.getClient() : null;
    if (!c || !c.channel || S.isDemo() || !S.me) return;
    stopRealtime();
    const meId = S.me.id;
    const add = (name, table, filter, handler) => {
      try {
        const opts = { event: "INSERT", schema: "public", table: table };
        if (filter) opts.filter = filter;
        rtChannels.push(c.channel(name).on("postgres_changes", opts, handler).subscribe());
      } catch (e) { console.warn("[realtime] " + name, e); }
    };

    // 1. the inbox row itself (written by the rb-notify Edge Function)
    add("rb-rt-notes", "rb_notifications", "user_id=eq." + meId, p => {
      const row = p.new || {};
      S.data.notifications.unshift({
        id: row.id, userId: row.user_id, type: row.type, title: row.title,
        body: row.body || "", data: row.data || {}, read: false, createdAt: row.created_at
      });
      if (window.RBPush) window.RBPush.showInApp(S.data.notifications[0]);
      renderAll();
    });

    // 2. instant banner even if the push round-trip is slow
    add("rb-rt-dm", "rb_direct_messages", "receiver_id=eq." + meId, p => {
      const row = p.new || {};
      S.refresh().then(() => renderAll()).catch(() => {});
      if (window.RBPush) window.RBPush.showInApp({
        id: "live_" + row.id, type: "message",
        title: profileOf(row.sender_id).name + ": you have a new message",
        body: row.text || "", data: { senderId: row.sender_id }
      });
    });
    add("rb-rt-fr", "rb_friend_requests", "to_user=eq." + meId, p => {
      const row = p.new || {};
      S.refresh().then(() => renderAll()).catch(() => {});
      if (window.RBPush) window.RBPush.showInApp({
        id: "live_" + row.id, type: "friend",
        title: profileOf(row.from_user).name + " sent you a friend request",
        body: "Tap Accept to connect.", data: { requestId: row.id, senderId: row.from_user }
      });
    });
    add("rb-rt-inv", "rb_group_invites", null, p => {
      S.refresh().then(() => renderAll()).catch(() => {});
      if (window.RBPush) window.RBPush.showInApp({
        id: "live_" + (p.new ? p.new.id : Date.now()), type: "invite",
        title: "You're invited to a group",
        body: "Open the app to join or decline.", data: { code: p.new ? p.new.code : "" }
      });
    });
    // 3. incoming calls — ring while the app is open
    add("rb-rt-calls", "rb_calls", "callee_id=eq." + meId, p => {
      const row = p.new || {};
      if (String(row.status) !== "ringing") return;
      S.refresh().then(() => renderAll()).catch(() => {});
      incomingCallFromRow({
        id: row.id, callerId: row.caller_id, calleeId: row.callee_id,
        kind: row.kind, status: row.status, createdAt: row.created_at
      });
    });
  }
  function checkRingingCalls() {
    if (S.isDemo() || !window.RBRtc || !S.me) return;
    const now = Date.now();
    const call = S.data.calls.find(c =>
      c.calleeId === S.me.id && String(c.status) === "ringing" &&
      (now - new Date(c.createdAt).getTime()) < 90000);
    if (call) incomingCallFromRow(call);
  }

  // ---------------------------------------------------------------- deep links
  // The service worker opens the app at  #join=CODE  /  #call=ID  /  #chat=ID
  // and adds &rbaction=accept|decline|join|answer when a button was pressed.
  function handleDeepLinks() {
    const h = String(location.hash || "").replace(/^#/, "");
    if (!h) return;
    let params = null;
    try { params = new URLSearchParams(h); } catch (e) { return; }

    if (params.has("join")) {
      const code = String(params.get("join") || "").toUpperCase();
      setTimeout(() => showJoinInvite(code).catch(() => {}), 350);
    } else if (params.has("chat")) {
      const uid = params.get("chat") || "";
      setTimeout(() => { setView("community"); if (uid) openChat(uid); }, 300);
    } else if (params.has("call")) {
      setTimeout(() => setView("community"), 200);
    } else if (params.has("requests")) {
      setTimeout(() => setView("community"), 200);
    } else if (params.has("inbox")) {
      setTimeout(() => openInbox(), 200);
    } else if (params.has("new")) {
      setTimeout(() => openCreateModal(), 300);
    }

    const action = params.get("rbaction") || "";
    if (action && action !== "open" && action !== "reply_later") {
      const data = {
        type: params.get("rbtype") || "",
        requestId: params.get("rbreq") || "",
        code: params.get("join") || "",
        callId: params.get("call") || ""
      };
      setTimeout(() => runNotificationAction(action, data), 900);
    }
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }
  async function runNotificationAction(action, data) {
    data = data || {};
    if (!S.me) return;
    try {
      if (action === "accept") await actFriend(data.requestId, "accepted");
      else if (action === "join") await joinGroup(data.code);
      else if (action === "answer") await answerCall(data.callId);
      else if (action === "decline") {
        if (data.type === "invite") await declineGroupInvite(data.code);
        else if (data.type === "call") await declineCall(data.callId);
        else await actFriend(data.requestId, "declined");
      } else setView("community");
    } catch (e) { /* never crash on a notification action */ }
    renderAll();
  }
  function setupSwMessages() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", ev => {
      const d = ev && ev.data;
      if (d && d.type === "rb-notification-action") runNotificationAction(d.action, d.data);
    });
  }
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("sw.js", { scope: "./" })
      .then(() => setupSwMessages())
      .catch(() => {});
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
    S.refresh().then(() => { renderAll(); checkRingingCalls(); }).catch(() => {});
  }
  function startAutoRefresh() {
    clearInterval(state.timer);
    if (S.isDemo()) return;
    state.timer = setInterval(autoRefreshTick, 20000);
  }

  async function boot() {
    fillGateChips();
    registerServiceWorker();
    const today = $("#todayPreview");
    if (today) today.textContent = fmtFull(new Date());

    if (window.RBRtc) {
      window.RBRtc.init({
        phase: ph => updateCallScreen(ph),
        localstream: st => { const el = $("#localVideo"); if (el) el.srcObject = st || null; },
        remotestream: st => { const el = $("#remoteVideo"); if (el) el.srcObject = st || null; },
        error: msg => showCallError(msg),
        localstatus: t => { const el = $("#callStatus"); if (el && window.RBRtc.phase === "outgoing") el.textContent = t; },
        demo: () => {}
      });
    }

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
      handleDeepLinks();
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
    startRealtime();
    checkRingingCalls();
    handleDeepLinks();
    return true;
  }

  // ---------------------------------------------------------------- expose
  Object.assign(window, {
    setView, openCreateModal, closeCreateModal, createRegister,
    openRegister, changePage, gotoPageInput, addLine, toggleDone, editEntry, deleteEntry, deleteRegister,
    handleInsideSearch, jumpToSuggestion, backToLibrary,
    openShareModal, closeShareModal, handleShareUserInput, pickShareUser, clearSharePick, doShare, removeShareConfirm,
    openShareModalForUser, openShareToGroupModal,
    handlePeopleSearch, selectPerson, askFriend: askFriend, sendFriendRequest: askFriend, respondFriend,
    openGroupModal, closeGroupModal, createGroup, openGroup, closeGroup, sendGroupMsg,
    openAddMemberModal, closeAddMemberModal, handleAddMemberSearch, toggleAddMember,
    openChat, sendChat, stateChatBack,
    startCall, endCall, hideCallScreen, answerCurrentCall, toggleCallMute, toggleCallCamera, simulateIncomingCall,
    openInbox, renderInbox, markAllNotificationsRead, openNotification, actFriend,
    openInviteModal, closeInviteModal, handleInviteUserInput, pickInviteUser, clearInvitePick,
    sendInvite, makeInviteLink, copyInviteLink, showJoinInvite, closeJoinModal, joinGroup, declineGroupInvite,
    answerCall, declineCall,
    openDeleteModal, closeDeleteModal, downloadMyBooks, confirmDeleteAccount,
    switchNotifications, sendTestNotification, renderNotificationSettings,
    toggleLineDate, useTodayForLine,
    handleGoogleLogin, handleSignOut, enterDemo, demoStory,
    handleFriend: respondFriend,
    toast, toggleSidebar, manualRefresh,
    // shared helpers, used by qbooks-ui.js
    esc, fmtDay, profileOf, renderAll, renderTopbar, renderQuestionBooks,
    copyText, runDiagnostics
  });

  // used by push.js to make the in-app banner open the right notification
  window.RBApp = { openNotification, openInbox };

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
      ["createModal", "shareModal", "groupModal", "addMemberModal", "inviteModal", "joinModal", "deleteModal"].forEach(id => {
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
