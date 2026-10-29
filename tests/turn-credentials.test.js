// Proves the TURN relay credentials are built the way coturn expects, and that
// the long-lived secret is never needed in the browser.
//
// Two phones on different networks almost always need a relay. The relay's
// shared secret lives in a Supabase secret; the Edge Function turns it into a
// credential that expires on its own. These tests check that maths and the
// plumbing around it.
//
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODULE_PATH = path.join(__dirname, "..", "supabase", "functions", "_shared", "turn.js");
const BUILT = path.join(__dirname, "..", "supabase", "functions", "rb-turn-credentials", "index.ts");

let turn = null;
test.before(async () => {
  const tmp = path.join(os.tmpdir(), "rb-turn-" + process.pid + ".mjs");
  fs.writeFileSync(tmp, fs.readFileSync(MODULE_PATH, "utf8"));
  turn = await import("file://" + tmp);
});

// The reference implementation: exactly what coturn does with a
// static-auth-secret, computed with Node's own crypto.
function referenceCredential(secret, username) {
  return crypto.createHmac("sha1", secret).update(username).digest("base64");
}

test("parseTurnUrls accepts a comma-separated list and a JSON array", () => {
  assert.deepEqual(turn.parseTurnUrls("turn:a.example:3478, turns:a.example:5349"), [
    "turn:a.example:3478", "turns:a.example:5349"
  ]);
  assert.deepEqual(turn.parseTurnUrls('["turn:a.example:3478","turns:a.example:5349"]'), [
    "turn:a.example:3478", "turns:a.example:5349"
  ]);
  assert.deepEqual(turn.parseTurnUrls(""), []);
  assert.deepEqual(turn.parseTurnUrls(null), []);
  assert.deepEqual(turn.parseTurnUrls("  turn:only.example:3478  "), ["turn:only.example:3478"]);
});

test("the username is '<expiry>:<userId>' — that is the coturn REST API format", () => {
  assert.equal(turn.turnUsername("abc-123", 1700000000), "1700000000:abc-123");
});

test("the credential matches coturn's own HMAC-SHA1 + base64", async () => {
  const secret = "s3cret-shared-with-coturn";
  const username = turn.turnUsername("user-1", 1700000000);

  const ours = await turn.turnCredential(secret, username);
  const theirs = referenceCredential(secret, username);

  assert.equal(ours, theirs, "our credential must be byte-identical to coturn's");
  // and it really is base64 of a 20-byte SHA-1 HMAC
  assert.equal(Buffer.from(ours, "base64").length, 20);
});

test("a different secret or a different user gives a different credential", async () => {
  const u = turn.turnUsername("user-1", 1700000000);
  const a = await turn.turnCredential("secret-A", u);
  const b = await turn.turnCredential("secret-B", u);
  const c = await turn.turnCredential("secret-A", turn.turnUsername("user-2", 1700000000));

  assert.notEqual(a, b, "another secret must not produce the same credential");
  assert.notEqual(a, c, "another user must not produce the same credential");
  // but it is stable, so a retry works
  assert.equal(a, await turn.turnCredential("secret-A", u));
});

test("turnCredential refuses empty input instead of signing nothing", async () => {
  await assert.rejects(() => turn.turnCredential("", "1700000000:x"), /TURN_AUTH_SECRET/);
  await assert.rejects(() => turn.turnCredential("secret", ""), /username/);
});

test("with no relay configured we fall back to STUN only, and say so", async () => {
  const r = await turn.buildIceServers({ userId: "u1" });
  assert.equal(r.turn, false, "no TURN available");
  assert.equal(r.iceServers.length, 1, "STUN entry only");
  assert.deepEqual(r.iceServers[0].urls, [
    "stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"
  ]);

  // a secret with no URLs is just as unconfigured
  const r2 = await turn.buildIceServers({ userId: "u1", authSecret: "s" });
  assert.equal(r2.turn, false, "secret alone is not enough");
});

test("with a relay configured we get a STUN entry plus an expiring TURN entry", async () => {
  const r = await turn.buildIceServers({
    userId: "user-42",
    turnUrls: "turn:relay.example.com:3478,turns:relay.example.com:5349",
    authSecret: "shared-secret",
    ttlSeconds: 3600
  });

  assert.equal(r.turn, true);
  assert.equal(r.iceServers.length, 2);
  assert.deepEqual(r.iceServers[1].urls, [
    "turn:relay.example.com:3478", "turns:relay.example.com:5349"
  ]);

  // the credential the server will recompute
  assert.equal(
    r.iceServers[1].credential,
    referenceCredential("shared-secret", r.iceServers[1].username),
    "the credential must verify against the shared secret"
  );
  assert.equal(r.iceServers[1].username, r.username);

  // it expires, roughly one TTL from now
  const now = Math.floor(Date.now() / 1000);
  assert.ok(r.expiresAt > now + 3500, "expires about an hour from now");
  assert.ok(r.expiresAt <= now + 3600, "and not later than the TTL");
  assert.match(r.username, new RegExp("^" + r.expiresAt + ":user-42$"));
});

test("the deployed Edge Function is self-contained, valid, and never trusts the body", () => {
  const code = fs.readFileSync(BUILT, "utf8");

  const relative = code.split("\n").filter(l => /import\s+(?:[^'"]*?from\s+)?["']\.[^'"]*["']/.test(l));
  assert.deepEqual(relative, [], "no relative imports survive the build");

  const ts = require("typescript");
  const out = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
    fileName: "rb-turn-credentials.ts"
  });
  assert.deepEqual(out.diagnostics || [], [], "it is valid TypeScript");

  // The identity comes from the Authorization header, never from a request body.
  assert.match(code, /Authorization:\s*authHeader/, "the caller's JWT is forwarded to getUser");
  assert.match(code, /auth\.getUser\(\)/, "the caller is resolved from the JWT");
  assert.match(code, /Deno\.env\.get\("TURN_AUTH_SECRET"\)/, "the secret is read from the environment");

  // And it is honest when nothing is configured.
  assert.match(code, /configured:\s*false/, "it says plainly when there is no relay");
});

test("no TURN secret is hard-coded anywhere in the app or the schema", () => {
  const root = path.join(__dirname, "..");
  const files = [
    "config.js", "store.js", "rtc.js", "app.js", "sw.js",
    "supabase/migrations.sql",
    "supabase/functions/rb-turn-credentials/index.ts"
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(text, /TURN_AUTH_SECRET\s*[:=]\s*["'][^"']+["']/,
      `${f} must not contain a hard-coded TURN secret`);
  }
});

test("the app asks the Edge Function for the relay, with a config.js fallback", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "store.js"), "utf8");
  const rtc = fs.readFileSync(path.join(__dirname, "..", "rtc.js"), "utf8");

  assert.match(store, /edgeUrl\("rb-turn-credentials"\)/, "store calls the Edge Function");
  assert.match(store, /fetchTurnCredentials/, "and exports it");
  assert.match(rtc, /ensureTurn\(\)/, "rtc fetches the relay before building the peer");
  assert.match(rtc, /await makePeer\(\)/, "and waits for it");

  const config = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  assert.match(config, /EDGE_TURN:\s*"rb-turn-credentials"/, "config names the function");
  assert.match(config, /TURN_URLS:\s*""/, "the fallback values are empty by default");
});
