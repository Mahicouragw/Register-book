// Row Level Security for "Create Questions Register Book", proven against the
// REAL supabase/migrations.sql in embedded PostgreSQL (PGlite).
//
// Story: Goldfish (the creator) writes a book and sends it to Silverfish (the
// recipient). Priya is an outsider. Every rule below is checked by actually
// trying the forbidden action as the signed-in role.
//
// A forbidden write either raises an error or changes 0 rows. Both count as
// "blocked". The test fails if the write succeeds.
//
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const SQL = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations.sql"), "utf8");

const GOLD = "11111111-1111-4111-8111-111111111111";
const SILVER = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";
const GHOST = "99999999-9999-4999-8999-999999999999"; // not a registered person

async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key, email text,
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
  `);
  const sql = SQL.replace(/create extension if not exists pgcrypto;/i, "-- (skipped)");
  await db.exec(sql);

  // three real people (auth.users is the parent of rb_profiles)
  for (const [id, name] of [[GOLD, "Goldfish"], [SILVER, "Silverfish"], [PRIYA, "Priya"]]) {
    await db.exec(`insert into auth.users (id, email) values ('${id}', '${name.toLowerCase()}@example.com') on conflict (id) do nothing`);
    await db.exec(`insert into public.rb_profiles (id, name, email) values ('${id}', '${name}', '${name.toLowerCase()}@example.com') on conflict (id) do nothing`);
  }
  return db;
}

// act as a signed-in user (or as the database owner when userId is null)
async function as(db, userId) {
  await db.exec("reset role;");
  if (userId) {
    await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false); set role authenticated;`);
  } else {
    await db.exec("select set_config('request.jwt.claim.sub', '', false);");
  }
}

// Try a statement as the current role. Returns { blocked, rows, error }.
async function attempt(db, sql, params) {
  try {
    const r = await db.query(sql, params || []);
    const changed = typeof r.affectedRows === "number" ? r.affectedRows : (r.rows || []).length;
    return { blocked: changed === 0, rows: r.rows || [], changed, error: null };
  } catch (e) {
    return { blocked: true, rows: [], changed: 0, error: String(e.message || e) };
  }
}

// Build the Goldfish book as the owner: 2 pages, 1 question with A–D + written.
async function seedBook(db) {
  await as(db, GOLD);
  await db.exec(`
    insert into public.rb_qbooks (id, owner_id, title) values ('qb1', '${GOLD}', 'Ward Safety Quiz');
    insert into public.rb_qpages (id, book_id, page_no) values ('qp1', 'qb1', 1), ('qp2', 'qb1', 2);
    insert into public.rb_questions (id, book_id, page_id, q_no, text, has_choices, has_written, written_label)
      values ('qq1', 'qb1', 'qp1', 1, 'Where is the oxygen?', true, true, 'Describe it');
    insert into public.rb_qoptions (id, question_id, label, text) values
      ('qo1', 'qq1', 'A', 'Store room'), ('qo2', 'qq1', 'B', 'Nurse station'),
      ('qo3', 'qq1', 'C', 'Corridor'), ('qo4', 'qq1', 'D', 'Outside');
  `);
  await as(db, null);
}

async function sendToSilver(db) {
  await as(db, GOLD);
  await db.exec(`insert into public.rb_qbook_copies (id, book_id, sender_id, recipient_id, status)
    values ('qc1', 'qb1', '${GOLD}', '${SILVER}', 'sent');`);
  await as(db, null);
}

// ------------------------------------------------------------------ the owner
test("owner: can create the book, its pages, questions and all four options", async () => {
  const db = await makeDb();
  await seedBook(db);
  await as(db, GOLD);
  const r = await db.query("select count(*)::int as n from public.rb_qoptions");
  assert.equal(r.rows[0].n, 4, "the four options were stored");
  await as(db, null);
});

test("owner: can send to a real registered person", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, GOLD);
  const r = await db.query("select status from public.rb_qbook_copies where id = 'qc1'");
  assert.equal(r.rows[0].status, "sent");
  await as(db, null);
});

