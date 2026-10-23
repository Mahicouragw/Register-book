// Tests the Supabase ("cloud") code path of store.js against a mock Supabase
// client. The mock enforces the same RLS rules as supabase/migrations.sql and
// rejects any column that does not exist in the migration, so column-name
// typos between app.js/store.js and the schema fail here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const SQL = fs.readFileSync(path.join(ROOT, "supabase", "migrations.sql"), "utf8");

// ---- parse the real schema so the mock only accepts real columns ----
function parseSchema(sql) {
  const tables = {};
  const re = /create table if not exists public\.(rb_\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const cols = new Set();
    m[2].split("\n").forEach(line => {
      const c = line.trim().match(/^([a-z_][a-z0-9_]*)\s+(uuid|text|int|integer|numeric|boolean|date|timestamptz)/i);
      if (c) cols.add(c[1]);
    });
    tables[m[1]] = cols;
  }
  return tables;
}
const SCHEMA = parseSchema(SQL);

const GOLD = "11111111-1111-4111-8111-111111111111";
const SILVER = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";
const USERS = {
  [GOLD]: { id: GOLD, name: "Goldfish", email: "gold@example.com", avatar: "https://x/g.png" },
  [SILVER]: { id: SILVER, name: "Silverfish", email: "silver@example.com", avatar: "" },
  [PRIYA]: { id: PRIYA, name: "Priya", email: "priya@example.com", avatar: "" }
};

