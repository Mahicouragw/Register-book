# RegisterBook Community

**One phone holds unlimited register books.** Replace paper books (Medical Checklist, Bill Book, Attendance, Stock, General) with shared digital register books for staff community.

Live: `https://mahicouragw.github.io/Register-book/` (enable GitHub Pages: Settings → Pages → Deploy from branch: `main`, root)

## What it does
- **Create Register** — name + type. Today's date/month/year/weekday auto-filled (e.g. Thursday, October 23, 2026).
- **Unlimited pages like a real book** — 10 lines per page. When full, next line shifts to new page (Page 1,2,3... unlimited) and tells you. Previous/Next + go-to-page.
- **Bill Book** — qty + ₹ amount with page total.
- **Smart search inside a register** — by page number, date, or month. Accepts "October", "oct", "10", "23 Oct", and misspellings like "octobr" (fuzzy). Shows suggestions like "October 1 — Page 1 • 2 lines"; click jumps to page and highlights that day. Owner can edit there.
- **Sharing — view only (core story)** — Goldfish writes 20–30 pages and shares with Silverfish. Silverfish can read every page + search, but **cannot add/edit/delete** because Goldfish is owner. Enforced by Row Level Security in Supabase, not just hiding buttons. Sharing via: search name → suggestions → pick register → share; share to whole group; share from private chat.
- **Community Home** — counts of my registers / shared with me / my groups + recent shared books.
- **Groups** — create group, add staff, group messages, share register to whole group.
- **Private Chat** — 1-to-1 messages + Call button (demo screen clearly labelled; real WebRTC listed as next step).
- **People & Friends** — search people (suggestions as you type), send friend request, accept/decline, then share.

## Login
- **Continue with Google** via Supabase Auth (Google provider). After login shows your Google name, email, photo, Sign out.
- **Try the demo** — works offline with demo users: Mahi, Goldfish, Silverfish, Priya, Rahul, Anjali. Switch account in sidebar to test sharing.

## Demo test (Goldfish → Silverfish)
1. On login gate click **Goldfish** chip (or sidebar switch to Goldfish)
2. Open **Medicine Checklist — Ward A** (25 lines, 3 pages)
3. Click **Share** → type "Silverfish" → pick → Share view-only
4. Switch to **Silverfish** (sidebar dropdown)
5. Go to **Shared With Me** → open the same book → verify: search "October" works, suggestions appear, but Add/Edit/Delete is blocked with banner "View only — Goldfish created this".
6. Switch back to Goldfish → you can edit again.

## Tech
- Frontend: `index.html`, `styles.css`, `app.js`, `auth.js`, `config.js`, `vendor/supabase.js` (v2.57.4 vendored, no CDN)
- Backend: Supabase (new project, **not** Blind-Quiz). Tables with prefix `rb_` and RLS ON (see `supabase/migrations.sql`).
- Storage: localStorage for demo; Supabase for real Google login (syncs my registers, shared, groups, chats, friends).

## Supabase setup (owner does these)
### 1. Create new Supabase project
- https://supabase.com → New project → name **RegisterBook** (not Blind quiz). Copy **Project URL** and **anon public key** (Settings → API).

### 2. Update `config.js`
- Replace `SUPABASE_URL` and `SUPABASE_ANON_KEY` with the new values. Commit & push.

### 3. Run database migration
- Supabase Dashboard → SQL Editor → paste `supabase/migrations.sql` → Run. This creates `rb_*` tables and RLS policies (owners can edit, shared can SELECT only).

### 4. Auth settings
- Supabase Dashboard → Authentication → URL Configuration → Site URL: `https://mahicouragw.github.io/Register-book/` → Redirect allow-list: add `https://mahicouragw.github.io/Register-book/**` plus your Arena preview URL and `http://localhost:8000/**` for testing.
- Authentication → Providers → Google → Enable → paste **Client ID** and **Client Secret** (see next).

### 5. Google Cloud Console (you do, never paste secret in chat)
- https://console.cloud.google.com → Create project → APIs & Services → Credentials → Create OAuth client (Web):
  - Authorized redirect URI: `https://<YOUR_NEW_PROJECT_REF>.supabase.co/auth/v1/callback`
  - Authorized JS origins: `https://mahicouragw.github.io` and your Arena preview URL (shown in Live Preview).
- Copy Client ID/Secret → paste into Supabase Google provider (step 4). Until done, login button shows friendly hint and Demo works.

## GitHub Pages
1. Push to `main`
2. Repo → Settings → Pages → Build and deployment → **Deploy from branch** → branch `main`, folder `/ (root)` → Save
3. Wait 1–2 min → visit `https://mahicouragw.github.io/Register-book/` → Should return HTTP 200, Google button visible, gate works, demo opens.

## Files
- `index.html` — app shell, sidebar, login gate, account card, demo switcher
- `styles.css` — paper look (ruled lines, red margin), chat, call UI
- `app.js` — full working prototype (localStorage + Supabase sync), 10 lines/page, fuzzy search, view-only sharing, groups, private chat, friend requests, demo call screen
- `auth.js` + `config.js` — real Google sign-in via Supabase Auth
- `vendor/supabase.js` — Supabase JS v2.57.4 vendored locally

## Next step for real calling
- WebRTC with Supabase Realtime presence. Current Call button shows demo screen labelled as demo and lists real calling as next step — never faked silently.

