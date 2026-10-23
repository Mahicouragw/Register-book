// Checks the generated Edge Functions: no un-inlined relative imports, valid
// TypeScript that transpiles, and the security rules that matter are present.
//
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const FUNC_DIR = path.join(ROOT, "supabase", "functions");

function readBuilt(name) {
  return fs.readFileSync(path.join(FUNC_DIR, name, "index.ts"), "utf8");
}

test("the generated Edge Functions are valid TypeScript and self-contained", () => {
  for (const name of ["rb-notify", "rb-delete-account"]) {
    const code = readBuilt(name);

    // 1. nothing relative is imported any more (the runtime would not find it)
    const relative = code.split("\n").filter(l => /import\s+(?:[^'"]*?from\s+)?["']\.[^"']*["']/.test(l));
    assert.deepEqual(relative, [], `${name} must not import relative paths`);

    // 2. it really is valid TypeScript (transpile = syntax check)
    const out = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
      fileName: name + ".ts"
    });
    assert.deepEqual(out.diagnostics || [], [], `${name} must transpile without syntax errors`);
    assert.ok(out.outputText.length > 1000, `${name} produced output`);

    // 3. the shared inlined modules really made it in
    if (name === "rb-notify") {
      assert.match(code, /function buildPushRequest/, "web push crypto is inlined");
      assert.match(code, /RBNotifyText/, "the shared wording module is inlined");
    }
  }
});

test("the source of truth is shared, and the build output matches it", () => {
  const { execFileSync } = require("node:child_process");
  const before = readBuilt("rb-notify");
  execFileSync(process.execPath, [path.join(ROOT, "tools", "build-functions.js")], { cwd: ROOT });
  const after = readBuilt("rb-notify");
  assert.equal(after, before, "rebuilding produces the same file (it is not stale)");
});

test("rb-notify never trusts the request body for identity", () => {
  const code = readBuilt("rb-notify");
  assert.match(code, /auth\.getUser\(\)/, "it resolves the caller from the JWT");
  assert.match(code, /Bearer |startsWith\("Bearer "\)/, "it requires an Authorization header");

  // every event type is verified against the database before a push goes out
  for (const [type, check] of [
    ["message", /rb_direct_messages[\s\S]{0,400}sender_id !== uid/],
    ["friend", /rb_friend_requests[\s\S]{0,400}from_user !== uid/],
    ["invite", /rb_group_invites[\s\S]{0,400}created_by !== uid/],
    ["call", /rb_calls[\s\S]{0,400}caller_id !== uid/]
  ]) {
    assert.match(code, check, `a ${type} notification must be checked against its own row`);
  }

  assert.match(code, /You cannot notify yourself/, "it refuses self-notifications");
  // the private key is only read from the environment
  assert.match(code, /Deno\.env\.get\("RB_VAPID_PRIVATE_KEY"\)/, "the VAPID private key comes from a secret");
  assert.doesNotMatch(code, /privateKey\s*=\s*"/, "the private key is not hard-coded");
});

test("rb-notify removes dead push endpoints", () => {
  const code = readBuilt("rb-notify");
  assert.match(code, /res\.status === 404 \|\| res\.status === 410/, "404/410 are detected");
  assert.match(code, /rb_push_subscriptions"\)\.delete\(\)/, "and the dead subscription is deleted");
});

test("rb-delete-account needs an explicit confirmation and uses the admin API", () => {
  const code = readBuilt("rb-delete-account");
  assert.match(code, /auth\.admin\.deleteUser/, "it calls the admin delete API");
  assert.match(code, /auth\.getUser\(\)/, "it identifies the caller from the JWT, not the body");
  assert.match(code, /"DELETE"/, "it requires the word DELETE");
  assert.match(code, /rb_account_deletions/, "it keeps an audit record");
  assert.match(code, /status: "done"/, "and marks the request done when it succeeds");
  assert.match(code, /status: "failed"/, "or failed - it never silently claims success");
});
