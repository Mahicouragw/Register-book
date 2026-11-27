// tools/prepare-www.js — copy the website files into www/ for Capacitor.
//
// The repo root IS the website (GitHub Pages serves it directly), but
// Capacitor wants a clean webDir without node_modules, .git, tests, etc.
// This script copies exactly the files the app needs into www/.
//
// Run:  node tools/prepare-www.js
// Then: npx cap sync   (copies www/ into the android project)
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WWW = path.join(ROOT, "www");

const FILES = [
  "index.html",
  "styles.css",
  "config.js",
  "notify.js",
  "auth.js",
  "store.js",
  "qbooks.js",
  "qbooks-ui.js",
  "push.js",
  "rtc.js",
  "app.js",
  "sw.js",
  "manifest.webmanifest",
  "terms.html",
  "privacy.html",
  "vendor/supabase.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png"
];

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

let copied = 0;
for (const rel of FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    console.warn("  (missing, skipped) " + rel);
    continue;
  }
  const dest = path.join(WWW, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied++;
  console.log("  " + rel);
}

console.log(`www/ ready — ${copied} files copied.`);
