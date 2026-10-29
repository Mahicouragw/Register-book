# RegisterBook Community 📒

**One phone holds unlimited register books.** Staff stop buying paper books for the
medical checklist, bill book, attendance, stock — and use shared digital registers
instead, with **view-only sharing** enforced by the database, **real push
notifications** and **real audio/video calling**.

- Permanent address: **https://mahicouragw.github.io/Register-book/**
- Live preview during development: the Arena preview URL for this session.

---

## The four screens

| Tab | What is on it |
|---|---|
| **🏠 Home** | Today's date, a greeting, **New for you** (unread notifications), a short list of your books, and **one big green button** to create a register. Nothing else. |
| **📒 Library** | **My register books** (badge: `OWNER — you can edit`) and **Shared with me** (badge: `VIEW-ONLY — you can read and search, not edit`). Big rows. Opening a book shows the paper pages. |
| **👥 Community** | Search people, friend requests with **Accept / Decline**, groups you are in, **Join a group** with an invite code, group invites waiting for you, and private chats with **📞 Audio** / **🎥 Video** call buttons. |
| **⚙️ Settings** | Your Google photo, name and email, **Sign out**, the notification switch, **Send test notification**, Terms & Conditions, Privacy Policy, **Delete my account**, and the owner setup guide. |

That is the whole app. Four buttons at the bottom of the phone, nothing hidden in a
sidebar. Everything else in this README is setup detail.

---

## Writing in a register

One big text box and a big **＋ Add line** button. **Today's date is saved
automatically** — there is no date box on screen and no long "Thursday, 23 October
2026 — auto-selected" sentence to confuse anyone.

If a member of staff needs to write up an older day, there is a tiny
**“Use a different date?”** link under the box that reveals a date picker, and a
**Back to today** button to hide it again.

10 lines per page. When a page fills, the next line moves to a new page automatically
and a message tells you. Unlimited pages.

---

## Files

```
index.html                   app shell: login gate, four tabs, modals, call screen
styles.css                   paper look, phone-first layout, 4-tab shell
app.js                       all screens, register pages, smart search, chat, calls
auth.js                      Supabase Auth (Google) + friendly error messages
store.js                     data layer: demo (localStorage) + cloud (Supabase) drivers
config.js                    public Supabase URL + publishable key + VAPID public key
notify.js                    the exact wording of every notification (shared module)
push.js                      Web Push permission handling, subscription, in-app banner
rtc.js                       WebRTC audio/video calling
vendor/supabase.js           Supabase JS v2.57.4, vendored locally (no CDN)
manifest.webmanifest         makes the app installable (needed for push on a phone)
sw.js                        service worker: offline + push + notification buttons
icons/                       PWA icons (192, 512, maskable, apple-touch)
terms.html                   Terms & Conditions
privacy.html                 Privacy Policy
supabase/migrations.sql      all rb_* tables + Row Level Security policies
supabase/functions/
  _shared/webpush.js         Web Push (RFC 8291 + VAPID) in pure WebCrypto, no deps
  src/rb-notify.ts           source of the push Edge Function
  src/rb-delete-account.ts   source of the account-deletion Edge Function
  rb-notify/index.ts         GENERATED single file that gets deployed
  rb-delete-account/index.ts GENERATED single file that gets deployed
tools/build-functions.js     inlines the shared modules  →  npm run build:functions
tools/preview_server.py      static server for / and /Register-book/
tests/                       automated tests
```

---

## Current status

**Connected project:** `RegisterBook` · ref **`tmkpdvljhnlnvbckbnsc`** · Mumbai (`ap-south-1`).

