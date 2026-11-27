// Automated tests for "Create Questions Register Book".
//
// These follow the owner's story end to end:
//   Tiger (here: Goldfish) writes a question book and sends it to Silver
//   (here: Silverfish). Silver answers it, submits it and sends it back.
//   Tiger then reads every original question, all four original options and
//   Silver's chosen option and written answer.
//
// The one rule everything checks: THE ORIGINAL BOOK IS NEVER OVERWRITTEN.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const LS_KEY = "rb_demo_v4";

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
  ["notify.js", "auth.js", "store.js", "qbooks.js", "push.js", "rtc.js", "app.js", "qbooks-ui.js"]
    .forEach(f => w.eval(fs.readFileSync(path.join(ROOT, f), "utf8")));
  return { dom, w, doc: w.document };
}
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

// Arrays built inside the JSDOM realm have a different Array.prototype, so
// node:assert/strict's deepEqual treats them as unequal. Round-tripping
// through JSON gives us plain Node-realm values to compare.
const plain = v => JSON.parse(JSON.stringify(v));
function deepEq(a, b, msg) { assert.deepEqual(plain(a), plain(b), msg); }

// An accessible name, the way TalkBack works it out: aria-label wins, then a
// <label for="…">, then a wrapping <label>, then the visible text, then the
// placeholder. Empty string means a screen reader would announce nothing.
function accessibleName(doc, el) {
  const al = (el.getAttribute("aria-label") || "").trim();
  if (al) return al;
  const id = el.getAttribute("id");
  if (id) {
    const lab = doc.querySelector('label[for="' + id + '"]');
    if (lab && lab.textContent.trim()) return lab.textContent.trim();
  }
  if (el.closest) {
    const wrap = el.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
  }
  const t = (el.textContent || "").trim();
  if (t) return t;
  return (el.getAttribute("placeholder") || "").trim();
}

async function bootGoldfish() {
  const app = loadApp();
  await app.w.__RB.boot();
  app.w.enterDemo("goldfish");
  app.w.setView("library");
  await tick();
  return app;
}

async function makeBook(w, doc, title, pageCount) {
  doc.getElementById("qbCreateTitle").value = title;
  doc.getElementById("qbCreatePages").value = String(pageCount);
  await w.qbCreateBook();
  await tick();
  const b = w.RBQBooks.myBooks().find(x => x.title === title);
  assert.ok(b, "book was created");
  return b;
}

async function addQuestion(w, doc, spec) {
  doc.getElementById("qbNewText").value = spec.text;
  doc.getElementById("qbNewChoices").checked = spec.hasChoices !== false;
  doc.getElementById("qbNewWritten").checked = !!spec.hasWritten;
  ["A", "B", "C", "D"].forEach(l => {
    const el = doc.getElementById("qbNew" + l);
    if (el) el.value = (spec.options && spec.options[l]) || "";
  });
  if (spec.writtenLabel) doc.getElementById("qbNewWrittenLabel").value = spec.writtenLabel;
  w.qbToggleChoices();
  w.qbToggleWritten();
  await w.qbAddQuestion();
  await tick();
}

// ============================================================ creating
test("create: the button is called exactly “Create Questions Register Book”", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const html = doc.getElementById("view-myQBooks").innerHTML;
  assert.match(html, /Create Questions Register Book/);
  dom.window.close();
});

test("create: a new book gets the number of lined pages asked for, numbered 1..N", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Ward Fire Drill Quiz", 25);

  const pages = w.RBQBooks.pagesOf(b.id);
  assert.equal(pages.length, 25, "25 pages");
  deepEq(pages.map(p => p.pageNo), Array.from({ length: 25 }, (_, i) => i + 1),
    "pages are numbered 1 to 25, in order");

  // and they are shown on screen as page N of 25
  w.qbOpenEditor(b.id);
  await tick();
  assert.match(doc.getElementById("view-qbookEditor").textContent, /Page 1 of 25/);
  dom.window.close();
});

test("create: default is 20 or more pages when nothing is typed", async () => {
  const { dom, w } = await bootGoldfish();
  assert.ok(w.RBQBooks.DEFAULT_PAGES >= 20, "default page count is at least 20");
  dom.window.close();
});

