// GENERATED FILE — do not edit by hand.
// Source: supabase/functions/src/rb-notify.ts
// Rebuild with:  npm run build:functions

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
// ---- inlined from supabase/functions/_shared/webpush.js ----
// webpush.js — Web Push in pure WebCrypto. No dependencies at all.
//
// Implements:
//   • RFC 8291  — Message Encryption for Web Push (aes128gcm)
//   • RFC 8292  — VAPID (ES256 JWT in the Authorization header)
//
// Written against the standard, byte-for-byte compatible with the widely used
// `web-push` npm package (verified in tests/webpush-crypto.test.js, which
// decrypts our output with http_ece and verifies our JWT with Node's crypto).
//
// It only uses WebCrypto, so the same file runs in:
//   • Deno / Supabase Edge Functions  (imported by rb-notify)
//   • Node 18+                        (imported by the test suite)
// A future Flutter app would not need this file — it uses FCM natively.

const enc = new TextEncoder();

// ------------------------------------------------------------------ base64url
function b64UrlDecode(value) {
  const raw = String(value == null ? "" : value).trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = raw.length % 4;
  const padded = raw + (pad ? "=".repeat(4 - pad) : "");
  let bin;
  try {
    bin = atob(padded);
  } catch (e) {
    throw new Error("Not valid base64url: \"" + String(value).slice(0, 24) + "\"");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64UrlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

// ------------------------------------------------------------------ HKDF (RFC 5869, SHA-256)
async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, data);
  return new Uint8Array(sig);
}

async function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}

async function hkdfExpand(prk, info, len) {
  const out = new Uint8Array(len);
  let t = new Uint8Array(0);
  let written = 0;
  let counter = 1;
  while (written < len) {
    const block = await hmacSha256(prk, concat(t, info, new Uint8Array([counter])));
    const n = Math.min(block.length, len - written);
    out.set(block.subarray(0, n), written);
    written += n;
    t = block;
    counter += 1;
  }
  return out;
}

async function hkdf(salt, ikm, info, len) {
  return hkdfExpand(await hkdfExtract(salt, ikm), info, len);
}

// ------------------------------------------------------------------ VAPID (RFC 8292)
// The private key is stored as the raw 32-byte scalar (base64url) and the
// public key as the 65-byte uncompressed point (base64url) — exactly the pair
// `webpush.generateVAPIDKeys()` produces.
function vapidJwk(privateKeyB64Url, publicKeyB64Url) {
  const pub = b64UrlDecode(publicKeyB64Url);
  const priv = b64UrlDecode(privateKeyB64Url);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  if (priv.length !== 32) throw new Error("VAPID private key must be 32 bytes");
  return {
    kty: "EC",
    crv: "P-256",
    x: b64UrlEncode(pub.subarray(1, 33)),
    y: b64UrlEncode(pub.subarray(33, 65)),
    d: b64UrlEncode(priv),
    ext: true
  };
}

async function createVapidAuthorization(endpoint, subject, publicKeyB64Url, privateKeyB64Url, ttlSeconds) {
  const url = new URL(endpoint);
  const audience = url.protocol + "//" + url.host;
  const exp = Math.floor(Date.now() / 1000) + (ttlSeconds || 12 * 60 * 60);

  const header = b64UrlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64UrlEncode(enc.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const unsigned = header + "." + claims;

  const key = await crypto.subtle.importKey(
    "jwk",
    vapidJwk(privateKeyB64Url, publicKeyB64Url),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned))
  );

  return "vapid t=" + unsigned + "." + b64UrlEncode(signature) + ", k=" + publicKeyB64Url;
}

