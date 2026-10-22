# MASTER_PROMPT — RegisterBook Community

> This file stores the original build brief for this app, so any future session
> can continue from the same rules. The owner can edit it at any time.

You are building my app "RegisterBook Community" in THIS repository:
https://github.com/Mahicouragw/Register-book

IMPORTANT RULES — READ FIRST:
1. DO NOT use, edit, read, or connect the "Blind-Quiz" repository or its
   Supabase project (zchircgdkyjnowqcdwvf) for this app. Blind-Quiz is a
   completely separate project and is ONLY for a quiz game.
2. Work ONLY inside the Register-book repository connected to this session,
   on this session's Arena branch. Do NOT create or switch to any other branch.
3. KEEP THE PULL REQUEST OPEN: Do all work — app changes, Supabase connection,
   testing, fixes — as many commits as needed on this one branch. Tell me to
   merge ONLY ONCE at the very end when everything is tested and done.
   Do not ask me to merge in between.
4. Supabase: I have created a NEW Supabase project only for RegisterBook.
   First call list_projects and find it (name "RegisterBook" or similar —
   NOT "Blind quiz"). If you cannot see it, STOP the backend work and ask me
   for the project's exact NAME and project REF (the code in the Supabase
   dashboard URL) — the name and ref are not secrets and I can share them.
   It may have been created under a different Supabase account/organisation
   than the one connected to Arena; if so, tell me which connected account
   you CAN see so I know where to recreate or reconnect it.
   Never reuse the Blind-Quiz Supabase project.
5. Never ask me for passwords, OTPs, Google/Supabase secrets, tokens, or
   Client Secrets in chat. If a Google OAuth Client Secret is needed, give
   me the exact click-by-click steps and I will paste it ONLY into the
   Supabase Dashboard myself.
6. Only use the publishable (anon/public) Supabase key in browser code
   (config.js). Never put a service_role / secret key in code, Git, or chat.
   No GitHub Environment Secret is needed for you or for this static site —
   do not ask me to create one for you.
7. Explain in simple English, step by step, with clickable links. I am the
   owner; I test on my phone. Show me a LIVE PREVIEW when the site runs
   (bind server to 0.0.0.0).

WHAT ALREADY EXISTS IN THIS REPO (continue from it, do not start over):
- index.html, styles.css, app.js, auth.js, config.js, vendor/supabase.js
  (Supabase JS v2.57.4 vendored locally, keep it, no CDN), README.md,
  supabase/migrations.sql
- The app was built in a previous session and its PR was merged to main.
  List the files first and read README.md before changing anything.
