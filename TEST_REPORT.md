# RegisterBook — test report

Date: 2026-10-23 · branch `arena/beefc0cb-register-book` · PR #3 (open, **not merged**)

---

## 1. Automated tests — 68 / 68 pass

```bash
npm install
npm test
```

```
# tests 68
# pass 68
# fail 0
```

| Suite | Count | What it proves |
|---|---:|---|
| `tests/demo.test.js` | 8 | The whole UI works in demo mode, including the Goldfish → Silverfish view-only story |
| `tests/schema.rls.test.js` | 7 | The **real** `supabase/migrations.sql` runs on PostgreSQL (PGlite) and RLS blocks every non-owner write |
| `tests/notifications.test.js` | 10 | Notification wording, invite codes, and RLS on the six new tables |
| `tests/cloud-driver.test.js` | 4 | The Supabase code path maps rows correctly and surfaces friendly errors |
| `tests/auth-config.test.js` | 8 | Google sign-in behaviour against the real project config |
| `tests/ui-simple.test.js` | 14 | The four tabs, the writing fix, Settings, permission gating, the invite flow |
| `tests/webpush-crypto.test.js` | 8 | Our dependency-free Web Push is byte-compatible with the `web-push` reference implementation, **in both directions** |
| `tests/edge-functions.test.js` | 5 | The generated Edge Functions are self-contained, valid TypeScript, and never trust the request body for identity |

### What the Web Push tests actually prove
`supabase/functions/_shared/webpush.js` implements RFC 8291 (`aes128gcm`) and RFC 8292
(VAPID) using only `WebCrypto`, because Deno Edge Functions cannot install npm packages.
The tests prove it is not a guess:

- The reference library `web-push@3.6.7` **decrypts our ciphertext** with the standard
  `http_ece` decoder.
- **Our code decrypts web-push's ciphertext.**
- Our VAPID JWT verifies under Node's `crypto` with the matching public key, and
  **fails** with a different key.
- A 9 000-byte payload (3 records) round-trips, so the record nonce counters are right.
- An empty payload produces no body at all.
- Bad keys (wrong length, uncompressed point without the `04` prefix) are rejected with
  a clear message.

### What the Edge Function tests prove
- Both generated files are valid TypeScript, contain **no** relative imports, and the
  build is idempotent.
- `rb-notify` reads the caller from `auth.getUser()` — never from the request body.
- For each event type it re-reads the row from the database and rejects an ownership
  mismatch (`sender_id` / `from_user` / `created_by` / `caller_id` ≠ the caller) with 403.
- It refuses to notify yourself.
- It deletes a subscription when the push service answers 404 or 410.
- `rb-delete-account` requires the literal `confirm: "DELETE"` and writes the audit row.

### What the SQL tests prove
`supabase/migrations.sql` is executed **as written** on a real PostgreSQL engine
(PGlite), and then every rule is attacked:

- A shared reader can `SELECT` the register and its lines, but `INSERT` / `UPDATE` /
  `DELETE` affect **0 rows**.
- An outsider sees **nothing** at all.
- The same is proven for the six new tables: `rb_group_invites`, `rb_push_subscriptions`,
  `rb_notifications`, `rb_account_deletions`, `rb_calls`, `rb_call_signals`.
- `rb_notifications` has **no INSERT grant** for `authenticated` — only the Edge Function
  can create a notification.

---

## 2. ✅ What has now been done on the live project

The owner reconnected the Supabase account, so everything below was run against the
**real** RegisterBook project (`tmkpdvljhnlnvbckbnsc`, Mumbai).

### 2a. Migration applied — 3 atomic migrations

| Migration | What it created |
|---|---|
| `rb_part2a_new_tables_notifications_invites_calls` | the 6 new tables + RLS enabled + `rb_is_call_participant()` |
| `rb_part2b_group_invite_policies_and_helpers` | invite policies + `rb_accept_group_invite`, `rb_decline_group_invite`, `rb_invite_preview` |
| `rb_part2c_policies_grants_realtime` | policies, grants, revoked anon access, Realtime publication |

Verified afterwards:

- **15 `rb_*` tables, every one with `rowsecurity = true`.**
- **50 policies**, and `rb_notifications` has **no INSERT policy** — only the Edge Function can write a notification.
- **7 tables published to `supabase_realtime`**: `rb_direct_messages`, `rb_notifications`, `rb_friend_requests`, `rb_group_invites`, `rb_calls`, `rb_call_signals`, `rb_group_messages`.