// ==================================================== questions & options
test("questions: A–D options + a written field, all stored and ordered", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Fire Drill", 3);
  w.qbOpenEditor(b.id);
  await tick();

  await addQuestion(w, doc, {
    text: "Where is the fire extinguisher kept?",
    hasChoices: true,
    hasWritten: true,
    writtenLabel: "Describe the exact spot",
    options: { A: "Corridor", B: "Nurse station", C: "Store room", D: "Ward door" }
  });

  const qs = w.RBQBooks.questionsOf(b.id);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].text, "Where is the fire extinguisher kept?");
  assert.equal(qs[0].hasChoices, true);
  assert.equal(qs[0].hasWritten, true);
  assert.equal(qs[0].writtenLabel, "Describe the exact spot");

  const opts = w.RBQBooks.optionsOf(qs[0].id);
  deepEq(opts.map(o => o.label), ["A", "B", "C", "D"], "always four options, in order");
  deepEq(opts.map(o => o.text), ["Corridor", "Nurse station", "Store room", "Ward door"]);
  dom.window.close();
});

test("questions: can be choices-only, written-only, or both", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Mixed", 2);
  w.qbOpenEditor(b.id);
  await tick();

  await addQuestion(w, doc, { text: "Pick one:", hasChoices: true, hasWritten: false, options: { A: "1", B: "2", C: "3", D: "4" } });
  await addQuestion(w, doc, { text: "Describe it:", hasChoices: false, hasWritten: true, writtenLabel: "Explain" });
  await addQuestion(w, doc, { text: "Both:", hasChoices: true, hasWritten: true, options: { A: "x", B: "y", C: "z", D: "w" } });

  const qs = w.RBQBooks.questionsOf(b.id);
  assert.equal(qs.length, 3);
  deepEq(qs.map(q => [q.hasChoices, q.hasWritten]), [[true, false], [false, true], [true, true]]);
  deepEq(w.RBQBooks.optionsOf(qs[1].id).map(o => o.text), ["", "", "", ""],
    "a written-only question stores no option text");
  dom.window.close();
});

test("questions: add, edit and delete all work from the editor screen", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Editable", 2);
  w.qbOpenEditor(b.id);
  await tick();

  await addQuestion(w, doc, { text: "Original text", hasChoices: true, hasWritten: false, options: { A: "a", B: "b", C: "c", D: "d" } });
  const qid = w.RBQBooks.questionsOf(b.id)[0].id;

  w.qbEditQuestion(qid);
  await tick();
  doc.getElementById("qbEditText").value = "Changed text";
  doc.getElementById("qbEditA").value = "alpha";
  await w.qbSaveEdit();
  await tick();

  const q = w.RBQBooks.questionsOf(b.id)[0];
  assert.equal(q.text, "Changed text", "question text edited");
  assert.equal(w.RBQBooks.optionsOf(q.id).find(o => o.label === "A").text, "alpha", "option A edited");

  await w.RBQBooks.deleteQuestion(q.id);
  await tick();
  assert.equal(w.RBQBooks.questionsOf(b.id).length, 0, "question deleted");
  dom.window.close();
});

test("pages: “Add page” grows the book and keeps the numbering continuous", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Growing", 2);
  w.qbOpenEditor(b.id);
  await tick();

  await w.qbAddPage(b.id);
  await tick();
  await w.qbAddPage(b.id);
  await tick();

  const pages = w.RBQBooks.pagesOf(b.id);
  assert.equal(pages.length, 4);
  deepEq(pages.map(p => p.pageNo), [1, 2, 3, 4], "numbering stays 1,2,3,4");
  dom.window.close();
});

// ================================================================ sending
test("send: cannot send an empty book, yourself, or an unknown person", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Empty book", 2);

  await assert.rejects(() => w.RBQBooks.sendBook(b.id, "silverfish", ""), /at least one question/i);
  await assert.rejects(() => w.RBQBooks.sendBook(b.id, "goldfish", ""), /yourself/i);
  await assert.rejects(() => w.RBQBooks.sendBook(b.id, "nobodyatall", ""), /No registered user/i);
  assert.equal(w.RBQBooks.findUserForSend("nobodyatall"), null, "an unknown name finds nobody");
  dom.window.close();
});

