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
export function b64UrlDecode(value) {
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

export function b64UrlEncode(bytes) {
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

export async function createVapidAuthorization(endpoint, subject, publicKeyB64Url, privateKeyB64Url, ttlSeconds) {
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
export async function encryptAes128Gcm(subscription, payloadText, salt, keyPair) {
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
export async function buildPushRequest(subscription, payloadText, options) {
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