// ------------------------------------------------------------------ RFC 8291 aes128gcm
function u32be(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

// http_ece: XOR the record counter into the last 6 bytes of the base nonce.
function generateNonce(base, counter) {
  const nonce = new Uint8Array(base);
  let m = 0;
  for (let i = nonce.length - 6; i < nonce.length; i++) m = m * 256 + nonce[i];
  const x = ((m ^ counter) & 0xffffff) +
    ((((m / 0x1000000) ^ (counter / 0x1000000)) & 0xffffff) * 0x1000000);
  let v = x;
  for (let i = nonce.length - 1; i >= nonce.length - 6; i--) {
    nonce[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return nonce;
}

const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
const PAD_LENGTH = 1;

/**
 * Encrypts a payload for one push subscription.
 * Returns { body: Uint8Array, contentEncoding } — `body` goes straight to fetch().
 */
async function encryptAes128Gcm(subscription, payloadText, salt, keyPair) {
  const uaPublic = b64UrlDecode(subscription.keys.p256dh);
  const authSecret = b64UrlDecode(subscription.keys.auth);
  if (uaPublic.length !== 65) throw new Error("p256dh must be a 65-byte uncompressed point");

  const saltBytes = salt || crypto.getRandomValues(new Uint8Array(16));
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));

  const uaKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, keyPair.privateKey, 256)
  );

  // secret = HKDF(authSecret, shared, "WebPush: info\0" || ua_public || as_public, 32)
  const secret = await hkdf(
    authSecret,
    shared,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublicRaw),
    32
  );

  const prk = await hkdfExtract(saltBytes, secret);
  const cek = await hkdfExpand(prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonceBase = await hkdfExpand(prk, enc.encode("Content-Encoding: nonce\0"), 12);

  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);

  // Header: salt(16) || rs(4) || keyid length(1) || keyid(as_public)
  const header = concat(saltBytes, u32be(RECORD_SIZE), new Uint8Array([asPublicRaw.length]), asPublicRaw);

  const data = enc.encode(String(payloadText == null ? "" : payloadText));
  const chunk = RECORD_SIZE - TAG_LENGTH - PAD_LENGTH;

  const blocks = [header];
  let start = 0;
  let counter = 0;
  for (;;) {
    const end = Math.min(start + chunk, data.length);
    const last = end >= data.length;
    const iv = generateNonce(nonceBase, counter);
    const plaintext = concat(data.subarray(start, end), new Uint8Array([last ? 2 : 1]));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new Uint8Array(0), tagLength: 128 },
        cekKey,
        plaintext
      )
    );
    blocks.push(cipher);
    start = end;
    counter += 1;
    if (last) break;
  }

  return { body: concat(...blocks), contentEncoding: "aes128gcm" };
}

/**
 * Builds everything needed to POST one push message.
 * Returns { endpoint, headers, body } — ready for fetch().
 */
async function buildPushRequest(subscription, payloadText, options) {
  const opts = options || {};
  if (!subscription || !subscription.endpoint) throw new Error("subscription.endpoint is required");
  if (!subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    throw new Error("subscription.keys.p256dh and subscription.keys.auth are required");
  }

  const vapidAuth = await createVapidAuthorization(
    subscription.endpoint,
    opts.subject,
    opts.publicKey,
    opts.privateKey,
    opts.vapidExpirySeconds
  );

  const hasPayload = payloadText != null && String(payloadText).length > 0;
  const headers = {
    TTL: String(opts.ttl == null ? 2419200 : opts.ttl),
    Urgency: opts.urgency || "normal",
    Authorization: vapidAuth
  };

  if (!hasPayload) {
    return { endpoint: subscription.endpoint, headers: Object.assign(headers, { "Content-Length": "0" }), body: null };
  }

  const keyPair = opts.keyPair || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const { body } = await encryptAes128Gcm(subscription, payloadText, opts.salt || null, keyPair);

  return {
    endpoint: subscription.endpoint,
    headers: Object.assign(headers, {
      "Content-Length": String(body.length),
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm"
    }),
    body
  };
}