// -------------------------------------------------------------- sending rules
test("send: cannot send to someone who is not a registered person", async () => {
  const db = await makeDb();
  await seedBook(db);
  await as(db, GOLD);
  const r = await attempt(db, `insert into public.rb_qbook_copies (id, book_id, sender_id, recipient_id, status)
    values ('qcx', 'qb1', '${GOLD}', '${GHOST}', 'sent')`);
  assert.ok(r.blocked, "an unknown recipient is refused");
  await as(db, null);
});

test("send: cannot send to yourself, or start a copy in any status but Sent", async () => {
  const db = await makeDb();
  await seedBook(db);
  await as(db, GOLD);
  const self = await attempt(db, `insert into public.rb_qbook_copies (id, book_id, sender_id, recipient_id, status)
    values ('qcs', 'qb1', '${GOLD}', '${GOLD}', 'sent')`);
  assert.ok(self.blocked, "cannot send to yourself");
  const submitted = await attempt(db, `insert into public.rb_qbook_copies (id, book_id, sender_id, recipient_id, status)
    values ('qcn', 'qb1', '${GOLD}', '${SILVER}', 'submitted')`);
  assert.ok(submitted.blocked, "a copy cannot be born already submitted");
  await as(db, null);
});

test("send: a person who does not own the book cannot send it", async () => {
  const db = await makeDb();
  await seedBook(db);
  await as(db, SILVER);
  const r = await attempt(db, `insert into public.rb_qbook_copies (id, book_id, sender_id, recipient_id, status)
    values ('qcf', 'qb1', '${SILVER}', '${PRIYA}', 'sent')`);
  assert.ok(r.blocked, "only the owner can send a book");
  await as(db, null);
});

// ------------------------------------------------------------------ outsiders
test("outsider: Priya sees no book, page, question, option, copy or answer", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, PRIYA);
  for (const t of ["rb_qbooks", "rb_qpages", "rb_questions", "rb_qoptions", "rb_qbook_copies", "rb_qanswers"]) {
    const r = await db.query(`select count(*)::int as n from public.${t}`);
    assert.equal(r.rows[0].n, 0, `Priya sees 0 rows in ${t}`);
  }
  await as(db, null);
});

test("outsider: Priya cannot write into the book either", async () => {
  const db = await makeDb();
  await seedBook(db);
  await as(db, PRIYA);
  assert.ok((await attempt(db, "update public.rb_qbooks set title = 'hacked' where id = 'qb1'")).blocked);
  assert.ok((await attempt(db, "delete from public.rb_qbooks where id = 'qb1'")).blocked);
  assert.ok((await attempt(db, `insert into public.rb_qpages (id, book_id, page_no) values ('qpx', 'qb1', 9)`)).blocked);
  await as(db, null);
});

// -------------------------------------------------------- recipient, read-only
test("recipient: Silverfish can READ the book, pages, questions and options", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);
  for (const t of ["rb_qbooks", "rb_qpages", "rb_questions", "rb_qoptions"]) {
    const r = await db.query(`select count(*)::int as n from public.${t}`);
    assert.ok(r.rows[0].n > 0, `Silverfish can read ${t}`);
  }
  await as(db, null);
});

