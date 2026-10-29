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
    groupMessages: [], friendRequests: [], directMessages: [],
    groupInvites: [], notifications: [], calls: [], callSignals: [], accountDeletions: [],
    // ---- Questions Register Books ----
    qbooks: [], qpages: [], qquestions: [], qoptions: [], qcopies: [], qanswers: []
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
      localStorage.setItem(LS_KEY, JSON.stringify({ v: 5, savedAt: new Date().toISOString(), ...DB }));
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

    // ---- Questions Register Book (demo) ---------------------------------
    // Goldfish wrote a safety quiz and sent it to Silverfish, so the whole
    // send -> answer -> submit -> return flow can be tried without a server.
    DB.qbooks.push({ id: "qb_safety", ownerId: "goldfish", title: "Ward Safety Quiz", createdAt: new Date(y, m, 3, 9, 0).toISOString(), updatedAt: new Date(y, m, 3, 9, 0).toISOString() });
    ["qp_s1", "qp_s2"].forEach((pid, i) => {
      DB.qpages.push({ id: pid, bookId: "qb_safety", pageNo: i + 1 });
    });
    DB.qquestions.push(
      { id: "qq_1", bookId: "qb_safety", pageId: "qp_s1", qNo: 1, text: "What is the first thing you do when a patient falls?", hasChoices: true, hasWritten: false, writtenLabel: "Written answer" },
      { id: "qq_2", bookId: "qb_safety", pageId: "qp_s1", qNo: 2, text: "Where is the emergency oxygen cylinder kept?", hasChoices: true, hasWritten: true, writtenLabel: "Describe the location" },
      { id: "qq_3", bookId: "qb_safety", pageId: "qp_s2", qNo: 3, text: "Who must you call before moving a patient to another ward?", hasChoices: false, hasWritten: true, writtenLabel: "Name the person and the number" }
    );
    DB.qoptions.push(
      { id: "qo_1a", questionId: "qq_1", label: "A", text: "Call the duty doctor" },
      { id: "qo_1b", questionId: "qq_1", label: "B", text: "Check the patient and do not move them" },
      { id: "qo_1c", questionId: "qq_1", label: "C", text: "Help them back into bed at once" },
      { id: "qo_1d", questionId: "qq_1", label: "D", text: "Write it in the register later" },
      { id: "qo_2a", questionId: "qq_2", label: "A", text: "Ward A store room" },
      { id: "qo_2b", questionId: "qq_2", label: "B", text: "Next to the nurse station" },
      { id: "qo_2c", questionId: "qq_2", label: "C", text: "In the corridor cupboard" },
      { id: "qo_2d", questionId: "qq_2", label: "D", text: "Outside the ward door" }
    );
    DB.qcopies.push({
      id: "qc_safety_silver", bookId: "qb_safety", senderId: "goldfish", recipientId: "silverfish",
      status: "sent", revision: 1, senderNote: "Please complete this by Friday.",
      sentAt: new Date(y, m, 7, 10, 0).toISOString(),
      receivedAt: null, submittedAt: null, returnedAt: null
    });

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
    // v4 was the old payload shape; v5 adds the six question-book tables.
    // Both restore safely, because hydrate() just copies over the known arrays.
    if (blob && (blob.v === 5 || blob.v === 4) && Array.isArray(blob.profiles) && blob.profiles.length) {
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
    const [groupMessagesRaw, invites, notes, calls] = await Promise.all([
      groupIds.length ? sel(supa.from("rb_group_messages").select("*").in("group_id", groupIds).order("created_at", { ascending: true }), "group messages") : [],
      sel(supa.from("rb_group_invites").select("*").order("created_at", { ascending: false }), "group invites"),
      sel(supa.from("rb_notifications").select("*").order("created_at", { ascending: false }).limit(50), "notifications"),
      sel(supa.from("rb_calls").select("*").order("created_at", { ascending: false }).limit(20), "calls")
    ]);
    const groupMessages = groupMessagesRaw;

    DB.profiles = profiles.map(p => ({ id: p.id, name: p.name || (p.email || "Staff").split("@")[0], email: p.email || "", avatar: p.avatar_url || "", color: colorFor(p.id) }));
    DB.registers = regs.map(r => ({ id: r.id, ownerId: r.owner_id, name: r.name, type: r.type, createdAt: r.created_at }));
    DB.entries = entries.map(e => ({ id: e.id, registerId: e.register_id, date: e.entry_date, text: e.text || "", note: e.note || "", qty: e.qty, amount: e.amount, done: !!e.done, seq: e.seq }));
    DB.shares = shares.map(s => ({ id: s.id, registerId: s.register_id, sharedWithUserId: s.shared_with_user_id, sharedWithEmail: s.shared_with_email, groupId: s.group_id || null, sharedBy: s.shared_by, permission: s.permission || "view" }));
    DB.groups = groups.map(g => ({ id: g.id, name: g.name, createdBy: g.created_by, createdAt: g.created_at }));
    DB.groupMembers = members.map(x => ({ groupId: x.group_id, userId: x.user_id }));
    DB.groupMessages = groupMessages.map(x => ({ id: x.id, groupId: x.group_id, senderId: x.sender_id, text: x.text, createdAt: x.created_at }));
    DB.friendRequests = friendRequests.map(x => ({ id: x.id, fromUser: x.from_user, toUser: x.to_user, status: x.status, createdAt: x.created_at }));
    DB.directMessages = dms.map(x => ({ id: x.id, senderId: x.sender_id, receiverId: x.receiver_id, text: x.text, createdAt: x.created_at }));
    DB.groupInvites = invites.map(x => ({ id: x.id, groupId: x.group_id, code: x.code, invitedUserId: x.invited_user_id, invitedEmail: x.invited_email, createdBy: x.created_by, status: x.status, createdAt: x.created_at, respondedAt: x.responded_at }));
    DB.notifications = notes.map(x => ({ id: x.id, userId: x.user_id, type: x.type, title: x.title, body: x.body || "", data: x.data || {}, read: !!x.read, createdAt: x.created_at }));
    DB.calls = calls.map(x => ({ id: x.id, callerId: x.caller_id, calleeId: x.callee_id, kind: x.kind, status: x.status, createdAt: x.created_at, answeredAt: x.answered_at, endedAt: x.ended_at }));

    // ---- Questions Register Books -------------------------------------
    // Only books I own or that were sent to me are visible, because RLS on
    // rb_qbooks / rb_qbook_copies already filters everything else out.
    const qcopiesRaw = await sel(
      supa.from("rb_qbook_copies").select("*").order("sent_at", { ascending: false }),
      "question book copies");

    DB.qcopies = qcopiesRaw.map(c => ({
      id: c.id, bookId: c.book_id, senderId: c.sender_id, recipientId: c.recipient_id,
      status: c.status, revision: c.revision, senderNote: c.sender_note || "",
      sentAt: c.sent_at, receivedAt: c.received_at, submittedAt: c.submitted_at, returnedAt: c.returned_at
    }));

    const qbookIds = [
      ...new Set([
        ...(await sel(supa.from("rb_qbooks").select("id").eq("owner_id", uid_), "my question books")).map(b => b.id),
        ...DB.qcopies.map(c => c.bookId)
      ])
    ];

    if (qbookIds.length) {
      const [qbooks, qpages, qquestions] = await Promise.all([
        sel(supa.from("rb_qbooks").select("*").in("id", qbookIds).order("created_at", { ascending: false }), "question books"),
        sel(supa.from("rb_qpages").select("*").in("book_id", qbookIds).order("page_no", { ascending: true }), "question pages"),
        sel(supa.from("rb_questions").select("*").in("book_id", qbookIds).order("q_no", { ascending: true }), "questions")
      ]);
      const qIds = qquestions.map(q => q.id);
      const [qoptions, qanswers] = await Promise.all([
        qIds.length ? sel(supa.from("rb_qoptions").select("*").in("question_id", qIds), "question options") : [],
        DB.qcopies.length
          ? sel(supa.from("rb_qanswers").select("*").in("copy_id", DB.qcopies.map(c => c.id)), "question answers")
          : []
      ]);

      DB.qbooks = qbooks.map(b => ({ id: b.id, ownerId: b.owner_id, title: b.title, createdAt: b.created_at, updatedAt: b.updated_at }));
      DB.qpages = qpages.map(p => ({ id: p.id, bookId: p.book_id, pageNo: p.page_no }));
      DB.qquestions = qquestions.map(q => ({
        id: q.id, bookId: q.book_id, pageId: q.page_id, qNo: q.q_no, text: q.text,
        hasChoices: !!q.has_choices, hasWritten: !!q.has_written,
        writtenLabel: q.written_label || "Written answer"
      }));
      DB.qoptions = qoptions.map(o => ({ id: o.id, questionId: o.question_id, label: o.label, text: o.text || "" }));
      DB.qanswers = qanswers.map(a => ({
        id: a.id, copyId: a.copy_id, questionId: a.question_id,
        selectedLabel: a.selected_label || "", writtenAnswer: a.written_answer || "", updatedAt: a.updated_at
      }));
    } else {
      DB.qbooks = []; DB.qpages = []; DB.qquestions = []; DB.qoptions = []; DB.qanswers = [];
    }

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
  // Insert, or update when the row is already there. Used for answers, which
  // the recipient saves over and over while they work through a book.
  async function upsert(table, row, onConflict) {
    const { error } = await supa.from(table).upsert(row, { onConflict });
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
      DB.directMessages.push(msg);
      addNotification(userId, "message", { sender: me.name, senderId: me.id, text });
      persist(); return msg;
    }
    const { data, error } = await supa.from("rb_direct_messages")
      .insert({ id: msg.id, sender_id: me.id, receiver_id: userId, text })
      .select().single();
    if (error) throw new Error(friendlyDbError(error));
    DB.directMessages.push({ id: data.id, senderId: data.sender_id, receiverId: data.receiver_id, text: data.text, createdAt: data.created_at });
    notifyRemote({ type: "message", recipientId: userId, senderId: me.id, sender: me.name, text, messageId: data.id }).catch(() => {});
    return msg;
  }

  // ---- writes: friends ----
  async function sendFriendRequest(userId) {
    if (userId === me.id) throw new Error("You cannot add yourself.");
    if (isFriend(userId)) return { already: "friends" };
    if (DB.friendRequests.some(f => f.fromUser === me.id && f.toUser === userId && f.status === "pending")) return { already: "pending" };
    const row = { id: uid("fr"), fromUser: me.id, toUser: userId, status: "pending", createdAt: new Date().toISOString() };
    if (mode === "demo") {
      DB.friendRequests.push(row);
      addNotification(userId, "friend", { sender: me.name, senderId: me.id, requestId: row.id });
      persist(); return { ok: true };
    }
    await ins("rb_friend_requests", { id: row.id, from_user: me.id, to_user: userId, status: "pending" });
    await refreshCloud();
    notifyRemote({ type: "friend", recipientId: userId, senderId: me.id, sender: me.name, requestId: row.id }).catch(() => {});
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

  // ---- notifications ----------------------------------------------------
  // Cloud: rows are written by the rb-notify Edge Function (the browser has no
  // INSERT grant on rb_notifications, on purpose) and arrive live over Realtime.
  // Demo: written straight into localStorage so the flow can be tested on one
  // phone by switching demo users.
  function addNotification(userId, type, payload) {
    const ev = payload || {};
    const w = (window.RBNotifyText && window.RBNotifyText.wording)
      ? window.RBNotifyText.wording(ev)
      : { title: ev.title || "RegisterBook" };
    const n = {
      id: uid("nt"),
      userId,
      type,
      title: w.title,
      body: ev.text ? String(ev.text).slice(0, 60) : (w.body || ""),
      data: { senderId: ev.senderId || "", groupId: ev.groupId || "", code: ev.code || "", callId: ev.callId || "", inviteId: ev.inviteId || "", requestId: ev.requestId || "", kind: ev.kind || "" },
      read: false,
      createdAt: new Date().toISOString()
    };
    DB.notifications.push(n);
    return n;
  }
  function notifications() {
    return DB.notifications
      .filter(n => n.userId === (me && me.id))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  function unreadNotifications() { return notifications().filter(n => !n.read); }
  async function markNotificationRead(id) {
    const n = DB.notifications.find(x => x.id === id);
    if (n) n.read = true;
    if (mode !== "demo") { try { await upd("rb_notifications", id, { read: true }); } catch (e) {} }
    else persist();
  }
  async function markAllNotificationsRead() {
    notifications().forEach(n => { n.read = true; });
    if (mode !== "demo") {
      try { await supa.from("rb_notifications").update({ read: true }).eq("user_id", me.id).eq("read", false); } catch (e) {}
    } else persist();
  }
  async function clearNotification(id) {
    DB.notifications = DB.notifications.filter(n => n.id !== id);
    if (mode !== "demo") { try { await del("rb_notifications", "id", id); } catch (e) {} }
    else persist();
  }

  // ---- group invites ----------------------------------------------------
  function incomingInvites() {
    return DB.groupInvites.filter(i => i.status === "pending"
      && i.createdBy !== (me && me.id)
      && (i.invitedUserId === (me && me.id) || !i.invitedUserId));
  }
  // Reads an invite by code even when RLS hides the row (open link invites).
  async function previewInvite(code) {
    if (mode === "demo") {
      const inv = DB.groupInvites.find(i => i.code === String(code || "").toUpperCase());
      if (!inv) return null;
      const g = DB.groups.find(x => x.id === inv.groupId) || {};
      return {
        code: inv.code, status: inv.status, groupId: g.id, groupName: g.name || "a group",
        fromName: profile(inv.createdBy).name, fromAvatar: profile(inv.createdBy).avatar,
        memberCount: DB.groupMembers.filter(m => m.groupId === inv.groupId).length
      };
    }
    const { data, error } = await supa.rpc("rb_invite_preview", { invite_code: code });
    if (error) throw new Error(friendlyDbError(error));
    return data || null;
  }
  function invitesForGroup(groupId) {
    return DB.groupInvites.filter(i => i.groupId === groupId);
  }
  function invitesISent() {
    return DB.groupInvites.filter(i => i.createdBy === (me && me.id));
  }
  async function invitePersonToGroup(groupId, userId) {
    const n = (window.RBNotifyText || {});
    const code = n.randomCode ? n.randomCode(8) : Math.random().toString(36).slice(2, 10).toUpperCase();
    const row = {
      id: uid("inv"), groupId, code, invitedUserId: userId || null, invitedEmail: null,
      createdBy: me.id, status: "pending", createdAt: new Date().toISOString(), respondedAt: null
    };
    if (mode === "demo") {
      DB.groupInvites.push(row);
      persist();
      if (userId) addNotification(userId, "invite", {
        inviter: me.name, group: (DB.groups.find(g => g.id === groupId) || {}).name || "a group",
        code, inviteId: row.id, groupId
      });
      persist();
      return row;
    }
    const { data, error } = await supa.from("rb_group_invites")
      .insert({ group_id: groupId, code, invited_user_id: userId || null, created_by: me.id })
      .select().single();
    if (error) throw new Error(friendlyDbError(error));
    const saved = { id: data.id, groupId: data.group_id, code: data.code, invitedUserId: data.invited_user_id, createdBy: data.created_by, status: data.status, createdAt: data.created_at };
    DB.groupInvites.push(saved);
    if (userId) {
      const p = profile(userId);
      await notifyRemote({
        type: "invite", recipientId: userId, inviteId: saved.id, groupId,
        inviter: me.name, group: (DB.groups.find(g => g.id === groupId) || {}).name || "a group", code
      });
    }
    return saved;
  }
  async function createGroupInviteLink(groupId) {
    return invitePersonToGroup(groupId, null);
  }
  async function acceptInvite(codeOrId) {
    const inv = DB.groupInvites.find(i => i.code === codeOrId || i.id === codeOrId);
    if (mode === "demo") {
      if (!inv) throw new Error("That invite link is not valid.");
      if (inv.status !== "pending") throw new Error("That invite was already " + inv.status + ".");
      if (inv.invitedUserId && inv.invitedUserId !== me.id) throw new Error("That invite was sent to someone else.");
      inv.status = "accepted";
      inv.invitedUserId = inv.invitedUserId || me.id;
      inv.respondedAt = new Date().toISOString();
      if (!DB.groupMembers.some(m => m.groupId === inv.groupId && m.userId === me.id)) {
        DB.groupMembers.push({ groupId: inv.groupId, userId: me.id });
      }
      // Joining a group must also give you the registers already shared with it.
      DB.shares
        .filter(s => s.groupId === inv.groupId && s.sharedWithUserId && s.sharedWithUserId !== me.id)
        .forEach(s => {
          if (DB.shares.some(x => x.registerId === s.registerId && x.sharedWithUserId === me.id)) return;
          DB.shares.push({
            id: uid("shr"), registerId: s.registerId, sharedWithUserId: me.id,
            sharedWithEmail: me.email || "", permission: s.permission || "view",
            sharedBy: s.sharedBy, groupId: s.groupId, createdAt: new Date().toISOString()
          });
        });
      persist();
      return inv.groupId;
    }
    const inv2 = inv || DB.groupInvites.find(i => i.id === codeOrId);
    const code = inv2 ? inv2.code : codeOrId;
    const { data, error } = await supa.rpc("rb_accept_group_invite", { invite_code: code });
    if (error) throw new Error(friendlyDbError(error));
    await refreshCloud();
    return data;
  }
  async function declineInvite(codeOrId) {
    const inv = DB.groupInvites.find(i => i.code === codeOrId || i.id === codeOrId);
    if (mode === "demo") {
      if (!inv) throw new Error("That invite link is not valid.");
      if (inv.invitedUserId && inv.invitedUserId !== me.id) throw new Error("That invite was sent to someone else.");
      inv.status = "declined";
      inv.invitedUserId = inv.invitedUserId || me.id;
      inv.respondedAt = new Date().toISOString();
      persist();
      return inv.groupId;
    }
    const code = inv ? inv.code : codeOrId;
    const { data, error } = await supa.rpc("rb_decline_group_invite", { invite_code: code });
    if (error) throw new Error(friendlyDbError(error));
    await refreshCloud();
    return data;
  }

  // ---- push subscriptions -----------------------------------------------
  async function savePushSubscription(sub) {
    const row = {
      userId: me.id, endpoint: sub.endpoint,
      p256dh: sub.keys ? sub.keys.p256dh : "", auth: sub.keys ? sub.keys.auth : "",
      userAgent: (navigator && navigator.userAgent) ? String(navigator.userAgent).slice(0, 200) : ""
    };
    if (mode === "demo") { persist(); return row; }
    const { error } = await supa.from("rb_push_subscriptions").upsert({
      user_id: row.userId, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, user_agent: row.userAgent
    }, { onConflict: "endpoint" });
    if (error) throw new Error(friendlyDbError(error));
    return row;
  }
  async function deletePushSubscription(endpoint) {
    if (mode === "demo") return;
    const { error } = await supa.from("rb_push_subscriptions").delete().eq("endpoint", endpoint);
    if (error) throw new Error(friendlyDbError(error));
  }

  // ---- calls ------------------------------------------------------------
  async function startCall(userId, kind) {
    const k = kind === "video" ? "video" : "audio";
    if (mode === "demo") {
      const call = { id: uid("call"), callerId: me.id, calleeId: userId, kind: k, status: "ringing", createdAt: new Date().toISOString(), answeredAt: null, endedAt: null };
      DB.calls.push(call);
      addNotification(userId, "call", { caller: me.name, kind: k, callId: call.id, senderId: me.id });
      persist();
      return call;
    }
    const { data, error } = await supa.from("rb_calls")
      .insert({ caller_id: me.id, callee_id: userId, kind: k, status: "ringing" })
      .select().single();
    if (error) throw new Error(friendlyDbError(error));
    const call = { id: data.id, callerId: data.caller_id, calleeId: data.callee_id, kind: data.kind, status: data.status, createdAt: data.created_at, answeredAt: null, endedAt: null };
    DB.calls.push(call);
    await notifyRemote({ type: "call", recipientId: userId, callId: call.id, caller: me.name, kind: k, senderId: me.id });
    return call;
  }
  async function updateCallStatus(callId, status) {
    const patch = { status };
    if (status === "accepted") patch.answered_at = new Date().toISOString();
    if (status === "ended" || status === "declined" || status === "missed") patch.ended_at = new Date().toISOString();
    const c = DB.calls.find(x => x.id === callId);
    if (c) Object.assign(c, { status, answeredAt: patch.answered_at || c.answeredAt, endedAt: patch.ended_at || c.endedAt });
    if (mode === "demo") { persist(); return; }
    const { error } = await supa.from("rb_calls").update(patch).eq("id", callId);
    if (error) throw new Error(friendlyDbError(error));
  }
  function activeCall() {
    return DB.calls.find(c => c.status === "ringing" || c.status === "accepted") || null;
  }
  async function sendCallSignal(callId, kind, payload) {
    const row = { id: uid("sig"), callId, fromUser: me.id, kind, payload, createdAt: new Date().toISOString() };
    if (mode === "demo") { DB.callSignals.push(row); persist(); return row; }
    const { error } = await supa.from("rb_call_signals")
      .insert({ call_id: callId, from_user: me.id, kind, payload });
    if (error) throw new Error(friendlyDbError(error));
    return row;
  }
  function callSignals(callId) {
    return DB.callSignals.filter(s => s.callId === callId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  async function fetchCallSignals(callId) {
    if (mode === "demo") return callSignals(callId);
    const rows = await sel(supa.from("rb_call_signals").select("*").eq("call_id", callId).order("id", { ascending: true }), "call signals");
    return rows.map(s => ({ id: String(s.id), callId: s.call_id, fromUser: s.from_user, kind: s.kind, payload: s.payload, createdAt: s.created_at }));
  }

  // ---- remote push (Edge Function) --------------------------------------
  // Returns { ok, delivered, reason }. Never throws: a failed push must not
  // stop the message/request/invite from being saved.
  async function notifyRemote(ev) {
    const url = (window.RB_CONFIG && window.RB_CONFIG.edgeUrl) ? window.RB_CONFIG.edgeUrl("rb-notify") : "";
    if (!url || !supa) return { ok: false, delivered: 0, reason: "not-configured" };
    try {
      const sess = await window.RBAuth.getSession();
      if (!sess || !sess.access_token) return { ok: false, delivered: 0, reason: "no-session" };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: String((window.RB_CONFIG || {}).SUPABASE_ANON_KEY || ""),
          Authorization: "Bearer " + sess.access_token
        },
        body: JSON.stringify(ev)
      });
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
        return { ok: false, delivered: 0, reason: msg };
      }
      const j = await res.json();
      return { ok: true, delivered: (j && j.delivered) || 0, reason: "" };
    } catch (e) {
      return { ok: false, delivered: 0, reason: (e && e.message) || "network" };
    }
  }

  // ---- TURN relay credentials for calling -------------------------------
  // Asks the rb-turn-credentials Edge Function for a short-lived credential.
  // The long-lived TURN secret stays in Supabase secrets, never in the page.
  // Returns { ok, configured, iceServers, username, credential, expiresAt }.
  // Never throws: if it fails, the caller falls back to STUN only and says so.
  let turnCache = null;
  async function fetchTurnCredentials() {
    // Reuse a cached credential until five minutes before it expires.
    if (turnCache && turnCache.expiresAt && turnCache.expiresAt - 300 > Math.floor(Date.now() / 1000)) {
      return turnCache;
    }
    const cfg = window.RB_CONFIG || {};
    // A relay wired straight into config.js wins (some owners prefer it).
    if (cfg.TURN_URLS && cfg.TURN_USERNAME && cfg.TURN_CREDENTIAL) {
      const urls = Array.isArray(cfg.TURN_URLS) ? cfg.TURN_URLS : String(cfg.TURN_URLS).split(",").map(s => s.trim()).filter(Boolean);
      turnCache = {
        ok: true, configured: true, expiresAt: Math.floor(Date.now() / 1000) + 3600,
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
          { urls, username: cfg.TURN_USERNAME, credential: cfg.TURN_CREDENTIAL }
        ]
      };
      return turnCache;
    }

    const url = cfg.edgeUrl ? cfg.edgeUrl("rb-turn-credentials") : "";
    if (!url || !supa || isDemo()) {
      return { ok: false, configured: false, iceServers: null, reason: "not-configured" };
    }
    try {
      const sess = await window.RBAuth.getSession();
      if (!sess || !sess.access_token) return { ok: false, configured: false, iceServers: null, reason: "no-session" };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: String(cfg.SUPABASE_ANON_KEY || ""),
          Authorization: "Bearer " + sess.access_token
        },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
        return { ok: false, configured: false, iceServers: null, reason: msg };
      }
      const j = await res.json();
      turnCache = {
        ok: true,
        configured: !!j.configured,
        iceServers: j.iceServers || null,
        username: j.username || null,
        credential: j.credential || null,
        expiresAt: j.expiresAt || 0,
        message: j.message || ""
      };
      return turnCache;
    } catch (e) {
      return { ok: false, configured: false, iceServers: null, reason: (e && e.message) || "network" };
    }
  }

  // ---- delete my account ------------------------------------------------
  function accountSummary() {
    const myRegs = DB.registers.filter(r => r.ownerId === me.id);
    const myRegIds = myRegs.map(r => r.id);
    return {
      registers: myRegs.length,
      lines: DB.entries.filter(e => myRegIds.indexOf(e.registerId) >= 0).length,
      shares: DB.shares.filter(s => myRegIds.indexOf(s.registerId) >= 0).length,
      groups: DB.groups.filter(g => g.createdBy === me.id).length,
      memberships: DB.groupMembers.filter(m => m.userId === me.id).length,
      messages: DB.directMessages.filter(m => m.senderId === me.id || m.receiverId === me.id).length,
      groupMessages: DB.groupMessages.filter(m => m.senderId === me.id).length,
      friends: friends().length
    };
  }
  function exportMyBooks() {
    const myRegs = DB.registers.filter(r => r.ownerId === me.id);
    const lines = [];
    lines.push("RegisterBook — my books");
    lines.push("Exported: " + new Date().toLocaleString());
    lines.push("Account: " + me.name + " <" + (me.email || "") + ">");
    lines.push("");
    myRegs.forEach(reg => {
      lines.push("========================================");
      lines.push(reg.name + "  (" + reg.type + ")");
      lines.push("Created: " + new Date(reg.createdAt).toLocaleDateString());
      lines.push("----------------------------------------");
      const es = entriesOf(reg.id);
      if (!es.length) lines.push("(no lines yet)");
      es.forEach((e, i) => {
        let row = String(i + 1).padStart(3, " ") + ". " + (e.date || "") + "  " + e.text;
        if (e.qty != null) row += "  qty:" + e.qty;
        if (e.amount != null) row += "  Rs." + e.amount;
        if (e.done) row += "  [done]";
        lines.push(row);
      });
      if (reg.type === "Bill Book") {
        lines.push("----------------------------------------");
        lines.push("TOTAL Rs." + es.reduce((s, e) => s + (Number(e.amount) || 0), 0));
      }
      lines.push("");
    });
    return lines.join("\n");
  }
  async function requestAccountDeletion(reason) {
    if (mode === "demo") {
      DB.accountDeletions.push({ id: uid("del"), userId: me.id, reason, status: "requested", createdAt: new Date().toISOString() });
      persist();
      return { ok: true, mode: "demo" };
    }
    const { error } = await supa.from("rb_account_deletions")
      .insert({ user_id: me.id, email: me.email || null, reason: reason || null });
    if (error) throw new Error(friendlyDbError(error));
    return { ok: true, mode: "requested" };
  }
  // Really deletes the signed-in user. Needs the rb-delete-account Edge
  // Function (only it holds the service_role key). If that function is not
  // deployed yet we say so honestly instead of pretending.
  async function deleteAccountNow() {
    const url = (window.RB_CONFIG && window.RB_CONFIG.edgeUrl) ? window.RB_CONFIG.edgeUrl("rb-delete-account") : "";
    if (!url || !supa) return { ok: false, reason: "not-configured" };
    const sess = await window.RBAuth.getSession();
    if (!sess || !sess.access_token) return { ok: false, reason: "no-session" };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: String((window.RB_CONFIG || {}).SUPABASE_ANON_KEY || ""),
          Authorization: "Bearer " + sess.access_token
        },
        body: JSON.stringify({ confirm: "DELETE" })
      });
      let j = {};
      try { j = await res.json(); } catch (e) {}
      if (!res.ok) return { ok: false, reason: j.error || ("HTTP " + res.status) };
      return { ok: true, summary: j.summary || null };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || "network" };
    }
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
    sendFriendRequest, respondFriendRequest,
    notifications, unreadNotifications, markNotificationRead, markAllNotificationsRead, clearNotification,
    incomingInvites, invitesForGroup, invitesISent,
    invitePersonToGroup, createGroupInviteLink, acceptInvite, declineInvite, previewInvite,
    savePushSubscription, deletePushSubscription,
    startCall, updateCallStatus, activeCall, sendCallSignal, callSignals, fetchCallSignals,
    notifyRemote, fetchTurnCredentials,
    accountSummary, exportMyBooks, requestAccountDeletion, deleteAccountNow,

    // ---- used by qbooks.js (the Questions Register Book feature) ----
    // These are the same primitives the rest of the store uses internally;
    // they are exposed so the question-book code can live in its own file.
    persistDemo() { persist(); },
    cloudInsert: ins,
    cloudUpdate: upd,
    cloudDelete: del,
    cloudUpsert: upsert,
    cloudRefresh: refreshCloud
  };
})();
