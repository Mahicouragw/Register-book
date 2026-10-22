# RegisterBook Community 📒

**One phone holds unlimited register books.** Staff stop buying paper books for the
medical checklist, bill book, attendance, stock — and use shared digital registers
instead, with **view-only sharing** enforced by the database.

- Permanent address: **https://mahicouragw.github.io/Register-book/**
- Live preview during development: the Arena preview URL for this session.

---

## What the app does

| Feature | How it works |
|---|---|
| **Google login** | Supabase Auth (Google provider). Shows your Google name, email and photo + Sign out. If Supabase or the Google provider is not set up yet, the button explains exactly what to click — it never crashes. |
| **Try the demo** | Fully offline demo with six people: Mahi, Goldfish, Silverfish, Priya, Rahul, Anjali. Saved in `localStorage`; the sidebar switcher lets you test sharing as different people. |
| **Create register** | Name + type: Medical Checklist, Bill Book, Attendance Register, Stock Register, General Register. Today's weekday, date, month and year are filled in automatically. |
| **Unlimited pages** | 10 lines per page. When a page fills, the next line moves to a new page automatically and a toast tells you. Previous / Next and “Page # → Go”. |
| **Bill Book** | Qty + ₹ amount per line, **page total** and **book total**. |
| **Smart search inside a register** | Accepts page numbers (`page 2`), months (`October`, `oct`, `10`), dates (`23 Oct`), weekdays, and misspellings (`octobr`). Suggestions look like **“October 1 — Page 1 • 2 lines”**; tapping one jumps to that page and highlights that day. |
| **Sharing — view only** | The creator can share with a person (name search → suggestions), with a whole group, or from a private chat. Recipients can read every page and search, but **cannot add/edit/delete** — enforced by Row Level Security in Postgres, not only hidden buttons. |
| **Community home** | Counts of my registers / shared with me / my groups, recent shared books, and a short explanation of the view-only rule. |
| **Groups** | Create a group, add staff, group chat (send/receive), share a register to everyone at once. |
| **Private chat** | 1-to-1 messages + Call button. The call screen is **clearly labelled as a demo** — real WebRTC calling is listed as the next step, never faked. |
| **People & friends** | Name search with suggestions as you type, send a friend request, the other person accepts/declines, then you can share registers. |

---

## Files

```
index.html              app shell, login gate, sidebar, views, modals
styles.css              paper look + phone-first responsive layout
app.js                  all screens, register pages, smart search, chat, calls
auth.js                 Supabase Auth (Google) + friendly error messages
store.js                data layer: demo (localStorage) + cloud (Supabase) drivers
config.js               public Supabase URL + publishable key (fill these in)
vendor/supabase.js      Supabase JS v2.57.4, vendored locally (no CDN)
supabase/migrations.sql tables rb_* + Row Level Security policies
MASTER_PROMPT.md        the original build brief
tests/                  automated tests: demo UI, cloud driver, SQL + RLS (PGlite)
```

---

## Current status

**Connected to the live project:** `RegisterBook` · ref **`tmkpdvljhnlnvbckbnsc`** · Mumbai (`ap-south-1`).

| Piece | Status |
|---|---|
| `config.js` (Project URL + **publishable** key only) | ✅ done |
| `supabase/migrations.sql` applied (9 `rb_*` tables, RLS on, 30 policies, signup trigger) | ✅ verified in the project |
| Auth Site URL `https://mahicouragw.github.io/Register-book/` + redirect allow-list | ✅ set |
| Signup enabled | ✅ |
| Google provider (Client ID + Secret) | ⏳ **owner step** — the app shows the exact clicks until it is done |
| GitHub Pages | ⏳ after this PR is merged |

Verified on the live database with three simulated users: owner writes, shared user reads but
`INSERT` is rejected (`42501`) and `UPDATE`/`DELETE` change 0 rows, outsiders see nothing
(transaction rolled back, project left empty). See `TEST_REPORT.md`.

---

## Run locally

```bash
python3 -m http.server 8000 --bind 0.0.0.0
# then open http://localhost:8000/  (or the Arena preview URL)
```

## Run the automated tests

```bash
npm install      # once — installs jsdom
npm test
```

The tests boot the real `index.html` in a DOM and check: the login gate, demo
login, register creation with auto date, 10 lines per page + automatic page shift,
fuzzy month search (“octobr”), page search, the **Goldfish → Silverfish view-only
story** (owner can edit, viewer cannot), groups + group chat + group share,
friend requests, private chat, the demo call label, and Bill Book totals.

---

## Supabase setup (owner does this)

### 1. Find or create the new project
- https://supabase.com/dashboard → the project named **RegisterBook**
  (never “Blind quiz”, ref `zchircgdkyjnowqcdwvf`).
- Copy **Project URL** and the **publishable / anon key** from
  Project Settings → API. Both are public and safe to share.

### 2. Put the two public values in `config.js`
```js
SUPABASE_URL: "https://<your-ref>.supabase.co",
SUPABASE_ANON_KEY: "<publishable key>",
```
Never put a `service_role` / secret key in this file or in Git.

### 3. Create the tables and security rules
- Supabase → **SQL Editor** → paste all of `supabase/migrations.sql` → **Run**.
- It creates the `rb_*` tables, enables RLS on all of them, adds the helper
  functions and the profile-on-signup trigger. The final query should list
  **9 tables, all with `rowsecurity = true`**.

### 4. Auth URLs
- Supabase → Authentication → **URL Configuration**
  - Site URL: `https://mahicouragw.github.io/Register-book/`
  - Redirect URLs: add
    - `https://mahicouragw.github.io/Register-book/`
    - `https://mahicouragw.github.io/Register-book/**`
    - your Arena preview URL (from the Live Preview panel)
    - `http://localhost:8000/**` if you test locally
- Authentication → **Providers → Google** → Enable → paste Client ID + Client
  Secret (you paste these yourself; never in chat).

### 5. Google Cloud Console
- https://console.cloud.google.com/apis/credentials → **Create credentials →
  OAuth client ID → Web application**
  - Authorized JavaScript origins:
    `https://mahicouragw.github.io` and your preview URL
  - Authorized redirect URI:
    `https://<your-project-ref>.supabase.co/auth/v1/callback`
- Copy the Client ID and Secret into the Supabase Google provider page.

Until step 4/5 is finished, “Continue with Google” shows a friendly,
step-by-step message and the demo keeps working.

---

## GitHub Pages

1. Settings → Pages: https://github.com/Mahicouragw/Register-book/settings/pages
2. **Deploy from a branch** → branch `main` → folder `/ (root)` → Save.
3. After 1–2 minutes: https://mahicouragw.github.io/Register-book/

---

## Privacy / security notes

- Browser code only contains the **publishable** Supabase key.
- All `rb_*` tables have RLS enabled. Signed-out visitors have no grants at all.
- Writes to registers and entries are allowed only when
  `rb_owns_register(...)` is true; shared readers only ever get `SELECT`.
- Google profile data (name, email, photo) is stored only in `rb_profiles`, used
  to show names in search and sharing.

## Next step for real calling

Group and private chat work today. The Call button opens a screen that says
**“Demo call screen — real audio/video calling (WebRTC) is not connected yet.”**
Real calling needs WebRTC plus Supabase Realtime signalling — that is the next
feature, and it is intentionally not faked.