// ---- a tiny PostgREST + RLS simulator ----
function makeMockSupabase(initial = {}) {
  const db = {
    rb_profiles: [], rb_registers: [], rb_entries: [], rb_shares: [], rb_groups: [],
    rb_group_members: [], rb_group_messages: [], rb_friend_requests: [], rb_direct_messages: [],
    rb_group_invites: [], rb_push_subscriptions: [], rb_notifications: [],
    rb_account_deletions: [], rb_calls: [], rb_call_signals: [],
    ...JSON.parse(JSON.stringify(initial))
  };
  const state = { me: GOLD };
  const errors = [];

  const rls = msg => ({ message: `new row violates row-level security policy for table "${msg}"` });
  const visibleRegisterIds = () => new Set(db.rb_registers.filter(r =>
    r.owner_id === state.me || db.rb_shares.some(s => s.register_id === r.id && s.shared_with_user_id === state.me)
  ).map(r => r.id));
  const myGroupIds = () => new Set(db.rb_groups.filter(g =>
    g.created_by === state.me || db.rb_group_members.some(m => m.group_id === g.id && m.user_id === state.me)
  ).map(g => g.id));
  const ownsRegister = id => db.rb_registers.some(r => r.id === id && r.owner_id === state.me);

  function checkColumns(table, obj) {
    const cols = SCHEMA[table];
    if (!cols) return { message: `relation "public.${table}" does not exist` };
    for (const k of Object.keys(obj)) {
      if (!cols.has(k)) return { message: `column "${k}" of relation "${table}" does not exist` };
    }
    return null;
  }

  function readFilter(table, rows) {
    const regIds = visibleRegisterIds();
    const groupIds = myGroupIds();
    switch (table) {
      case "rb_profiles": return rows;
      case "rb_registers": return rows.filter(r => regIds.has(r.id));
      case "rb_entries": return rows.filter(r => regIds.has(r.register_id));
      case "rb_shares": return rows.filter(s => s.shared_with_user_id === state.me || ownsRegister(s.register_id) || s.shared_by === state.me);
      case "rb_groups": return rows.filter(g => groupIds.has(g.id));
      case "rb_group_members": return rows.filter(m => groupIds.has(m.group_id));
      case "rb_group_messages": return rows.filter(x => groupIds.has(x.group_id));
      case "rb_friend_requests": return rows.filter(f => f.from_user === state.me || f.to_user === state.me);
      case "rb_direct_messages": return rows.filter(d => d.sender_id === state.me || d.receiver_id === state.me);
      // --- new tables ---
      case "rb_group_invites": return rows.filter(i =>
        i.created_by === state.me || i.invited_user_id === state.me ||
        db.rb_groups.some(g => g.id === i.group_id && g.created_by === state.me));
      case "rb_push_subscriptions": return rows.filter(x => x.user_id === state.me);
      case "rb_notifications": return rows.filter(n => n.user_id === state.me);
      case "rb_account_deletions": return rows.filter(a => a.user_id === state.me);
      case "rb_calls": return rows.filter(c => c.caller_id === state.me || c.callee_id === state.me);
      case "rb_call_signals": return rows.filter(sg =>
        db.rb_calls.some(c => c.id === sg.call_id && (c.caller_id === state.me || c.callee_id === state.me)));
      default: return [];
    }
  }

  function writeAllowed(table, row, mode) {
    switch (table) {
      case "rb_profiles": return row.id === state.me ? null : rls(table);
      case "rb_registers":
        if (mode === "insert") return row.owner_id === state.me ? null : rls(table);
        return ownsRegister(row.id) ? null : rls(table);
      case "rb_entries":
        return ownsRegister(row.register_id) ? null : rls(table);
      case "rb_shares":
        return ownsRegister(row.register_id) && row.permission === "view" ? null : rls(table);
      case "rb_groups":
        return row.created_by === state.me ? null : rls(table);
      case "rb_group_members":
        return db.rb_groups.some(g => g.id === row.group_id && g.created_by === state.me) ? null : rls(table);
      case "rb_group_messages":
        return row.sender_id === state.me && myGroupIds().has(row.group_id) ? null : rls(table);
      case "rb_friend_requests":
        if (mode === "insert") return row.from_user === state.me ? null : rls(table);
        return db.rb_friend_requests.some(f => f.id === row.id && f.to_user === state.me) ? null : rls(table);
      case "rb_direct_messages":
        return row.sender_id === state.me ? null : rls(table);
      // --- new tables ---
      case "rb_push_subscriptions":
        return row.user_id === state.me ? null : rls(table);
      case "rb_notifications":
        // the browser has no INSERT grant: only the Edge Function writes rows
        return rls(table);
      case "rb_account_deletions":
        return row.user_id === state.me ? null : rls(table);
      case "rb_calls":
        return row.caller_id === state.me || row.callee_id === state.me ? null : rls(table);
      case "rb_call_signals":
        return row.from_user === state.me &&
          db.rb_calls.some(c => c.id === row.call_id && (c.caller_id === state.me || c.callee_id === state.me))
          ? null : rls(table);
      case "rb_group_invites":
        return db.rb_groups.some(g => g.id === row.group_id && g.created_by === state.me) && row.created_by === state.me
          ? null : rls(table);
      default: return { message: `relation "public.${table}" does not exist` };
    }
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orders = [];
      this.mode = "select";
      this.payload = null;
      this.singleMode = false;
    }
    select() { return this; }
    insert(rows) { this.mode = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows) {
      this.mode = "upsert";
      this.payload = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    update(patch) { this.mode = "update"; this.payload = patch; return this; }
    delete() { this.mode = "delete"; return this; }
    eq(col, val) { this.filters.push({ type: "eq", col, val }); return this; }
    in(col, vals) { this.filters.push({ type: "in", col, vals }); return this; }
    or(expr) {
      const parts = String(expr).split(",").map(p => {
        const [col, op, val] = p.split(".");
        return { col, val };
      });
      this.filters.push({ type: "or", parts });
      return this;
    }
    order(col, opts) { this.orders.push({ col, asc: !opts || opts.ascending !== false }); return this; }
    limit(n) { this.maxRows = n; return this; }
    single() { this.singleMode = true; return this; }
    match(row) {
      return this.filters.every(f => {
        if (f.type === "eq") return row[f.col] === f.val;
        if (f.type === "in") return f.vals.includes(row[f.col]);
        if (f.type === "or") return f.parts.some(p => row[p.col] === p.val);
        return true;
      });
    }
    run() {
      const table = this.table;
      if (!SCHEMA[table]) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      if (this.mode === "select") {
        let rows = readFilter(table, db[table].slice()).filter(r => this.match(r));
        if (this.maxRows != null) rows = rows.slice(0, this.maxRows);
        this.orders.forEach(o => {
          rows = rows.slice().sort((a, b) => {
            const av = a[o.col], bv = b[o.col];
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * (o.asc ? 1 : -1);
          });
        });
        return { data: this.singleMode ? rows[0] || null : rows, error: null };
      }
      if (this.mode === "insert" || this.mode === "upsert") {
        const out = [];
        for (const raw of this.payload) {
          const colErr = checkColumns(table, raw);
          if (colErr) return { data: null, error: colErr };
          const row = Object.assign({}, raw);
          if (table === "rb_entries" && row.done == null) row.done = false;
          if (table === "rb_shares" && !row.permission) row.permission = "view";
          if (table === "rb_friend_requests" && !row.status) row.status = "pending";
          const deny = writeAllowed(table, row, this.mode === "upsert" ? "upsert" : "insert");
          if (deny) return { data: null, error: deny };
          if (this.mode === "upsert") {
            const i = db[table].findIndex(r => r.id && r.id === row.id);
            if (i >= 0) db[table][i] = Object.assign({}, db[table][i], row);
            else db[table].push(row);
          } else {
            db[table].push(row);
          }
          out.push(row);
        }
        return { data: this.singleMode ? out[0] : out, error: null };
      }
      if (this.mode === "update") {
        const colErr = checkColumns(table, this.payload);
        if (colErr) return { data: null, error: colErr };
        let affected = 0;
        for (const row of db[table]) {
          if (!this.match(row)) continue;
          const deny = writeAllowed(table, row, "update");
          if (deny) continue;
          Object.assign(row, this.payload);
          affected++;
        }
        return { data: null, error: null, affected };
      }
      if (this.mode === "delete") {
        const keep = [];
        for (const row of db[table]) {
          if (!this.match(row)) { keep.push(row); continue; }
          const owns =
            table === "rb_entries" ? ownsRegister(row.register_id)
              : table === "rb_registers" ? row.owner_id === state.me
                : table === "rb_shares" ? ownsRegister(row.register_id)
                  : true;
          if (owns) continue;
          keep.push(row);
        }
        db[table] = keep;
        return { data: null, error: null };
      }
      return { data: null, error: { message: "unsupported" } };
    }
    then(resolve, reject) {
      try { resolve(this.run()); } catch (e) { reject(e); }
    }
  }

  const client = {
    from: table => new Query(table),
    rpc(name, args) {
      // Minimal support for the SECURITY DEFINER invite helpers. The full RLS
      // behaviour is proven against real Postgres in tests/notifications.test.js.
      const a = args || {};
      if (name === "rb_invite_preview") {
        const inv = db.rb_group_invites.find(i => i.code === String(a.invite_code || "").toUpperCase());
        if (!inv) return Promise.resolve({ data: null, error: null });
        const g = db.rb_groups.find(x => x.id === inv.group_id) || {};
        return Promise.resolve({
          data: {
            code: inv.code, status: inv.status, groupId: g.id, groupName: g.name,
            fromName: "a colleague", fromAvatar: null,
            memberCount: db.rb_group_members.filter(m => m.group_id === inv.group_id).length
          },
          error: null
        });
      }
      if (name === "rb_accept_group_invite" || name === "rb_decline_group_invite") {
        const inv = db.rb_group_invites.find(i => i.code === String(a.invite_code || "").toUpperCase());
        if (!inv) return Promise.resolve({ data: null, error: { message: "That invite link is not valid." } });
        if (inv.status !== "pending") return Promise.resolve({ data: null, error: { message: "That invite was already " + inv.status } });
        if (inv.invited_user_id && inv.invited_user_id !== state.me) {
          return Promise.resolve({ data: null, error: { message: "That invite was sent to someone else." } });
        }
        inv.status = name === "rb_accept_group_invite" ? "accepted" : "declined";
        inv.invited_user_id = inv.invited_user_id || state.me;
        if (name === "rb_accept_group_invite" &&
            !db.rb_group_members.some(m => m.group_id === inv.group_id && m.user_id === state.me)) {
          db.rb_group_members.push({ group_id: inv.group_id, user_id: state.me });
        }
        return Promise.resolve({ data: inv.group_id, error: null });
      }
      return Promise.resolve({ data: null, error: { message: "unknown rpc " + name } });
    },
    auth: { getSession: async () => ({ data: { session: { user: { id: state.me, email: USERS[state.me].email, user_metadata: { full_name: USERS[state.me].name } } } }, error: null }) }
  };
  return { client, db, state, errors };
}

