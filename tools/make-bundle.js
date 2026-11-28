#!/usr/bin/env node
// tools/make-bundle.js — builds the OTA content bundle (Part 2 of the updater).
//
// WHAT THIS PRODUCES
// ------------------
// A zip of the web files the app actually loads, plus `rb-bundle.json`
// describing it, and the exact JSON to paste into version.json:
//
//   bundle_url      where you upload the zip
//   bundle_version  must go UP every time, or phones ignore it
//   bundle_sha256   the hash the phone verifies before adopting it
//
// WHY A HASH, AND WHY IT IS COMPUTED THIS WAY
// -------------------------------------------
// The phone cannot trust a download. The hash lets it refuse a bundle that was
// corrupted in transit or replaced with something else.
//
// The algorithm has to match BundleManager.hashFiles() in the Android code
// exactly, or every bundle is rejected. It is:
//
//   for each file, in manifest order:
//       sha256( name + "\0" + sha256(file bytes) as hex + "\n" )
//   then sha256 of all of those bytes concatenated
//
// The per-file hex digest makes it independent of how the zip was compressed
// (timestamps, compression level), so re-zipping identical files yields the
// same hash and an unchanged bundle is never re-downloaded. The test suite
// checks this implementation against the Java one on a real bundle.
//
// Run:  node tools/make-bundle.js [--out dist] [--version N]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

// The files a bundle may contain. This is the same list prepare-www.js copies
// into the APK, minus things that must never be swapped at runtime:
//
//   rb-build.js   carries the build stamp (version, Firebase flag) that only a
//                 real APK build can set honestly. A bundle must not rewrite it.
//   sw.js         the service worker belongs to the website; the APK ignores it.
//
// Everything else is plain UI/logic and is safe to update over the air.
const BUNDLE_FILES = [
  "index.html",
  "auth-callback.html",
  "styles.css",
  "config.js",
  "notify.js",
  "update.js",
  "auth.js",
  "store.js",
  "qbooks.js",
  "qbooks-ui.js",
  "push.js",
  "rtc.js",
  "app.js",
  "terms.html",
  "privacy.html",
  "manifest.webmanifest",
  "vendor/supabase.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png"
];

/** Files that must never appear in a bundle, with the reason. */
const FORBIDDEN = {
  "rb-build.js": "the build stamp must come from a real APK build",
  "sw.js": "the service worker belongs to the website, not the APK",
  "capacitor.js": "injected by the native runtime"
};

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * The bundle hash, byte for byte identical to BundleManager.hashFiles().
 * @param {{name:string, bytes:Buffer}[]} entries in manifest order
 */
function bundleHash(entries) {
  const digest = crypto.createHash("sha256");
  for (const entry of entries) {
    digest.update(Buffer.from(entry.name, "utf8"));
    digest.update(Buffer.from([0]));
    digest.update(Buffer.from(sha256(entry.bytes), "utf8"));
    digest.update(Buffer.from("\n", "utf8"));
  }
  return digest.digest("hex");
}

// --------------------------------------------------------------------- zip
//
// A deliberate, minimal ZIP writer. Adding an archiver dependency for this
// would mean the released bundle depends on a package that can change
// behaviour under us; the format is small and stable, and writing it here keeps
// the bundle reproducible.
//
// Every entry is DEFLATE-compressed with a fixed timestamp of 1980-01-01, so
// running this twice on the same sources produces the same bytes. That matters
// for the CI check that compares hashes.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(entries) {
  const zlib = require("zlib");
  const chunks = [];
  const central = [];
  let offset = 0;

  // Fixed DOS timestamp: 1980-01-01 00:00:00
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.bytes;
    const crc = crc32(raw);

    // Deflate; if it does not shrink, store instead (method 0).
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);       // compression
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central directory signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0, 8);               // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0, 38);              // external attrs
    cd.writeUInt32LE(offset, 42);         // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// -------------------------------------------------------------------- build

function build(opts) {
  const options = opts || {};
  const outDir = options.outDir || path.join(ROOT, "dist");
  const version = Number(options.version) || 1;

  const entries = [];
  const missing = [];
  for (const rel of BUNDLE_FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { missing.push(rel); continue; }
    entries.push({ name: rel, bytes: fs.readFileSync(full) });
  }
  if (missing.length) {
    throw new Error("Missing web files: " + missing.join(", "));
  }

  // Belt and braces: a forbidden file must never reach a bundle even if the
  // list above is edited carelessly.
  for (const entry of entries) {
    if (FORBIDDEN[entry.name]) {
      throw new Error(entry.name + " must not be in a bundle: " + FORBIDDEN[entry.name]);
    }
  }
  if (!entries.some(e => e.name === "index.html")) {
    throw new Error("A bundle without index.html cannot start the app.");
  }

  const hash = bundleHash(entries);
  const manifest = {
    bundle_version: version,
    sha256: hash,
    files: entries.map(e => e.name)
  };

  // The manifest goes in last so `files` lists exactly the payload.
  const withManifest = entries.concat([{
    name: "rb-bundle.json",
    bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")
  }]);

  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, "bundle.zip");
  const zipBytes = zip(withManifest);
  fs.writeFileSync(zipPath, zipBytes);

  const totalRaw = entries.reduce((n, e) => n + e.bytes.length, 0);

  return {
    zipPath,
    zipBytes: zipBytes.length,
    rawBytes: totalRaw,
    version,
    sha256: hash,
    files: entries.map(e => e.name),
    manifest
  };
}

/** The snippet to paste into version.json. */
function manifestSnippet(result, url) {
  return {
    bundle_url: url || "https://mahicouragw.github.io/Register-book/bundle.zip",
    bundle_version: result.version,
    bundle_sha256: result.sha256,
    bundle_notes: "Content update " + result.version
  };
}

module.exports = { build, bundleHash, zip, sha256, BUNDLE_FILES, FORBIDDEN, manifestSnippet };

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  try {
    const result = build({
      outDir: getArg("--out", path.join(ROOT, "dist")),
      version: Number(getArg("--version", "1"))
    });
    console.log("Built " + path.relative(ROOT, result.zipPath));
    console.log("  files    : " + result.files.length);
    console.log("  raw      : " + (result.rawBytes / 1024).toFixed(1) + " KB");
    console.log("  zip      : " + (result.zipBytes / 1024).toFixed(1) + " KB");
    console.log("  sha256   : " + result.sha256);
    console.log("");
    console.log("Add to version.json:");
    console.log(JSON.stringify(manifestSnippet(result), null, 2));
  } catch (e) {
    console.error("FAILED: " + e.message);
    process.exit(1);
  }
}
