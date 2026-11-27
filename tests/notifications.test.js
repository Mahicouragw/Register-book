// Tests for the new pieces: notification wording, invite codes, and Row Level
// Security on the six new tables (group invites, push subscriptions,
// notifications, account deletions, calls, call signals).
//
// The database half runs the REAL supabase/migrations.sql in PGlite.
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const NT = require(path.join(__dirname, "..", "notify.js"));
const SQL = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations.sql"), "utf8");

const GOLDFISH = "11111111-1111-4111-8111-111111111111";
const SILVERFISH = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";

// ----------------------------------------------------------------- wording
test("notification wording matches the agreed sentences", () => {
  const msg = NT.wording({ type: "message", sender: "Goldfish", text: "Bring the keys" });
  assert.equal(msg.title, "Goldfish: you have a new message");
  assert.equal(msg.body, "Bring the keys");
  assert.deepEqual(msg.actions.map(a => a.title), ["Open", "Reply later"]);

  const fr = NT.wording({ type: "friend", sender: "Priya" });
  assert.equal(fr.title, "Priya sent you a new friend request");
  assert.deepEqual(fr.actions.map(a => a.title), ["Accept", "Decline"]);

  const inv = NT.wording({ type: "invite", inviter: "Rahul", group: "Ward Staff" });
  assert.equal(inv.title, "You're invited to Ward Staff");
  assert.deepEqual(inv.actions.map(a => a.title), ["Join", "Decline"]);

  const audio = NT.wording({ type: "call", caller: "Anjali", kind: "audio" });
  assert.equal(audio.title, "Anjali is calling (audio)");
  assert.deepEqual(audio.actions.map(a => a.title), ["Answer", "Decline"]);

  const video = NT.wording({ type: "call", caller: "Anjali", kind: "video" });
  assert.equal(video.title, "Anjali is calling (video)");

  // a very long message must be clipped so the banner stays readable
  const long = NT.wording({ type: "message", sender: "Mahi", text: "x".repeat(300) });
  assert.ok(long.body.length <= 61, "long body is clipped");
  assert.match(long.body, /…$/);
});

test("every notification type can be turned into a deep link", () => {
  assert.equal(NT.deepLink({ type: "message", senderId: "u1" }), "#chat=u1");
  assert.equal(NT.deepLink({ type: "friend" }), "#requests=1");
  assert.equal(NT.deepLink({ type: "invite", code: "ABCD2345" }), "#join=ABCD2345");
  assert.equal(NT.deepLink({ type: "call", callId: "c9" }), "#call=c9");
  assert.equal(NT.deepLink({ type: "system" }), "#home=1");
});

test("invite codes are short, unambiguous and unique", () => {
  const code = NT.randomCode(8);
  assert.equal(code.length, 8);
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/, "no O/0, I/1 or L");
  assert.equal(NT.randomCode(8, () => 0), "AAAAAAAA", "deterministic with a fixed rng");

  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(NT.randomCode(8));
  assert.ok(seen.size > 390, `codes are not colliding (${seen.size}/400 unique)`);

  assert.equal(
    NT.joinUrl("https://mahicouragw.github.io/Register-book/", "ABCD2345"),
    "https://mahicouragw.github.io/Register-book/#join=ABCD2345"
  );
  assert.equal(NT.joinUrl("https://x.test/", "AB"), "https://x.test/#join=AB");
});

// ----------------------------------------------------------------- database
async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create or replace function auth.uid()
    returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated;
    grant usage on schema auth to authenticated;
    insert into auth.users (id, email) values
      ('${GOLDFISH}', 'goldfish@example.com'),
      ('${SILVERFISH}', 'silverfish@example.com'),
      ('${PRIYA}', 'priya@example.com');
  `);
  const sql = SQL.replace(/create extension if not exists pgcrypto;/i, "-- skipped");
  await db.exec(sql);
  return db;
}
async function as(db, userId) {
  await db.exec(`reset role;`);
  if (userId) await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false); set role authenticated;`);
  else await db.exec(`select set_config('request.jwt.claim.sub', '', false);`);
}

async function seedGroup(db) {
  await db.exec(`insert into public.rb_groups (id, name, created_by) values ('grp1','Ward Staff','${GOLDFISH}')`);
  await db.exec(`insert into public.rb_group_members (group_id, user_id) values ('grp1','${GOLDFISH}')`);
}

