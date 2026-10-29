// rb-notify — the ONLY place that writes an rb_notifications row and the only
// place that sends a real web push.
//
// Security model
// --------------
// 1. It never trusts the body. It reads the caller's identity from the JWT that
//    Supabase Auth issued (auth.getUser), so `uid` cannot be spoofed.
// 2. It then checks that the event the caller is announcing really belongs to
//    them: the message must have been sent BY them TO the recipient, the friend
//    request must be theirs, the invite must come from a group they created, and
//    the call must be one they placed.
// 3. Only then does it look up the recipient's push subscriptions and send.
//
// Secrets (set in Supabase → Edge Functions → Secrets, never in Git):
//   RB_VAPID_PUBLIC_KEY    the public half of the VAPID pair (also in config.js)
//   RB_VAPID_PRIVATE_KEY   the private half — server side only
//   RB_VAPID_SUBJECT       optional, defaults to a mailto for this app
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
//
// Deploy: see README.md → "Edge Functions".

import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildPushRequest } from "../_shared/webpush.js";
import "../../../notify.js"; // sets globalThis.RBNotifyText (same wording as the browser)

// deno-lint-ignore no-explicit-any
const NT = (globalThis as unknown as { RBNotifyText: any }).RBNotifyText;

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
function fail(status: number, message: string) {
  return json({ ok: false, error: message }, status);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
      }
    });
  }
  if (req.method !== "POST") return fail(405, "Use POST.");

  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const vapidPublic = Deno.env.get("RB_VAPID_PUBLIC_KEY") || "";
  const vapidPrivate = Deno.env.get("RB_VAPID_PRIVATE_KEY") || "";
  const vapidSubject = Deno.env.get("RB_VAPID_SUBJECT") || "mailto:numbersareplaying@gmail.com";

  if (!url || !serviceKey) return fail(500, "The function is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");

  // ---- 1. who is calling? --------------------------------------------------
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return fail(401, "Sign in first, then try again.");

  const userClient = createClient(url, anonKey || serviceKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const caller = userData && userData.user;
  if (userErr || !caller) return fail(401, "That sign-in has expired. Sign in again and try.");
  const uid = caller.id;

  // ---- 2. what are they announcing? ---------------------------------------
  let ev: Record<string, unknown>;
  try { ev = await req.json(); } catch (_e) { return fail(400, "The request body must be JSON."); }

  const type = String(ev.type || "");
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // filled in from the database, never from the request body
  let recipientId = String(ev.recipientId || "");
  let title = "";
  let body = "";
  let data: Record<string, string> = {};

  if (type === "system") {
    // a test notification to yourself — always allowed
    recipientId = uid;
    title = String(ev.title || "RegisterBook test");
    body = String(ev.text || "If you can read this, push notifications work.");
    data = {};
  } else if (type === "message") {
    const id = String(ev.messageId || "");
    if (!id) return fail(400, "messageId is required.");
    const { data: row, error } = await admin
      .from("rb_direct_messages")
      .select("id, sender_id, receiver_id, text")
      .eq("id", id)
      .maybeSingle();
    if (error) return fail(500, error.message);
    if (!row) return fail(404, "That message does not exist.");
    if (row.sender_id !== uid) return fail(403, "You can only announce a message you sent.");
    recipientId = row.receiver_id;
    title = String(ev.sender || "");
    body = String(row.text || "");
    data = { senderId: uid, messageId: id };
  } else if (type === "friend") {
    const id = String(ev.requestId || "");
    if (!id) return fail(400, "requestId is required.");
    const { data: row, error } = await admin
      .from("rb_friend_requests")
      .select("id, from_user, to_user, status")
      .eq("id", id)
      .maybeSingle();
    if (error) return fail(500, error.message);
    if (!row) return fail(404, "That friend request does not exist.");
    if (row.from_user !== uid) return fail(403, "You can only announce a friend request you sent.");
    if (row.status !== "pending") return fail(409, "That request is no longer pending.");
    recipientId = row.to_user;
    title = String(ev.sender || "");
    body = "";
    data = { senderId: uid, requestId: id };
  } else if (type === "invite") {
    const id = String(ev.inviteId || "");
    if (!id) return fail(400, "inviteId is required.");
    const { data: row, error } = await admin
      .from("rb_group_invites")
      .select("id, group_id, code, created_by, invited_user_id, status")
      .eq("id", id)
      .maybeSingle();
    if (error) return fail(500, error.message);
    if (!row) return fail(404, "That invite does not exist.");
    if (row.created_by !== uid) return fail(403, "You can only announce an invite you created.");
    if (row.status !== "pending") return fail(409, "That invite is no longer pending.");
    if (!row.invited_user_id) {
      // a link with no named person: nobody to push to yet
      return json({ ok: true, delivered: 0, note: "Open invite link — no named recipient to push to." });
    }
    recipientId = row.invited_user_id;
    const { data: grp } = await admin.from("rb_groups").select("name").eq("id", row.group_id).maybeSingle();
    title = "";
    body = "";
    data = { groupId: row.group_id, code: row.code, inviteId: id };
    ev.group = (grp && grp.name) || ev.group || "a group";
    ev.inviter = ev.sender || ev.inviter || "";
    ev.code = row.code;
  } else if (type === "call") {
    const id = String(ev.callId || "");
    if (!id) return fail(400, "callId is required.");
    const { data: row, error } = await admin
      .from("rb_calls")
      .select("id, caller_id, callee_id, kind, status")
      .eq("id", id)
      .maybeSingle();
    if (error) return fail(500, error.message);
    if (!row) return fail(404, "That call does not exist.");
    if (row.caller_id !== uid) return fail(403, "You can only announce a call you placed.");
    recipientId = row.callee_id;
    ev.kind = row.kind;
    title = String(ev.caller || ev.sender || "");
    body = "";
    data = { callId: id, senderId: uid };
  } else if (type === "qbook" || type === "qbook_done") {
    const id = String(ev.copyId || "");
    if (!id) return fail(400, "copyId is required.");
    const { data: row, error } = await admin
      .from("rb_qbook_copies")
      .select("id, book_id, sender_id, recipient_id")
      .eq("id", id)
      .maybeSingle();
    if (error) return fail(500, error.message);
    if (!row) return fail(404, "That question book does not exist.");

    if (type === "qbook") {
      // the creator is telling the recipient a book is waiting for them
      if (row.sender_id !== uid) return fail(403, "You can only announce a book you sent.");
      recipientId = row.recipient_id;
    } else {
      // the recipient is telling the creator they have finished it
      if (row.recipient_id !== uid) return fail(403, "You can only return a book that was sent to you.");
      recipientId = row.sender_id;
    }

    const { data: bk } = await admin.from("rb_qbooks").select("title").eq("id", row.book_id).maybeSingle();
    title = String(ev.sender || "");
    body = (bk && bk.title) || "";
    data = { copyId: id, senderId: uid, bookId: row.book_id };
  } else {
    return fail(400, "Unknown notification type: " + type);
  }

  if (!recipientId) return fail(400, "We could not work out who this is for.");
  if (recipientId === uid && type !== "system") return fail(400, "You cannot notify yourself.");

  // ---- 3. the exact wording (same module the browser uses) -----------------
  const w = NT.wording({
    type,
    sender: title,
    caller: title,
    inviter: ev.inviter,
    group: ev.group,
    kind: ev.kind,
    text: body,
    title: title
  });
  const deepLink = NT.deepLink({
    type,
    senderId: data.senderId,
    code: data.code,
    callId: data.callId,
    copyId: data.copyId
  });

  // ---- 4. write the inbox row --------------------------------------------
  const { data: note, error: noteErr } = await admin
    .from("rb_notifications")
    .insert({
      user_id: recipientId,
      type,
      title: w.title,
      body: w.body,
      data: Object.assign({}, data, { type })
    })
    .select("id")
    .maybeSingle();
  if (noteErr) return fail(500, "Could not save the notification: " + noteErr.message);

  // ---- 5. push to every device they have ----------------------------------
  let delivered = 0;
  let removed = 0;
  let pushError = "";

  if (!vapidPublic || !vapidPrivate) {
    pushError = "RB_VAPID_PUBLIC_KEY / RB_VAPID_PRIVATE_KEY are not set as Supabase secrets yet.";
  } else {
    const { data: subs, error: subErr } = await admin
      .from("rb_push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", recipientId);

    if (subErr) {
      pushError = subErr.message;
    } else if (subs && subs.length) {
      const payload = JSON.stringify({
        type,
        title: w.title,
        body: w.body,
        tag: w.tag,
        renotify: w.renotify,
        requireInteraction: !!w.requireInteraction,
        actions: w.actions,
        deepLink,
        senderId: data.senderId || "",
        groupId: data.groupId || "",
        code: data.code || "",
        callId: data.callId || "",
        requestId: data.requestId || "",
        inviteId: data.inviteId || "",
        copyId: data.copyId || ""
      });

      for (const sub of subs) {
        try {
          const request = await buildPushRequest(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            {
              subject: vapidSubject,
              publicKey: vapidPublic,
              privateKey: vapidPrivate,
              ttl: type === "call" ? 60 : 86400,
              // "high" wakes the phone straight away; "normal" can be batched
              // or delayed by Android's Doze. Messages, friend requests,
              // invites and calls must arrive now, so only the quiet system
              // notices are allowed to be "normal".
              urgency: type === "system" ? "normal" : "high"
            }
          );
          const res = await fetch(request.endpoint, {
            method: "POST",
            headers: request.headers,
            body: request.body
          });
          if (res.ok || res.status === 201) {
            delivered += 1;
          } else if (res.status === 404 || res.status === 410) {
            // the phone unsubscribed — forget this endpoint
            await admin.from("rb_push_subscriptions").delete().eq("id", sub.id);
            removed += 1;
          } else {
            const txt = await res.text().catch(() => "");
            pushError = "Push service replied " + res.status + (txt ? ": " + txt.slice(0, 200) : "");
          }
        } catch (e) {
          pushError = String((e && e.message) || e);
        }
      }
    }
  }

  return json({
    ok: true,
    delivered,
    removed,
    notificationId: note ? note.id : null,
    title: w.title,
    body: w.body,
    deepLink,
    actions: w.actions.map((a: { action: string; title: string }) => a.action),
    pushError: pushError || undefined
  });
});
