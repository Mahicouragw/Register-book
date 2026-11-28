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

// Returns the code that really runs: for a wrapped function (rb-notify) that
// means the inflated gzip body, not the outer stub. Asserting against the stub
// would pass even if the body inside were empty — which is how a bundle that
// had lost its createClient import shipped unnoticed.
function readBuilt(name) {
  return require("./helpers/deployed-body").deployedSource(name);
}

// The outer file, for the properties that belong to the wrapper itself.
function readWrapper(name) {
  return fs.readFileSync(path.join(FUNC_DIR, name, "index.ts"), "utf8");
}

test("the generated Edge Functions are valid TypeScript and self-contained", () => {
  for (const name of ["rb-notify", "rb-delete-account", "rb-turn-credentials"]) {
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
      // The import has to travel inside the bundle: the body is its own ES
      // module and cannot see a global. This one line is the whole
      // "createClient is not defined" bug.
      assert.match(code, /import\s*\{\s*createClient\s*\}\s*from\s*["']npm:@supabase\/supabase-js@2["']/,
        "the bundled body must import createClient itself");
      assert.doesNotMatch(code, /__RB_createClient/, "no globalThis hand-off");
    }
  }
});

test("the outer wrapper files are valid TypeScript too", () => {
  // The bundle body is checked above, but the file the platform actually
  // deploys is the wrapper around it — a syntax error there is a BOOT_ERROR
  // just as fatal.
  for (const name of ["rb-notify", "rb-delete-account", "rb-turn-credentials"]) {
    const code = readWrapper(name);
    const out = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
      fileName: name + ".ts"
    });
    assert.deepEqual(out.diagnostics || [], [], `${name}/index.ts must transpile`);
  }

  // rb-notify must stay a plain module. It was once gzip+base64'd behind a
  // `data:` URL, which hid syntax errors until runtime, made npm: imports
  // unresolvable in the inner scope, and is what produced
  // "createClient is not defined". It must not come back.
  const wrapped = readWrapper("rb-notify");
  assert.doesNotMatch(wrapped, /const BUNDLE =/, "no base64 bundle");
  assert.doesNotMatch(wrapped, /data:text\/javascript/, "no data: module");
  assert.match(wrapped, /^import \{ createClient \} from "npm:/m);
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
