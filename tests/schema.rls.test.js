// Runs the REAL supabase/migrations.sql against embedded PostgreSQL (PGlite)
// and simulates signed-in users, to prove Row Level Security enforces
// "only the creator can edit; shared people can only read".
//
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const SQL = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations.sql"), "utf8");

const GOLDFISH = "11111111-1111-4111-8111-111111111111";
const SILVERFISH = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";

async function makeDb() {
  const db = new PGlite();

  // ---- stand-ins for what Supabase provides out of the box ----
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
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
    end $$;

    grant usage on schema public to anon, authenticated;
    grant usage on schema auth to authenticated;
  `);

  // pgcrypto already provides gen_random_uuid() on Supabase; PG13+ has it built in.
  const sql = SQL.replace(/create extension if not exists pgcrypto;/i, "-- (pgcrypto skipped: not needed in this embedded test)");
  await db.exec(sql);
  return db;
}

// act as a signed-in user
async function as(db, userId) {
  await db.exec(`reset role;`);
  if (userId) {
    await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false); set role authenticated;`);
  } else {
    await db.exec(`select set_config('request.jwt.claim.sub', '', false);`);
  }
}
async function superuser(db) {
  await db.exec(`reset role;`);
}

test("migration creates all 15 rb_ tables with Row Level Security enabled", async () => {
  const db = await makeDb();
  const { rows } = await db.query(`
    select tablename, rowsecurity from pg_tables
    where schemaname = 'public' and tablename like 'rb\\_%'
    order by tablename`);
  assert.equal(rows.length, 15, "15 tables");
  for (const r of rows) assert.equal(r.rowsecurity, true, `${r.tablename} has RLS on`);
  await db.close();
});

test("profiles are created automatically from Google metadata", async () => {
  const db = await makeDb();
  await superuser(db);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${GOLDFISH}', 'goldfish@example.com', '{"full_name":"Goldfish Kar","picture":"https://x/y.png"}'),
      ('${SILVERFISH}', 'silver@example.com', '{"name":"Silverfish"}'),
      ('${PRIYA}', 'priya@example.com', '{}');
  `);
  const { rows } = await db.query(`select id, name, email, avatar_url from public.rb_profiles order by email`);
  assert.equal(rows.length, 3);
  const gold = rows.find(r => r.id === GOLDFISH);
  assert.equal(gold.name, "Goldfish Kar");
  assert.equal(gold.avatar_url, "https://x/y.png");
  assert.equal(rows.find(r => r.id === SILVERFISH).name, "Silverfish");
  assert.equal(rows.find(r => r.id === PRIYA).name, "priya", "falls back to the email name");
  await db.close();
});

test("ONLY the creator can write; shared people can read but never edit (the core story)", async () => {
  const db = await makeDb();
  await superuser(db);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${GOLDFISH}', 'goldfish@example.com', '{"full_name":"Goldfish"}'),
      ('${SILVERFISH}', 'silver@example.com', '{"full_name":"Silverfish"}'),
      ('${PRIYA}', 'priya@example.com', '{"full_name":"Priya"}');
  `);

  // --- Goldfish writes a book ---
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_registers (id, owner_id, name, type) values ('reg1', '${GOLDFISH}', 'Medicine Checklist', 'Medical Checklist')`);
  await db.query(`insert into public.rb_entries (id, register_id, entry_date, text, seq) values
      ('e1','reg1','2026-10-01','Paracetamol 500mg',1),
      ('e2','reg1','2026-10-01','Insulin vials',2)`);
  let r = await db.query(`select count(*)::int as n from public.rb_entries`);
  assert.equal(r.rows[0].n, 2, "owner sees own lines");

  // --- Silverfish cannot even see it before it is shared ---
  await as(db, SILVERFISH);
  r = await db.query(`select count(*)::int as n from public.rb_registers`);
  assert.equal(r.rows[0].n, 0, "not visible before sharing");
  r = await db.query(`select count(*)::int as n from public.rb_entries`);
  assert.equal(r.rows[0].n, 0);

  // --- Goldfish shares (view only) ---
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_shares (id, register_id, shared_with_user_id, shared_with_email, permission, shared_by)
                  values ('s1','reg1','${SILVERFISH}','silver@example.com','view','${GOLDFISH}')`);

  // --- Silverfish can read everything, but every write is refused ---
  await as(db, SILVERFISH);
  r = await db.query(`select name from public.rb_registers`);
  assert.equal(r.rows.length, 1, "shared register is visible");
  assert.equal(r.rows[0].name, "Medicine Checklist");
  r = await db.query(`select id from public.rb_entries order by seq`);
  assert.equal(r.rows.length, 2, "shared lines are visible");
  r = await db.query(`select permission from public.rb_shares`);
  assert.equal(r.rows.length, 1, "share row visible to the recipient");
  assert.equal(r.rows[0].permission, "view");

  await assert.rejects(
    () => db.query(`insert into public.rb_entries (id, register_id, text, seq) values ('e3','reg1','Hacked',3)`),
    /row-level security/i, "viewer INSERT is blocked by RLS"
  );
  r = await db.query(`update public.rb_entries set text = 'changed' where id = 'e1'`);
  assert.equal(r.affectedRows, 0, "viewer UPDATE touches 0 rows");
  r = await db.query(`delete from public.rb_entries where id = 'e1'`);
  assert.equal(r.affectedRows, 0, "viewer DELETE touches 0 rows");
  await assert.rejects(
    () => db.query(`insert into public.rb_registers (id, owner_id, name, type) values ('reg2','${GOLDFISH}','mine','General Register')`),
    /row-level security/i, "cannot create a register owned by someone else"
  );
  // ...but a viewer may still create their own book (they own that one)
  await db.query(`insert into public.rb_registers (id, owner_id, name, type) values ('reg3','${SILVERFISH}','Silver notes','General Register')`);
  r = await db.query(`select count(*)::int as n from public.rb_registers`);
  assert.equal(r.rows[0].n, 2, "own book is visible next to the shared one");
  await db.query(`delete from public.rb_registers where id = 'reg3'`);
  r = await db.query(`update public.rb_registers set name = 'stolen' where id = 'reg1'`);
  assert.equal(r.affectedRows, 0, "viewer cannot rename someone else's register (0 rows touched)");
  r = await db.query(`select name from public.rb_registers where id = 'reg1'`);
  assert.equal(r.rows[0].name, "Medicine Checklist", "register name unchanged");

  // --- A third person sees nothing at all ---
  await as(db, PRIYA);
  r = await db.query(`select count(*)::int as n from public.rb_registers`);
  assert.equal(r.rows[0].n, 0);
  r = await db.query(`select count(*)::int as n from public.rb_entries`);
  assert.equal(r.rows[0].n, 0);
  r = await db.query(`select count(*)::int as n from public.rb_shares`);
  assert.equal(r.rows[0].n, 0);

  // --- Goldfish can still edit and delete his own lines ---
  await as(db, GOLDFISH);
  r = await db.query(`update public.rb_entries set done = true where id = 'e1'`);
  assert.equal(r.affectedRows, 1, "owner UPDATE works");
  await db.query(`insert into public.rb_entries (id, register_id, text, seq) values ('e4','reg1','Bandages',3)`);
  r = await db.query(`delete from public.rb_entries where id = 'e2'`);
  assert.equal(r.affectedRows, 1, "owner DELETE works");

  await db.close();
});

