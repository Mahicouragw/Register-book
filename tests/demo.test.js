// Automated DOM tests for RegisterBook (demo mode + view-only rules)
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadApp(opts) {
  const options = opts || {};
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "https://rb.test/Register-book/",
    runScripts: "dangerously",
    pretendToBeVisual: true
  });
  const w = dom.window;
  w.supabase = { createClient() { return null; } }; // vendor bundle stub
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.confirm = () => true;
  w.prompt = () => "Edited by test";
  // Unless asked otherwise, these UI tests run with the "not configured yet" state
  // (the configured/Google paths have their own suite in auth-config.test.js).
  w.eval(fs.readFileSync(path.join(ROOT, "config.js"), "utf8"));
  if (!options.configured) {
    w.RB_CONFIG = {
      SUPABASE_URL: "https://REPLACE_WITH_NEW_REGISTERBOOK_URL.supabase.co",
      SUPABASE_ANON_KEY: "REPLACE_WITH_NEW_ANON_KEY",
      SITE_URL: "https://mahicouragw.github.io/Register-book/",
      isConfigured() { return false; },
      projectRef() { return ""; }
    };
  }
  ["notify.js", "auth.js", "store.js", "qbooks.js", "push.js", "rtc.js", "app.js", "qbooks-ui.js"].forEach(f => w.eval(fs.readFileSync(path.join(ROOT, f), "utf8")));
  return { dom, w, doc: w.document };
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function currentMonthName() {
  return new Date().toLocaleDateString("en-US", { month: "long" });
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function addLines(w, doc, regId, texts, extra) {
  for (const t of texts) {
    doc.getElementById("newLineText").value = t;
    if (extra) extra(doc);
    await w.addLine(regId);
  }
}

test("login gate: Google button present, friendly message when Supabase is not configured", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();

  assert.equal(doc.getElementById("appShell").classList.contains("show"), false, "app should stay hidden before login");
  assert.ok(doc.getElementById("loginGate").classList.contains("hidden") === false, "gate should be visible");
  assert.match(doc.getElementById("googleLoginBtn").textContent, /Continue with Google/);
  assert.equal(doc.querySelectorAll("#gateDemoChips .demo-chip").length, 6, "six demo people on the gate");
  assert.match(doc.getElementById("authHint").textContent, /not connected|placeholder/i);

  doc.getElementById("googleLoginBtn").click();
  await tick(20);
  assert.match(doc.getElementById("authHint").textContent, /not connected|placeholder|Create the new RegisterBook/i);
  assert.match(doc.getElementById("authHint").className, /err/);

  dom.window.close();
});

