// store.js — RegisterBook data layer
// Two drivers behind one API:
//   demo  → localStorage (works offline, all demo people share one community)
//   cloud → Supabase tables rb_* (real Google accounts, RLS enforces view-only)
(function () {
  "use strict";

  const LS_KEY = "rb_demo_v4";
  const LS_USER = "rb_demo_user";

  const DEMO_USERS = [
    { id: "mahi",      name: "Mahi",       email: "mahi@registerbook.demo",       color: "#0f766e" },
    { id: "goldfish",  name: "Goldfish",   email: "goldfish@registerbook.demo",   color: "#f59e0b" },
    { id: "silverfish",name: "Silverfish", email: "silverfish@registerbook.demo", color: "#64748b" },
    { id: "priya",     name: "Priya",      email: "priya@registerbook.demo",      color: "#ec4899" },
    { id: "rahul",     name: "Rahul",      email: "rahul@registerbook.demo",      color: "#3b82f6" },
    { id: "anjali",    name: "Anjali",     email: "anjali@registerbook.demo",     color: "#8b5cf6" }
  ];

  const PALETTE = ["#0f766e", "#f59e0b", "#64748b", "#ec4899", "#3b82f6", "#8b5cf6", "#dc2626", "#0891b2", "#65a30d"];

  // ---- shared utilities (also used by app.js) ----
  function levenshtein(a, b) {
    a = String(a || "").toLowerCase(); b = String(b || "").toLowerCase();
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    if (Math.abs(m - n) > 4) return 99;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const row = [i];
      for (let j = 1; j <= n; j++) {
        row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
      }
      prev = row;
    }
    return prev[n];
  }
  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function colorFor(id) {
    let h = 0;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function isoLocal(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function uid(prefix) {
    return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  window.RBUtil = { levenshtein, initials, colorFor, isoLocal, uid };

  // ---- state ----
  const DB = {
    profiles: [], registers: [], entries: [], shares: [], groups: [], groupMembers: [],
    groupMessages: [], friendRequests: [], directMessages: []
  };
  let mode = "demo";
  let me = null;
  let supa = null;
  let setupError = "";
  let lastLoadedAt = null;

  function blankDB() {
    Object.keys(DB).forEach(k => { DB[k] = []; });
  }
  function hydrate(blob) {
    Object.keys(DB).forEach(k => { DB[k] = Array.isArray(blob[k]) ? blob[k] : []; });
  }

  // ---- localStorage helpers ----
  function readDemo() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function persist() {
    if (mode !== "demo") return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ v: 4, savedAt: new Date().toISOString(), ...DB }));
    } catch (e) { /* storage may be blocked; keep in memory */ }
  }
  function demoUserId() {
    try { return localStorage.getItem(LS_USER); } catch (e) { return null; }
  }

  // ---- demo seed ----
  function seed() {
    blankDB();
    DB.profiles = DEMO_USERS.map(u => ({ id: u.id, name: u.name, email: u.email, color: u.color, avatar: "" }));

    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const dim = new Date(y, m + 1, 0).getDate();
    const clampDay = d => Math.min(d, dim);
    const mkDate = d => new Date(y, m, clampDay(d));
    const iso = d => isoLocal(d);

    function addEntry(registerId, day, text, extra) {
      const d = mkDate(day);
      const seq = DB.entries.filter(e => e.registerId === registerId).length + 1;
      DB.entries.push(Object.assign({
        id: "ent_" + registerId + "_" + seq,
        registerId, date: iso(d), text, note: "", qty: null, amount: null, done: false, seq
      }, extra || {}));
    }

    // Goldfish's medicine checklist — 25 lines across 3 pages (5 lines per day for 5 days)
    DB.registers.push({ id: "reg_med", ownerId: "goldfish", name: "Medicine Checklist — Ward A", type: "Medical Checklist", createdAt: new Date(y, m, 1, 9, 0).toISOString() });
    const meds = ["Paracetamol 500mg", "Amoxicillin 250mg", "Insulin vials", "IV saline 500ml", "Bandages (roll)"];
    let n = 0;
    for (let d = 1; d <= 5; d++) {
      for (let k = 0; k < 5; k++) {
        n++;
        addEntry("reg_med", d, `${meds[k]} — ${10 + n} strips checked`, { note: n % 4 === 0 ? "Verified by nurse" : "", done: n <= 8 });
      }
    }

    // Goldfish's bill book — qty + ₹ amount
    DB.registers.push({ id: "reg_bills", ownerId: "goldfish", name: "Daily Bills — Medicine", type: "Bill Book", createdAt: new Date(y, m, 2, 10, 0).toISOString() });
    for (let i = 0; i < 12; i++) {
      addEntry("reg_bills", 10 + i, `Medicine supplier payment #${i + 1}`, { qty: 5 + i, amount: 150 * (i + 1) });
    }

    // Mahi's attendance register
    DB.registers.push({ id: "reg_att", ownerId: "mahi", name: "Staff Attendance — This Month", type: "Attendance Register", createdAt: new Date(y, m, 1, 8, 0).toISOString() });
    const staff = ["Mahi", "Goldfish", "Priya", "Rahul"];
    for (let i = 0; i < 8; i++) {
      addEntry("reg_att", 1 + i, `${staff[i % staff.length]} — Present`, { note: i % 4 === 0 ? "Shift A" : "" });
    }

    // Goldfish shares his medicine checklist with Silverfish (the story) and Priya; bill book with Mahi
    DB.shares.push(
      { id: "shr_1", registerId: "reg_med", sharedWithUserId: "silverfish", sharedWithEmail: "silverfish@registerbook.demo", sharedBy: "goldfish", permission: "view", groupId: null, createdAt: new Date(y, m, 5, 12, 0).toISOString() },
      { id: "shr_2", registerId: "reg_med", sharedWithUserId: "priya", sharedWithEmail: "priya@registerbook.demo", sharedBy: "goldfish", permission: "view", groupId: null, createdAt: new Date(y, m, 5, 12, 1).toISOString() },
      { id: "shr_3", registerId: "reg_bills", sharedWithUserId: "mahi", sharedWithEmail: "mahi@registerbook.demo", sharedBy: "goldfish", permission: "view", groupId: null, createdAt: new Date(y, m, 6, 9, 0).toISOString() }
    );

    // Groups
    DB.groups.push({ id: "grp_ward", name: "Ward Staff", createdBy: "goldfish", createdAt: new Date(y, m, 1, 9, 30).toISOString() });
    DB.groupMembers.push(
      { groupId: "grp_ward", userId: "goldfish" },
      { groupId: "grp_ward", userId: "silverfish" },
      { groupId: "grp_ward", userId: "priya" }
    );
    DB.groupMessages.push(
      { id: "gm_1", groupId: "grp_ward", senderId: "goldfish", text: "Welcome to Ward Staff! I shared the medicine checklist — open it from Shared With Me.", createdAt: new Date(y, m, 5, 12, 5).toISOString() },
      { id: "gm_2", groupId: "grp_ward", senderId: "silverfish", text: "Thanks! I can read every page. I see it is view-only for me — correct.", createdAt: new Date(y, m, 5, 12, 30).toISOString() }
    );

    // Friends
    DB.friendRequests.push(
      { id: "fr_1", fromUser: "goldfish", toUser: "silverfish", status: "accepted", createdAt: new Date(y, m, 2, 11, 0).toISOString() },
      { id: "fr_2", fromUser: "mahi", toUser: "rahul", status: "pending", createdAt: new Date(y, m, 6, 14, 0).toISOString() },
      { id: "fr_3", fromUser: "priya", toUser: "mahi", status: "accepted", createdAt: new Date(y, m, 3, 10, 0).toISOString() }
    );

    // Private chat
    DB.directMessages.push(
      { id: "dm_1", senderId: "goldfish", receiverId: "silverfish", text: "Hey Silverfish, check the medicine checklist I shared with you.", createdAt: new Date(y, m, 5, 12, 2).toISOString() },
      { id: "dm_2", senderId: "silverfish", receiverId: "goldfish", text: "Opened it — search works and I cannot edit. Perfect.", createdAt: new Date(y, m, 5, 12, 20).toISOString() }
    );
  }

  function initDemo(userId) {
    mode = "demo";
    setupError = "";
    blankDB();
    const blob = readDemo();
    if (blob && blob.v === 4 && Array.isArray(blob.profiles) && blob.profiles.length) {
      hydrate(blob);
    } else {
      seed();
      persist();
    }
    const wanted = userId || demoUserId() || "mahi";
    const p = DB.profiles.find(x => x.id === wanted) || DB.profiles[0];
    me = Object.assign({}, p, { isReal: false });
    try { localStorage.setItem(LS_USER, me.id); } catch (e) {}
    return me;
  }

  function resetDemo() {
    blankDB();
    seed();
    persist();
    const p = DB.profiles[0];
    me = Object.assign({}, p, { isReal: false });
    try { localStorage.setItem(LS_USER, me.id); } catch (e) {}
    return me;
  }

  // ---- cloud ----
  function friendlyDbError(err) {
    const msg = (err && (err.message || err.error_description || err.toString())) || "Unknown error";
    if (/could not find the table|relation .* does not exist|schema cache/i.test(msg)) {
      return "The database tables are not created yet. In Supabase open SQL Editor, paste and run supabase/migrations.sql, then refresh this page.";
    }
    if (/row-level security|permission denied|new row violates/i.test(msg)) {
      return "The database blocked that action (Row Level Security). Only the creator can edit a register. If you are the creator, check the RLS policies in supabase/migrations.sql.";
    }
    if (/jwt|api key|invalid api key|no api key/i.test(msg)) {
      return "The Supabase URL or publishable key in config.js looks wrong. Copy them again from Project Settings → API.";
    }
    return msg;
  }

  async function sel(query, label) {
    const { data, error } = await query;
    if (error) throw new Error((label ? label + ": " : "") + error.message);
    return data || [];
  }

  async function refreshCloud() {
    if (!supa) throw new Error("Supabase client is not ready");
    const uid_ = me.id;

    const [profiles, regs] = await Promise.all([
      sel(supa.from("rb_profiles").select("*"), "profiles"),
      sel(supa.from("rb_registers").select("*").order("created_at", { ascending: false }), "registers")
    ]);

    const regIds = regs.map(r => r.id);
    const [entries, shares, groups, members, friendRequests, dms] = await Promise.all([
      regIds.length ? sel(supa.from("rb_entries").select("*").in("register_id", regIds).order("seq", { ascending: true }), "entries") : [],
      regIds.length ? sel(supa.from("rb_shares").select("*").in("register_id", regIds), "shares") : [],
      sel(supa.from("rb_groups").select("*"), "groups"),
      sel(supa.from("rb_group_members").select("*"), "group members"),
      sel(supa.from("rb_friend_requests").select("*").or(`from_user.eq.${uid_},to_user.eq.${uid_}`), "friend requests"),
      sel(supa.from("rb_direct_messages").select("*").or(`sender_id.eq.${uid_},receiver_id.eq.${uid_}`).order("created_at", { ascending: true }), "messages")
    ]);

    const groupIds = groups.map(g => g.id);
    const groupMessages = groupIds.length
      ? await sel(supa.from("rb_group_messages").select("*").in("group_id", groupIds).order("created_at", { ascending: true }), "group messages")
      : [];

    DB.profiles = profiles.map(p => ({ id: p.id, name: p.name || (p.email || "Staff").split("@")[0], email: p.email || "", avatar: p.avatar_url || "", color: colorFor(p.id) }));
    DB.registers = regs.map(r => ({ id: r.id, ownerId: r.owner_id, name: r.name, type: r.type, createdAt: r.created_at }));
    DB.entries = entries.map(e => ({ id: e.id, registerId: e.register_id, date: e.entry_date, text: e.text || "", note: e.note || "", qty: e.qty, amount: e.amount, done: !!e.done, seq: e.seq }));
    DB.shares = shares.map(s => ({ id: s.id, registerId: s.register_id, sharedWithUserId: s.shared_with_user_id, sharedWithEmail: s.shared_with_email, groupId: s.group_id || null, sharedBy: s.shared_by, permission: s.permission || "view" }));
    DB.groups = groups.map(g => ({ id: g.id, name: g.name, createdBy: g.created_by, createdAt: g.created_at }));
    DB.groupMembers = members.map(x => ({ groupId: x.group_id, userId: x.user_id }));
    DB.groupMessages = groupMessages.map(x => ({ id: x.id, groupId: x.group_id, senderId: x.sender_id, text: x.text, createdAt: x.created_at }));
    DB.friendRequests = friendRequests.map(x => ({ id: x.id, fromUser: x.from_user, toUser: x.to_user, status: x.status, createdAt: x.created_at }));
    DB.directMessages = dms.map(x => ({ id: x.id, senderId: x.sender_id, receiverId: x.receiver_id, text: x.text, createdAt: x.created_at }));
    lastLoadedAt = new Date().toISOString();
  }

  async function initCloud() {
    mode = "cloud";
    setupError = "";
    supa = window.RBAuth ? window.RBAuth.getClient() : null;
    if (!supa) { setupError = "Supabase is not configured yet (config.js still has placeholders)."; return false; }
    const session = await window.RBAuth.getSession();
    if (!session || !session.user) return false;
    const u = session.user, meta = u.user_metadata || {};
    me = {
      id: u.id,
      name: meta.full_name || meta.name || (u.email || "Staff").split("@")[0],
      email: u.email || "",
      avatar: meta.avatar_url || meta.picture || "",
      isReal: true
    };
    try {
      const { error } = await supa.from("rb_profiles").upsert(
        { id: me.id, name: me.name, email: me.email, avatar_url: me.avatar },
        { onConflict: "id" }
      );
      if (error) throw error;
      await refreshCloud();
      return true;
    } catch (e) {
      setupError = friendlyDbError(e);
      return false;
    }
  }

  async function ins(table, rows) {
    const { error } = await supa.from(table).insert(rows);
    if (error) throw new Error(friendlyDbError(error));
  }
  async function del(table, column, value) {
    const { error } = await supa.from(table).delete().eq(column, value);
    if (error) throw new Error(friendlyDbError(error));
  }
  async function upd(table, id, patch) {
    const { error } = await supa.from(table).update(patch).eq("id", id);
    if (error) throw new Error(friendlyDbError(error));
  }

  async function refresh() {
    if (mode === "cloud" && supa) await refreshCloud();
  }

  // ---- reads ----
  function profile(id) {
    return DB.profiles.find(p => p.id === id) || { id, name: "Staff member", email: "", avatar: "", color: colorFor(id) };
  }
  function imageUrl(p) {
    return p && p.avatar && /^https?:\/\//i.test(p.avatar) ? p.avatar : "";
  }
  function registersVisible() {
    return DB.registers.filter(r => r.ownerId === me.id || DB.shares.some(s => s.registerId === r.id && s.sharedWithUserId === me.id));
  }
  function myRegisters() { return DB.registers.filter(r => r.ownerId === me.id); }
  function sharedWithMe() { return registersVisible().filter(r => r.ownerId !== me.id); }
  function entriesOf(regId) {
    return DB.entries.filter(e => e.registerId === regId).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  }
  function myGroups() {
    return DB.groups.filter(g => g.createdBy === me.id || DB.groupMembers.some(m => m.groupId === g.id && m.userId === me.id));
  }
  function groupMembers(groupId) {
    return DB.groupMembers.filter(m => m.groupId === groupId).map(m => m.userId);
  }
  function sharesOf(regId) { return DB.shares.filter(s => s.registerId === regId); }
  function canEdit(reg) { return !!reg && reg.ownerId === me.id; }
  function canView(reg) {
    return !!reg && (reg.ownerId === me.id || DB.shares.some(s => s.registerId === reg.id && s.sharedWithUserId === me.id));
  }
  function isFriend(userId) {
    return DB.friendRequests.some(f => f.status === "accepted" &&
      ((f.fromUser === me.id && f.toUser === userId) || (f.fromUser === userId && f.toUser === me.id)));
  }
  function pendingIncoming() { return DB.friendRequests.filter(f => f.toUser === me.id && f.status === "pending"); }
  function pendingOutgoing() { return DB.friendRequests.filter(f => f.fromUser === me.id && f.status === "pending"); }
  function friends() {
    const ids = new Set();
    DB.friendRequests.filter(f => f.status === "accepted").forEach(f => {
      if (f.fromUser === me.id) ids.add(f.toUser);
      if (f.toUser === me.id) ids.add(f.fromUser);
    });
    return [...ids].map(profile);
  }
  function otherProfiles() {
    return DB.profiles.filter(p => p.id !== me.id);
  }
  function messagesBetween(userId) {
    return DB.directMessages
      .filter(m => (m.senderId === me.id && m.receiverId === userId) || (m.senderId === userId && m.receiverId === me.id))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }
  function groupMessages(groupId) {
    return DB.groupMessages.filter(m => m.groupId === groupId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  function searchPeople(query) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    return otherProfiles()
      .map(p => {
        const name = (p.name || "").toLowerCase(), email = (p.email || "").toLowerCase();
        let score = 0;
        if (name === q) score = 100;
        else if (name.startsWith(q)) score = 90;
        else if (name.includes(q)) score = 80;
        else if (email.includes(q)) score = 60;
        else {
          const lev = levenshtein(q, name);
          if (lev <= 2) score = 50 - lev * 10;
          else {
            const first = name.split(/\s+/)[0] || "";
            if (levenshtein(q, first) <= 1) score = 40;
          }
        }
        return { p, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(x => x.p);
  }

  // ---- writes: registers & entries ----
  async function createRegister(name, type) {
    const reg = { id: uid("reg"), ownerId: me.id, name, type, createdAt: new Date().toISOString() };
    if (mode === "demo") {
      DB.registers.push(reg); persist(); return reg;
    }
    await ins("rb_registers", { id: reg.id, owner_id: me.id, name, type, created_at: reg.createdAt });
    await refreshCloud();
    return reg;
  }

  async function addEntry(registerId, { date, text, note, qty, amount }) {
    const existing = entriesOf(registerId);
    const seq = existing.reduce((mx, e) => Math.max(mx, e.seq || 0), 0) + 1;
    const entry = {
      id: uid("ent"), registerId, date: date || isoLocal(new Date()), text,
      note: note || "", qty: qty == null || qty === "" ? null : Number(qty),
      amount: amount == null || amount === "" ? null : Number(amount), done: false, seq
    };
    if (mode === "demo") {
      DB.entries.push(entry); persist(); return entry;
    }
    await ins("rb_entries", {
      id: entry.id, register_id: registerId, entry_date: entry.date, text: entry.text,
      note: entry.note, qty: entry.qty, amount: entry.amount, done: false, seq
    });
    await refreshCloud();
    return entry;
  }

  async function updateEntry(id, patch) {
    if (mode === "demo") {
      const e = DB.entries.find(x => x.id === id);
      if (e) Object.assign(e, patch);
      persist(); return;
    }
    const row = {};
    if ("text" in patch) row.text = patch.text;
    if ("note" in patch) row.note = patch.note;
    if ("qty" in patch) row.qty = patch.qty;
    if ("amount" in patch) row.amount = patch.amount;
    if ("done" in patch) row.done = patch.done;
    await upd("rb_entries", id, row);
    await refreshCloud();
  }

  async function deleteEntry(id) {
    if (mode === "demo") {
      DB.entries = DB.entries.filter(e => e.id !== id);
      persist(); return;
    }
    await del("rb_entries", "id", id);
    await refreshCloud();
  }

  async function deleteRegister(id) {
    if (mode === "demo") {
      DB.registers = DB.registers.filter(r => r.id !== id);
      DB.entries = DB.entries.filter(e => e.registerId !== id);
      DB.shares = DB.shares.filter(s => s.registerId !== id);
      persist(); return;
    }
    await del("rb_registers", "id", id);
    await refreshCloud();
  }

  // ---- writes: sharing ----
  async function shareWithUser(registerId, userId) {
    const p = profile(userId);
    if (DB.shares.some(s => s.registerId === registerId && s.sharedWithUserId === userId)) {
      return { already: true, name: p.name };
    }
    const row = {
      id: uid("shr"), registerId, sharedWithUserId: userId,
      sharedWithEmail: p.email || "", permission: "view", sharedBy: me.id,
      groupId: null, createdAt: new Date().toISOString()
    };
    if (mode === "demo") {
      DB.shares.push(row); persist(); return { already: false, name: p.name };
    }
    await ins("rb_shares", {
      id: row.id, register_id: registerId, shared_with_user_id: userId,
      shared_with_email: p.email || null, permission: "view", shared_by: me.id
    });
    await refreshCloud();
    return { already: false, name: p.name };
  }

  async function shareWithGroup(registerId, groupId) {
    const g = DB.groups.find(x => x.id === groupId);
    if (!g) throw new Error("Group not found");
    const members = groupMembers(groupId).filter(id => id !== me.id);
    let added = 0;
    const rows = [];
    for (const userId of members) {
      if (DB.shares.some(s => s.registerId === registerId && s.sharedWithUserId === userId)) continue;
      const p = profile(userId);
      rows.push({
        id: uid("shr"), registerId, sharedWithUserId: userId,
        sharedWithEmail: p.email || "", permission: "view", sharedBy: me.id,
        groupId, createdAt: new Date().toISOString()
      });
      added++;
    }
    if (!rows.length) return { already: true, name: g.name, added: 0 };
    if (mode === "demo") {
      rows.forEach(r => DB.shares.push(r)); persist();
      return { already: false, name: g.name, added };
    }
    await ins("rb_shares", rows.map(r => ({
      id: r.id, register_id: r.registerId, shared_with_user_id: r.sharedWithUserId,
      shared_with_email: r.sharedWithEmail || null, permission: "view", shared_by: me.id, group_id: groupId
    })));
    await refreshCloud();
    return { already: false, name: g.name, added };
  }

  async function removeShare(shareId) {
    if (mode === "demo") {
      DB.shares = DB.shares.filter(s => s.id !== shareId); persist(); return;
    }
    await del("rb_shares", "id", shareId);
    await refreshCloud();
  }

  // ---- writes: groups ----
  async function createGroup(name, memberIds) {
    const g = { id: uid("grp"), name, createdBy: me.id, createdAt: new Date().toISOString() };
    const members = [...new Set([me.id, ...(memberIds || [])])];
    if (mode === "demo") {
      DB.groups.push(g);
      members.forEach(userId => DB.groupMembers.push({ groupId: g.id, userId }));
      persist();
      return g;
    }
    await ins("rb_groups", { id: g.id, name, created_by: me.id });
    await ins("rb_group_members", members.map(userId => ({ group_id: g.id, user_id: userId })));
    await refreshCloud();
    return g;
  }

  async function addGroupMember(groupId, userId) {
    if (DB.groupMembers.some(m => m.groupId === groupId && m.userId === userId)) return { already: true };
    if (mode === "demo") {
      DB.groupMembers.push({ groupId, userId });
      // Give the new member access to registers already shared with the whole group
      DB.shares.filter(s => s.groupId === groupId).forEach(s => {
        if (!DB.shares.some(x => x.registerId === s.registerId && x.sharedWithUserId === userId)) {
          const p = profile(userId);
          DB.shares.push({ id: uid("shr"), registerId: s.registerId, sharedWithUserId: userId, sharedWithEmail: p.email || "", permission: "view", sharedBy: me.id, groupId, createdAt: new Date().toISOString() });
        }
      });
      persist();
      return { already: false };
    }
    await ins("rb_group_members", [{ group_id: groupId, user_id: userId }]);
    const groupShares = DB.shares.filter(s => s.groupId === groupId);
    const newRows = groupShares
      .filter(s => !DB.shares.some(x => x.registerId === s.registerId && x.sharedWithUserId === userId))
      .map(s => {
        const p = profile(userId);
        return { id: uid("shr"), register_id: s.registerId, shared_with_user_id: userId, shared_with_email: p.email || null, permission: "view", shared_by: me.id, group_id: groupId };
      });
    if (newRows.length) await ins("rb_shares", newRows);
    await refreshCloud();
    return { already: false };
  }

  async function sendGroupMessage(groupId, text) {
    const msg = { id: uid("gm"), groupId, senderId: me.id, text, createdAt: new Date().toISOString() };
    if (mode === "demo") {
      DB.groupMessages.push(msg); persist(); return msg;
    }
    const { data, error } = await supa.from("rb_group_messages")
      .insert({ id: msg.id, group_id: groupId, sender_id: me.id, text })
      .select().single();
    if (error) throw new Error(friendlyDbError(error));
    DB.groupMessages.push({ id: data.id, groupId: data.group_id, senderId: data.sender_id, text: data.text, createdAt: data.created_at });
    return msg;
  }

  // ---- writes: messages ----
  async function sendDirectMessage(userId, text) {
    const msg = { id: uid("dm"), senderId: me.id, receiverId: userId, text, createdAt: new Date().toISOString() };
    if (mode === "demo") {
      DB.directMessages.push(msg); persist(); return msg;
    }
    const { data, error } = await supa.from("rb_direct_messages")
      .insert({ id: msg.id, sender_id: me.id, receiver_id: userId, text })
      .select().single();
    if (error) throw new Error(friendlyDbError(error));
    DB.directMessages.push({ id: data.id, senderId: data.sender_id, receiverId: data.receiver_id, text: data.text, createdAt: data.created_at });
    return msg;
  }

  // ---- writes: friends ----
  async function sendFriendRequest(userId) {
    if (userId === me.id) throw new Error("You cannot add yourself.");
    if (isFriend(userId)) return { already: "friends" };
    if (DB.friendRequests.some(f => f.fromUser === me.id && f.toUser === userId && f.status === "pending")) return { already: "pending" };
    const row = { id: uid("fr"), fromUser: me.id, toUser: userId, status: "pending", createdAt: new Date().toISOString() };
    if (mode === "demo") {
      DB.friendRequests.push(row); persist(); return { ok: true };
    }
    await ins("rb_friend_requests", { id: row.id, from_user: me.id, to_user: userId, status: "pending" });
    await refreshCloud();
    return { ok: true };
  }

  async function respondFriendRequest(id, status) {
    if (mode === "demo") {
      const fr = DB.friendRequests.find(f => f.id === id);
      if (fr) fr.status = status;
      persist(); return;
    }
    await upd("rb_friend_requests", id, { status });
    await refreshCloud();
  }

  // ---- public API ----
  window.RBStore = {
    get mode() { return mode; },
    get me() { return me; },
    get data() { return DB; },
    get setupError() { return setupError; },
    get lastLoadedAt() { return lastLoadedAt; },
    isDemo() { return mode === "demo"; },
    initDemo, initCloud, resetDemo, refresh,
    demoUsers() { return DEMO_USERS; },
    profile, imageUrl,
    registersVisible, myRegisters, sharedWithMe, entriesOf, myGroups, groupMembers, sharesOf,
    canEdit, canView, isFriend, pendingIncoming, pendingOutgoing, friends, otherProfiles,
    messagesBetween, groupMessages, searchPeople,
    createRegister, addEntry, updateEntry, deleteEntry, deleteRegister,
    shareWithUser, shareWithGroup, removeShare,
    createGroup, addGroupMember, sendGroupMessage, sendDirectMessage,
    sendFriendRequest, respondFriendRequest
  };
})();