test("groups: members read and chat, only the creator manages membership, group share grants read access", async () => {
  const db = await makeDb();
  await superuser(db);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${GOLDFISH}', 'goldfish@example.com', '{"full_name":"Goldfish"}'),
      ('${SILVERFISH}', 'silver@example.com', '{"full_name":"Silverfish"}'),
      ('${PRIYA}', 'priya@example.com', '{"full_name":"Priya"}');
  `);

  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_registers (id, owner_id, name, type) values ('reg1','${GOLDFISH}','Ward book','Stock Register')`);
  await db.query(`insert into public.rb_entries (id, register_id, text, seq) values ('e1','reg1','Gloves',1)`);
  await db.query(`insert into public.rb_groups (id, name, created_by) values ('g1','Ward Staff','${GOLDFISH}')`);
  await db.query(`insert into public.rb_group_members (group_id, user_id) values ('g1','${GOLDFISH}'), ('g1','${SILVERFISH}')`);

  // member can read the group + members and post messages
  await as(db, SILVERFISH);
  let r = await db.query(`select name from public.rb_groups`);
  assert.equal(r.rows.length, 1, "member sees the group");
  r = await db.query(`select user_id from public.rb_group_members`);
  assert.equal(r.rows.length, 2, "member sees members (no infinite recursion)");
  await db.query(`insert into public.rb_group_messages (id, group_id, sender_id, text) values ('m1','g1','${SILVERFISH}','Hello ward')`);
  r = await db.query(`select text from public.rb_group_messages`);
  assert.equal(r.rows.length, 1, "member reads messages");

  // a member cannot add other members or rename the group
  await assert.rejects(
    () => db.query(`insert into public.rb_group_members (group_id, user_id) values ('g1','${PRIYA}')`),
    /row-level security/i, "only the creator can add members"
  );
  r = await db.query(`update public.rb_groups set name = 'hijacked' where id = 'g1'`);
  assert.equal(r.affectedRows, 0, "members cannot rename the group");

  // the group share makes the book readable for members only
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_shares (id, register_id, shared_with_user_id, permission, shared_by, group_id)
                  values ('s1','reg1','${SILVERFISH}','view','${GOLDFISH}','g1')`);
  await as(db, SILVERFISH);
  r = await db.query(`select id from public.rb_entries`);
  assert.equal(r.rows.length, 1, "group-shared book readable by member");
  await assert.rejects(
    () => db.query(`insert into public.rb_entries (id, register_id, text, seq) values ('e2','reg1','x',2)`),
    /row-level security/i, "group member still cannot write"
  );

  // an outsider sees no group, no messages, no book
  await as(db, PRIYA);
  r = await db.query(`select count(*)::int as n from public.rb_groups`);
  assert.equal(r.rows[0].n, 0);
  r = await db.query(`select count(*)::int as n from public.rb_group_messages`);
  assert.equal(r.rows[0].n, 0);
  r = await db.query(`select count(*)::int as n from public.rb_registers`);
  assert.equal(r.rows[0].n, 0);
  await assert.rejects(
    () => db.query(`insert into public.rb_group_messages (id, group_id, sender_id, text) values ('m9','g1','${PRIYA}','intruder')`),
    /row-level security/i, "outsider cannot post in the group"
  );

  await db.close();
});

test("friend requests and private messages are limited to the two people involved", async () => {
  const db = await makeDb();
  await superuser(db);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${GOLDFISH}', 'goldfish@example.com', '{"full_name":"Goldfish"}'),
      ('${SILVERFISH}', 'silver@example.com', '{"full_name":"Silverfish"}'),
      ('${PRIYA}', 'priya@example.com', '{"full_name":"Priya"}');
  `);

  // Goldfish asks Silverfish
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_friend_requests (id, from_user, to_user, status) values ('f1','${GOLDFISH}','${SILVERFISH}','pending')`);
  await assert.rejects(
    () => db.query(`insert into public.rb_friend_requests (id, from_user, to_user, status) values ('f2','${SILVERFISH}','${PRIYA}','pending')`),
    /row-level security/i, "cannot send a request on behalf of someone else"
  );
  // sender cannot accept their own request
  let r = await db.query(`update public.rb_friend_requests set status = 'accepted' where id = 'f1'`);
  assert.equal(r.affectedRows, 0, "only the recipient can accept");

  // recipient accepts
  await as(db, SILVERFISH);
  r = await db.query(`select status from public.rb_friend_requests where id = 'f1'`);
  assert.equal(r.rows.length, 1, "recipient sees the request");
  r = await db.query(`update public.rb_friend_requests set status = 'accepted' where id = 'f1'`);
  assert.equal(r.affectedRows, 1, "recipient accepts");

  // third person sees nothing
  await as(db, PRIYA);
  r = await db.query(`select count(*)::int as n from public.rb_friend_requests`);
  assert.equal(r.rows[0].n, 0);

  // direct messages
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_direct_messages (id, sender_id, receiver_id, text) values ('d1','${GOLDFISH}','${SILVERFISH}','hello silver')`);
  await assert.rejects(
    () => db.query(`insert into public.rb_direct_messages (id, sender_id, receiver_id, text) values ('d2','${SILVERFISH}','${PRIYA}','spoof')`),
    /row-level security/i, "cannot send a message as someone else"
  );
  await as(db, SILVERFISH);
  r = await db.query(`select text from public.rb_direct_messages`);
  assert.equal(r.rows.length, 1, "recipient reads the message");
  await as(db, PRIYA);
  r = await db.query(`select count(*)::int as n from public.rb_direct_messages`);
  assert.equal(r.rows[0].n, 0, "outsider cannot read the private chat");

  await db.close();
});

