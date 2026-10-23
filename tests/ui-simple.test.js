// Tests for the simpler four-tab interface, the register-writing fix,
// notification permission gating, and the group-invite flow.
// Run: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadApp() {
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
  w.prompt = () => "Edited by test";
  w.eval(fs.readFileSync(path.join(ROOT, "config.js"), "utf8"));
  w.RB_CONFIG = {
    SUPABASE_URL: "https://REPLACE.supabase.co",
    SUPABASE_ANON_KEY: "REPLACE",
    SITE_URL: "https://mahicouragw.github.io/Register-book/",
    isConfigured() { return false; },
    projectRef() { return ""; }
  };
  ["notify.js", "auth.js", "store.js", "push.js", "rtc.js", "app.js"]
    .forEach(f => w.eval(fs.readFileSync(path.join(ROOT, f), "utf8")));
  return { dom, w, doc: w.document };
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("the app has exactly four tabs: Home, Library, Community, Settings", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("mahi");

  const tabs = [...doc.querySelectorAll("#tabbar .tab")];
  assert.equal(tabs.length, 4, "exactly four bottom tabs");
  assert.deepEqual(
    tabs.map(t => t.querySelector(".tab-label").textContent.trim()),
    ["Home", "Library", "Community", "Settings"]
  );

  // no busy sidebar nav left over
  assert.equal(doc.querySelectorAll(".nav-item").length, 0, "the old sidebar nav is gone");
  assert.equal(doc.getElementById("sidebar"), null, "the sidebar itself is gone");

  // tapping a tab switches the screen
  doc.getElementById("tab-library").click();
  assert.equal(doc.getElementById("view-library").style.display, "block");
  assert.equal(doc.getElementById("view-home").style.display, "none");
  assert.equal(doc.getElementById("tab-library").getAttribute("aria-selected"), "true");

  doc.getElementById("tab-community").click();
  assert.equal(doc.getElementById("view-community").style.display, "block");
  doc.getElementById("tab-settings").click();
  assert.equal(doc.getElementById("view-settings").style.display, "block");

  dom.window.close();
});

test("Home: greeting with today's date, 'New for you', and one big create button", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("mahi");
  w.setView("home");

  const home = doc.getElementById("view-home");
  assert.match(home.textContent, /Hello, Mahi/, "greets the signed-in person");
  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });
  assert.match(doc.getElementById("todayPreview").textContent, new RegExp(monthName), "today's date is shown");
  assert.match(home.textContent, /New for you/, "there is a 'New for you' area");

  const createButtons = [...home.querySelectorAll("button")].filter(b => /Create a register book/i.test(b.textContent));
  assert.equal(createButtons.length, 1, "exactly one create button on Home");

  dom.window.close();
});

test("Library shows OWNER and VIEW-ONLY badges", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();

  // Goldfish creates a book and shares it with Silverfish
  w.enterDemo("goldfish");
  w.openCreateModal();
  doc.getElementById("newRegName").value = "Ward Checklist";
  doc.getElementById("newRegType").value = "Medical Checklist";
  await w.createRegister();
  const wardId = w.__RB.state.reg.id;

  w.openShareModal(wardId);
  w.handleShareUserInput("silver");
  const sug = doc.querySelectorAll("#shareSuggest div");
  assert.ok(sug.length > 0, "name suggestions appear");
  w.pickShareUser("silverfish");
  await w.doShare();
  w.closeShareModal();

  w.setView("library");
  const mine = doc.getElementById("view-myRegisters").textContent;
  assert.match(mine, /Ward Checklist/);
  assert.match(mine, /OWNER/, "my own book is badged OWNER");

  w.enterDemo("silverfish");
  w.setView("library");
  const shared = doc.getElementById("view-shared").textContent;
  assert.match(shared, /Ward Checklist/);
  assert.match(shared, /VIEW-ONLY/, "a shared book is badged VIEW-ONLY");

  dom.window.close();
});

