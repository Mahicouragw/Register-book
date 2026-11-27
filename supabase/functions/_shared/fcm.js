// fcm.js — Firebase Cloud Messaging (FCM) HTTP v1 sender, in pure WebCrypto.
//
// The installed website (PWA) uses Web Push (webpush.js). The Android app
// (Capacitor WebView) has no PushManager, so it uses FCM instead — this is
// the server half: it signs a JWT with the Firebase service-account key,
// exchanges it for an OAuth access token, and POSTs the message to FCM.
//
// No dependencies at all. Only WebCrypto, so the same file runs in:
//   • Deno / Supabase Edge Functions  (imported by rb-notify)
//   • Node 18+                        (imported by the test suite)
//
// The service-account JSON is a Supabase secret called RB_FCM_SERVICE_ACCOUNT
// (set by the owner in the Supabase dashboard — never in Git).
//
// NOTE: every top-level name here is prefixed `fcm` on purpose. The build
// script inlines this file into rb-notify/index.ts alongside webpush.js, and
// a duplicate `const` (e.g. a second `enc`) is a syntax error that would
// crash the deployed function. Keep the prefixes.

const fcmEnc = new TextEncoder();

// ------------------------------------------------------------------ base64url
export function fcmB64UrlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fcmB64UrlEncodeText(text) {
  return fcmB64UrlEncode(fcmEnc.encode(text));
}

function fcmB64UrlDecode(value) {
  const raw = String(value == null ? "" : value).trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = raw.length % 4;
  const padded = raw + (pad ? "=".repeat(4 - pad) : "");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------ PEM → key
// A Firebase service-account private key is a PEM block ("-----BEGIN PRIVATE
// KEY-----..."). WebCrypto wants the raw PKCS#8 DER bytes.
export function pemToDer(pem) {
  const body = String(pem || "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("The service-account key is empty.");
  return fcmB64UrlDecode(body);
}

async function fcmImportPrivateKey(pem) {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// ------------------------------------------------------------------ JWT
// FCM accepts a service-account JWT as the OAuth grant:
//   header  { alg: RS256, typ: JWT }
//   claims  { iss: client_email, scope: fcm, aud: oauth2 token endpoint,
//             iat, exp (max 1 hour) }
export async function buildServiceAccountJwt(serviceAccount, opts) {
  const o = opts || {};
  const sa = serviceAccount || {};
  const clientEmail = sa.client_email || "";
  const privateKey = sa.private_key || "";
  if (!clientEmail || !privateKey) {
    throw new Error("The service account needs client_email and private_key.");
  }
  const now = Math.floor((o.now || Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const signingInput =
    fcmB64UrlEncodeText(JSON.stringify(header)) + "." + fcmB64UrlEncodeText(JSON.stringify(claims));
  const key = await fcmImportPrivateKey(privateKey);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, fcmEnc.encode(signingInput));
  return signingInput + "." + fcmB64UrlEncode(new Uint8Array(sig));
}

// Exchange the JWT for an OAuth access token (cached by the caller).
export async function getAccessToken(serviceAccount, opts) {
  const o = opts || {};
  const jwt = await buildServiceAccountJwt(serviceAccount, o);
  const res = await (o.fetchImpl || fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=" +
      encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" +
      encodeURIComponent(jwt)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("FCM token request failed (" + res.status + ")" + (txt ? ": " + txt.slice(0, 200) : ""));
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("FCM token request returned no access token.");
  return json.access_token;
}

// ------------------------------------------------------------------ send
// Sends one notification to one FCM registration token.
// Returns { ok: true } or { ok: false, gone: true } for a dead token
// (FCM answers 404 / UNREGISTERED — the caller deletes the row).
export async function sendFcmMessage(serviceAccount, accessToken, message, opts) {
  const o = opts || {};
  const sa = serviceAccount || {};
  const projectId = sa.project_id || "";
  if (!projectId) throw new Error("The service account has no project_id.");
  if (!accessToken) throw new Error("No FCM access token.");
  const m = message || {};
  if (!m.token) throw new Error("No registration token to send to.");

  const payload = {
    message: {
      token: m.token,
      notification: { title: m.title || "RegisterBook", body: m.body || "" },
      data: m.data || {},
      android: {
        priority: m.priority || "high",
        ttl: m.ttl || "86400s",
        notification: {
          channel_id: m.channelId || "registerbook_default",
          sound: "default",
          tag: m.tag || undefined
        }
      }
    }
  };

  const res = await (o.fetchImpl || fetch)(
    "https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(projectId) + "/messages:send",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  if (res.ok) return { ok: true };
  const txt = await res.text().catch(() => "");
  const gone = res.status === 404 || /UNREGISTERED|NOT_FOUND/i.test(txt);
  return { ok: false, gone, status: res.status, error: txt.slice(0, 200) };
}
