// Regression tests for "Could not send: createClient is not defined".
//
// WHAT WENT WRONG
// ---------------
// rb-notify's deployed form was gzip+base64'd and loaded through a `data:` URL
// so the deploy channel would not choke on the size. To make that work the
// build stripped the import lines and handed createClient over as
// `globalThis.__RB_createClient`. An ES module has its own scope, so the bare
// `createClient(...)` in the body never saw that global and every send failed
// with
//     {"ok":false,"error":"createClient is not defined"}
// which the app showed verbatim as "Could not send: createClient is not defined".
//
// The fix removes the whole mechanism rather than patching it: the deployed
// file is one ordinary ES module with its imports at the top, executed exactly
// as written. These tests execute that file, so a build that loses the import
// again, or that reintroduces a bundling layer, fails here.
//
// A "data:" module cannot resolve npm: specifiers, and a module that is not
// parsed at build time cannot be trusted — both are asserted below.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const GENERATED = path.join(ROOT, "supabase", "functions", "rb-notify", "index.ts");

const readDeployed = () => fs.readFileSync(GENERATED, "utf8");

test("the generated rb-notify file is in sync with its source", () => {
  const before = readDeployed();
  require("node:child_process").execFileSync(
    process.execPath, [path.join(ROOT, "tools", "build-functions.js")], { cwd: ROOT });
  assert.strictEqual(readDeployed(), before,
    "supabase/functions/rb-notify/index.ts is stale — run npm run build:functions");
});

test("the deployed file imports createClient itself, as a normal module", () => {
  const code = readDeployed();

  assert.match(
    code,
    /^import\s*\{\s*createClient\s*\}\s*from\s*["']npm:@supabase\/supabase-js@2["']/m,
    "createClient must be imported at the top level of the deployed file"
  );

  // The exact shape of the old bug: a bare call with the import removed.
  const bareCalls = (code.match(/(^|[^.\w])createClient\s*\(/g) || []).length;
  assert.ok(bareCalls > 0, "rb-notify is supposed to create a Supabase client");

  // Nothing may reach for the old global hand-off.
  assert.doesNotMatch(code, /__RB_createClient/, "no globalThis hand-off");

  // No inlined-`data:`-module machinery may come back: that is what made the
  // scope trap possible, and it hides syntax errors until runtime.
  assert.doesNotMatch(code, /const BUNDLE =/, "the body must not be base64-wrapped again");
  assert.doesNotMatch(code, /DecompressionStream/, "no runtime inflate step");
  assert.doesNotMatch(code, /data:text\/javascript/, "no data: module import");

  // A relative import would not resolve in a single deployed file.
  const relative = code.split("\n").filter(l => /import\s+(?:[^'"]*?from\s+)?["']\.[^"']*["']/.test(l));
  assert.deepEqual(relative, [], "no relative imports in the deployed file");
});

test("the deployed file is plain ASCII so nothing is mangled in transit", () => {
  const bad = readDeployed().match(/[^\x00-\x7F]/g);
  assert.strictEqual(bad, null, "non-ASCII characters in the deployed file: " + (bad || []).join(" "));
});

test("the deployed file answers every request with CORS", () => {
  const code = readDeployed();
  assert.match(code, /Access-Control-Allow-Origin/);
  // Both the preflight and the JSON helper carry the headers, so a 4xx stays
  // readable instead of surfacing as the useless "Failed to fetch".
  assert.match(code, /req\.method === "OPTIONS"/);
  assert.match(code, /\.\.\.CORS_HEADERS/);
});

test("the real deployed function runs and reaches createClient", async () => {
  // Run the deployed file as an actual ES module — the same thing the runtime
  // does. If createClient were not bound in module scope this throws
  // ReferenceError at the first request instead of returning a 500.
  const src = readDeployed();
  const stubUrl = pathToFileURL(path.join(__dirname, "fixtures", "supabase-js-stub.mjs")).href;

  let served = null;
  const deno = {
    serve: (handler) => { served = handler; },
    env: {
      get: (k) => ({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        SUPABASE_ANON_KEY: "anon-key"
      }[k])
    }
  };
  // A module reaches Deno through the global object, exactly as in production.
  globalThis.Deno = deno;

  const patched = src.replace(
    /from\s*["']npm:@supabase\/supabase-js@2["']/,
    'from "' + stubUrl + '"'
  );
  assert.notStrictEqual(patched, src, "the npm: import must be present to rewrite");

  // The runtime strips types before executing, so do the same, then import the
  // result as a real ES module (no vm, no data: URL). This is the step that
  // would have thrown "createClient is not defined" in production.
  const ts = require("typescript");
  const js = ts.transpileModule(patched, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: "rb-notify.ts"
  }).outputText;

  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "rb-run-"));
  const modFile = path.join(dir, "rb-notify.mjs");
  fs.writeFileSync(modFile, js);
  try {
    await import(pathToFileURL(modFile).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.strictEqual(typeof served, "function", "the file must call Deno.serve");

  const pre = await served(new Request("https://example.test/rb-notify", { method: "OPTIONS" }));
  assert.strictEqual(pre.status, 200);
  assert.strictEqual(pre.headers.get("Access-Control-Allow-Origin"), "*");

  const res = await served(new Request("https://example.test/rb-notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "system" })
  }));
  const body = await res.json();

  assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.doesNotMatch(JSON.stringify(body), /createClient is not defined/);
  assert.match(String(body.error || ""), /sign in/i,
    "an unauthenticated request must get the auth error, not a crash");

  // createClient was really called: the stub counts every invocation.
  assert.ok(globalThis.__createClientCalls >= 1, "createClient() was never reached");
});

test("the build refuses to emit a file that calls createClient without importing it", () => {
  const script = path.join(ROOT, "tools", "build-functions.js");

  // Run the real build in a copy of the repo (node_modules symlinked) with the
  // createClient import surgically removed — the precise regression.
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "rb-guard-"));
  try {
    for (const entry of ["supabase", "tools", "notify.js", "package.json"]) {
      const from = path.join(ROOT, entry);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");

    const bad = path.join(dir, "supabase", "functions", "src", "rb-notify.ts");
    const src = fs.readFileSync(bad, "utf8").replace(
      /^import \{ createClient \}.*$/m,
      "// import removed on purpose: this is the bug that shipped"
    );
    fs.writeFileSync(bad, src);

    const r = spawnSync(process.execPath, [path.join(dir, "tools", "build-functions.js")],
      { cwd: dir, encoding: "utf8" });
    const out = String(r.stdout || "") + String(r.stderr || "");

    assert.notStrictEqual(r.status, 0, "the build must fail when createClient is not imported");
    assert.match(out, /createClient is not defined/,
      "the failure must name the bug, so it is obvious in the build log");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the build refuses to emit a file with a syntax error", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "rb-syntax-"));
  try {
    for (const entry of ["supabase", "tools", "notify.js", "package.json"]) {
      const from = path.join(ROOT, entry);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");

    const bad = path.join(dir, "supabase", "functions", "src", "rb-delete-account.ts");
    fs.writeFileSync(bad, fs.readFileSync(bad, "utf8") + "\nconst oops = ;\n");

    const r = spawnSync(process.execPath, [path.join(dir, "tools", "build-functions.js")],
      { cwd: dir, encoding: "utf8" });
    assert.notStrictEqual(r.status, 0, "a syntax error must fail the build, not the deployed function");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