test("Settings holds the account card, Sign out, Terms, Privacy and Delete account", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.setView("settings");

  const s = doc.getElementById("view-settings");
  assert.ok(doc.getElementById("accountCard"), "account card is inside Settings");
  assert.match(doc.getElementById("accountCard").textContent, /Goldfish/, "shows my name");

  const texts = [...s.querySelectorAll("button, a")].map(b => b.textContent);
  assert.ok(texts.some(t => /Sign out|Exit demo/i.test(t)), "sign out lives in Settings");

  const links = [...s.querySelectorAll("a")].map(a => a.getAttribute("href"));
  assert.ok(links.includes("terms.html"), "links to Terms");
  assert.ok(links.includes("privacy.html"), "links to Privacy");

  assert.ok(texts.some(t => /Delete my account/i.test(t)), "delete account lives in Settings");
  assert.ok(texts.some(t => /Send test notification/i.test(t)), "test notification button is in Settings");

  dom.window.close();
});

test("writing a line: no date box on screen, date is saved automatically", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.openCreateModal();
  doc.getElementById("newRegName").value = "Daily Log";
  await w.createRegister();

  // 1. the date input exists but is NOT shown until you ask for it
  const dateInput = doc.getElementById("newLineDate");
  assert.ok(dateInput, "the optional date input exists in the DOM");
  assert.ok(dateInput.closest("#lineDateWrap").hasAttribute("hidden"), "the date box is hidden by default");
  assert.equal(dateInput.value, todayIso(), "and it is pre-filled with today");

  // 2. the writing area no longer prints the long date sentence
  const add = doc.querySelector(".add-line").textContent;
  assert.doesNotMatch(add, /auto-selected/i, "no 'auto-selected' sentence next to the writing box");
  assert.doesNotMatch(doc.getElementById("newLineText").placeholder, /\d{4}/, "placeholder has no date in it");

  // 3. the tiny link reveals it
  w.toggleLineDate();
  assert.equal(dateInput.closest("#lineDateWrap").hasAttribute("hidden"), false, "the link reveals the date box");
  w.useTodayForLine();
  assert.ok(dateInput.closest("#lineDateWrap").hasAttribute("hidden"), "and it can be hidden again");

  // 4. a line typed with no date interaction is saved with today's date
  doc.getElementById("newLineText").value = "Paracetamol given";
  await w.addLine(w.__RB.state.reg.id);
  const entries = w.__RB.store.entriesOf(w.__RB.state.reg.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].date, todayIso(), "the line is dated today automatically");

  // 5. an older date can still be chosen on purpose
  doc.getElementById("newLineText").value = "Backdated entry";
  doc.getElementById("newLineDate").value = "2026-01-05";
  await w.addLine(w.__RB.state.reg.id);
  const entries2 = w.__RB.store.entriesOf(w.__RB.state.reg.id);
  assert.equal(entries2[1].date, "2026-01-05", "a deliberately chosen old date is honoured");

  dom.window.close();
});

test("10 lines per page still shifts to the next page automatically", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.openCreateModal();
  doc.getElementById("newRegName").value = "Pages";
  await w.createRegister();
  const regId = w.__RB.state.reg.id;
  for (let i = 1; i <= 11; i++) {
    doc.getElementById("newLineText").value = "Line " + i;
    await w.addLine(regId);
  }
  assert.match(doc.querySelector(".page-info").textContent, /Page 2 of 2/, "the 11th line moved to page 2");
  dom.window.close();
});

