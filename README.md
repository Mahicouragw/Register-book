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
| **📒 Library** | **My register books** (badge: `OWNER — you can edit`) and **Shared with me** (badge: `VIEW-ONLY — you can read and search, not edit`). Big rows. Opening a book shows the paper pages. Also **❓ Create Questions Register Book** — write questions and A–D options on lined pages, send the book to a colleague, and read their answers when it comes back (see below). |
| **👥 Community** | Search people, friend requests with **Accept / Decline**, groups you are in, **Join a group** with an invite code, group invites waiting for you, and private chats with **📞 Audio** / **🎥 Video** call buttons. |
| **⚙️ Settings** | Your Google photo, name and email, **Sign out**, the notification switch, **Send test notification**, Terms & Conditions, Privacy Policy, and **Delete my account**. |

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
| **H.** Create Questions Register Book — write, send, answer, submit, return | ✅ built, live, and tested end to end (automated) — ⏳ must be tested on two phones |
| **I.** Install prompt + high-priority push for messages, invites and calls | ✅ built — ⏳ delivery when closed must be tested on a phone |
| `supabase/migrations.sql` — 21 tables | ✅ runs clean on PostgreSQL |
| Migration applied to the **live** project | ✅ **done** — 15 tables, all with RLS on |
| RLS proven against the **live** database | ✅ **49 checks pass** (earlier tables) + **question-book RLS: 44 live checks** (one probe re-run after an ordering mistake — see TEST_REPORT.md), inside discarded transactions |
| VAPID secrets set in Supabase | ✅ **done** |
| The three Edge Functions deployed | ✅ **done** — all `ACTIVE`; `rb-notify` is now **version 3** (question-book notifications) |
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
Question books: `rb_part4a_question_books_tables_and_helpers`, `rb_part4b_question_books_policies`,
`rb_part4c_question_books_grants_and_realtime`, and `rb_part4d_question_books_hardening`
(the hardening adds the two new notification types, locks the copy's identity columns,
checks recipients are real people, and locks answers once a book is submitted).
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

## Create Questions Register Book

A question book is a notebook you write once and send to a colleague. They answer it
and send it back. Here is the whole round trip, using the names from the spec:
**Tiger** writes the book and sends it to **Silver**.

1. **Tiger** → Library → **❓ Create Questions Register Book** → type a title → **Create book**.
   The book opens on 20 lined, numbered pages.
2. **Tiger** writes questions. Each question can have options **A, B, C, D**, a **written
   answer** box, or both. **Add question**, **Add page**, **Edit** and **Delete** are all
   there. Tiger's questions are never copied into Silver's copy by reference: every send
   makes its own copy row, so Tiger's book is never overwritten.
3. **Tiger** → **Send to…** → type Silver's name or user ID → **Find person** → **Send book**.
   Silver gets a push notification and a row in **Received books** with the title, Tiger's
   name and the date.
4. **Silver** opens it. Questions and options are read-only for Silver. She taps an option
   or types an answer; every change is saved straight away, so she can close the app and
   come back later. **Save my progress** saves the page she is on.
5. **Silver** → **Submit answers** (asks for confirmation). After that her answers are
   locked. Only Tiger can ask for a revision, which reopens the same copy.
6. **Silver** → **Send completed book back**. The book appears in Tiger's **Completed books**
   with every original question, all four original options, Silver's chosen option, her
   written answer, the respondent's name, the submission date and the status.

**Status words**: Draft · Sent · Received · In progress · Submitted · Returned to creator.

**What is enforced in the database** (not just in the screens) — see migration part 4d and
`tests/question-books.rls.test.js`:
- only the creator can change the questions, options and pages;
- a recipient can only read a book they were sent, and only write their own answers;
- a copy can never be moved to another book, another person, or another revision;
- a copy moves through the statuses in one fixed order, and only the right person can move it;
- answers are refused once a book is submitted, so an accidental double submit cannot change them;
- a recipient must be a real registered person.