test("group invites: only the creator invites, only the invitee accepts", async () => {
  const db = await makeDb();
  await db.exec(`insert into public.rb_groups (id, name, created_by) values ('grp1','Ward Staff','${GOLDFISH}')`);
  await db.exec(`insert into public.rb_group_members (group_id, user_id) values ('grp1','${GOLDFISH}')`);

  // a stranger cannot invite people into a group they do not own
  await as(db, PRIYA);
  await assert.rejects(
    () => db.query(`insert into public.rb_group_invites (group_id, code, invited_user_id, created_by)
                    values ('grp1','CODE1','${SILVERFISH}','${PRIYA}')`),
    /row-level security/i, "a non-creator cannot create an invite"
  );

  // the creator can
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_group_invites (group_id, code, invited_user_id, created_by)
                  values ('grp1','CODE1','${SILVERFISH}','${GOLDFISH}')`);

  // the invitee sees it, an outsider does not
  await as(db, SILVERFISH);
  let r = await db.query(`select code from public.rb_group_invites`);
  assert.equal(r.rows.length, 1, "invitee sees the invite");
  await as(db, PRIYA);
  r = await db.query(`select count(*)::int as n from public.rb_group_invites`);
  assert.equal(r.rows[0].n, 0, "outsider sees no invites");

  // a stranger cannot accept it
  await as(db, PRIYA);
  await assert.rejects(() => db.query(`select public.rb_accept_group_invite('CODE1')`), /someone else/i);

  // the invitee accepts and really becomes a member
  await as(db, SILVERFISH);
  const gid = await db.query(`select public.rb_accept_group_invite('CODE1') as g`);
  assert.equal(gid.rows[0].g, "grp1");

  r = await db.query(`select count(*)::int as n from public.rb_group_members where group_id='grp1' and user_id='${SILVERFISH}'`);
  assert.equal(r.rows[0].n, 1, "accepting adds a real membership row");

  // accepting twice is refused
  await assert.rejects(() => db.query(`select public.rb_accept_group_invite('CODE1')`), /already accepted/i);

  await db.close();
});

test("an open invite link (no named person) can be claimed once", async () => {
  const db = await makeDb();
  await seedGroup(db);
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_group_invites (group_id, code, created_by)
                  values ('grp1','OPEN1234','${GOLDFISH}')`);

  // nobody is named, so the first person to open the link joins
  await as(db, PRIYA);
  await db.query(`select public.rb_accept_group_invite('OPEN1234')`);
  let r = await db.query(`select count(*)::int as n from public.rb_group_members where group_id='grp1' and user_id='${PRIYA}'`);
  assert.equal(r.rows[0].n, 1);

  // and then it is used up
  await as(db, SILVERFISH);
  await assert.rejects(() => db.query(`select public.rb_accept_group_invite('OPEN1234')`), /someone else|already/i);

  await db.close();
});