### 2b. RLS proven on the live database — 33 / 33 PASS

Three temporary users were created **inside one database transaction that was then
discarded**, so nothing was written. A re-count immediately afterwards showed every
table still empty — the proof left no trace.

| # | As | Action | Result |
|---:|---|---|---|
| 1–3 | owner | create a register, write a line, see it | ✅ all work |
| 4–7 | owner | create a group, join it, share the register, create an invite | ✅ all work |
| 8 | owner | save own push subscription | ✅ works |
| 9 | owner | **forge** an `rb_notifications` row | ✅ **BLOCKED (42501)** |
| 10–11 | owner | place a call, send a call signal | ✅ work |
| 12–13 | reader | see the shared register and read its lines | ✅ works |
| 14 | reader | **INSERT** a line | ✅ **BLOCKED (42501)** |
| 15–16 | reader | **UPDATE** / **DELETE** a line | ✅ **0 rows** |
| 17 | reader | **forge** a notification | ✅ **BLOCKED (42501)** |
| 18–19 | reader | see only the invite addressed to them; cannot see the owner's push subscription | ✅ |
| 20–23 | reader | accept the invite (becomes a member: 2 members), second accept refused, answer the call | ✅ |
| 24–32 | outsider | see register / lines / call / invite / push subs / notifications / shares | ✅ **all 0 rows** |
| 26, 28 | outsider | **INSERT** a line, send a call signal | ✅ **BLOCKED (42501)** |
| 33 | link only | preview an invite by code without being signed in to it | ✅ works |

> Note on PostgreSQL semantics: a blocked **INSERT** raises error `42501`, while a
> blocked **UPDATE** or **DELETE** silently affects **0 rows**. Both mean the same
> thing — the write did not happen.

### 2c. VAPID keys and secrets

The private key file was lost with the sandbox scratch directory. Since the database
had **zero** push subscriptions, a fresh key pair was generated and verified:

- the private scalar really is the partner of the public point (ECDH round-trip),
- our module's VAPID JWT verifies under the public key with Node's crypto,
- the JWT carries the right `aud` and `sub`.

The **public** half now sits in `config.js`; the **private** half was written straight
into Supabase secrets and is not stored anywhere in the workspace or in Git.

| Secret | Set |
|---|---|
| `RB_VAPID_PRIVATE_KEY` | ✅ |
| `RB_VAPID_PUBLIC_KEY` | ✅ |
| `RB_VAPID_SUBJECT` | ✅ |

### 2d. Edge Functions deployed

| Function | Status | JWT |
|---|---|---|
| `rb-notify` | **ACTIVE** | verified |
| `rb-delete-account` | **ACTIVE** | verified |

### 2e. Auth configuration (checked, already correct)

- Site URL: `https://mahicouragw.github.io/Register-book/`
- Redirect allow-list extended with this session's preview host.
- Google provider: **enabled**.

---

## 3. What is still NOT verified — please read

| Not verified | Why | What is needed |
|---|---|---|
| **Real push delivery** on a phone | Needs a real device that has subscribed | The owner must test with two accounts on two phones |
| **Real audio/video calls** | Needs two real devices, and a TURN relay on many mobile networks | The owner must test; the app says plainly when a relay is missing |
| **Add to Home Screen** / offline | Needs a real phone | The owner must test |
| **That a notification arrives while the app is closed** | The highest-value test, and only a phone can prove it | Step 6 of the script below |

**Nothing above is claimed to work.** If account deletion cannot reach the Edge
Function, the app says honestly: *“Recorded as a pending deletion request — a manager
will process it.”* It never pretends.

---

## 4. Two-account phone test script

You need **two devices** (or one phone + one computer) and **two Google accounts**.

Sign in as **Account A** on device 1 and **Account B** on device 2.

### Step 0 — Install the app on both phones
- **Android / Chrome:** open the site, menu → **“Add to Home Screen”** (or “Install app”).
- **iPhone / iPad / Safari:** **Share → Add to Home Screen** (iOS 16.4 or newer), then
  **open it from the new icon**. Push does **not** work inside a normal Safari tab —
  Apple blocks it, and the app says so.