**Accessibility**: every button and field has a name for TalkBack and VoiceOver; answer
options are real radio buttons inside a labelled group; reading order is page →
question number → question → options → written answer; nothing needs drag-and-drop.

**Files**: `qbooks.js` (data and rules), `qbooks-ui.js` (screens), `supabase/migrations.sql`
part 4, `supabase/functions/src/rb-notify.ts` (the `qbook` and `qbook_done` notifications).

---

## Install RegisterBook — why it matters for notifications

Push notifications are delivered to the phone's **service worker**, not to a browser
tab. Android only gives a web app that delivery path after it is **installed**. Until
then, messages, invites and calls reach you only while RegisterBook is open. Settings
→ **Install RegisterBook on this phone** shows the install button when the phone offers it,
and written steps otherwise (Android: ⋮ → *Install app*; iPhone: Share → *Add to Home Screen*,
iOS 16.4 or newer).

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

## Auto-update — the app updates itself

When a new version is merged to `main`, GitHub Pages redeploys the website
automatically (1–2 minutes). Phones running the app update themselves:

- The service worker (`sw.js`) installs the new version immediately
  (`skipWaiting`), and `app.js` reloads the open page into the new code the
  moment the new worker takes over — with a short "New version installed —
  refreshing…" toast first. A first-ever install never reloads.
- The app asks the browser to check for a new version every 5 minutes and
  whenever the tab comes back to the front, instead of waiting up to 24 hours.
- Code files (js/css/json) are always fetched network-first, so a phone never
  keeps running last week's app after a deploy. Offline, the cached copy is
  used.

**Rule for every future change:** bump `VERSION` in `sw.js` (e.g.
`rb-2026-11-27a` → `rb-2026-11-27b`). That is what makes phones pick up the
new version. The `tests/auto-update.test.js` suite checks the wiring.

## Android APK

