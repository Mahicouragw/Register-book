# Test report — RegisterBook Community

Date: 2026-10-22 · Branch: `arena/045abc76-register-book`

## Summary

| Suite | What it proves | Result |
|---|---|---|
| `tests/demo.test.js` (8 tests) | The whole UI works in demo mode, including the Goldfish → Silverfish view-only story | ✅ 8/8 |
| `tests/schema.rls.test.js` (7 tests) | **The real `supabase/migrations.sql` runs on PostgreSQL 18 and RLS blocks every non-owner write** | ✅ 7/7 |
| `tests/cloud-driver.test.js` (4 tests) | The Supabase code path in `store.js` maps rows/columns correctly and surfaces friendly errors | ✅ 4/4 |

```
npm test  →  # tests 19   # pass 19   # fail 0
```

---

## 1. App / demo tests (`tests/demo.test.js`)

Boots the real `index.html` with the real `config.js`, `auth.js`, `store.js`,
`app.js` in a DOM (jsdom 30) and clicks real elements.

| # | Test | Result |
|---|---|---|
| 1 | Login gate: Google button, 6 demo people, friendly “not connected yet” message when Supabase config is empty (no crash) | ✅ |
| 2 | Demo login → create register → today's weekday auto-filled → 10 lines per page → 11th line moves to **Page 2** with toast → Previous / Go-to-page | ✅ |
| 3 | Smart search: month name, misspelling (`octobr`), suggestion “October 1 — Page 1 • 2 lines”, click jumps + highlights, `page 2`, `1 Oct`, bare month number | ✅ |
| 4 | **Goldfish → Silverfish**: share via name suggestions; Silverfish sees it in Shared With Me, reads and searches it, sees the view-only banner, has **no add/edit/delete controls**, and is refused at model level (`addLine`, `deleteEntry`, `toggleDone`). Goldfish can edit again after switching back. | ✅ |
| 5 | Groups: create, add member, group chat, share to whole group (share row per member + group id), member sees book | ✅ |
| 6 | Friends: request → accept → friends both ways; private chat delivered; call screen opens and is clearly labelled **demo** | ✅ |
| 7 | Bill Book: qty + ₹ amount, page total ₹150 → ₹200, book total | ✅ |
| 8 | Demo persistence: register survives user switch + reload from localStorage; private until shared | ✅ |

## 2. Database / RLS tests (`tests/schema.rls.test.js`)

Runs the **actual migration file** against embedded PostgreSQL 18 (PGlite) with
`auth.users`, `auth.uid()`, the `anon` / `authenticated` roles and three
simulated signed-in users (Goldfish, Silverfish, Priya).

| # | Test | Result |
|---|---|---|
| 1 | All **9 `rb_*` tables exist with `rowsecurity = true`** | ✅ |
| 2 | Profiles auto-created from Google metadata by the `auth.users` trigger (name + picture), fallback to email prefix | ✅ |
| 3 | **Core story**: before sharing Silverfish sees nothing; after sharing she reads the register, its lines and the share row — but `INSERT` raises *row-level security*, `UPDATE`/`DELETE` touch 0 rows, renaming is impossible, owner spoofing is refused. A third person sees nothing. Goldfish can still insert/update/delete. | ✅ |
| 4 | Groups: member reads group + members (**no “infinite recursion in policy” error**), posts messages, cannot add members or rename; group-shared book readable by members; outsiders see nothing and cannot post | ✅ |
| 5 | Friend requests: only recipient can accept (sender's update touches 0 rows); cannot send on behalf of someone else; third person sees nothing. DMs readable only by the two people, no sender spoofing. | ✅ |
| 6 | Signed-out (`anon`) role: permission denied on `rb_registers`, `rb_entries`, `rb_profiles`, and on inserts | ✅ |
| 7 | Migration is idempotent — running it 3× keeps 9 tables and all policies | ✅ |

## 3. Cloud code-path tests (`tests/cloud-driver.test.js`)

Uses a mock Supabase client that enforces the same rules and **rejects any
column that does not exist in `supabase/migrations.sql`** (so column-name typos
between JS and SQL fail the test).

| # | Test | Result |
|---|---|---|
| 1 | Owner load: profiles/registers/entries/shares/groups/messages/friends/DMs mapped (`owner_id → ownerId`, `entry_date → date`, `done`, `seq`, …) | ✅ |
| 2 | Shared user: reads everything, `canEdit` false, `INSERT` rejected with a friendly RLS message, `UPDATE`/`DELETE`/`share` leave server data unchanged | ✅ |
| 3 | Missing tables → friendly “run `supabase/migrations.sql` in the SQL Editor” message, no crash | ✅ |
| 4 | Invalid publishable key → friendly “check config.js” message | ✅ |

## 4. Static / runtime checks

| Check | Result |
|---|---|
| `node --check` on `app.js`, `store.js`, `auth.js`, `config.js` | ✅ |
| CSS braces balanced (253/253) | ✅ |
| Every inline `onclick/oninput/onchange` handler in every view, for all 6 demo users, resolves to a real function | ✅ 0 missing |
| Rendered HTML has no `undefined`, `NaN`, `[object Object]` for any user/view | ✅ |
| HTTP 200 for `/`, `index.html`, `styles.css`, `app.js`, `auth.js`, `config.js`, `store.js`, `vendor/supabase.js` | ✅ |
| Real script load over HTTP incl. vendored Supabase JS v2.57.4 (`createClient` is a function) | ✅ |
| Gate visible + demo opens when served over HTTP | ✅ |

## 5. Blocked on the Supabase project

The connected Supabase account is a **Vercel-managed organisation**
(`vercel_icfg_SJB9o5VUc5rmLgQ8u3PEJNHY`) containing only
`supabase-sky-umbrella` (INACTIVE) and `Blind quiz` (never touched):

- ❌ `create_project` → Supabase: *“organisation member reached the free-project limit”*
- ❌ `restore_project` on `supabase-sky-umbrella` → **403** (token cannot control that project)

So these still need the real project:

- Google OAuth end-to-end (also needs the Google Client ID/Secret the owner pastes).
- Two-device cloud sync.
- RLS check against the live Supabase database (already proven locally on PostgreSQL 18).
- Auth URL configuration, GitHub Pages verification after merge.

They will be added here once the project is connected.