test("send: to a registered user by name (and by id) creates a copy with status Sent", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Fire Drill", 3);
  w.qbOpenEditor(b.id);
  await tick();
  await addQuestion(w, doc, { text: "Ready?", hasChoices: true, hasWritten: false, options: { A: "y", B: "n", C: "", D: "" } });

  w.qbOpenSend(b.id);
  await tick();
  doc.getElementById("qbSendUser").value = "silverfish";
  w.qbFindSendUser();
  assert.match(doc.getElementById("qbSendResult").textContent, /Silverfish/i, "the person is confirmed before sending");
  doc.getElementById("qbSendNote").value = "Please finish by Friday.";
  await w.qbDoSend();
  await tick();

  const copies = w.RBQBooks.sentCopies().filter(c => c.bookId === b.id);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].recipientId, "silverfish");
  assert.equal(copies[0].status, "sent");
  assert.equal(copies[0].revision, 1);
  assert.equal(copies[0].senderNote, "Please finish by Friday.");
  assert.equal(w.RBQBooks.bookStatus(b.id), "sent", "the book now reads Sent");

  // sending again to the same person makes a NEW copy (revision 2), never overwrites
  await w.RBQBooks.sendBook(b.id, "silverfish", "second round");
  await tick();
  const again = w.RBQBooks.sentCopies().filter(c => c.bookId === b.id);
  assert.equal(again.length, 2, "two separate copies");
  deepEq(again.map(c => c.revision).sort(), [1, 2], "the second send is revision 2");
  dom.window.close();
});