test("recipient: Silverfish cannot change, add or delete the original questions or options", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);

  const checks = [
    ["update the book title", "update public.rb_qbooks set title = 'x' where id = 'qb1'"],
    ["delete the book", "delete from public.rb_qbooks where id = 'qb1'"],
    ["rename a question", "update public.rb_questions set text = 'x' where id = 'qq1'"],
    ["delete a question", "delete from public.rb_questions where id = 'qq1'"],
    ["add a question", `insert into public.rb_questions (id, book_id, page_id, q_no, text, has_choices, has_written)
        values ('qqx', 'qb1', 'qp1', 2, 'sneaky', true, false)`],
    ["change option A", "update public.rb_qoptions set text = 'x' where id = 'qo1'"],
    ["delete option B", "delete from public.rb_qoptions where id = 'qo2'"],
    ["add an option", "insert into public.rb_qoptions (id, question_id, label, text) values ('qox', 'qq1', 'A', 'x')"],
    ["add a page", "insert into public.rb_qpages (id, book_id, page_no) values ('qpx', 'qb1', 3)"],
    ["delete a page", "delete from public.rb_qpages where id = 'qp2'"]
  ];
  for (const [what, sql] of checks) {
    const r = await attempt(db, sql);
    assert.ok(r.blocked, `Silverfish cannot ${what}`);
  }

  await as(db, null);
  const q = await db.query("select text from public.rb_questions where id = 'qq1'");
  assert.equal(q.rows[0].text, "Where is the oxygen?", "the original question text is unchanged");
  const o = await db.query("select text from public.rb_qoptions where id = 'qo1'");
  assert.equal(o.rows[0].text, "Store room", "the original option A is unchanged");
});

// -------------------------------------------------------- recipient, answers
test("answers: Silverfish can write answers to her own copy, and nobody else's", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);
  const ok = await attempt(db, `insert into public.rb_qanswers (id, copy_id, question_id, selected_label, written_answer)
    values ('qa1', 'qc1', 'qq1', 'B', 'Next to the nurse station')`);
  assert.equal(ok.changed, 1, "her own answer is saved");

  await as(db, PRIYA);
  const other = await attempt(db, `insert into public.rb_qanswers (id, copy_id, question_id, selected_label)
    values ('qa2', 'qc1', 'qq1', 'A')`);
  assert.ok(other.blocked, "Priya cannot answer Silverfish's copy");
  await as(db, null);
});

test("answers: the sender can read the answers but cannot write them", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);
  await db.query(`insert into public.rb_qanswers (id, copy_id, question_id, selected_label)
    values ('qa1', 'qc1', 'qq1', 'C')`);
  await db.query(`update public.rb_qbook_copies set status = 'in_progress' where id = 'qc1'`);

  await as(db, GOLD);
  const read = await db.query("select count(*)::int as n from public.rb_qanswers");
  assert.equal(read.rows[0].n, 1, "Goldfish can read the answer");
  const write = await attempt(db, "update public.rb_qanswers set selected_label = 'A' where id = 'qa1'");
  assert.ok(write.blocked, "Goldfish cannot change the answer");
  await as(db, null);
});

// ------------------------------------------------------- copy status machine
test("status: Silverfish can walk sent -> received -> in_progress -> submitted", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);
  for (const to of ["received", "in_progress", "submitted"]) {
    const r = await attempt(db, `update public.rb_qbook_copies set status = '${to}' where id = 'qc1'`);
    assert.equal(r.changed, 1, "moved to " + to);
  }
  await as(db, null);
});

test("status: skipping a step is refused (sent -> submitted)", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);
  const r = await attempt(db, "update public.rb_qbook_copies set status = 'submitted' where id = 'qc1'");
  assert.ok(r.error && /not allowed/i.test(r.error), "the trigger refuses the jump: " + r.error);
  await as(db, null);
});

test("status: once submitted, Silverfish cannot write answers any more (no accidental resubmission)", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);
  await db.query("update public.rb_qbook_copies set status = 'received' where id = 'qc1'");
  await db.query("update public.rb_qbook_copies set status = 'in_progress' where id = 'qc1'");
  await db.query("update public.rb_qbook_copies set status = 'submitted' where id = 'qc1'");

  const r = await attempt(db, `insert into public.rb_qanswers (id, copy_id, question_id, selected_label)
    values ('qa9', 'qc1', 'qq1', 'D')`);
  assert.ok(r.blocked, "a submitted copy takes no new answers");
  await as(db, null);
});