async function bootCloud(userId, seed = {}) {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "https://rb.test/Register-book/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.confirm = () => true;
  w.prompt = () => "Edited";
  const mock = makeMockSupabase(seed);
  mock.state.me = userId;
  w.supabase = { createClient: () => mock.client };
  w.RB_CONFIG = { SUPABASE_URL: "https://abcdefghijkl.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_test", isConfigured: () => true, SITE_URL: "https://x" };
  w.eval(fs.readFileSync(path.join(ROOT, "auth.js"), "utf8").replace(/window\.RB_CONFIG \|\| \{\}/, "window.RB_CONFIG"));
  w.RBAuth = {
    isConfigured: () => true,
    getClient: () => mock.client,
    getSession: async () => ({ user: { id: userId, email: USERS[userId].email, user_metadata: { full_name: USERS[userId].name } } }),
    onChange: () => () => {},
    signInGoogle: async () => ({ ok: true }),
    signOut: async () => {},
    init: async () => ({ client: mock.client, session: null, urlError: null }),
    projectRef: () => "abcdefghijkl",
    friendly: e => ({ title: "Error", message: String(e && e.message || e), steps: [] })
  };
  w.eval(fs.readFileSync(path.join(ROOT, "notify.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "store.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "push.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "rtc.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
  const ok = await w.RBStore.initCloud();
  return { dom, w, mock, ok, doc: w.document };
}

const seedRows = () => ({
  rb_profiles: [
    { id: GOLD, name: "Goldfish", email: "gold@example.com", avatar_url: "" },
    { id: SILVER, name: "Silverfish", email: "silver@example.com", avatar_url: "" },
    { id: PRIYA, name: "Priya", email: "priya@example.com", avatar_url: "" }
  ],
  rb_registers: [{ id: "reg1", owner_id: GOLD, name: "Medicine Checklist", type: "Medical Checklist", created_at: "2026-10-01T09:00:00Z" }],
  rb_entries: [
    { id: "e1", register_id: "reg1", entry_date: "2026-10-01", text: "Paracetamol", note: "", qty: null, amount: null, done: false, seq: 1 },
    { id: "e2", register_id: "reg1", entry_date: "2026-10-02", text: "Insulin", note: "", qty: null, amount: null, done: true, seq: 2 }
  ],
  rb_shares: [{ id: "s1", register_id: "reg1", shared_with_user_id: SILVER, shared_with_email: "silver@example.com", permission: "view", shared_by: GOLD, group_id: null }],
  rb_groups: [{ id: "g1", name: "Ward Staff", created_by: GOLD, created_at: "2026-10-01T09:00:00Z" }],
  rb_group_members: [{ group_id: "g1", user_id: GOLD }, { group_id: "g1", user_id: SILVER }],
  rb_group_messages: [{ id: "gm1", group_id: "g1", sender_id: GOLD, text: "Welcome", created_at: "2026-10-01T10:00:00Z" }],
  rb_friend_requests: [{ id: "f1", from_user: GOLD, to_user: SILVER, status: "accepted", created_at: "2026-10-01T09:00:00Z" }],
  rb_direct_messages: [{ id: "d1", sender_id: GOLD, receiver_id: SILVER, text: "hi", created_at: "2026-10-01T11:00:00Z" }]
});

test("cloud mode: loads and maps Supabase rows for the owner", async () => {
  const { dom, w, ok } = await bootCloud(GOLD, seedRows());
  assert.equal(ok, true, "initCloud succeeded");
  const S = w.RBStore;
  assert.equal(S.mode, "cloud");
  assert.equal(S.me.name, "Goldfish");
  assert.equal(S.me.isReal, true);
  assert.equal(S.myRegisters().length, 1);
  assert.equal(S.entriesOf("reg1").length, 2);
  assert.equal(S.entriesOf("reg1")[1].done, true, "done flag mapped");
  assert.equal(S.entriesOf("reg1")[0].date, "2026-10-01", "entry_date → date");
  assert.equal(S.canEdit(S.myRegisters()[0]), true);
  assert.equal(S.myGroups().length, 1);
  assert.equal(S.groupMessages("g1").length, 1);
  dom.window.close();
});

test("cloud mode: the shared person reads everything and cannot write (RLS blocks it)", async () => {
  const { dom, w, mock } = await bootCloud(SILVER, seedRows());
  const S = w.RBStore;
  assert.equal(S.sharedWithMe().length, 1, "shared book is listed");
  assert.equal(S.entriesOf("reg1").length, 2, "and its lines are readable");
  assert.equal(S.canEdit(S.sharedWithMe()[0]), false, "viewer is not the owner");

  // INSERT raises the RLS error and is surfaced with a helpful message
  await assert.rejects(() => S.addEntry("reg1", { text: "Hacked" }), /Row Level Security|row-level security/i);

  // UPDATE / DELETE are filtered out by RLS (0 rows touched, no error) — the data must not change
  await S.updateEntry("e1", { text: "changed" });
  await S.deleteEntry("e1");
  await S.deleteRegister("reg1");
  await assert.rejects(() => S.shareWithUser("reg1", PRIYA), /Row Level Security/i, "viewer cannot share someone else's book");
  const onServer = mock.db.rb_entries.find(e => e.id === "e1");
  assert.equal(onServer.text, "Paracetamol", "line text unchanged on the server");
  assert.equal(mock.db.rb_entries.length, 2, "no line deleted on the server");
  assert.ok(mock.db.rb_registers.some(r => r.id === "reg1"), "register still exists on the server");
  assert.equal(mock.db.rb_shares.length, 1, "viewer cannot share someone else's book");
  dom.window.close();
});

test("cloud mode: friendly message when the tables have not been created yet", async () => {
  const { dom, w, ok } = await bootCloud(GOLD, {});
  // wipe the schema so every table looks missing
  const saved = {};
  Object.keys(SCHEMA).forEach(t => { saved[t] = SCHEMA[t]; delete SCHEMA[t]; });
  const res = await w.RBStore.initCloud();
  Object.keys(saved).forEach(t => { SCHEMA[t] = saved[t]; });
  assert.equal(res, false, "initCloud reports the schema problem instead of pretending");
  assert.match(w.RBStore.setupError, /tables are not created yet/i);
  assert.match(w.RBStore.setupError, /migrations\.sql|SQL Editor/i);
  dom.window.close();
});

test("setup guide shows the real project ref and redirect URI when configured", async () => {
  const { dom, w, doc } = await bootCloud(GOLD, seedRows());
  w.openSetupModal();
  const text = doc.getElementById("setupBody").textContent;
  assert.match(text, /abcdefghijkl/, "project ref parsed from the configured URL");
  assert.match(text, /https:\/\/abcdefghijkl\.supabase\.co\/auth\/v1\/callback/, "exact Google redirect URI");
  assert.match(text, /https:\/\/rb\.test/, "this page URL for the redirect allow-list");
  assert.match(doc.getElementById("setupStatus").textContent, /configured/i);
  dom.window.close();
});

test("cloud mode: anon key / bad URL produces a config hint", async () => {
  const { dom, w } = await bootCloud(GOLD, seedRows());
  // simulate an API-key error from a write
  const origFrom = w.RBAuth.getClient().from;
  w.RBAuth.getClient().from = () => ({
    insert: () => Promise.resolve({ error: { message: "Invalid API key", code: "invalid_api_key" } })
  });
  await assert.rejects(() => w.RBStore.createRegister("X", "General Register"), /publishable key|publishable \(anon\)|config\.js/i);
  w.RBAuth.getClient().from = origFrom;
  dom.window.close();
});