| Piece | Status |
|---|---|
| **A.** Four-tab app, phone-one-hand usable, accessible | ✅ built and live |
| **B.** Writing fix — no date box, date saved automatically | ✅ built and live |
| **C.** Terms, Privacy, Delete my account (real deletion) | ✅ built and live |
| **D.** Group invites by name and by link | ✅ built, live, and **fixed**: joining a group now also grants the registers already shared with it |
| **E.** Push notifications (PWA + VAPID + Edge Function) | ✅ built and **deployed** — ⏳ delivery must be tested on a phone |
| **F.** Real WebRTC audio + video calling | ✅ built; **relay plumbing added** — ⏳ must be tested on two phones |
| **G.** Flutter-ready (table names stable, plan in README) | ✅ documented |
| `supabase/migrations.sql` — 15 tables | ✅ runs clean on PostgreSQL |
| Migration applied to the **live** project | ✅ **done** — 15 tables, all with RLS on |
| RLS proven against the **live** database | ✅ **49 checks pass**, inside discarded transactions |
| VAPID secrets set in Supabase | ✅ **done** |
| The three Edge Functions deployed | ✅ **done** — all `ACTIVE` |
| GitHub Pages | ✅ `status: built`, branch `main`, folder `/` |

### What still needs a human

1. **Test on two phones.** Push delivery and call connection cannot be proven from a
   computer. See `TEST_REPORT.md` for the two-account test script.
2. **Add a TURN server** if calls fail across different networks. The app, the
   `rb-turn-credentials` Edge Function and the secrets are all ready — only the
   server itself is missing. See **Calling — honest limits**.

### What was applied to the live project

Four migrations: `rb_part2a_new_tables_notifications_invites_calls`,
`rb_part2b_group_invite_policies_and_helpers`, `rb_part2c_policies_grants_realtime`,
`rb_part3_accepting_an_invite_grants_group_registers`. They are safe to re-run.
The full script `supabase/migrations.sql` stays the single source of truth and is
safe to run on a fresh project.

---

## Run it locally

```bash
python3 tools/preview_server.py        # serves / and /Register-book/ on 0.0.0.0:8000
# or
python3 -m http.server 8000 --bind 0.0.0.0
```

## Run the automated tests

```bash
npm install      # once — installs jsdom, pglite, web-push (test-only), typescript
npm test
```

66 tests. They cover:

| Suite | What it proves |
|---|---|
| `tests/demo.test.js` (8) | The whole UI works in demo mode, including the Goldfish → Silverfish view-only story |
| `tests/schema.rls.test.js` (7) | The real `migrations.sql` runs on PostgreSQL and RLS blocks every non-owner write |
| `tests/notifications.test.js` (10) | Notification wording, invite codes, and RLS on the six new tables |
| `tests/cloud-driver.test.js` (4) | The Supabase code path maps rows correctly and surfaces friendly errors |
| `tests/auth-config.test.js` (8) | Google sign-in behaviour with the real project config |
| `tests/ui-simple.test.js` (14) | The four tabs, the writing fix, Settings, permission gating, the invite flow, clean rendering |
| `tests/webpush-crypto.test.js` (8) | Our dependency-free Web Push is byte-compatible with the `web-push` reference implementation, **in both directions** |
| `tests/edge-functions.test.js` (5) | The generated Edge Functions are self-contained, valid, and never trust the request body for identity |

---

## Supabase setup (owner does this)

### 1. `config.js` — public values only
Already filled in for the RegisterBook project:

```js
SUPABASE_URL:     "https://tmkpdvljhnlnvbckbnsc.supabase.co",
SUPABASE_ANON_KEY: "sb_publishable_A1EprlCSXwkWPY7Aboww5A_DuTSoJ9x",
VAPID_PUBLIC_KEY: "BOulBV26fO2TPgsIOQw6uHVhM04OAio62acpiSpi69Huin…",
```

The publishable key and the VAPID **public** key are meant to be public.
The VAPID **private** key must never appear here, in Git, or in chat.

### 2. Create the tables and security rules
Supabase → **SQL Editor** → paste all of `supabase/migrations.sql` → **Run**.

The final query should list **15 tables**, every one with `rowsecurity = true`:

```
rb_profiles, rb_registers, rb_entries, rb_shares, rb_groups, rb_group_members,
rb_group_messages, rb_friend_requests, rb_direct_messages,
rb_group_invites, rb_push_subscriptions, rb_notifications,
rb_account_deletions, rb_calls, rb_call_signals
```

### 3. Auth URLs
Supabase → **Authentication → URL Configuration**
- Site URL: `https://mahicouragw.github.io/Register-book/`
- Redirect URLs: add the site, the site with `/**`, and your preview URL.

### 4. Google provider
Authentication → **Providers → Google** → Enable → paste Client ID + Secret.
Google Cloud Console → Credentials → Web OAuth client:
- Authorized JavaScript origin: `https://mahicouragw.github.io` and your preview origin
- Authorized redirect URI: `https://tmkpdvljhnlnvbckbnsc.supabase.co/auth/v1/callback`

### 5. Realtime
Database → **Replication** → make sure these tables are published (the migration adds
them to `supabase_realtime` automatically):

`rb_direct_messages`, `rb_notifications`, `rb_friend_requests`, `rb_group_invites`,
`rb_calls`, `rb_call_signals`, `rb_group_messages`

---

## Edge Functions

Two functions, both in `supabase/functions/`. Deploy the **generated** `index.ts`
inside each folder (the generator inlines the shared modules so each function is one
self-contained file).

### `rb-notify`
Verifies the caller's JWT, then checks that the event really belongs to them
(the message was sent *by* them *to* the recipient, the invite came from a group they
created, the call is one they placed). Only then does it write the
`rb_notifications` row and push to every device the recipient has. Dead endpoints
(HTTP 404/410) are deleted automatically.

### `rb-delete-account`
The only place that can call Supabase's admin `deleteUser` — the browser must never
hold the `service_role` key. It requires `{ "confirm": "DELETE" }`, keeps an audit
row in `rb_account_deletions`, and reports `ok:false` with a reason if it fails.

### `rb-turn-credentials`
Hands a signed-in phone a TURN relay credential that expires after a few hours, so
calls work across different networks. The long-lived relay secret stays in Supabase
secrets. If no relay is configured it answers `configured: false` and the app falls
back to STUN only with an honest message. See **Calling — honest limits** below.

### Secrets
Supabase → **Edge Functions → Secrets** (or Project Settings → Edge Functions):

| Secret name | Value |
|---|---|
| `RB_VAPID_PRIVATE_KEY` | the private half of the VAPID pair — **server side only** |
| `RB_VAPID_PUBLIC_KEY` | the same public key that is in `config.js` (optional, defaults are read from the function) |
| `RB_VAPID_SUBJECT` | optional, e.g. `mailto:you@example.com` |
| `TURN_URLS` | optional — needed for calls across different networks |
| `TURN_AUTH_SECRET` | optional — the relay's shared secret, server side only |
| `TURN_TTL_SECONDS` | optional, defaults to `21600` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform — do not
set them by hand.

### Rebuilding after a change
```bash
npm run build:functions     # regenerates the three index.ts files
```

---

## Notifications — honest limits

| Situation | What happens |
|---|---|
| **Android Chrome, normal tab** | Push works. Better after “Add to Home Screen”. |
| **Android Chrome, installed app** | Push works, with sound and a lock-screen banner. |
| **iPhone Safari, normal tab** | **Apple blocks web push.** The app says so plainly and tells you what to do. |
| **iPhone/iPad after Share → Add to Home Screen** (iOS 16.4+) | Push works from the installed icon. |
| **App open** | No push needed — Supabase Realtime gives an instant banner, a short “ting” and an unread badge. |

---

## Calling — honest limits

Calls use real WebRTC: full-screen Answer / Decline, live timer, mic mute, camera off,
and self-view plus remote video for video calls. It never says **“connected”** until
the connection really is connected.

### Why calls sometimes need a relay (TURN)

The two phones first try to talk **directly** to each other (STUN). That works on the
same Wi-Fi. But mobile carriers and most routers hide each phone behind NAT, and then
the audio and video have to go through a server in the middle — a **TURN relay**.