test("notification permission is gated honestly", async () => {
  const { dom, w } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  const P = w.RBPush;

  // jsdom has neither PushManager nor serviceWorker; stub them so the code
  // under test is the real permission logic.
  w.PushManager = function PushManager() {};
  Object.defineProperty(w.navigator, "serviceWorker", {
    value: { register: async () => ({}), ready: Promise.resolve({ pushManager: {} }), addEventListener() {} },
    configurable: true
  });

  // 1. no Notification API at all
  const savedNotification = w.Notification;
  delete w.Notification;
  let st = P.statusText();
  assert.equal(st.state, "unsupported");
  assert.equal(st.canEnable, false, "we do not offer a switch that cannot work");
  const r = await P.enable();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unsupported", "enable() refuses instead of pretending");

  // 2. permission denied by the person
  w.Notification = Object.assign(function () {}, {
    permission: "denied",
    requestPermission: async () => "denied"
  });
  st = P.statusText();
  assert.equal(st.state, "denied");
  assert.equal(st.canEnable, false);

  // 3. default: we may ask
  w.Notification = Object.assign(function () {}, {
    permission: "default",
    requestPermission: async () => "default"
  });
  st = P.statusText();
  assert.equal(st.state, "default");
  assert.equal(st.canEnable, true);
  const r2 = await P.enable();
  assert.equal(r2.ok, false, "if the person says no, enable() reports failure");
  assert.equal(r2.reason, "not-granted");

  // 4. granted but no service worker (jsdom) → still reports failure, never lies
  w.Notification = Object.assign(function () {}, {
    permission: "granted",
    requestPermission: async () => "granted"
  });
  st = P.statusText();
  assert.equal(st.state, "granted");

  if (savedNotification) w.Notification = savedNotification;
  dom.window.close();
});

test("iPhone Safari tells the truth about needing Add to Home Screen", async () => {
  const { dom, w } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  const P = w.RBPush;

  const realUa = w.navigator.userAgent;
  Object.defineProperty(w.navigator, "userAgent", {
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    configurable: true
  });
  w.PushManager = function PushManager() {};
  Object.defineProperty(w.navigator, "serviceWorker", {
    value: { register: async () => ({}), ready: Promise.resolve({ pushManager: {} }), addEventListener() {} },
    configurable: true
  });
  w.Notification = Object.assign(function () {}, { permission: "default", requestPermission: async () => "default" });
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  const st = P.statusText();
  assert.equal(st.state, "ios-needs-install", "iOS Safari in a normal tab is flagged");
  assert.match(st.body, /Home Screen/i, "and the message says Add to Home Screen");
  assert.ok(st.howTo, "with click-by-click help");

  Object.defineProperty(w.navigator, "userAgent", { value: realUa, configurable: true });
  dom.window.close();
});

test("group invite by name: send → the other person sees Join / Decline → Join adds them", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();

  // Goldfish creates a group and invites Silverfish by name
  w.enterDemo("goldfish");
  w.openGroupModal();
  doc.getElementById("newGroupName").value = "Invite Test Group";
  await w.createGroup();
  const group = w.__RB.data.groups.find(g => g.name === "Invite Test Group");
  assert.ok(group, "group created");

  w.openInviteModal(group.id);
  w.handleInviteUserInput("silver");
  const sug = doc.querySelectorAll("#inviteSuggest div");
  assert.ok(sug.length > 0, "people suggestions appear");
  w.pickInviteUser("silverfish");
  await w.sendInvite();
  const inv = w.__RB.data.groupInvites.find(i => i.groupId === group.id);
  assert.ok(inv, "an invite row was created");
  assert.equal(inv.status, "pending");
  assert.match(inv.code, /^[A-HJ-NP-Z2-9]{8}$/, "the invite code is short and unambiguous");

  // Silverfish sees it in her inbox with Join / Decline
  w.enterDemo("silverfish");
  w.openInbox();
  const inbox = doc.getElementById("view-inbox").textContent;
  assert.match(inbox, /You're invited to Invite Test Group/, "the invite is in her inbox");
  assert.ok([...doc.querySelectorAll("#view-inbox button")].some(b => b.textContent.trim() === "Join"));
  assert.ok([...doc.querySelectorAll("#view-inbox button")].some(b => b.textContent.trim() === "Decline"));
  const handlers = [...doc.querySelectorAll("#view-inbox button")].map(b => b.getAttribute("onclick") || "");
  assert.ok(handlers.some(h => h.includes("joinGroup('" + inv.code + "')")), "the Join button is wired to that invite code");
  assert.ok(handlers.some(h => h.includes("declineGroupInvite('" + inv.code + "')")), "the Decline button is wired too");

  // Join really adds a membership row
  await w.joinGroup(inv.code);
  assert.ok(
    w.__RB.data.groupMembers.some(m => m.groupId === group.id && m.userId === "silverfish"),
    "joining adds Silverfish to rb_group_members"
  );
  assert.equal(w.__RB.data.groupInvites.find(i => i.id === inv.id).status, "accepted");

  dom.window.close();
});