The app ships as an Android APK built with [Capacitor](https://capacitorjs.com/).
The APK contains the full website (offline-capable) inside a native shell.

**How the APK is built (automatic):** the GitHub Actions workflow
`.github/workflows/build-apk.yml` runs on every push to `main`. It copies the
website into `www/` (`node tools/prepare-www.js`), syncs it into the Android
project (`npx cap sync android`), builds a debug APK with Gradle, and uploads
it as a downloadable artifact.

**To download the APK:**

1. Open https://github.com/Mahicouragw/Register-book/actions
2. Click the latest **Build Android APK** run (the newest one on top).
3. Scroll to **Artifacts** → download **RegisterBook-debug-apk**.
4. Unzip it and install `app-debug.apk` on your phone (Android will ask to
   allow installs from your browser once — tap Allow).

**Google sign-in inside the APK (opens Chrome, returns to the app):**

Google refuses OAuth inside the APK's built-in web view, so the APK does it
the way real apps do:

1. You tap **Continue with Google** in the app.
2. Chrome opens (a Custom Tab) and you sign in with your Google account.
3. Supabase sends Chrome to `auth-callback.html` — a small page on the site.
4. That page hands the login **code** to the app through the deep link
   `com.registerbook.community://auth` (declared in `AndroidManifest.xml`).
   The page shows one big **Open RegisterBook** button as a guaranteed way
   back: Chrome refuses an *automatic* jump to a custom scheme, a tap never
   is. So the person is never left staring at a blank page.
5. The app exchanges the code for a session — you land back in RegisterBook
   already signed in, with your name and photo.

Why the extra page (and why PKCE) matters — this was a real bug:

* The login used Supabase's default **implicit** flow, which returns the
  tokens in the URL `#fragment`. A custom-scheme redirect cannot carry a
  fragment, and Chrome Custom Tabs block an automatic redirect to a custom
  scheme at all — the phone sat on "connecting" for ever.
* The app now asks for `flowType: "pkce"` (both on the client and on the
  OAuth call), so Supabase sends `?code=...` instead, and
  `auth-callback.html` passes it across.
* The app also re-checks for a session on `appUrlOpen`, on
  `getLaunchUrl` (cold start), and on resume/visibility, so a return is
  never missed. `watchNativeReturn()` in `app.js` drives the retry.

**Two owner steps are required** — Supabase must allow both addresses:

1. Supabase Dashboard → your **RegisterBook** project → **Authentication → URL Configuration**
2. **Redirect URLs** → Add → `com.registerbook.community://auth` → Save
3. **Redirect URLs** → Add → `https://mahicouragw.github.io/Register-book/auth-callback.html` → Save

(If you ever move the site to another domain, update `SITE_URL` in
`config.js` and add the new `…/auth-callback.html` to the list above.)

Still stuck? Open **Settings → Diagnostics** in the app: it now shows the
login return page and the last login attempt it made.

**Permissions the APK declares** (`android/app/src/main/AndroidManifest.xml`):

| Permission | Why |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | Supabase sync, realtime, calls |
| `RECORD_AUDIO` | Voice/video calls (microphone) |
| `CAMERA` | Video calls |
| `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH`, `BLUETOOTH_CONNECT` | Call audio routing (speaker, headset) |
| `POST_NOTIFICATIONS` | Notification permission (Android 13+ asks at runtime; the app requests it from Settings → Notifications) |
| `VIBRATE` | Notification buzz |
| `WAKE_LOCK` | Keeps the phone awake during calls |

Camera/microphone prompts appear automatically when a call starts (the web
view asks Android). The notification prompt appears when you switch
notifications on in Settings.

**Push notifications — honest status:**

- **Installed website (PWA): real push works today.** Install from Settings
  ("Install RegisterBook on this phone") and notifications arrive even when
  the app is closed — like Messenger. This is the recommended path.
- **APK: the app asks for the notification permission, and the sending code
  is already built and deployed-ready.** Real push inside the APK needs
  Firebase (FCM) — the app's web view has no Web Push. Everything below is
  already done in this repo: the `rb_fcm_tokens` table (live), the FCM
  sender in `rb-notify` (`_shared/fcm.js`, tested), the token registration
  in the app (`push.js`), and the permission prompt. Only the Firebase
  project itself is left — it needs your Google account:

  1. Go to https://console.firebase.google.com/ → **Add project** → name it
     `RegisterBook` → continue (disable Google Analytics — not needed).
  2. On the project home, click the **Android icon** → App nickname
     `RegisterBook` → Android package name `com.registerbook.community` →
     **Register app**.
  3. Download **`google-services.json`** and upload it into this repo at
     `android/app/google-services.json` (GitHub → `android/app` → **Add
     file → Upload files**). It is not a secret — it is app configuration.
     The build already switches the Firebase plugin on automatically when
     this file exists (`android/app/build.gradle`), so nothing else to edit.
  4. Firebase console → **Project Settings → Service accounts** → **Generate
     new private key** → download the JSON → open it, copy the **entire**
     file contents → Supabase Dashboard → your project → **Edge Functions →
     Secrets** → add a secret named `RB_FCM_SERVICE_ACCOUNT` and paste the
     whole JSON as its value. (Only in the dashboard — never in Git/chat.)
  5. Rebuild the APK (the Actions workflow does this on every push to
     `main`) and install it. Open the app, sign in, go to Settings →
     Notifications → **Switch notifications ON** → **Send test notification**.
     Close the app completely and send another message from a second
     account — the notification arrives like Messenger.

  The `rb-notify` function already sends to both Web Push (website) and FCM
  (app) whenever the secret exists; without it, only the website path runs.

**Other honest limits of the APK:**

- The APK is a **debug build** (signed with the standard debug key) — perfect
  for testing on your own phone. For a Play Store release build, sign with
  your own keystore and run `./gradlew assembleRelease` in `android/`.
- The APK contains a copy of the website, so it does not change itself when
  the website changes — a fresh APK is built automatically on every push to
  `main`, so the newest one is always one download away. The website/PWA
  updates itself instantly (see "Auto-update" above).

**Rebuilding the APK by hand (needs Android Studio / SDK):**

```bash
npm ci
node tools/prepare-www.js
npx cap sync android
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```
