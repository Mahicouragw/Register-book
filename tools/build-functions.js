#!/usr/bin/env node
// Builds the deployable Edge Functions.
//
// Supabase deploys each function as a single file, but the tested shared
// modules (the notification wording in notify.js, the Web Push crypto and the
// FCM sender in _shared/) must live in exactly one place. This script inlines
// them into supabase/functions/<name>/index.ts.
//
// Registry imports (npm:) are left alone — the Supabase runtime fetches those
// itself, and leaving them alone is the whole point:
//
//   DO NOT WRAP, ENCODE, OR STRIP IMPORTS.
//
// An earlier version of this script gzip+base64'd rb-notify's body and loaded
// it through a `data:` URL, and to make that work it stripped the import lines
// and handed createClient over as `globalThis.__RB_createClient`. An ES module
// has its own scope, so the bare createClient(...) inside the body never saw
// that global: every send died with "createClient is not defined", which the
// app showed as "Could not send: createClient is not defined". The wrapper also
// turned a plain syntax error into an opaque boot failure.
//
// The deployed file is now the obviously-correct thing: one ordinary ES module
// with its imports at the top, where the runtime resolves them normally.
// assertCreateClientBound() below still runs on every build, so the file simply
// cannot be emitted with an unbound createClient call.
//
// Run: npm run build:functions
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "supabase", "functions", "src");
const OUT = path.join(ROOT, "supabase", "functions");

// Matches `import x from "./y.js"` and `import "./y.js"`, allowing a trailing
// comment on the same line.
const RELATIVE_IMPORT = /^(\s*import\s+(?:[^'"]*?from\s+)?)["'](\.[^"']+)["'];?/;

function inlineFile(file, seen) {
  const src = fs.readFileSync(file, "utf8");
  const out = [];
  for (const line of src.split("\n")) {
    const m = line.match(RELATIVE_IMPORT);
    if (!m) { out.push(line); continue; }

    const target = path.resolve(path.dirname(file), m[2]);
    if (!fs.existsSync(target)) throw new Error("Cannot find " + m[2] + " (from " + file + ")");
    const key = path.relative(ROOT, target).split(path.sep).join("/");
    const rest = line.slice(m[0].length);

    if (seen.has(key)) {
      out.push(`// (${key} already inlined above)`);
    } else {
      seen.add(key);
      out.push(`// ---- inlined from ${key} ----`);
      out.push(inlineFile(target, seen));
      out.push(`// ---- end of ${key} ----`);
    }
    if (rest.trim()) out.push(rest);
  }
  return out.join("\n");
}

/**
 * Refuses to emit a file that calls createClient() without importing it.
 *
 * This is the regression guard that would have caught "createClient is not
 * defined" before it reached the owner's phone.
 */
function assertCreateClientBound(name, code) {
  if (!/\bcreateClient\s*\(/.test(code)) return; // function does not use it
  const importsIt = /import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*["'][^"']+["']/.test(code);
  const definesIt = /(?:const|let|var|function)\s+createClient\b/.test(code);
  if (!importsIt && !definesIt) {
    throw new Error(
      name + " calls createClient() but never imports it — the deployed function would throw " +
      "\"createClient is not defined\" on the first request. Keep the import at the top of the file."
    );
  }
}

function build(name) {
  const entry = path.join(SRC, name + ".ts");
  if (!fs.existsSync(entry)) throw new Error("Missing source: " + entry);

  let code = inlineFile(entry, new Set());

  // The shared modules are plain ES-module JavaScript; drop the `export`
  // keyword so their declarations become local to the deployed file.
  code = code.replace(/^export\s+(async\s+function|function|const|let|class)/gm, "$1");

  const leftover = code.split("\n").filter(l => RELATIVE_IMPORT.test(l));
  if (leftover.length) throw new Error("Un-inlined imports remain in " + name + ": " + leftover.join(" | "));

  // Keep the payload pure ASCII: the deploy path is not guaranteed to
  // round-trip non-ASCII reliably, and a mangled string literal is a syntax
  // error nobody can see until the function fails to boot.
  code = code.replace(/[^\x00-\x7F]/g, (m) => ({
    "\u2014": "-", "\u2019": "'", "\u201c": '"', "\u201d": '"',
    "\u2026": "...", "\u2192": "->", "\u2022": "*", "\u00a0": " "
  }[m] || "?"));

  assertCreateClientBound(name, code);

  // Syntax-check what is actually shipped. A transpile is a full parse, so a
  // broken literal or a duplicate declaration fails the build instead of the
  // function.
  const parsed = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true },
    reportDiagnostics: true,
    fileName: name + ".ts"
  });
  if (parsed.diagnostics && parsed.diagnostics.length) {
    const first = parsed.diagnostics[0];
    throw new Error("syntax error: " + ts.flattenDiagnosticMessageText(first.messageText, " "));
  }

  const banner =
    "// GENERATED FILE - do not edit by hand.\n" +
    "// Source: supabase/functions/src/" + name + ".ts\n" +
    "// Rebuild with:  npm run build:functions\n\n";

  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, "index.ts");

  const file = banner + code;
  // The whole file must be ASCII, banner included: one stray em dash in a
  // comment is harmless, but the rule is easier to trust than to exception.
  const nonAscii = file.match(/[^\x00-\x7F]/g);
  if (nonAscii) throw new Error("non-ASCII characters survived into the output: " + nonAscii.join(" "));

  fs.writeFileSync(outFile, file);
  return { outFile, bytes: Buffer.byteLength(code) };
}

const NAMES = ["rb-notify", "rb-delete-account", "rb-turn-credentials"];
let failed = false;
for (const n of NAMES) {
  try {
    const r = build(n);
    console.log(`built supabase/functions/${n}/index.ts  (${r.bytes} bytes)`);
  } catch (e) {
    failed = true;
    console.error("FAILED " + n + ": " + e.message);
  }
}
process.exit(failed ? 1 : 0);