test("push subscriptions are private to their owner", async () => {
  const db = await makeDb();
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_push_subscriptions (user_id, endpoint, p256dh, auth)
                  values ('${GOLDFISH}','https://push.example/1','pk1','ak1')`);
  let r = await db.query(`select count(*)::int as n from public.rb_push_subscriptions`);
  assert.equal(r.rows[0].n, 1);

  await as(db, SILVERFISH);
  r = await db.query(`select count(*)::int as n from public.rb_push_subscriptions`);
  assert.equal(r.rows[0].n, 0, "another member of staff sees no subscriptions");
  await assert.rejects(
    () => db.query(`insert into public.rb_push_subscriptions (user_id, endpoint, p256dh, auth)
                    values ('${GOLDFISH}','https://push.example/2','pk','ak')`),
    /row-level security/i, "cannot register a subscription for someone else"
  );

  // owner can delete their own
  await as(db, GOLDFISH);
  await db.query(`delete from public.rb_push_subscriptions where endpoint='https://push.example/1'`);
  r = await db.query(`select count(*)::int as n from public.rb_push_subscriptions`);
  assert.equal(r.rows[0].n, 0);

  await db.close();
});

test("notifications: users can read and mark, but cannot forge one", async () => {
  const db = await makeDb();
  // rows are written by the Edge Function (service_role), simulated as superuser
  await db.query(`insert into public.rb_notifications (user_id, type, title, body)
                  values ('${SILVERFISH}','message','Goldfish: you have a new message','hi')`);

  await as(db, SILVERFISH);
  let r = await db.query(`select title, read from public.rb_notifications`);
  assert.equal(r.rows.length, 1, "recipient reads their notification");
  assert.equal(r.rows[0].read, false);
  await db.query(`update public.rb_notifications set read = true`);
  r = await db.query(`select read from public.rb_notifications`);
  assert.equal(r.rows[0].read, true, "recipient can mark it read");

  // nobody in the browser may insert a notification row at all
  await assert.rejects(
    () => db.query(`insert into public.rb_notifications (user_id, type, title) values ('${GOLDFISH}','friend','fake')`),
    /permission denied|row-level security/i, "inserting a notification from the browser is refused"
  );

  await as(db, GOLDFISH);
  r = await db.query(`select count(*)::int as n from public.rb_notifications`);
  assert.equal(r.rows[0].n, 0, "an outsider sees no notifications");
  await db.close();
});

test("calls and call signals are visible only to the two people in the call", async () => {
  const db = await makeDb();
  await as(db, GOLDFISH);
  const c = await db.query(
    `insert into public.rb_calls (caller_id, callee_id, kind) values ('${GOLDFISH}','${SILVERFISH}','audio') returning id`
  );
  const callId = c.rows[0].id;

  await db.query(`insert into public.rb_call_signals (call_id, from_user, kind, payload)
                  values ('${callId}','${GOLDFISH}','offer','{"sdp":"x"}'::jsonb)`);

  await as(db, SILVERFISH);
  let r = await db.query(`select count(*)::int as n from public.rb_calls`);
  assert.equal(r.rows[0].n, 1, "the callee sees the call");
  r = await db.query(`select count(*)::int as n from public.rb_call_signals`);
  assert.equal(r.rows[0].n, 1, "the callee sees the offer");
  await db.query(`update public.rb_calls set status='accepted', answered_at=now() where id='${callId}'`);
  r = await db.query(`select status from public.rb_calls`);
  assert.equal(r.rows[0].status, "accepted", "the callee can answer");

  await as(db, PRIYA);
  r = await db.query(`select count(*)::int as n from public.rb_calls`);
  assert.equal(r.rows[0].n, 0, "an outsider sees no calls");
  r = await db.query(`select count(*)::int as n from public.rb_call_signals`);
  assert.equal(r.rows[0].n, 0, "an outsider sees no signals");
  await assert.rejects(
    () => db.query(`insert into public.rb_call_signals (call_id, from_user, kind, payload)
                    values ('${callId}','${PRIYA}','ice','{}'::jsonb)`),
    /row-level security/i, "an outsider cannot inject signals"
  );

  // you cannot start a call pretending to be someone else
  await assert.rejects(
    () => db.query(`insert into public.rb_calls (caller_id, callee_id, kind) values ('${GOLDFISH}','${PRIYA}','video')`),
    /row-level security/i
  );
  await db.close();
});

test("delete-account requests are private to the person who filed them", async () => {
  const db = await makeDb();
  await as(db, SILVERFISH);
  await db.query(`insert into public.rb_account_deletions (user_id, email, reason) values ('${SILVERFISH}','s@x.test','done')`);
  let r = await db.query(`select count(*)::int as n from public.rb_account_deletions`);
  assert.equal(r.rows[0].n, 1);

  await assert.rejects(
    () => db.query(`insert into public.rb_account_deletions (user_id, email) values ('${GOLDFISH}','g@x.test')`),
    /row-level security/i, "cannot file a deletion request for someone else"
  );

  await as(db, GOLDFISH);
  r = await db.query(`select count(*)::int as n from public.rb_account_deletions`);
  assert.equal(r.rows[0].n, 0);
  await db.close();
});

test("the six new tables all have RLS on and signed-out visitors get nothing", async () => {
  const db = await makeDb();
  const { rows } = await db.query(`
    select tablename, rowsecurity from pg_tables
    where schemaname='public' and tablename in
      ('rb_group_invites','rb_push_subscriptions','rb_notifications',
       'rb_account_deletions','rb_calls','rb_call_signals')
    order by tablename`);
  assert.equal(rows.length, 6, "six new tables exist");
  for (const r of rows) assert.equal(r.rowsecurity, true, `${r.tablename} has RLS on`);

  await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); set role anon;`);
  for (const t of ["rb_group_invites", "rb_push_subscriptions", "rb_notifications", "rb_calls", "rb_call_signals"]) {
    await assert.rejects(() => db.query(`select * from public.${t}`), /permission denied/i, `${t} is closed to anon`);
  }
  await db.close();
});

test("the deployed rb-notify Edge Function carries the exact same wording as the browser", () => {
  // rb-notify inlines notify.js at build time. If someone edits notify.js and
  // forgets `npm run build:functions`, the push banner would say one thing and
  // the in-app inbox another. This test makes that impossible to miss.
  const built = fs.readFileSync(
    path.join(__dirname, "..", "supabase", "functions", "rb-notify", "index.ts"), "utf8");

  for (const phrase of [
    "you have a new message",
    "sent you a new friend request",
    "You're invited to ",       // eslint-disable-line
    "is calling (",
    "Reply later",
    "Accept", "Decline", "Join", "Answer", "Open",
    "sent you a question book",          // question books
    "returned a completed question book"
  ]) {
    assert.ok(built.includes(phrase),
      `rb-notify must contain the wording "${phrase}" — run: npm run build:functions`);
  }

  // and the deep links too
  for (const frag of ["#chat=", "#requests=1", "#join=", "#call=", "#home=1", "#qbook=", "#qbookdone="]) {
    assert.ok(built.includes(frag), `rb-notify must contain the deep link ${frag}`);
  }

  // Rebuilding must be idempotent, otherwise the shipped file is stale.
  const { execFileSync } = require("child_process");
  const before = fs.readFileSync(
    path.join(__dirname, "..", "supabase", "functions", "rb-notify", "index.ts"), "utf8");
  execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "build-functions.js")]);
  const after = fs.readFileSync(
    path.join(__dirname, "..", "supabase", "functions", "rb-notify", "index.ts"), "utf8");
  assert.equal(after, before, "the built Edge Function was out of date — rebuild and commit it");
});