// ============================================ the full round trip (the story)
test("round trip: Goldfish sends → Silverfish answers → submits → sends back → Goldfish reads it", async () => {
  const { dom, w, doc } = await bootGoldfish();

  // --- Goldfish writes it -------------------------------------------------
  const b = await makeBook(w, doc, "Ward Safety Quiz", 20);
  w.qbOpenEditor(b.id);
  await tick();
  await addQuestion(w, doc, {
    text: "What is the first thing you do when a patient falls?",
    hasChoices: true, hasWritten: false,
    options: { A: "Call the doctor", B: "Check them, do not move them", C: "Help them up", D: "Write it later" }
  });
  await addQuestion(w, doc, {
    text: "Where is the emergency oxygen cylinder kept?",
    hasChoices: true, hasWritten: true, writtenLabel: "Describe the location",
    options: { A: "Store room", B: "Nurse station", C: "Corridor", D: "Outside" }
  });
  const questionIds = w.RBQBooks.questionsOf(b.id).map(q => q.id);
  const originalTexts = w.RBQBooks.questionsOf(b.id).map(q => q.text);
  const originalOptions = {};
  questionIds.forEach(id => { originalOptions[id] = w.RBQBooks.optionsOf(id).map(o => o.text); });

  await w.RBQBooks.sendBook(b.id, "silverfish", "Please complete this by Friday.");
  await tick();

  // --- Silverfish receives it --------------------------------------------
  w.enterDemo("silverfish");
  w.setView("library");
  await tick();
  const Q2 = w.RBQBooks;
  const inbox = Q2.receivedCopies().filter(c => c.bookId === b.id);
  assert.equal(inbox.length, 1, "it is in Silverfish's Received Books");
  assert.equal(inbox[0].status, "sent");

  const copyId = inbox[0].id;
  await w.qbOpenAnswer(copyId);
  await tick();
  assert.equal(Q2.copy(copyId).status, "received", "opening it marks it Received");

  // --- Silverfish answers it ---------------------------------------------
  await w.qbPick(copyId, questionIds[0], "B");
  await tick();
  const wEl = doc.getElementById("qbw_" + questionIds[1]);
  assert.ok(wEl, "the written-answer box exists for question 2");
  wEl.value = "It is next to the nurse station, on the left.";
  await w.qbType(copyId, questionIds[1], "qbw_" + questionIds[1]);
  await tick();
  await w.qbPick(copyId, questionIds[1], "B");
  await tick();

  assert.equal(Q2.copy(copyId).status, "in_progress", "answering moves it to In progress");

  const saved = Q2.answersOf(copyId);
  assert.equal(saved.length, 2, "two answers saved");
  assert.equal(saved.find(a => a.questionId === questionIds[0]).selectedLabel, "B");
  assert.equal(saved.find(a => a.questionId === questionIds[1]).writtenAnswer, "It is next to the nurse station, on the left.");

  // --- Silverfish closes the app; the answers must still be there ----------
  const snapshot = w.localStorage.getItem(LS_KEY);
  assert.ok(snapshot, "demo data is written to localStorage");
  const copyIdKept = copyId;
  dom.window.close();

  const re = loadApp();
  re.w.localStorage.setItem(LS_KEY, snapshot);
  await re.w.__RB.boot();
  re.w.enterDemo("silverfish");
  re.w.setView("library");
  await tick();
  const Q3 = re.w.RBQBooks;
  const after = Q3.answersOf(copyIdKept);
  assert.equal(after.length, 2, "answers survived closing and reopening the app");
  assert.equal(after.find(a => a.questionId === questionIds[0]).selectedLabel, "B");
  assert.equal(after.find(a => a.questionId === questionIds[1]).writtenAnswer, "It is next to the nurse station, on the left.");
  assert.equal(Q3.copy(copyIdKept).status, "in_progress", "and it is still In progress");

  // --- Silverfish submits and sends it back -------------------------------
  re.w.qbOpenAnswer(copyIdKept);
  await tick(25);
  re.w.qbSubmitAnswers();
  await tick(25);
  assert.equal(Q3.copy(copyIdKept).status, "submitted");

  // a second submit is refused — no accidental duplicate submission
  await assert.rejects(() => Q3.submitAnswers(copyIdKept), /already submitted/i);

  re.w.qbSendBack();
  await tick(25);
  assert.equal(Q3.copy(copyIdKept).status, "returned_to_creator");
  await assert.rejects(() => Q3.returnCompletedBook(copyIdKept), /Submit your answers first/i);

  // --- Goldfish reads the completed book ----------------------------------
  re.w.enterDemo("goldfish");
  re.w.setView("library");
  await tick();
  const Q4 = re.w.RBQBooks;
  const done = Q4.completedCopies().filter(c => c.bookId === b.id);
  assert.equal(done.length, 1, "it is in Goldfish's Completed Books");

  re.w.qbOpenResults(copyIdKept);
  await tick(25);
  const results = re.w.document.getElementById("view-qbookResults").textContent;
  assert.match(results, /Ward Safety Quiz/, "the title");
  assert.match(results, /Silverfish/, "the respondent's name");
  assert.match(results, /Submitted/, "the submission date");
  assert.match(results, /Returned to creator/, "the submission status");
  // every original question, all four original options, the chosen one and the written answer
  originalTexts.forEach(t => assert.match(results, new RegExp(t.replace(/[?]/g, "\\?"), "i"), "original question shown: " + t));
  ["Call the doctor", "Check them, do not move them", "Help them up", "Write it later",
    "Store room", "Nurse station", "Corridor", "Outside"].forEach(o => {
      assert.ok(results.indexOf(o) >= 0, "original option still shown: " + o);
    });
  assert.match(results, /Chosen/, "the chosen option is marked");
  assert.match(results, /It is next to the nurse station, on the left\./, "the written answer is shown");

  // --- THE ORIGINAL BOOK WAS NEVER TOUCHED --------------------------------
  const stillThere = Q4.questionsOf(b.id);
  deepEq(stillThere.map(q => q.text), originalTexts, "the original questions are unchanged");
  stillThere.forEach(q => {
    deepEq(Q4.optionsOf(q.id).map(o => o.text), originalOptions[q.id], "the original options are unchanged");
  });
  assert.equal(Q4.pagesOf(b.id).length, 20, "still 20 pages");

  re.dom.window.close();
});

// ====================================================== permissions / safety
test("safety: the recipient cannot change the original questions or options", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Locked", 2);
  w.qbOpenEditor(b.id);
  await tick();
  await addQuestion(w, doc, { text: "Original question", hasChoices: true, hasWritten: false, options: { A: "a", B: "b", C: "c", D: "d" } });
  const qid = w.RBQBooks.questionsOf(b.id)[0].id;
  await w.RBQBooks.sendBook(b.id, "silverfish", "");
  await tick();

  w.enterDemo("silverfish");
  w.setView("library");
  await tick();
  const Q = w.RBQBooks;

  await assert.rejects(() => Q.updateQuestion(qid, { text: "Hacked" }), /Only the creator/i);
  await assert.rejects(() => Q.deleteQuestion(qid), /Only the creator/i);
  await assert.rejects(() => Q.addQuestion(b.id, "ignored", { text: "Hacked", hasChoices: true, hasWritten: false }), /Only the creator/i);
  await assert.rejects(() => Q.addPage(b.id), /Only the creator/i);
  await assert.rejects(() => Q.renameBook(b.id, "Hacked"), /Only the creator/i);
  await assert.rejects(() => Q.deleteBook(b.id), /Only the creator/i);

  assert.equal(Q.questionsOf(b.id)[0].text, "Original question", "nothing changed");
  dom.window.close();
});

