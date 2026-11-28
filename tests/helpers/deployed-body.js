// Reads the code that actually runs in the deployed Edge Function.
//
// This used to have to inflate a gzip bundle, because rb-notify shipped its
// body base64'd. That wrapper is gone: the deployed file is a plain ES module
// again. The helper stays because tests should agree on one definition of
// "what runs", and because a future deploy format change should only have to
// be handled here.
//
// Asserting against the outer file alone is how "createClient is not defined"
// shipped: the text that ran was never inspected by a test.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

/** The deployable source of a function — exactly what the platform runs. */
function deployedSource(name) {
  return fs.readFileSync(path.join(ROOT, "supabase", "functions", name, "index.ts"), "utf8");
}

/** The same file; kept so callers that say "wrapper" still read clearly. */
function wrapperSource(name) {
  return deployedSource(name);
}

module.exports = { deployedSource, wrapperSource, ROOT };