test("demo login + create register: date auto-filled, 10 lines per page, auto page shift", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");

  assert.ok(doc.getElementById("appShell").classList.contains("show"), "app visible in demo");
  assert.match(doc.getElementById("accountCard").textContent, /Goldfish/);
  assert.match(doc.getElementById("modeBadge").textContent, /Demo/i);

  w.openCreateModal();
  const dateText = doc.getElementById("newRegDatePreview").textContent;
  assert.match(dateText, /auto-filled/);
  const weekday = new Date().toLocaleDateString("en-US", { weekday: "long" });
  assert.match(dateText, new RegExp(weekday));

  doc.getElementById("newRegName").value = "Test Checklist";
  doc.getElementById("newRegType").value = "Medical Checklist";
  await w.createRegister();

  const regId = w.__RB.state.reg.id;
  assert.ok(regId, "register created");
  assert.equal(w.__RB.state.view, "registerDetail");
  assert.match(doc.getElementById("view-registerDetail").textContent, /Test Checklist/);
  assert.equal(doc.querySelectorAll("#view-registerDetail .paper-body .line").length, 10, "a page shows 10 lines");
  assert.equal(doc.getElementById("newLineDate").value, todayIso(), "new line date is today");

  await addLines(w, doc, regId, Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`));
  assert.equal(w.__RB.store.entriesOf(regId).length, 10);
  assert.equal(w.__RB.state.reg.page, 1, "10 lines still on page 1");
  assert.match(doc.querySelector(".page-info").textContent, /Page 1 of 1/);

  doc.getElementById("newLineText").value = "Line 11";
  await w.addLine(regId);
  assert.equal(w.__RB.store.entriesOf(regId).length, 11);
  assert.equal(w.__RB.state.reg.page, 2, "11th line moved to page 2");
  assert.match(doc.querySelector(".page-info").textContent, /Page 2 of 2/);
  assert.match(doc.getElementById("toast").textContent, /full — moved to Page 2/);

  // page navigation
  w.changePage(-1);
  assert.equal(w.__RB.state.reg.page, 1);
  doc.getElementById("gotoPage").value = "2";
  w.gotoPageInput(2);
  assert.equal(w.__RB.state.reg.page, 2);

  dom.window.close();
});

test("smart search: month names, fuzzy misspellings, page numbers and jump-to-page", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("silverfish"); // the seed shares Goldfish's medicine checklist with Silverfish

  const reg = w.__RB.store.sharedWithMe().find(r => /Medicine/i.test(r.name));
  assert.ok(reg, "Silverfish can see the shared medicine checklist");
  w.openRegister(reg.id);
  assert.ok(doc.querySelector(".view-only-banner"), "view-only banner on a shared book");

  const month = currentMonthName();
  const fuzzy = month.toLowerCase().replace(/e/, ""); // e.g. october -> octobr
  w.handleInsideSearch(fuzzy);
  const items = doc.querySelectorAll("#insideSuggest .sug-item");
  assert.ok(items.length > 0, `suggestions appear for "${fuzzy}"`);
  const first = items[0].textContent;
  assert.match(first, /Page \d+/);
  assert.match(first, new RegExp(month, "i"));
  assert.match(first, /•\s*\d+\s*lines?/);

  items[0].click();
  assert.ok(w.__RB.state.reg.highlightDate, "clicking a suggestion highlights that day");
  assert.ok(doc.querySelectorAll("#view-registerDetail .line.highlight").length > 0);

  // page-number search
  w.handleInsideSearch("page 2");
  const pageItems = doc.querySelectorAll("#insideSuggest .sug-item");
  assert.ok(pageItems.length > 0);
  assert.match(pageItems[0].textContent, /Page 2/);
  pageItems[0].click();
  assert.equal(w.__RB.state.reg.page, 2);

  // "23 Oct" style and bare month number
  const dayQuery = `1 ${month.slice(0, 3)}`;
  w.handleInsideSearch(dayQuery);
  assert.ok(doc.querySelectorAll("#insideSuggest .sug-item").length > 0, `suggestions for "${dayQuery}"`);
  w.handleInsideSearch(String(new Date().getMonth() + 1));
  assert.ok(doc.querySelectorAll("#insideSuggest .sug-item").length > 0, "bare month number works");

  dom.window.close();
});

test("Goldfish → Silverfish: share view-only, Silverfish can read + search but cannot edit", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");

  w.openCreateModal();
  doc.getElementById("newRegName").value = "Shared Checklist";
  doc.getElementById("newRegType").value = "Medical Checklist";
  await w.createRegister();
  const regId = w.__RB.state.reg.id;
  await addLines(w, doc, regId, ["Aspirin 75mg", "Insulin vial"]);

  // share through the modal: search name → suggestion → share
  w.openShareModal(regId);
  const input = doc.getElementById("shareUserInput");
  input.value = "Silver";
  w.handleShareUserInput("Silver");
  const suggestions = doc.querySelectorAll("#shareSuggest div");
  assert.ok(suggestions.length > 0, "name suggestions appear");
  suggestions[0].click();
  assert.match(doc.getElementById("shareSelected").textContent, /Silverfish/);
  await w.doShare();

  const shares = w.__RB.store.sharesOf(regId);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].sharedWithUserId, "silverfish");
  assert.equal(shares[0].permission, "view");
  assert.match(doc.getElementById("shareExisting").textContent, /Silverfish/);

  // switch to Silverfish
  w.enterDemo("silverfish");
  assert.match(doc.getElementById("accountCard").textContent, /Silverfish/);
  assert.ok(w.__RB.store.sharedWithMe().some(r => r.id === regId), "register appears in Shared With Me");
  w.openRegister(regId);

  assert.ok(doc.querySelector(".view-only-banner"), "view-only banner is shown");
  assert.match(doc.querySelector(".view-only-banner").textContent, /cannot add, edit or delete/i);
  assert.equal(doc.getElementById("newLineText"), null, "no add-line box for a viewer");
  assert.equal(doc.getElementById("newLineDate"), null);
  assert.equal(doc.querySelectorAll(".line-actions button").length, 0, "no edit buttons for a viewer");

  // search still works for the viewer
  w.handleInsideSearch(currentMonthName().slice(0, 4));
  assert.ok(doc.querySelectorAll("#insideSuggest .sug-item").length > 0, "viewer can search");

  // the model layer refuses writes too (defence in depth on top of UI)
  const before = w.__RB.store.entriesOf(regId).length;
  await w.addLine(regId);
  assert.equal(w.__RB.store.entriesOf(regId).length, before, "viewer cannot add a line");
  assert.match(doc.getElementById("toast").textContent, /View only/);

  const entryId = w.__RB.store.entriesOf(regId)[0].id;
  await w.deleteEntry(entryId);
  assert.equal(w.__RB.store.entriesOf(regId).length, before, "viewer cannot delete a line");
  await w.toggleDone(entryId);
  assert.equal(w.__RB.store.entriesOf(regId)[0].done, false, "viewer cannot change a line");

  // back to the owner — editing works again
  w.enterDemo("goldfish");
  w.openRegister(regId);
  assert.ok(doc.getElementById("newLineText"), "owner sees the add-line box");
  await addLines(w, doc, regId, ["Added by Goldfish"]);
  assert.equal(w.__RB.store.entriesOf(regId).length, before + 1);

  dom.window.close();
});

test("groups: create group, group chat, share register to the whole group", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");

  w.openCreateModal();
  doc.getElementById("newRegName").value = "Group Book";
  doc.getElementById("newRegType").value = "Stock Register";
  await w.createRegister();
  const regId = w.__RB.state.reg.id;
  await addLines(w, doc, regId, ["Gloves", "Masks"]);

  w.openGroupModal();
  doc.getElementById("newGroupName").value = "Test Ward";
  const cb = doc.querySelector('#newGroupMembers input[value="silverfish"]');
  assert.ok(cb, "Silverfish is in the member picker");
  cb.checked = true;
  await w.createGroup();

  const groupId = w.__RB.state.groupId;
  assert.ok(groupId, "group created and opened");
  assert.match(doc.getElementById("view-groups").textContent, /Test Ward/);
  assert.ok(w.__RB.store.myGroups().some(g => g.id === groupId));

  doc.getElementById("groupChatInput").value = "Hello ward team";
  await w.sendGroupMsg(groupId);
  assert.ok(w.__RB.store.groupMessages(groupId).some(m => m.text === "Hello ward team"));

  w.openShareToGroupModal(groupId);
  assert.equal(doc.getElementById("shareRegSelect").value, regId, "share modal preselects the open register");
  await w.doShare();
  const groupShare = w.__RB.store.sharesOf(regId).find(s => s.sharedWithUserId === "silverfish");
  assert.ok(groupShare, "group share created a share for Silverfish");
  assert.equal(groupShare.groupId, groupId);

  // Silverfish sees the group, its message and the shared book
  w.enterDemo("silverfish");
  assert.ok(w.__RB.store.myGroups().some(g => g.id === groupId), "Silverfish is a member");
  w.openGroup(groupId);
  assert.match(doc.getElementById("view-groups").textContent, /Hello ward team/);
  assert.ok(w.__RB.store.sharedWithMe().some(r => r.id === regId), "group-shared book is in Shared With Me");

  dom.window.close();
});

test("people & friends: request → accept, then private chat messages", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("mahi");

  await w.askFriend("rahul");
  assert.ok(w.__RB.store.pendingOutgoing().some(f => f.toUser === "rahul"), "Mahi sent a request to Rahul");

  w.enterDemo("rahul");
  const incoming = w.__RB.store.pendingIncoming().find(f => f.fromUser === "mahi");
  assert.ok(incoming, "Rahul sees the request");
  await w.respondFriend(incoming.id, "accepted");
  assert.ok(w.__RB.store.isFriend("mahi"), "Rahul and Mahi are friends");

  w.enterDemo("mahi");
  assert.ok(w.__RB.store.isFriend("rahul"), "friendship works both ways");

  w.openChat("rahul");
  doc.getElementById("chatInput").value = "Hello Rahul";
  await w.sendChat("rahul");
  assert.ok(w.__RB.store.messagesBetween("rahul").some(m => m.text === "Hello Rahul"));

  w.enterDemo("rahul");
  w.openChat("mahi");
  assert.match(doc.getElementById("chatMsgs").textContent, /Hello Rahul/, "Rahul receives the message");

  // the call screen opens, and in demo mode it says plainly that there is no
  // second phone — it never pretends a call is connected
  doc.querySelector('button[onclick*="startCall"]').click();
  const overlay = doc.getElementById("callOverlay");
  assert.equal(overlay.style.display, "flex", "call screen opens");
  assert.match(overlay.textContent, /Ringing|no second phone|demo/i, "demo call is labelled honestly");
  assert.ok(overlay.querySelector("#callActions .btn-end"), "there is an end-call button");
  w.hideCallScreen();
  assert.equal(overlay.style.display, "none", "call screen closes");

  dom.window.close();
});

test("bill book: qty + ₹ amount with page total and book total", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");

  w.openCreateModal();
  doc.getElementById("newRegName").value = "Bills Test";
  doc.getElementById("newRegType").value = "Bill Book";
  await w.createRegister();
  const regId = w.__RB.state.reg.id;

  assert.ok(doc.getElementById("newLineQty"), "qty input exists for a Bill Book");
  assert.ok(doc.getElementById("newLineAmt"), "amount input exists for a Bill Book");

  doc.getElementById("newLineText").value = "Bandages";
  doc.getElementById("newLineQty").value = "3";
  doc.getElementById("newLineAmt").value = "150";
  await w.addLine(regId);

  let text = doc.querySelector(".page-bar").textContent;
  assert.match(text, /Page total: ₹150/);
  assert.match(text, /Book total: ₹150/);
  const entry = w.__RB.store.entriesOf(regId)[0];
  assert.equal(entry.qty, 3);
  assert.equal(entry.amount, 150);

  doc.getElementById("newLineText").value = "Gloves";
  doc.getElementById("newLineQty").value = "2";
  doc.getElementById("newLineAmt").value = "50";
  await w.addLine(regId);
  text = doc.querySelector(".page-bar").textContent;
  assert.match(text, /Page total: ₹200/);
  assert.match(text, /Book total: ₹200/);

  dom.window.close();
});

test("demo data is shared between demo people in one browser (localStorage)", async () => {
  const { dom, w } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.openCreateModal();
  w.document.getElementById("newRegName").value = "Persisted Book";
  await w.createRegister();
  const id = w.__RB.state.reg.id;

  // same page, switch user
  w.enterDemo("mahi");
  assert.ok(!w.__RB.store.registersVisible().some(r => r.id === id), "private until shared");

  // wipe in-memory state and re-load from localStorage
  w.__RB.store.initDemo("goldfish");
  assert.ok(w.__RB.store.myRegisters().some(r => r.id === id), "register persisted in localStorage");

  dom.window.close();
});
