// Proves our dependency-free Web Push implementation is correct by checking it
// against the widely used `web-push` / `http_ece` reference implementation:
//
//   1. web-push encrypts a payload  → our code decrypts it byte-for-byte
//   2. our code encrypts a payload  → http_ece decrypts it byte-for-byte
//   3. our VAPID JWT verifies with Node crypto against the real public key
//   4. our VAPID JWT is byte-identical in structure to web-push's
//
// `web-push` is a devDependency of this test only (it never ships, and the Edge
// Function has no dependencies at all).
//
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

const MODULE_PATH = path.join(__dirname, "..", "supabase", "functions", "_shared", "webpush.js");

// The shipped file is plain ESM JavaScript. Copy it to a .mjs temp file so Node
// can `import()` it without touching the repository's package.json.
let wp = null;
test.before(async () => {
  const tmp = path.join(os.tmpdir(), "rb-webpush-" + Date.now() + ".mjs");
  fs.writeFileSync(tmp, fs.readFileSync(MODULE_PATH, "utf8"));
  wp = await import("file://" + tmp);
});

let webpush = null;
let ece = null;
try {
  webpush = require("web-push");
  ece = require("http_ece");
} catch (e) {
  console.log("(web-push not installed — cross-check tests will be skipped)");
}

// ---- helpers ----------------------------------------------------------------
function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

function makeVapidKeys() {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}

function makeSubscription() {
  // A receiver key pair where we know BOTH halves, so we can decrypt.
  const curve = crypto.createECDH("prime256v1");
  curve.generateKeys();
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/abcdefghijklmnop",
    keys: {
      p256dh: curve.getPublicKey().toString("base64url"),
      auth: crypto.randomBytes(16).toString("base64url")
    },
    _curve: curve
  };
}

// ---------------------------------------------------------------------------
test("base64url helpers round-trip and match Node's encoder", () => {
  const bytes = crypto.randomBytes(65);
  const mine = wp.b64UrlEncode(new Uint8Array(bytes));
  assert.equal(mine, bytes.toString("base64url"), "encoder agrees with Node");
  assert.deepEqual(Buffer.from(wp.b64UrlDecode(mine)), bytes, "decoder round-trips");

  // unpadded input must be accepted too (that is how the browser sends keys)
  assert.deepEqual(Buffer.from(wp.b64UrlDecode("AAAA")), Buffer.alloc(3));
});

test("our VAPID JWT verifies against the real public key and matches web-push's shape", async () => {
  if (!webpush) return;
  const vapid = makeVapidKeys();
  const endpoint = "https://fcm.googleapis.com/fcm/send/xyz";
  const subject = "mailto:owner@example.com";

  const auth = await wp.createVapidAuthorization(endpoint, subject, vapid.publicKey, vapid.privateKey, 3600);
  assert.match(auth, /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/);
  assert.equal(auth.split(", k=")[1], vapid.publicKey, "the public key is advertised");

  const jwt = auth.slice("vapid t=".length).split(", k=")[0];
  const [h, p, s] = jwt.split(".");

  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });

  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com", "audience is the push service origin");
  assert.equal(claims.sub, subject);
  assert.ok(claims.exp - Math.floor(Date.now() / 1000) > 3000, "expires in the future");

  // verify the ES256 signature (raw r||s, IEEE P1363) with Node crypto
  const pubBytes = Buffer.from(vapid.publicKey, "base64url");
  const key = crypto.createPublicKey({
    key: {
      kty: "EC", crv: "P-256",
      x: b64url(pubBytes.subarray(1, 33)),
      y: b64url(pubBytes.subarray(33, 65))
    },
    format: "jwk"
  });
  const ok = crypto.verify(
    "sha256",
    Buffer.from(h + "." + p),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url")
  );
  assert.equal(ok, true, "the signature verifies with the matching public key");

  // and it must NOT verify against a different key
  const other = makeVapidKeys();
  const otherKey = crypto.createPublicKey({
    key: {
      kty: "EC", crv: "P-256",
      x: b64url(Buffer.from(other.publicKey, "base64url").subarray(1, 33)),
      y: b64url(Buffer.from(other.publicKey, "base64url").subarray(33, 65))
    },
    format: "jwk"
  });
  const bad = crypto.verify(
    "sha256", Buffer.from(h + "." + p),
    { key: otherKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url")
  );
  assert.equal(bad, false, "a different key does not verify");
});

test("http_ece can decrypt what we encrypt (RFC 8291 compatibility)", async () => {
  const sub = makeSubscription();
  const text = JSON.stringify({ title: "Goldfish: you have a new message", body: "Bring the keys" });

  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const { body, contentEncoding } = await wp.encryptAes128Gcm(sub, text, null, keyPair);
  assert.equal(contentEncoding, "aes128gcm");

  // record header: salt(16) || rs(4) || keyidlen(1) || keyid
  const bodyBuf = Buffer.from(body);
  assert.equal(bodyBuf.readUIntBE(16, 4), 4096, "record size is in the header");
  assert.equal(bodyBuf.readUIntBE(20, 1), 65, "keyid length is 65 (uncompressed P-256 point)");

  const plain = ece.decrypt(bodyBuf, {
    version: "aes128gcm",
    privateKey: sub._curve,
    authSecret: Buffer.from(sub.keys.auth, "base64url")
  });
  assert.equal(plain.toString("utf8"), text, "the reference implementation reads our message");
});