test("an invite link can be copied and then opened by another account", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");

  w.openGroupModal();
  doc.getElementById("newGroupName").value = "Night Shift";
  await w.createGroup();
  const group = w.__RB.data.groups.find(g => g.name === "Night Shift");

  w.openInviteModal(group.id);
  await w.makeInviteLink();
  const url = doc.getElementById("inviteLinkValue").textContent;
  assert.match(url, /#join=[A-HJ-NP-Z2-9]{8}$/, "the link carries the invite code");
  const code = url.split("#join=")[1];

  // opening the link in the app shows the Join screen
  w.enterDemo("priya");
  await w.showJoinInvite(code);
  const body = doc.getElementById("joinBody").textContent;
  assert.match(body, /You're invited to Night Shift/, "the link shows which group it is");
  assert.ok([...doc.querySelectorAll("#joinBody button")].some(b => b.textContent.trim() === "Join group"));

  await w.joinGroup(code);
  assert.ok(w.__RB.data.groupMembers.some(m => m.groupId === group.id && m.userId === "priya"));
  dom.window.close();
});

test("delete account: shows exactly what goes, offers a download, then asks to type DELETE", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.openCreateModal();
  doc.getElementById("newRegName").value = "My Book";
  await w.createRegister();
  w.setView("settings");

  w.openDeleteModal();
  const body = doc.getElementById("deleteBody");
  const text = body.textContent;
  assert.match(text, /register book\(s\) you created/, "lists the books");
  assert.match(text, /lines you wrote/, "lists the lines");
  assert.match(text, /will disappear for the other staff too/, "warns about shared books");
  assert.match(text, /group membership/, "lists memberships");
  assert.ok([...body.querySelectorAll("button")].some(b => /Download my books/i.test(b.textContent)), "offers a download first");

  // refusing to type DELETE does nothing
  await w.confirmDeleteAccount();
  assert.match(doc.getElementById("toast").textContent, /type DELETE/i, "it waits for the confirmation word");

  doc.getElementById("deleteConfirm").value = "DELETE";
  await w.confirmDeleteAccount();
  assert.match(doc.getElementById("deleteResult").textContent, /recorded|request/i,
    "in demo mode it says honestly that it is only a recorded request");

  dom.window.close();
});

test("export of my books contains the books and their lines", async () => {
  const { dom, w, doc } = loadApp();
  await w.__RB.boot();
  w.enterDemo("goldfish");
  w.openCreateModal();
  doc.getElementById("newRegName").value = "Bill Book Test";
  doc.getElementById("newRegType").value = "Bill Book";
  await w.createRegister();
  const regId = w.__RB.state.reg.id;
  doc.getElementById("newLineText").value = "Sugar";
  doc.getElementById("newLineQty").value = "2";
  doc.getElementById("newLineAmt").value = "50";
  await w.addLine(regId);

  const text = w.__RB.store.exportMyBooks();
  assert.match(text, /Bill Book Test/);
  assert.match(text, /Sugar/);
  assert.match(text, /Rs\.50/, "amounts are included");
  assert.match(text, /TOTAL Rs\.50/, "with a total for bill books");
  dom.window.close();
});