test("safety: nobody else can answer a book that was not sent to them", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Private", 2);
  w.qbOpenEditor(b.id);
  await tick();
  await addQuestion(w, doc, { text: "Secret?", hasChoices: true, hasWritten: false, options: { A: "1", B: "2", C: "3", D: "4" } });
  const qid = w.RBQBooks.questionsOf(b.id)[0].id;
  const copyId = (await w.RBQBooks.sendBook(b.id, "silverfish", "")).id;
  await tick();

  w.enterDemo("priya");
  w.setView("library");
  await tick();
  const Q = w.RBQBooks;
  assert.equal(Q.receivedCopies().filter(c => c.id === copyId).length, 0, "Priya cannot even see it");
  await assert.rejects(() => Q.saveAnswer(copyId, qid, { selectedLabel: "A" }), /Only the person it was sent to/i);
  await assert.rejects(() => Q.submitAnswers(copyId), /Only the person it was sent to/i);
  dom.window.close();
});

test("safety: empty books, empty inboxes and missing people are handled clearly", async () => {
  const { dom, w, doc } = await bootGoldfish();
  w.setView("library");
  await tick();

  // Before creating anything, Mahi has nothing of her own.
  w.enterDemo("mahi");
  w.setView("library");
  await tick();
  const html = doc.getElementById("view-myQBooks").innerHTML +
    doc.getElementById("view-receivedQBooks").innerHTML +
    doc.getElementById("view-completedQBooks").innerHTML;
  assert.match(html, /No question books yet/, "own section explains it is empty");
  assert.match(html, /inbox is empty/, "received section explains it is empty");
  assert.match(html, /No completed books yet/, "completed section explains it is empty");
  dom.window.close();
});

// ================================================================ revision
test("revision: the creator can ask for changes and the recipient can resubmit", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Revision test", 2);
  w.qbOpenEditor(b.id);
  await tick();
  await addQuestion(w, doc, { text: "Question?", hasChoices: true, hasWritten: false, options: { A: "1", B: "2", C: "3", D: "4" } });
  const qid = w.RBQBooks.questionsOf(b.id)[0].id;
  const copyId = (await w.RBQBooks.sendBook(b.id, "silverfish", "")).id;
  await tick();

  w.enterDemo("silverfish");
  w.setView("library");
  await tick();
  await w.qbOpenAnswer(copyId);
  await tick();
  await w.qbPick(copyId, qid, "A");
  await tick();
  w.qbSubmitAnswers();
  await tick();
  assert.equal(w.RBQBooks.copy(copyId).status, "submitted");

  // Goldfish asks for a revision
  w.enterDemo("goldfish");
  w.setView("library");
  await tick();
  await w.RBQBooks.requestRevision(copyId);
  await tick();
  assert.equal(w.RBQBooks.copy(copyId).status, "in_progress", "reopened for the recipient");

  // Silverfish can answer again and resubmit the same copy
  w.enterDemo("silverfish");
  w.setView("library");
  await tick();
  await w.qbPick(copyId, qid, "C");
  await tick();
  assert.equal(w.RBQBooks.answersOf(copyId)[0].selectedLabel, "C", "the answer is editable again");
  w.qbSubmitAnswers();
  await tick();
  assert.equal(w.RBQBooks.copy(copyId).status, "submitted", "resubmitted cleanly");

  w.qbSendBack();
  await tick();
  assert.equal(w.RBQBooks.copy(copyId).status, "returned_to_creator");

  // only ever one copy — the original book was never duplicated or overwritten
  w.enterDemo("goldfish");
  w.setView("library");
  await tick();
  assert.equal(w.RBQBooks.questionsOf(b.id).length, 1, "still exactly one question in the original");
  dom.window.close();
});

