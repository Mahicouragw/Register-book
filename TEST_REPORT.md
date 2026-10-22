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

## 5. Live Supabase project tests (real, not mocked)

Project **`RegisterBook`** · ref `tmkpdvljhnlnvbckbnsc` (Mumbai, `ap-south-1`), created for this app.
Blind-Quiz was never touched.

### Structural verification (via the Supabase tools)

| Check | Result |
|---|---|
| `pg_tables` for `rb\_%` | ✅ **9 tables, `rowsecurity = true` on all** |
| `pg_policies` | ✅ **30 policies** (profiles 3, registers 4, entries 4, shares 3, groups 4, group members 3, group messages 3, friend requests 4, direct messages 3) |
| Columns per table vs what the app selects/inserts | ✅ exact match |
| Helper functions exist and are `SECURITY DEFINER` | ✅ `rb_owns_register`, `rb_can_read_register`, `rb_is_group_member`, `rb_is_group_creator` |
| Signup trigger `rb_auth_user_created` on `auth.users` | ✅ present |
| Table grants: `anon` | ✅ **none** (signed-out visitors get nothing) |
| Table grants: `authenticated` | ✅ select/insert/update/delete (RLS decides rows) |
| Auth config | ✅ Site URL `https://mahicouragw.github.io/Register-book/`, allow-list with GitHub Pages + `/**` + localhost, signup enabled |

### Behavioural test on the live database (11 checks, rolled back)

Simulated three Google users inside a transaction (`set local role authenticated` +
`request.jwt.claim.sub`), then rolled back:

| # | Check | Result |
|---|---|---|
| 1 | Signup trigger creates profiles for new users | ✅ 3 of 3 |
| 2 | Goldfish (owner) writes a register + 2 lines | ✅ 2 lines |
| 3 | Goldfish shares view-only with Silverfish | ✅ |
| 4 | Silverfish sees the shared register | ✅ 1 |
| 5 | Silverfish sees its lines | ✅ 2 |
| 6 | **Silverfish UPDATE** | ✅ **0 rows changed** |
| 7 | **Silverfish DELETE** | ✅ **0 rows deleted** |
| 8 | **Silverfish INSERT** | ✅ **BLOCKED by RLS (SQLSTATE 42501)** |
| 9 | Priya (outsider) sees registers | ✅ 0 |
| 10 | Priya sees lines | ✅ 0 |
| 11 | Owner's lines after the attack | ✅ `Paracetamol,Insulin` (unchanged) |
| — | After rollback: users / profiles / registers / entries / shares | ✅ 0 / 0 / 0 / 0 / 0 (project left clean) |

### Auth behaviour with the real project (7 automated tests)

| # | Test | Result |
|---|---|---|
| 1 | `config.js` has the real URL + a `sb_publishable_…` key and **no** JWT/secret literals | ✅ |
| 2 | Gate reports the project as connected | ✅ |
| 3 | Google provider still off → friendly click-by-click message with the exact redirect URI, **no JSON error page, no navigation** | ✅ |
| 4 | Google provider on → OAuth redirect starts with `redirect_to=https://mahicouragw.github.io/Register-book/` | ✅ |
| 5 | Provider probe blocked/offline → sign-in still attempts the redirect | ✅ |
| 6 | Demo mode still works with the real config present | ✅ |
| 7 | No session → gate shown (no fake login) | ✅ |

### Still to do (needs the owner / the merge)

- **Google provider**: owner creates a Web OAuth client in Google Cloud and pastes Client ID +
  Secret into Supabase → Providers → Google. Until then the app explains the steps.
- **Real Google login and two-device sync**: must be clicked by the owner after that step.
- **GitHub Pages**: only after this PR is merged.

> Note: the coding sandbox can only reach github.com / npm / pypi, so the browser-side network
> calls to `*.supabase.co` cannot be exercised from here; the database itself was verified through
> the Supabase API instead.
