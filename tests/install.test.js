// Tests for the "Install RegisterBook" flow.
//
// Why this exists: push notifications are delivered to the SERVICE WORKER, not
// to a tab. Android only gives a web app that delivery path once it is
// INSTALLED (Chrome turns it into a WebAPK) — a bookmarked tab stops receiving
// pushes once its tab is closed. iPhone Safari needs Share → Add to Home
// Screen. So installing is not decoration: it is the difference between
// "notifications work while the app is open" and "notifications work whenever
// someone sends one, even if you are in a different app".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

// jsdom has no matchMedia, so we supply one we can flip on and off.
function loadApp(opts) {
  const o = opts || {};
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "https://rb.test/Register-book/",
    runScripts: "dangerously",
    pretendToBeVisual: true
  });
  const w = dom.window;
  w.supabase = { createClient() { return null; } };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.confirm = () => true;
  w.prompt = () => "x";

  const standalone = !!o.standalone;
  w.matchMedia = q => ({
    media: q,
    matches: q.indexOf("standalone") >= 0 ? standalone : false,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}
  });

  w.eval(fs.readFileSync(path.join(ROOT, "config.js"), "utf8"));
  w.RB_CONFIG = {
    SUPABASE_URL: "https://REPLACE.supabase.co",
    SUPABASE_ANON_KEY: "REPLACE",
    SITE_URL: "https://mahicouragw.github.io/Register-book/",
    isConfigured() { return false; },
    projectRef() { return ""; }
  };
  ["notify.js", "auth.js", "store.js", "qbooks.js", "push.js", "rtc.js", "app.js", "qbooks-ui.js"]
    .forEach(f => w.eval(fs.readFileSync(path.join(ROOT, f), "utf8")));
  return { dom, w, doc: w.document };
}
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

function fireInstallPrompt(w, outcome) {
  const evt = new w.Event("beforeinstallprompt");
  let prompted = false;
  evt.prompt = () => { prompted = true; };
  evt.userChoice = Promise.resolve({ outcome: outcome || "accepted" });
  w.dispatchEvent(evt);
  return () => prompted;
}

test("install status: a browser tab is not installed and says why it matters", async () => {
  const { dom, w } = loadApp();
  await w.__RB.boot();

  const st = w.RBPush.installStatus();
  assert.equal(st.installed, false, "a normal browser tab is not installed");
  assert.equal(st.canPrompt, false, "and the phone is not offering to install yet");
  assert.match(st.why, /only arrive while the app is open/i, "it explains the consequence plainly");
  assert.ok(st.howTo.length > 20, "and gives real steps, not a dead end");
  dom.window.close();
});

test("install status: once installed, it says the app can wake up when closed", async () => {
  const { dom, w } = loadApp({ standalone: true });
  await w.__RB.boot();

  const st = w.RBPush.installStatus();
  assert.equal(st.installed, true);
  assert.equal(st.canPrompt, false, "an installed app is never asked to install again");
  assert.match(st.why, /even when it is closed/i);
  dom.window.close();
});

test("install prompt: the phone's own install sheet is used, and acceptance is reported", async () => {
  const { dom, w } = loadApp();
  await w.__RB.boot();

  // before the browser offers it, we must never crash and must give the manual steps
  const before = await w.RBPush.promptInstall();
  assert.equal(before.ok, false);
  assert.equal(before.reason, "no-prompt");
  assert.match(before.message, /Add to Home Screen|Install app|Install RegisterBook/i);

  // the browser offers to install
  const wasPrompted = fireInstallPrompt(w, "accepted");
  assert.equal(w.RBPush.canPromptInstall(), true, "the offer is remembered");

  const res = await w.RBPush.promptInstall();
  assert.equal(res.ok, true, "accepted");
  assert.equal(res.outcome, "accepted");
  assert.equal(wasPrompted(), true, "the phone's install sheet was actually shown");
  assert.equal(w.RBPush.canPromptInstall(), false, "and the offer is used up");
  dom.window.close();
});

test("install prompt: dismissing is handled without nagging or crashing", async () => {
  const { dom, w } = loadApp();
  await w.__RB.boot();
  fireInstallPrompt(w, "dismissed");

  const res = await w.RBPush.promptInstall();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "dismissed");
  assert.equal(res.outcome, "dismissed");
  dom.window.close();
});

test("Settings shows a big Install card when not installed, and hides it once installed", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.setView("settings");
  await tick();

  let body = doc.getElementById("notifBody").textContent;
  assert.match(body, /Install RegisterBook on this phone/, "the card is shown on a plain tab");

  // nothing to press yet, so the manual steps must be spelled out
  assert.ok(doc.querySelector("#notifBody .how-to"), "with written how-to steps");

  // the browser offers to install → a real button appears, properly labelled
  fireInstallPrompt(w, "accepted");
  w.renderNotificationSettings();
  await tick();
  const btn = doc.querySelector('#notifBody button[onclick="installRegisterBook()"]');
  assert.ok(btn, "an install button appears");
  assert.match(btn.getAttribute("aria-label"), /Install RegisterBook/i, "with a screen-reader label");

  // press it
  btn.click();
  await tick(30);
  assert.match(doc.getElementById("notifResult").textContent, /Installed|install/i);
  dom.window.close();
});

test("Settings hides the install card once the app is on the home screen", async () => {
  const { dom, w, doc } = loadApp({ standalone: true });
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.setView("settings");
  await tick();

  const body = doc.getElementById("notifBody").textContent;
  assert.doesNotMatch(body, /Install RegisterBook on this phone/, "no install card when already installed");
  dom.window.close();
});

test("the honest-limits text still tells iPhone users about Add to Home Screen", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.setView("settings");
  await tick();
  assert.match(doc.getElementById("notifBody").textContent, /Add to Home Screen/i);
  dom.window.close();
});
