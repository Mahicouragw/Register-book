// turn.js — short-lived credentials for a TURN relay (coturn "REST API").
//
// Why this exists
// ---------------
// Two phones on different networks usually cannot talk to each other directly:
// mobile carriers and most Wi-Fi routers use NAT, so WebRTC needs a server in
// the middle that relays the audio and video. That server is called TURN.
//
// A TURN server needs a username and password. Those must NOT be pasted into
// browser code, because anyone could read them and use our relay for free.
// The standard fix is coturn's "static-auth-secret" scheme:
//
//   username   = "<unix time when it expires>:<user id>"
//   credential = base64( HMAC-SHA1( shared secret, username ) )
//
// The TURN server knows the same shared secret, recomputes the HMAC and
// compares. Because the expiry time is inside the username, a leaked
// credential stops working by itself after a short while.
//
// So the shared secret lives ONLY in a Supabase secret, and this function
// hands each signed-in phone a credential that expires in a few hours.
//
// Only WebCrypto is used, so this file runs in Deno and in Node (the tests
// import the very same file).

const enc = new TextEncoder();

function base64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** coturn expects a comma-separated list or a JSON array. */
export function parseTurnUrls(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return [];
  const list = raw.startsWith("[")
    ? JSON.parse(raw)
    : raw.split(",");
  return list.map(u => String(u).trim()).filter(Boolean);
}

/** "<expiryUnix>:<userId>" */
export function turnUsername(userId, expiryUnix) {
  return expiryUnix + ":" + userId;
}

/** base64(HMAC-SHA1(secret, username)) */
export async function turnCredential(authSecret, username) {
  if (!authSecret) throw new Error("TURN_AUTH_SECRET is empty");
  if (!username) throw new Error("username is empty");
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(authSecret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(username))
  );
  return base64(sig);
}

/**
 * Builds the whole ICE-server list a browser should use.
 * Always includes the public STUN servers (free, and enough on some networks),
 * plus a TURN entry when the relay is configured.
 */
export async function buildIceServers(options) {
  const o = options || {};
  const urls = parseTurnUrls(o.turnUrls);
  const servers = [
    { urls: (o.stunUrls && o.stunUrls.length ? o.stunUrls : ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]) }
  ];
  if (!urls.length || !o.authSecret) return { iceServers: servers, turn: false };

  const ttl = o.ttlSeconds || 6 * 60 * 60;
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = turnUsername(o.userId || "anonymous", expiry);
  const credential = await turnCredential(o.authSecret, username);

  servers.push({ urls, username, credential });
  return { iceServers: servers, turn: true, username, credential, expiresAt: expiry, ttl };
}
