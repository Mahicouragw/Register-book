#!/usr/bin/env node
// Builds the deployable Edge Functions.
//
// Supabase deploys each function as a single file, but the tested shared
// modules (the notification wording in notify.js and the Web Push crypto in
// _shared/webpush.js) must live in exactly one place. This script inlines them
// into supabase/functions/<name>/index.ts.
//
// Registry imports (jsr: and npm:) are left alone — the Supabase runtime
// fetches those itself.
//
// Run: npm run build:functions
const fs = require("fs");
const path = require("path");

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

function build(name) {
  const entry = path.join(SRC, name + ".ts");
  if (!fs.existsSync(entry)) throw new Error("Missing source: " + entry);

  let code = inlineFile(entry, new Set());

  // The shared modules are plain ES-module JavaScript; drop the `export`
  // keyword so their declarations become local to the deployed file.
  code = code.replace(/^export\s+(async\s+function|function|const|let|class)/gm, "$1");

  const leftover = code.split("\n").filter(l => RELATIVE_IMPORT.test(l));
  if (leftover.length) throw new Error("Un-inlined imports remain in " + name + ": " + leftover.join(" | "));

  const banner =
    "// GENERATED FILE — do not edit by hand.\n" +
    "// Source: supabase/functions/src/" + name + ".ts\n" +
    "// Rebuild with:  npm run build:functions\n\n";

  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, "index.ts");
  fs.writeFileSync(outFile, banner + code);
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
