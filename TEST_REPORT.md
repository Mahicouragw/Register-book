# Test report — RegisterBook Community

Date: 2026-10-22 · Branch: `arena/045abc76-register-book`

## Automated DOM tests (`npm test`)

The test suite boots the real `index.html` with the real `config.js`, `auth.js`,
`store.js` and `app.js` in a DOM (jsdom 30.1.3) and drives the app by clicking
real elements / calling the same handlers the buttons call.

| # | Test | Result |
|---|---|---|
| 1 | Login gate: Google button present, 6 demo people, friendly “not connected yet” message when Supabase config is empty (no crash) | ✅ PASS |
| 2 | Demo login as Goldfish → create “Test Checklist” → today's weekday auto-filled → 10 lines per page → 11th line moves to **Page 2** with toast → Previous / Go-to-page work | ✅ PASS |
| 3 | Smart search inside a register: month name, misspelling (`octobr` style), suggestion “October 1 — Page 1 • 2 lines”, click jumps to page + highlights the day, `page 2` search, `1 Oct` search, bare month number | ✅ PASS |
| 4 | **Goldfish → Silverfish (core story)**: Goldfish creates + writes lines, shares with Silverfish via name suggestions; Silverfish sees the book in **Shared With Me**, reads it, searches it, sees the view-only banner, has **no add/edit/delete controls**, and is refused at model level (`addLine`, `deleteEntry`, `toggleDone` all blocked). Goldfish can edit again after switching back. | ✅ PASS |
| 5 | Groups: create “Test Ward”, add Silverfish, group chat message, share a register to the whole group (creates a share row per member with the group id); Silverfish sees the group, the message and the shared book | ✅ PASS |
| 6 | People & friends: Mahi sends request → Rahul accepts → both are friends; private chat message delivered and readable by the other demo user; Call screen opens and is clearly labelled **demo** (no audio) | ✅ PASS |
| 7 | Bill Book: qty + ₹ amount saved, **Page total** and **Book total** correct (₹150 → ₹200) | ✅ PASS |
| 8 | Demo persistence: register survives switching users and reloading from localStorage; private until shared | ✅ PASS |

```
# tests 8   # pass 8   # fail 0
```

## Static / runtime checks

| Check | Result |
|---|---|
| `node --check` on `app.js`, `store.js`, `auth.js`, `config.js` | ✅ OK |
| CSS braces balanced (253/253) | ✅ OK |
| Every inline `onclick/oninput/onchange` handler in every view, for all 6 demo users, resolves to a real global function | ✅ 0 missing |
| Rendered HTML contains no `undefined`, `NaN` or `[object Object]` for any user/view | ✅ 0 found |
| Server returns HTTP 200 for `/`, `index.html`, `styles.css`, `app.js`, `auth.js`, `config.js`, `store.js`, `vendor/supabase.js` | ✅ 200 |
| Real script loading order over HTTP, including vendored Supabase JS v2.57.4 (`window.supabase.createClient` is a function) | ✅ OK |
| Gate visible + demo opens when served over HTTP | ✅ OK |
| Goldfish demo home shows 2 registers / 1 group; medicine book = 3 pages, 25 lines | ✅ OK |

## Not yet testable (blocked on the Supabase project)

These need the **new RegisterBook** Supabase project, which is not visible in the
connected account (`numbersareplaying-1136's projects`) yet:

- Google OAuth end-to-end (provider not enabled until the owner pastes Client ID/Secret).
- Cloud data load/save on two different devices.
- **Database-level** view-only test: signed in as Silverfish, a direct
  `insert into rb_entries` / `update` / `delete` must be rejected by RLS.
- Auth URL configuration (Site URL + redirect allow-list).
- GitHub Pages verification after merge.

They will be added to this report once the project is connected.