- If MASTER_PROMPT.md does not exist in the repo, create it by saving this
  entire prompt as MASTER_PROMPT.md (on this session's branch).
- Current state: config.js still has REPLACE placeholders for the new
  RegisterBook Supabase URL/key, so Google login shows a friendly
  "not connected yet" message and demo mode works. Your job is to wire
  the NEW RegisterBook Supabase project in.

MY IDEA (the product — build exactly this):
Staff have to buy many expensive paper register books from the store — a
separate book for a medical checklist, a separate bill book, and so on.
This app replaces all of them with shared digital register books in a
staff community, so one phone holds unlimited register books.

FEATURES (must all work, tested — not just designs):
1. REAL GOOGLE LOGIN: "Continue with Google" using Supabase Auth (Google
   provider). After login show my Google name, email, and photo, with
   Sign out. Keep a "Try the demo" option for people without an account.
2. CREATE REGISTER: name + type (Medical Checklist, Bill Book, Attendance
   Register, Stock Register, General Register). Today's date, month, year,
   and weekday are selected AUTOMATICALLY (e.g. Thursday, October 23,
   2026) — I just start typing. Bill Book supports qty + amount (₹) with
   a page total.
3. UNLIMITED PAGES LIKE A REAL BOOK: one page holds 10 lines. When a page
   fills, the next line automatically shifts to a new page (Page 1, 2, 3,
   unlimited) and tells the user. Previous/Next page buttons + go-to-page
   by number.
4. SMART SEARCH INSIDE A REGISTER: search by page number, date, or month.
   Accept "October", "oct", "10", "23 Oct", AND misspellings like "octobr"
   (fuzzy matching). Show SUGGESTIONS like "October 1 — Page 1 • 2 lines";
   clicking a suggestion jumps straight to that page with that day
   highlighted. The owner can then edit there.
5. SHARING — VIEW ONLY (core story): Example — Goldfish writes 20–30 pages
   of a medicine checklist and shares it with Silverfish. Silverfish can
   open it, read every page, and search it, but CANNOT add/edit/delete
   anything because Goldfish created it. Only the creator can change a
   register. Enforce this in the database with Row Level Security, not
   only by hiding buttons.
   Sharing ways: (a) search a person's name -> suggestions appear -> click
   -> select my register -> share; (b) share to a whole group; (c) share
   from inside a private chat.
6. COMMUNITY HOME: registers shared in the community, counts of my
   registers / shared with me / my groups.
7. GROUPS: create a group, add staff members, group messages
   (send/receive), share registers to the whole group at once.
8. PRIVATE CHAT: 1-to-1 messages, plus a Call button. If real calling
   (WebRTC) is not ready, keep the call screen clearly labelled as demo
   and list real calling as a next step — never fake it silently.
9. PEOPLE & FRIENDS: search people (name suggestions as I type), send a
   friend request, the other person accepts/declines, then they can
   share registers.
Demo people: Mahi, Goldfish, Silverfish, Priya, Rahul, Anjali
(demo-user switcher in sidebar; demo mode saved in browser localStorage).

BACKEND TASKS (do these with the connected Supabase tools):
1. Find my NEW RegisterBook Supabase project with list_projects
   (NOT "Blind quiz", ref zchircgdkyjnowqcdwvf). If missing, ask me for
   the exact project name + ref (safe to share) as explained in rule 4.
2. Create/verify database tables with prefix rb_ and Row Level Security
   ON (SQL already in supabase/migrations.sql — run/apply it via the
   Supabase tools where possible):
   rb_profiles (id = auth user id, name, email, avatar_url)
   rb_registers (id, owner_id, name, type, created_at)
   rb_entries (id, register_id, entry_date, text, note, qty, amount,
   done, seq)
   rb_shares (register_id, shared_with_user_id, shared_with_email,
   permission 'view' only, shared_by)
   rb_groups (id, name, created_by), rb_group_members (group_id, user_id)
   rb_group_messages (group_id, sender_id, text, created_at)
   rb_friend_requests (from_user, to_user, status pending/accepted/declined)
   rb_direct_messages (sender_id, receiver_id, text, created_at)
   Policies: owners can edit their registers/entries; people in rb_shares
   (and group members for group shares) can SELECT but NOT
   insert/update/delete.
3. Update config.js with the NEW project's URL + publishable (anon) key
   only. Move the app from localStorage to these tables: after Google
   login, my registers, shared with me, groups, chats, and friends load
   from Supabase and work on any phone/device. Keep the localStorage demo
   mode working offline when I choose "Try the demo".
4. Supabase Auth configuration: enable signup, set Site URL to
   https://mahicouragw.github.io/Register-book/ and the redirect
   allow-list to that URL (/**) plus the Arena preview/localhost URL I
   test on (use the Supabase tools where possible; otherwise give me
   exact clicks).
5. Give ME these manual steps in simple words with clickable links
   (I do them; you never touch the secret):
   (a) Google Cloud Console -> create a Web OAuth client with redirect
       URI https://<NEW-PROJECT-REF>.supabase.co/auth/v1/callback and
       JS origins https://mahicouragw.github.io + my test URL;
   (b) Supabase Dashboard -> Authentication -> Providers -> Google ->
       enable -> I paste Client ID/Secret myself.
   Until I finish this, the login button must show a friendly message,
   not crash.

MAKE THE WEBSITE LIVE:
- GitHub Pages: our permanent address is
  https://mahicouragw.github.io/Register-book/
- Commit on your Arena branch and open ONE PR to main. Keep it OPEN while
  I test. Tell me to merge only when everything below passes.
- After merge, give me the exact Settings -> Pages steps
  (Deploy from branch: main, root) if I must click them:
  https://github.com/Mahicouragw/Register-book/settings/pages
- Before saying "live", actually test: server returns HTTP 200, Google
  button visible, login gate works, demo mode opens, and one full test of
  the Goldfish -> Silverfish story (create as one user, share, switch
  account, confirm view-only: search works, edit is blocked).

DELIVERABLES AT THE END:
1. Working RegisterBook app in this repo with real Google login on the
   NEW Supabase project and real shared data (not only localStorage).
2. A step-by-step summary in simple English: what you built, what I must
   click (Google Cloud + Supabase Provider steps, GitHub Pages switch),
   and the live URL.
3. A short test report: what you tested and the results (including the
   view-only sharing test).

Start by: (1) confirming you will NOT use Blind-Quiz or its Supabase
project, (2) listing the files already in this repo, (3) calling
list_projects and telling me which Supabase projects you can see and
whether my new RegisterBook project is among them (if not, ask me for
its exact name + ref), (4) then building step by step with a live
preview, keeping the PR open until I say merge.
