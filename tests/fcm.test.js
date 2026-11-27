// Proves the FCM (Android app push) sender is correct:
//   1. The service-account JWT is really signed with the private key
//      (verified with Node crypto against the public key).
//   2. The JWT carries the right claims for FCM's OAuth endpoint.
//   3. sendFcmMessage builds the right request and spots dead tokens.
//   4. The wiring exists end to end: migration table, Edge Function,
//      built function, app store + push registration.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODULE_PATH = path.join(__dirname, "..", "supabase", "functions", "_shared", "fcm.js");

let fcm = null;
test.before(async () => {
  const tmp = path.join(os.tmpdir(), "rb-fcm-" + Date.now() + ".mjs");
  fs.writeFileSync(tmp, fs.readFileSync(MODULE_PATH, "utf8"));
  fcm = await import("file://" + tmp);
});

function makeServiceAccount() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return {
    sa: {
      type: "service_account",
      project_id: "registerbook-test",
      private_key_id: "abc123",
      private_key: privateKey,
      client_email: "firebase-adminsdk@test.iam.gserviceaccount.com",
      client_id: "1234567890",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token"
    },
    publicKey
  };
}

test("pemToDer decodes a PEM block to DER bytes", () => {
  const { sa } = makeServiceAccount();
  const der = fcm.pemToDer(sa.private_key);
  assert.ok(der instanceof Uint8Array && der.length > 100, "DER bytes produced");
  assert.throws(() => fcm.pemToDer(""), /empty/, "empty key is refused");
});

test("the service-account JWT verifies against the real public key", async () => {
  const { sa, publicKey } = makeServiceAccount();
  const jwt = await fcm.buildServiceAccountJwt(sa, { now: 1700000000000 });
  const parts = jwt.split(".");
  assert.equal(parts.length, 3, "header.claims.signature");

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");

  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.equal(claims.iss, sa.client_email, "issuer is the service account");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.iat, 1700000000);
  assert.equal(claims.exp - claims.iat, 3600, "one hour validity");

  const sig = Buffer.from(parts[2], "base64url");
  const ok = crypto.verify(
    "sha256",
    Buffer.from(parts[0] + "." + parts[1]),
    publicKey,
    sig
  );
  assert.equal(ok, true, "signature verifies with the public key");
});

test("a service account without a key is refused with a clear error", async () => {
  await assert.rejects(
    () => fcm.buildServiceAccountJwt({ client_email: "a@b.c" }),
    /client_email and private_key/
  );
});

test("getAccessToken posts the jwt-bearer grant and returns the token", async () => {
  const { sa } = makeServiceAccount();
  let seen = null;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ access_token: "ya29.test-token", token_type: "Bearer" }) };
  };
  const tok = await fcm.getAccessToken(sa, { fetchImpl: fakeFetch });
  assert.equal(tok, "ya29.test-token");
  assert.equal(seen.url, "https://oauth2.googleapis.com/token");
  assert.match(seen.opts.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  assert.match(seen.opts.body, /assertion=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
});

test("sendFcmMessage builds the FCM v1 request and reports dead tokens", async () => {
  const { sa } = makeServiceAccount();
  let seen = null;
  const okFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, text: async () => "" };
  };
  const r = await fcm.sendFcmMessage(sa, "ya29.tok", {
    token: "device-token-1",
    title: "Goldfish: you have a new message",
    body: "Hello",
    data: { type: "message", senderId: "u1" },
    tag: "rb-message"
  }, { fetchImpl: okFetch });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen.url, "https://fcm.googleapis.com/v1/projects/registerbook-test/messages:send");
  assert.equal(seen.opts.headers.Authorization, "Bearer ya29.tok");
  const payload = JSON.parse(seen.opts.body);
  assert.equal(payload.message.token, "device-token-1");
  assert.equal(payload.message.notification.title, "Goldfish: you have a new message");
  assert.equal(payload.message.android.priority, "high");
  assert.equal(payload.message.data.type, "message");

  const goneFetch = async () => ({ ok: false, status: 404, text: async () => '{"error":{"status":"UNREGISTERED"}}' });
  const g = await fcm.sendFcmMessage(sa, "ya29.tok", { token: "dead" }, { fetchImpl: goneFetch });
  assert.equal(g.ok, false);
  assert.equal(g.gone, true, "a dead token is reported as gone so the row is deleted");

  const errFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const e = await fcm.sendFcmMessage(sa, "ya29.tok", { token: "x" }, { fetchImpl: errFetch });
  assert.equal(e.ok, false);
  assert.equal(e.gone, false, "a server error is not a dead token");
});

// ------------------------------------------------------------ wiring
test("FCM is wired end to end: table, function, built file, app", () => {
  const root = path.join(__dirname, "..");
  const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

  const sql = read("supabase/migrations.sql");
  assert.ok(sql.includes("create table if not exists public.rb_fcm_tokens"), "tokens table in the migration");
  assert.ok(sql.includes("rb_fcm_tokens_read"), "RLS read policy");
  assert.ok(sql.includes("rb_fcm_tokens_insert"), "RLS insert policy");

  const src = read("supabase/functions/src/rb-notify.ts");
  assert.ok(src.includes("RB_FCM_SERVICE_ACCOUNT"), "reads the service-account secret");
  assert.ok(src.includes("rb_fcm_tokens"), "looks up the recipient's app tokens");
  assert.ok(src.includes("sendFcmMessage"), "sends via FCM");

  const built = read("supabase/functions/rb-notify/index.ts");
  assert.ok(built.includes("buildServiceAccountJwt"), "built function carries the FCM sender");

  // Regression: inlining webpush.js + fcm.js into one file must not declare
  // the same top-level name twice — a duplicate `const` is a syntax error
  // that crashes the deployed function on load (transpileModule misses it).
  const count = re => (built.match(re) || []).length;
  assert.equal(count(/^const enc = new TextEncoder/gm), 1, "exactly one TextEncoder");
  assert.equal(count(/^function b64UrlDecode\(/gm), 1, "exactly one b64UrlDecode");
  assert.equal(count(/^function b64UrlEncode\(/gm), 1, "exactly one b64UrlEncode");
  assert.equal(count(/^(async )?function sendFcmMessage\(/gm), 1, "exactly one sendFcmMessage");

  const store = read("store.js");
  assert.ok(store.includes("saveFcmToken"), "app saves its FCM token");
  assert.ok(store.includes("rb_fcm_tokens"), "saves to the tokens table");

  const push = read("push.js");
  assert.ok(push.includes("registerFcm"), "app registers for FCM");
  assert.ok(push.includes("pushNotificationReceived"), "foreground pushes show a banner");
  assert.ok(push.includes("pushNotificationActionPerformed"), "tapping a push opens the app");
});