- **With** a relay: calls connect from anywhere, on Wi-Fi or mobile data.
- **Without** a relay: calls work on the same Wi-Fi, and often fail across different
  networks. When that happens the app says plainly:
  *“Your network needs a relay — TURN is not configured yet.”*

The relay plumbing is already built. What is missing is the server itself.

### Turning the relay on

**1. Get a TURN server.** Either run [coturn](https://github.com/coturn/coturn) on a
small VPS, or buy one from a hosted provider. It needs a public IP and these ports
open: **3478** (UDP + TCP), **5349** (TLS), and **49152–65535** UDP for the media.

A minimal coturn config:

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=PASTE-A-LONG-RANDOM-STRING-HERE
realm=turn.yourdomain.com
total-quota=100
no-multicast-peers
```

**2. Put the secret in Supabase, never in the code.**
Supabase → **Edge Functions → Secrets**:

| Secret | Example |
|---|---|
| `TURN_URLS` | `turn:turn.yourdomain.com:3478,turns:turn.yourdomain.com:5349` |
| `TURN_AUTH_SECRET` | the same long random string as `static-auth-secret` |
| `TURN_TTL_SECONDS` | optional, defaults to `21600` (6 hours) |

**3. That is it.** The `rb-turn-credentials` Edge Function verifies the caller's
sign-in and hands each phone a credential that **expires on its own** after the TTL
(coturn's `static-auth-secret` scheme):

```
username   = "<unix time it expires>:<user id>"
credential = base64( HMAC-SHA1( TURN_AUTH_SECRET, username ) )
```

So the long-lived secret never reaches the browser, and a leaked credential stops
working by itself. If the secrets are not set, the function answers
`{ configured: false }` and the app falls back to STUN only with the honest message.

> **Advanced:** you can bypass the Edge Function by filling `TURN_URLS`,
> `TURN_USERNAME` and `TURN_CREDENTIAL` in `config.js`. Do not do that unless you
> have to — those values would be readable by anyone who opens the page.

---

## Privacy / security notes

- Browser code only contains the **publishable** Supabase key and the VAPID **public** key.
- The `service_role` key and the VAPID **private** key exist only as Supabase secrets,
  read by the Edge Functions.
- All `rb_*` tables have RLS enabled. Signed-out visitors have no grants at all.
- Writes to registers and entries are allowed only when `rb_owns_register(...)` is true;
  shared readers only ever get `SELECT`.
- `rb_notifications` has **no INSERT grant** for `authenticated` — only the Edge
  Function can write a notification, so nobody can forge one.
- Google profile data (name, email, photo) is stored only in `rb_profiles`, used to
  show names in search and sharing.

---

## Flutter (future — planned, not built)

Nothing here needs renaming when a Flutter app arrives:

- **Same tables, same columns.** The `rb_*` names and every column are stable.
- **Same Edge Function boundaries.** `rb-notify` and `rb-delete-account` take plain
  JSON and a Supabase JWT, so a Flutter app calls them exactly the same way.
- **Notifications:** Flutter will register a device token with **FCM** (Android) and
  **APNs** (iOS) and store it in `rb_push_subscriptions` alongside the web endpoints.
  The Edge Function already loops over every row for a user; a small `platform`
  column would let it choose FCM vs Web Push.
- **Calls:** Flutter will use **CallKit** (iOS) and **ConnectionService** (Android) for
  the incoming-call UI, but the signalling stays in `rb_calls` / `rb_call_signals`, so
  a Flutter phone and a web browser can call each other.

---

## GitHub Pages

1. Settings → Pages: https://github.com/Mahicouragw/Register-book/settings/pages
2. **Deploy from a branch** → branch `main` → folder `/ (root)` → Save.
3. After 1–2 minutes: https://mahicouragw.github.io/Register-book/

Current status via the API: `gh api repos/Mahicouragw/Register-book/pages` → `"status": "built"`.