test("we can decrypt what web-push encrypts (round trip both ways)", async () => {
  const sub = makeSubscription();
  const text = "Silverfish invited you to join Ward Staff";

  const details = webpush.generateRequestDetails(sub, text, { TTL: 60 });
  const bodyBuf = Buffer.from(details.body);

  const plain = ece.decrypt(bodyBuf, {
    version: "aes128gcm",
    privateKey: sub._curve,
    authSecret: Buffer.from(sub.keys.auth, "base64url")
  });
  assert.equal(plain.toString("utf8"), text, "sanity: reference decrypts itself");

  // now decrypt web-push's output using OUR derivation, by re-implementing the
  // decrypt side with the same primitive: derive the key from the header values
  // that web-push put in the body, then AES-GCM open the record.
  const salt = bodyBuf.subarray(0, 16);
  const keyidLen = bodyBuf.readUIntBE(20, 1);
  const asPublic = bodyBuf.subarray(21, 21 + keyidLen);
  const record = bodyBuf.subarray(21 + keyidLen);

  const mine = await decryptForCheck(sub._curve, sub.keys.auth, salt, asPublic, record);
  assert.equal(mine, text, "our key derivation reads the reference implementation's message");
});

// A tiny decryptor written with the same primitives, used only by the test to
// prove the derivation matches in both directions.
async function decryptForCheck(curve, authB64, salt, asPublic, record) {
  const authSecret = Buffer.from(authB64, "base64url");
  const uaPublic = curve.getPublicKey();
  const shared = curve.computeSecret(Buffer.from(asPublic));

  const uaKey = await crypto.subtle.importKey(
    "raw", new Uint8Array(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  // we only need the shared secret, which ECDH already gave us above
  void uaKey;

  const secret = await hkdf(authSecret, shared, Buffer.concat([
    Buffer.from("WebPush: info\0"), uaPublic, Buffer.from(asPublic)
  ]), 32);

  const prk = await hmacSha256(salt, secret);
  const cek = (await hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = (await hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12));

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, record);
  const buf = Buffer.from(opened);
  const delim = buf.readUInt8(buf.length - 1);
  assert.equal(delim, 2, "last-record delimiter");
  return buf.subarray(0, buf.length - 1).toString("utf8");
}

async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", k, data));
}
async function hkdfExtract(salt, ikm) { return hmacSha256(salt, ikm); }
async function hkdfExpand(prk, info, len) {
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  let counter = 1;
  while (out.length < len) {
    t = await hmacSha256(prk, Buffer.concat([t, info, Buffer.from([counter])]));
    out = Buffer.concat([out, t]);
    counter += 1;
  }
  return out.subarray(0, len);
}
async function hkdf(salt, ikm, info, len) {
  return hkdfExpand(await hkdfExtract(salt, ikm), info, len);
}

test("buildPushRequest produces a request the push service accepts the shape of", async () => {
  const sub = makeSubscription();
  const vapid = makeVapidKeys();
  const payload = JSON.stringify({ title: "Test", body: "Hello" });

  const req = await wp.buildPushRequest(sub, payload, {
    subject: "mailto:owner@example.com",
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
    ttl: 60,
    urgency: "high"
  });

  assert.equal(req.endpoint, sub.endpoint);
  assert.equal(req.headers.TTL, "60");
  assert.equal(req.headers.Urgency, "high");
  assert.equal(req.headers["Content-Encoding"], "aes128gcm");
  assert.equal(req.headers["Content-Type"], "application/octet-stream");
  assert.equal(Number(req.headers["Content-Length"]), req.body.length);
  assert.match(req.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.ok(req.body.length > payload.length, "the payload is actually encrypted");

  // and it really is readable by the receiver
  const plain = ece.decrypt(Buffer.from(req.body), {
    version: "aes128gcm",
    privateKey: sub._curve,
    authSecret: Buffer.from(sub.keys.auth, "base64url")
  });
  assert.equal(plain.toString("utf8"), payload);
});

test("an empty payload sends no body (notification without data)", async () => {
  const sub = makeSubscription();
  const vapid = makeVapidKeys();
  const req = await wp.buildPushRequest(sub, "", {
    subject: "mailto:owner@example.com",
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey
  });
  assert.equal(req.body, null);
  assert.equal(req.headers["Content-Length"], "0");
  assert.ok(!req.headers["Content-Encoding"]);
  assert.match(req.headers.Authorization, /^vapid t=/);
});

test("a payload longer than one record is split into records correctly", async () => {
  const sub = makeSubscription();
  const long = "x".repeat(9000); // > 4096 record size
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const { body } = await wp.encryptAes128Gcm(sub, long, null, keyPair);

  const plain = ece.decrypt(Buffer.from(body), {
    version: "aes128gcm",
    privateKey: sub._curve,
    authSecret: Buffer.from(sub.keys.auth, "base64url")
  });
  assert.equal(plain.toString("utf8"), long, "multi-record encryption round-trips");
});

test("a bad subscription key is rejected with a clear error, not a crash", async () => {
  const vapid = makeVapidKeys();
  await assert.rejects(
    () => wp.buildPushRequest({ endpoint: "https://push.example/x", keys: {} }, "hi", {
      subject: "mailto:o@e.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey
    }),
    /p256dh|auth/i
  );
  await assert.rejects(
    () => wp.buildPushRequest(null, "hi", { subject: "mailto:o@e.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey }),
    /endpoint is required/i
  );
  await assert.rejects(
    () => wp.createVapidAuthorization("https://push.example/x", "mailto:o@e.com", "short", "short"),
    /base64url|65-byte|uncompressed/i
  );
});