### Step 1 — Sign in (both devices)
1. Open the app → **“Sign in with Google”**.
2. Pick the Google account. You land on **Home** with today's date.
3. **Settings** shows your photo, name and email. ✅

### Step 2 — Create and write in a register (device 1, Account A)
1. **Home** → tap the big green **“＋ Create a register book”**.
2. Name: `Ward A medicine` → choose **Medical Checklist** → **Create register**.
3. Type `Paracetamol given to bed 4` → tap **＋ Add line**.
4. ✅ **Expected:** the line appears with **today's date**.
   ✅ **Expected:** there is **no date box** and **no “auto-selected” sentence**.
5. Add 10 more lines (`Line 2` … `Line 11`).
   ✅ **Expected:** after the 10th line you are moved to **page 2** automatically.
6. Tap **“Use a different date?”** → the date picker appears. Pick an older date, add a
   line, then tap **“Back to today”**.

### Step 3 — Share it as view-only (device 1)
1. **Library** → tap the book → **Share** → type the name of **Account B** → select it.
2. ✅ **Expected:** it says “Shared with … — view-only”.

### Step 4 — Read it, and try to edit it (device 2, Account B)
1. **Library** → **Shared with me** → open the book.
2. ✅ **Expected:** the badge says **VIEW-ONLY — you can read and search, not edit**, and
   the writing box is **not** there.
3. Try to search inside it — search should work.
4. ✅ **Expected:** you cannot add, edit or delete any line.

### Step 5 — Switch notifications on (both devices)
1. **Settings** → **Notifications → Allow**. Say **Allow** to the phone's question.
2. ✅ **Expected:** the switch turns green and reads **ON (web push)**.
3. Tap **“Send test notification”**.
   ✅ **Expected:** a banner appears on that same phone within a few seconds.

### Step 6 — Notifications while the app is CLOSED (the WhatsApp test)
1. On device 2, **close the app completely** (swipe it away).
2. On device 1: **Community** → find Account B → send a **message**.
3. ✅ **Expected on device 2:** a lock-screen notification saying
   **“<Name>: you have a new message”** with **Open** and **Reply later**.
4. Tap it.
   ✅ **Expected:** the app opens on that chat.
5. Repeat for a **friend request** (Community → search → Add friend) →
   **“<Name> sent you a new friend request”** with **Accept** / **Decline**.
   ✅ **Expected:** tapping **Accept** from the notification really makes you friends.
6. Repeat for a **group invite** (Community → your group → Invite → by name) →
   **“You're invited to <group>”** with **Join** / **Decline**.

### Step 7 — Real call (both devices, app open)
1. Device 1 → **Community** → Account B → **📞 Audio**.
2. ✅ **Expected on device 2:** a full-screen **Incoming audio call** with
   **Answer** and **Decline**, even if it is in another tab or closed (push).
3. **Answer** on both sides. Say “hello”.
   ✅ **Expected:** you hear each other. The timer counts up.
4. End and repeat with **🎥 Video** → you should see each other, and **Mic** /
   **Camera** buttons should mute and stop the picture.
5. ❗ If it fails, the app says **“Your network needs a relay — TURN is not configured
   yet.”** That is the truth: a TURN server is still needed for many mobile networks.

### Step 8 — Delete my account (only on a throwaway account)
1. **Settings** → **Delete my account**.
2. ✅ **Expected:** it lists exactly what will be deleted, offers
   **“Download my books (JSON)”**, and asks you to type **DELETE**.
3. Type `DELETE` → **“Delete everything permanently”**.
4. ✅ **Expected:** you are signed out and the account is gone.
5. Sign in again with the same Google account → a **fresh, empty** account.

### If something does not work
- Note the **exact screen**, the **exact words** on it, and **Android or iPhone**.
- Check **Settings → Setup guide & connection check** first — it tests the link to
  Supabase and names what is missing.

---

## 5. Honest summary

**Proven by code and tests:** the interface, the writing fix, the Terms and Privacy
screens, the invite flow, the wording of every notification, and the Web Push
encryption itself.

**Proven against the live database:** the migration really ran, all 15 tables have RLS
on, and 33 security checks pass as owner, as shared reader and as an outsider.

**Not proven yet:** that a notification actually arrives on your phone, and that a call
actually connects. The database and the Edge Functions are live now; what is missing is
two real phones — and I will not say they work until you have seen them work.