test("signed-out visitors (anon role) get no data at all", async () => {
  const db = await makeDb();
  await superuser(db);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values ('${GOLDFISH}', 'goldfish@example.com', '{"full_name":"Goldfish"}');
  `);
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_registers (id, owner_id, name, type) values ('reg1','${GOLDFISH}','Private','General Register')`);

  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;`);
  await assert.rejects(() => db.query(`select * from public.rb_registers`), /permission denied/i);
  await assert.rejects(() => db.query(`select * from public.rb_entries`), /permission denied/i);
  await assert.rejects(() => db.query(`select * from public.rb_profiles`), /permission denied/i);
  await assert.rejects(
    () => db.query(`insert into public.rb_registers (id, owner_id, name, type) values ('x','${GOLDFISH}','x','x')`),
    /permission denied/i
  );
  await db.close();
});

test("the migration is safe to run twice", async () => {
  const db = await makeDb();
  const sql = SQL.replace(/create extension if not exists pgcrypto;/i, "-- skipped");
  await db.exec(sql); // second run
  await db.exec(sql); // third run
  const { rows } = await db.query(`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename like 'rb\\_%'`);
  assert.ok(rows[0].n >= 20, `policies present after re-running (${rows[0].n})`);
  const t = await db.query(`select count(*)::int as n from pg_tables where schemaname='public' and tablename like 'rb\\_%'`);
  assert.equal(t.rows[0].n, 15);
  await db.close();
});

test("accepting a group invite also grants the registers already shared with that group", async () => {
  const db = await makeDb();
  await superuser(db);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${GOLDFISH}', 'goldfish@example.com', '{"full_name":"Goldfish"}'),
      ('${SILVERFISH}', 'silver@example.com', '{"full_name":"Silverfish"}'),
      ('${PRIYA}', 'priya@example.com', '{"full_name":"Priya"}');
  `);

  // Goldfish owns two books and a group; both books are shared with the group.
  await as(db, GOLDFISH);
  await db.query(`insert into public.rb_registers (id, owner_id, name, type) values
                    ('reg1','${GOLDFISH}','Ward A','Stock Register'),
                    ('reg2','${GOLDFISH}','Ward B','Stock Register')`);
  await db.query(`insert into public.rb_entries (id, register_id, text, seq) values
                    ('e1','reg1','Gloves',1), ('e2','reg2','Masks',1)`);
  await db.query(`insert into public.rb_groups (id, name, created_by) values ('g1','Ward Staff','${GOLDFISH}')`);
  await db.query(`insert into public.rb_group_members (group_id, user_id) values ('g1','${GOLDFISH}'), ('g1','${SILVERFISH}')`);
  await db.query(`insert into public.rb_shares (id, register_id, shared_with_user_id, permission, shared_by, group_id)
                  values ('s1','reg1','${SILVERFISH}','view','${GOLDFISH}','g1'),
                         ('s2','reg2','${SILVERFISH}','view','${GOLDFISH}','g1')`);
  await db.query(`insert into public.rb_group_invites (group_id, code, invited_user_id, created_by)
                  values ('g1','JOINME22','${PRIYA}','${GOLDFISH}')`);

  // Before accepting, Priya is outside and sees nothing.
  await as(db, PRIYA);
  let r = await db.query(`select count(*)::int as n from public.rb_registers`);
  assert.equal(r.rows[0].n, 0, "before accepting, Priya sees no books");

  // Accept the invite.
  r = await db.query(`select public.rb_accept_group_invite('JOINME22') as gid`);
  assert.equal(r.rows[0].gid, "g1", "accepting returns the group id");
  r = await db.query(`select count(*)::int as n from public.rb_group_members
                      where group_id = 'g1' and user_id = '${PRIYA}'`);
  assert.equal(r.rows[0].n, 1, "Priya is now a member of the group");

  // THE REQUIREMENT: the books already shared with that group are now hers to read.
  r = await db.query(`select id from public.rb_registers order by id`);
  assert.deepEqual(r.rows.map(x => x.id), ["reg1", "reg2"], "Priya now sees both group books");
  r = await db.query(`select id from public.rb_entries order by id`);
  assert.deepEqual(r.rows.map(x => x.id), ["e1", "e2"], "and can read both books' lines");

  // ...but "shared" still means view-only.
  await assert.rejects(
    () => db.query(`insert into public.rb_entries (id, register_id, text, seq) values ('e9','reg1','x',9)`),
    /row-level security/i, "a late joiner still cannot write"
  );

  // Accepting twice is refused.
  await assert.rejects(
    () => db.query(`select public.rb_accept_group_invite('JOINME22')`),
    /already accepted/i, "the same invite cannot be accepted twice"
  );

  // No duplicate rows were created for people who were already members.
  await superuser(db);
  r = await db.query(`select count(*)::int as n from public.rb_shares
                      where register_id = 'reg1' and shared_with_user_id = '${SILVERFISH}'`);
  assert.equal(r.rows[0].n, 1, "existing members did not get duplicate shares");
  r = await db.query(`select count(*)::int as n from public.rb_shares
                      where register_id = 'reg1' and shared_with_user_id = '${PRIYA}'`);
  assert.equal(r.rows[0].n, 1, "the new member got exactly one share row per book");

  await db.close();
});