// ---- end of supabase/functions/_shared/webpush.js ----
// ---- inlined from notify.js ----
// notify.js — the exact wording of every push notification, in one place.
//
// Pure functions, no DOM, no network. Used by:
//   • the browser (window.RBNotifyText) to preview a notification,
//   • the rb-notify Edge Function (identical wording, imported copy),
//   • the automated tests (require("./notify.js")) so the wording is locked in.
//
// Flutter can reuse the same strings later; nothing here is web-specific.
(function () {
  "use strict";

  // Letters and digits without the confusing ones (no O/0, I/1, L, U).
  const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

  function randomCode(len, rng) {
    const rand = rng || Math.random;
    const n = len || 8;
    let out = "";
    for (let i = 0; i < n; i++) {
      out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
    }
    return out;
  }

  // The site lives in a sub-folder on GitHub Pages, so the trailing "/" matters:
  // https://mahicouragw.github.io/Register-book/#join=ABCD2345
  function joinUrl(base, code) {
    const b = String(base || "").replace(/\/+$/, "");
    return `${b}/#join=${encodeURIComponent(code || "")}`;
  }

  function clip(text, max) {
    const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    const n = max || 60;
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // The four notification types. `actions` are the buttons shown on the phone
  // banner (Android Chrome shows them; iOS shows a plain banner until you tap).
  function wording(ev) {
    const e = ev || {};
    const who = e.sender || e.caller || e.inviter || "Someone";
    const group = e.group || "a group";

    switch (e.type) {
      case "message":
        return {
          type: "message",
          title: `${who}: you have a new message`,
          body: e.text ? clip(e.text) : "Tap to open the chat.",
          actions: [
            { action: "open", title: "Open" },
            { action: "reply_later", title: "Reply later" }
          ],
          tag: "rb-message",
          renotify: true
        };

      case "friend":
        return {
          type: "friend",
          title: `${who} sent you a friend request`,
          body: "Tap Accept to connect, or Decline.",
          actions: [
            { action: "accept", title: "Accept" },
            { action: "decline", title: "Decline" }
          ],
          tag: "rb-friend",
          renotify: true
        };

      case "invite":
        return {
          type: "invite",
          title: `You're invited to ${group}`,
          body: e.text ? clip(e.text) : `${who} invited you to join “${group}”.`,
          actions: [
            { action: "join", title: "Join" },
            { action: "decline", title: "Decline" }
          ],
          tag: "rb-invite",
          renotify: true
        };

      case "call":
        return {
          type: "call",
          title: `${who} is calling (${e.kind === "video" ? "video" : "audio"})`,
          body: "Tap Answer to talk now, or Decline.",
          actions: [
            { action: "answer", title: "Answer" },
            { action: "decline", title: "Decline" }
          ],
          tag: "rb-call",
          renotify: true,
          requireInteraction: true
        };

      case "system":
      default:
        return {
          type: "system",
          title: e.title || "RegisterBook",
          body: e.text || "Test notification — if you can read this, push works.",
          actions: [{ action: "open", title: "Open" }],
          tag: "rb-system",
          renotify: false
        };
    }
  }

  // Which screen inside the app a notification should open.
  // Returns a deep-link fragment that the app understands, e.g. "#chat=<id>".
  function deepLink(e) {
    const ev = e || {};
    switch (ev.type) {
      case "message": return `#chat=${encodeURIComponent(ev.senderId || "")}`;
      case "friend":  return `#requests=1`;
      case "invite":  return `#join=${encodeURIComponent(ev.code || "")}`;
      case "call":    return `#call=${encodeURIComponent(ev.callId || "")}`;
      default:        return `#home=1`;
    }
  }

  const API = { CODE_ALPHABET, randomCode, joinUrl, clip, wording, deepLink };

  if (typeof window !== "undefined") window.RBNotifyText = API;
  if (typeof globalThis !== "undefined") globalThis.RBNotifyText = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();

// ---- end of notify.js ----
 // sets globalThis.RBNotifyText (same wording as the browser)

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
    callId: data.callId
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
        inviteId: data.inviteId || ""
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
              urgency: type === "call" ? "high" : "normal"
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