test("status: only the creator can ask for a revision; only the recipient can return it", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);
  for (const to of ["received", "in_progress", "submitted"]) {
    await db.query(`update public.rb_qbook_copies set status = '${to}' where id = 'qc1'`);
  }

  // Silverfish may not reopen her own submission
  const selfReopen = await attempt(db, "update public.rb_qbook_copies set status = 'in_progress' where id = 'qc1'");
  assert.ok(selfReopen.error && /creator/i.test(selfReopen.error), "recipient cannot reopen: " + selfReopen.error);

  // Goldfish may not mark it returned on her behalf
  await as(db, GOLD);
  const fakeReturn = await attempt(db, "update public.rb_qbook_copies set status = 'returned_to_creator' where id = 'qc1'");
  assert.ok(fakeReturn.error && /person it was sent to/i.test(fakeReturn.error), "creator cannot return it: " + fakeReturn.error);

  // Goldfish asks for a revision: allowed
  const revise = await attempt(db, "update public.rb_qbook_copies set status = 'in_progress' where id = 'qc1'");
  assert.equal(revise.changed, 1, "the creator can ask for a revision");

  // and Silverfish can answer again, then return it
  await as(db, SILVER);
  await db.query("update public.rb_qbook_copies set status = 'submitted' where id = 'qc1'");
  const back = await attempt(db, "update public.rb_qbook_copies set status = 'returned_to_creator' where id = 'qc1'");
  assert.equal(back.changed, 1, "the recipient returns the completed book");
  await as(db, null);
});

// ------------------------------------------------------- the identity guard
test("guard: a copy can never be re-pointed to another book (the leak this closes)", async () => {
  const db = await makeDb();
  await seedBook(db);
  // a second book of Goldfish's that Silverfish must NOT be able to read
  await as(db, GOLD);
  await db.exec(`insert into public.rb_qbooks (id, owner_id, title) values ('qb2', '${GOLD}', 'Private salary notes')`);
  await sendToSilver(db);

  await as(db, SILVER);
  const r = await attempt(db, "update public.rb_qbook_copies set book_id = 'qb2' where id = 'qc1'");
  assert.ok(r.error && /re-pointed/i.test(r.error), "re-pointing is refused: " + r.error);

  // even after the attempt, Silverfish still cannot see the other book
  const seen = await db.query("select count(*)::int as n from public.rb_qbooks where id = 'qb2'");
  assert.equal(seen.rows[0].n, 0, "Silverfish cannot see the other book");
  const pages = await db.query("select count(*)::int as n from public.rb_qpages where book_id = 'qb2'");
  assert.equal(pages.rows[0].n, 0, "and none of its pages");
  await as(db, null);
});

test("guard: nobody can move a copy to a different person (the sender included)", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, GOLD);
  const r = await attempt(db, `update public.rb_qbook_copies set recipient_id = '${PRIYA}' where id = 'qc1'`);
  assert.ok(r.error && /re-pointed/i.test(r.error), "the recipient cannot be swapped: " + r.error);
  await as(db, null);
});

test("guard: the revision number of a copy cannot be edited", async () => {
  const db = await makeDb();
  await seedBook(db);
  await sendToSilver(db);
  await as(db, SILVER);
  const r = await attempt(db, "update public.rb_qbook_copies set revision = 7 where id = 'qc1'");
  assert.ok(r.error && /re-pointed/i.test(r.error), "revision is fixed: " + r.error);
  await as(db, null);
});

// --------------------------------------------------------------- notifications
test("notifications: the two question-book types are accepted, nonsense types are not", async () => {
  const db = await makeDb();
  await as(db, null);
  await db.exec(`insert into public.rb_notifications (user_id, type, title) values
    ('${SILVER}', 'qbook', 'Goldfish sent you a question book'),
    ('${GOLD}', 'qbook_done', 'Silverfish returned a completed question book')`);
  const bad = await attempt(db, `insert into public.rb_notifications (user_id, type, title)
    values ('${SILVER}', 'hacked', 'x')`);
  assert.ok(bad.error && /check/i.test(bad.error), "an unknown type is refused: " + bad.error);
});