// ============================================================ accessibility
test("accessibility: every control on the question-book screens has a clear name", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Accessible book", 3);
  w.qbOpenEditor(b.id);
  await tick();
  await addQuestion(w, doc, {
    text: "What is the emergency number?",
    hasChoices: true, hasWritten: true, writtenLabel: "Type the number"
  });

  const copyId = (await w.RBQBooks.sendBook(b.id, "silverfish", "")).id;
  await tick();

  function checkAll(rootId, label) {
    const root = doc.getElementById(rootId);
    const controls = root.querySelectorAll("button, input, textarea, select");
    assert.ok(controls.length > 3, label + ": has controls to check");
    controls.forEach(el => {
      const name = accessibleName(doc, el);
      assert.ok(name && name.length > 1,
        label + ": <" + el.tagName.toLowerCase() + ' id="' + (el.id || "") + '"> has no accessible name');
    });
  }

  checkAll("view-myQBooks", "library / my books");
  checkAll("view-qbookEditor", "editor");

  // the answer screen
  w.enterDemo("silverfish");
  w.setView("library");
  await tick();
  await w.qbOpenAnswer(copyId);
  await tick(25);
  checkAll("view-qbookAnswer", "answer screen");

  // the options are real radio buttons inside a fieldset with a legend
  const fs = doc.querySelectorAll("#view-qbookAnswer fieldset.qb-opts-field");
  assert.ok(fs.length >= 1, "options are a real fieldset");
  assert.match(fs[0].querySelector("legend").textContent, /Choose one option/, "with a legend TalkBack reads out");
  const radios = fs[0].querySelectorAll('input[type="radio"]');
  assert.equal(radios.length, 4, "four radio buttons, A to D");
  dom.window.close();
});

test("accessibility: reading order is page → question number → text → options → written answer", async () => {
  const { dom, w, doc } = await bootGoldfish();
  const b = await makeBook(w, doc, "Order test", 2);
  w.qbOpenEditor(b.id);
  await tick();
  await addQuestion(w, doc, {
    text: "Where is the oxygen cylinder?",
    hasChoices: true, hasWritten: true, writtenLabel: "Describe the location"
  });
  const copyId = (await w.RBQBooks.sendBook(b.id, "silverfish", "")).id;
  await tick();

  w.enterDemo("silverfish");
  w.setView("library");
  await tick();
  await w.qbOpenAnswer(copyId);
  await tick(25);

  const text = doc.getElementById("view-qbookAnswer").textContent;
  const iPage = text.indexOf("Page 1 of 2");
  const iQ = text.indexOf("Question 1");
  const iQuestion = text.indexOf("Where is the oxygen cylinder?");
  const iLegend = text.indexOf("Choose one option");
  const iWritten = text.indexOf("Describe the location");
  assert.ok(iPage >= 0 && iPage < iQ, "page number comes first");
  assert.ok(iQ < iQuestion, "then the question number");
  assert.ok(iQuestion < iLegend, "then the question text, then the options");
  assert.ok(iLegend < iWritten, "then the written answer");

  // nothing depends on a gesture: no drag-and-drop handlers anywhere
  const html = fs.readFileSync(path.join(ROOT, "qbooks-ui.js"), "utf8");
  assert.equal(/ondrag|ondrop|draggable=/.test(html), false, "no drag-and-drop in the question-book UI");
  dom.window.close();
});

// ====================================================== cloud-mode columns
test("cloud: every column the question-book code writes exists in the real migration", async () => {
  const sql = fs.readFileSync(path.join(ROOT, "supabase", "migrations.sql"), "utf8");
  const src = fs.readFileSync(path.join(ROOT, "qbooks.js"), "utf8");

  // pull out every object literal passed to cloudInsert / cloudUpsert / cloudUpdate
  const used = new Set();
  const re = /S\.cloud(?:Insert|Upsert|Update)\(\s*"(rb_\w+)"\s*,\s*([\s\S]*?)\);/g;
  let m;
  while ((m = re.exec(src))) {
    const table = m[1];
    const body = m[2];
    body.replace(/([a-z_][a-z0-9_]*)\s*:/g, (all, col) => { used.add(table + "." + col); return all; });
  }
  assert.ok(used.size > 20, "found the columns the code writes");

  // every table.column used must appear in the migration
  const missing = [];
  used.forEach(ref => {
    const [table, col] = ref.split(".");
    const block = sql.match(new RegExp("create table if not exists public\\." + table + "\\s*\\(([\\s\\S]*?)\\n\\);"));
    if (!block) { missing.push(ref + " (table missing)"); return; }
    if (!new RegExp("^\\s*" + col + "\\s", "m").test(block[1])) missing.push(ref);
  });
  deepEq(missing, [], "no column-name typos between qbooks.js and migrations.sql");
});
