/* qbooks-ui.js — the screens for "Create Questions Register Book".
 *
 * Three screens live here, plus the three Library sections that open them:
 *   1. EDITOR   (view-qbookEditor)  — the creator writes questions on lined pages.
 *   2. ANSWER   (view-qbookAnswer)  — the recipient answers. Questions and
 *                                     options are READ-ONLY here, by design.
 *   3. RESULTS  (view-qbookResults) — the creator reads a completed book.
 *
 * Accessibility rules this file follows (TalkBack / Android screen readers):
 *   • every control is a real <button>, <input> or <textarea> — never a div
 *     with a click handler, so it is focusable and announced;
 *   • every control has a visible or aria-label naming exactly what it does;
 *   • radio groups are wrapped in <fieldset> with a <legend>, so TalkBack
 *     reads "Question 2, Where is the oxygen cylinder? … option A of 4";
 *   • reading order is: page number → question number → question text →
 *     options → written answer → status. Nothing is positioned by CSS order;
 *   • no drag-and-drop, no swipe gestures, no hover-only affordances.
 */
(function () {
  "use strict";

  const S = window.RBStore;
  const Q = window.RBQBooks;
  const STATUS = Q.STATUS;

  // Helpers exported by app.js (see the Object.assign at the bottom of app.js).
  function esc(s) { return window.esc ? window.esc(s) : String(s == null ? "" : s); }
  function fmtDay(iso) { return window.fmtDay ? window.fmtDay(iso) : String(iso || ""); }
  function profileOf(id) { return window.profileOf ? window.profileOf(id) : (S.profile ? S.profile(id) : { name: "Someone" }); }
  function toast(m) { if (window.toast) window.toast(m); }
  function renderAll() { if (window.renderAll) window.renderAll(); }
  function nameOf(id) { const p = profileOf(id); return (p && (p.name || p.email)) || "Someone"; }

  function fmtWhen(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    } catch (e) { return fmtDay(iso); }
  }

  // ---------------------------------------------------------------- state
  const ui = {
    bookId: null,        // editor: which book is open
    page: 1,             // editor: which page
    copyId: null,        // answer: which copy is being answered
    answerPage: 1,
    resultsCopyId: null, // results: which completed copy is open
    editing: null,       // question id being edited in the modal
    sendBookId: null,    // book id in the send modal
    sendPick: null       // resolved recipient in the send modal
  };

  // ---------------------------------------------------------------- library
  function statusBadge(status) {
    const map = {
      draft: "badge-gray",
      sent: "badge-blue",
      received: "badge-blue",
      in_progress: "badge-amber",
      submitted: "badge-amber",
      returned_to_creator: "badge-green"
    };
    return `<span class="badge ${map[status] || "badge-gray"}">${esc(Q.statusLabel(status))}</span>`;
  }

  function qbIcon() {
    return `<div style="width:40px;height:40px;border-radius:10px;background:#eff6ff;border:1px solid #bfdbfe;display:grid;place-items:center;font-size:18px" aria-hidden="true">❓</div>`;
  }

  function section(id, title, sub, bodyHtml) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<div class="card">
      <div class="card-head"><h2>${esc(title)}</h2></div>
      <div class="small muted" style="padding:0 14px 8px">${esc(sub)}</div>
      <div class="card-pad" style="padding-top:0">${bodyHtml}</div>
    </div>`;
  }

  function emptyBox(msg, hint) {
    return `<div class="empty"><div class="big">${esc(msg)}</div><div class="small">${esc(hint || "")}</div></div>`;
  }

  function renderQuestionBooks() {
    if (!S.me) return;

    // ---- My question books (the creator's own) -----------------------------
    const mine = Q.myBooks().slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    let myHtml = `<div class="row mb8">
        <button class="btn btn-primary" onclick="qbOpenCreate()">＋ Create Questions Register Book</button>
      </div>`;
    if (!mine.length) {
      myHtml += emptyBox("No question books yet",
        "Tap “Create Questions Register Book”, give it a title, then write your questions on the lined pages.");
    } else {
      myHtml += mine.map(b => {
        const pages = Q.pagesOf(b.id).length;
        const n = Q.questionCount(b.id);
        const status = Q.bookStatus(b.id);
        return `<div class="list-item">
          ${qbIcon()}
          <div class="flex1">
            <div class="strong">${esc(b.title)}</div>
            <div class="small muted">${pages} page${pages === 1 ? "" : "s"} • ${n} question${n === 1 ? "" : "s"}</div>
          </div>
          ${statusBadge(status)}
          <div class="row" style="gap:6px">
            <button class="btn btn-sm btn-primary" onclick="qbOpenEditor('${esc(b.id)}')" aria-label="Open question book ${esc(b.title)}">Open</button>
            <button class="btn btn-sm" onclick="qbOpenSend('${esc(b.id)}')" aria-label="Send question book ${esc(b.title)} to someone">Send</button>
            <button class="btn btn-sm btn-ghost" style="color:#dc2626" onclick="qbDeleteBook('${esc(b.id)}')" aria-label="Delete question book ${esc(b.title)}">Delete</button>
          </div>
        </div>`;
      }).join("");
    }
    section("view-myQBooks", "Question books I wrote",
      "Write questions once, send them to a colleague, and read their answers when the book comes back.",
      myHtml);

    // ---- Received books (the recipient's inbox) ----------------------------
    const received = Q.receivedCopies()
      .slice().sort((a, b) => String(b.sentAt || "").localeCompare(String(a.sentAt || "")));
    let recvHtml = "";
    if (!received.length) {
      recvHtml = emptyBox("Your received books inbox is empty",
        "When a colleague sends you a question book it appears here with the title, the sender’s name and the date.");
    } else {
      recvHtml = received.map(c => {
        const b = Q.book(c.bookId);
        const when = c.receivedAt || c.sentAt;
        const done = c.status === STATUS.SUBMITTED || c.status === STATUS.RETURNED;
        return `<div class="list-item">
          ${qbIcon()}
          <div class="flex1">
            <div class="strong">${esc(b ? b.title : "Question book")}</div>
            <div class="small muted">From ${esc(nameOf(c.senderId))} • ${esc(fmtWhen(when))}${c.revision > 1 ? ` • revision ${c.revision}` : ""}</div>
          </div>
          ${statusBadge(c.status)}
          <div class="row" style="gap:6px">
            <button class="btn btn-sm btn-primary" onclick="qbOpenAnswer('${esc(c.id)}')"
              aria-label="${done ? "Review" : "Open and answer"} question book ${esc(b ? b.title : "")} from ${esc(nameOf(c.senderId))}">${done ? "Review" : "Open & answer"}</button>
          </div>
        </div>`;
      }).join("");
    }
    section("view-receivedQBooks", "Received books",
      "Question books your colleagues sent you. You can answer them, but never change their questions.",
      recvHtml);

    // ---- Completed books (answers returned to the creator) -----------------
    const done = Q.completedCopies()
      .slice().sort((a, b) => String(b.submittedAt || b.returnedAt || "").localeCompare(String(a.submittedAt || a.returnedAt || "")));
    let doneHtml = "";
    if (!done.length) {
      doneHtml = emptyBox("No completed books yet",
        "When someone finishes your question book and sends it back, their answers appear here.");
    } else {
      doneHtml = done.map(c => {
        const b = Q.book(c.bookId);
        return `<div class="list-item">
          ${qbIcon()}
          <div class="flex1">
            <div class="strong">${esc(b ? b.title : "Question book")}</div>
            <div class="small muted">Answered by ${esc(nameOf(c.recipientId))} • ${esc(fmtWhen(c.submittedAt || c.returnedAt))}${c.revision > 1 ? ` • revision ${c.revision}` : ""}</div>
          </div>
          ${statusBadge(c.status)}
          <div class="row" style="gap:6px">
            <button class="btn btn-sm btn-primary" onclick="qbOpenResults('${esc(c.id)}')"
              aria-label="Read the answers from ${esc(nameOf(c.recipientId))} for ${esc(b ? b.title : "")}">Read answers</button>
          </div>
        </div>`;
      }).join("");
    }
    section("view-completedQBooks", "Completed books",
      "Books that have come back to you. Open one to see every original question, all four options, and the answer given.",
      doneHtml);
  }

  // ================================================================ EDITOR
  function openEditor(bookId) {
    ui.bookId = bookId;
    ui.page = 1;
    window.setView("qbookEditor");
    renderEditor();
    window.renderTopbar();
  }

  function renderEditor() {
    const c = document.getElementById("view-qbookEditor");
    if (!c) return;
    const b = Q.book(ui.bookId);
    if (!b) {
      c.innerHTML = `<div class="card"><div class="empty"><div class="big">Book not available</div>
        <button class="btn mt8" onclick="window.setView('library')">← Back to library</button></div></div>`;
      return;
    }
    const pages = Q.pagesOf(b.id);
    const total = pages.length;
    let page = Math.min(Math.max(1, ui.page || 1), total || 1);
    ui.page = page;
    const cur = pages[page - 1];
    const qs = cur ? Q.questionsOfPage(cur.id) : [];

    const questionsHtml = qs.length ? qs.map(q => editorQuestion(q)).join("")
      : `<div class="qb-empty-line">This page is empty. Use the form below to write the first question.</div>`;

    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="flex1">
            <h2>${esc(b.title)}</h2>
            <div class="small muted">${total} page${total === 1 ? "" : "s"} • ${Q.questionCount(b.id)} question${Q.questionCount(b.id) === 1 ? "" : "s"} • ${esc(Q.statusLabel(Q.bookStatus(b.id)))}</div>
          </div>
          <button class="btn btn-sm" onclick="qbRenameBook('${esc(b.id)}')" aria-label="Rename this question book">Rename</button>
          <button class="btn btn-sm btn-primary" onclick="qbOpenSend('${esc(b.id)}')" aria-label="Send this question book to a colleague">Send to…</button>
        </div>
        <div class="card-pad">
          ${pageNav("qbEditorPage", page, total)}
          <div class="qb-page" role="group" aria-label="Lined notebook page ${page} of ${total}">
            ${questionsHtml}
          </div>
          <div class="qb-page-foot">Page ${page} of ${total}</div>
          <div class="row mt8">
            <button class="btn btn-sm" onclick="qbAddPage('${esc(b.id)}')" aria-label="Add one more page to this book">＋ Add page</button>
            <button class="btn btn-sm" onclick="window.setView('library')" aria-label="Save and go back to the library">← Back to library</button>
          </div>
          ${editorAddForm()}
        </div>
      </div>`;
  }

  function editorQuestion(q) {
    const opts = Q.optionsOf(q.id);
    let choices = "";
    if (q.hasChoices) {
      choices = `<ul class="qb-opts">${opts.map(o => `
        <li><span class="qb-opt-label" aria-hidden="true">${esc(o.label)}</span>
        <span class="qb-opt-text">${o.text ? esc(o.text) : `<i class="muted">empty</i>`}</span></li>`).join("")}</ul>`;
    }
    let written = "";
    if (q.hasWritten) {
      written = `<div class="qb-written">
        <div class="qb-written-label">${esc(q.writtenLabel || "Written answer")}</div>
        <div class="qb-written-box" aria-hidden="true"></div>
      </div>`;
    }
    return `<div class="qb-q">
      <div class="qb-qhead">
        <span class="qb-qno">Question ${esc(q.qNo)}</span>
        <span class="row" style="gap:6px">
          <button class="btn btn-sm" onclick="qbEditQuestion('${esc(q.id)}')" aria-label="Edit question ${esc(q.qNo)}: ${esc(q.text)}">Edit</button>
          <button class="btn btn-sm btn-ghost" style="color:#dc2626" onclick="qbDeleteQuestion('${esc(q.id)}')" aria-label="Delete question ${esc(q.qNo)}: ${esc(q.text)}">Delete</button>
        </span>
      </div>
      <div class="qb-qtext">${esc(q.text)}</div>
      ${choices}
      ${written}
    </div>`;
  }

  function editorAddForm() {
    return `<div class="qb-form" id="qbAddForm">
      <h3 class="qb-form-title">Add a question to page ${ui.page}</h3>
      <div class="form-row">
        <label for="qbNewText">Question text</label>
        <textarea id="qbNewText" rows="2" placeholder="e.g. What is the first thing you do when a patient falls?"></textarea>
      </div>
      <div class="form-row">
        <label class="qb-check"><input type="checkbox" id="qbNewChoices" checked onchange="qbToggleChoices()">
          Offer choices A, B, C and D</label>
      </div>
      <div id="qbChoicesBox">
        <div class="form-row"><label for="qbNewA">Option A</label><input id="qbNewA" placeholder="First choice"></div>
        <div class="form-row"><label for="qbNewB">Option B</label><input id="qbNewB" placeholder="Second choice"></div>
        <div class="form-row"><label for="qbNewC">Option C</label><input id="qbNewC" placeholder="Third choice"></div>
        <div class="form-row"><label for="qbNewD">Option D</label><input id="qbNewD" placeholder="Fourth choice"></div>
      </div>
      <div class="form-row">
        <label class="qb-check"><input type="checkbox" id="qbNewWritten" onchange="qbToggleWritten()">
          Also allow a written answer</label>
      </div>
      <div id="qbWrittenBox" style="display:none">
        <div class="form-row"><label for="qbNewWrittenLabel">Label for the written answer</label>
          <input id="qbNewWrittenLabel" value="Written answer" placeholder="e.g. Describe the location"></div>
      </div>
      <div class="row mt8">
        <button class="btn btn-primary" onclick="qbAddQuestion()" aria-label="Add this question to the page">＋ Add question</button>
      </div>
    </div>`;
  }

  function pageNav(fn, page, total) {
    return `<div class="qb-pagenav" role="navigation" aria-label="Page navigation">
      <button class="btn btn-sm" onclick="${fn}(${page - 1})" ${page <= 1 ? "disabled" : ""} aria-label="Go to previous page">← Previous</button>
      <span class="small" aria-live="polite">Page ${page} of ${total}</span>
      <button class="btn btn-sm" onclick="${fn}(${page + 1})" ${page >= total ? "disabled" : ""} aria-label="Go to next page">Next →</button>
    </div>`;
  }

  // ================================================================ ANSWER
  async function openAnswer(copyId) {
    ui.copyId = copyId;
    ui.answerPage = 1;
    const c = Q.copy(copyId);
    if (c && c.status === STATUS.SENT) {
      try { await Q.markReceived(copyId); } catch (e) { /* offline — fine, it stays "Sent" */ }
    }
    window.setView("qbookAnswer");
    renderAnswer();
    window.renderTopbar();
  }

  function renderAnswer() {
    const c = document.getElementById("view-qbookAnswer");
    if (!c) return;
    const cp = Q.copy(ui.copyId);
    if (!cp) {
      c.innerHTML = `<div class="card"><div class="empty"><div class="big">Book not available</div>
        <button class="btn mt8" onclick="window.setView('library')">← Back to library</button></div></div>`;
      return;
    }
    const b = Q.book(cp.bookId);
    if (!b) { c.innerHTML = `<div class="card"><div class="empty"><div class="big">Book not available</div></div></div>`; return; }

    const locked = cp.status === STATUS.SUBMITTED || cp.status === STATUS.RETURNED;
    const pages = Q.pagesOf(b.id);
    const total = pages.length || 1;
    let page = Math.min(Math.max(1, ui.answerPage || 1), total);
    ui.answerPage = page;
    const cur = pages[page - 1];
    const qs = cur ? Q.questionsOfPage(cur.id) : [];
    const answers = {};
    Q.answersOf(cp.id).forEach(a => { answers[a.questionId] = a; });

    const body = qs.length ? qs.map(q => answerQuestion(q, answers[q.id], locked, cp.id)).join("")
      : `<div class="qb-empty-line">This page has no questions.</div>`;

    const answered = Q.answersOf(cp.id).filter(a => a.selectedLabel || (a.writtenAnswer || "").trim()).length;
    const nq = Q.questionCount(b.id);

    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="flex1">
            <h2>${esc(b.title)}</h2>
            <div class="small muted">From ${esc(nameOf(cp.senderId))} • received ${esc(fmtWhen(cp.receivedAt || cp.sentAt))} • ${esc(Q.statusLabel(cp.status))}</div>
            <div class="small muted">${answered} of ${nq} question${nq === 1 ? "" : "s"} answered</div>
          </div>
          ${statusBadge(cp.status)}
        </div>
        <div class="card-pad">
          ${cp.senderNote ? `<div class="qb-note"><b>Message from ${esc(nameOf(cp.senderId))}:</b> ${esc(cp.senderNote)}</div>` : ""}
          ${locked ? `<div class="qb-locked" role="status">You have already submitted this book. Your answers are saved and read-only now.
            ${cp.status === STATUS.SUBMITTED ? `Tap “Send completed book back” to return it to ${esc(nameOf(cp.senderId))}.` : `It is on its way back to ${esc(nameOf(cp.senderId))}.`}</div>` : ""}
          ${pageNav("qbAnswerPage", page, total)}
          <div class="qb-page" role="group" aria-label="Lined notebook page ${page} of ${total}">
            ${body}
          </div>
          <div class="qb-page-foot">Page ${page} of ${total}</div>
          <div class="row mt8" style="flex-wrap:wrap">
            ${locked ? "" : `<button class="btn btn-primary" onclick="qbSaveAnswers()" aria-label="Save my answers on this page">💾 Save my progress</button>`}
            ${locked ? "" : `<button class="btn btn-primary" onclick="qbSubmitAnswers()" aria-label="Submit all my answers">✓ Submit answers</button>`}
            ${cp.status === STATUS.SUBMITTED ? `<button class="btn btn-primary" onclick="qbSendBack()" aria-label="Send the completed book back to ${esc(nameOf(cp.senderId))}">↩ Send completed book back</button>` : ""}
            <button class="btn btn-sm" onclick="window.setView('library')" aria-label="Go back to the library, your answers are already saved">← Back to library</button>
          </div>
        </div>
      </div>`;
  }

  function answerQuestion(q, ans, locked, copyId) {
    const a = ans || { selectedLabel: "", writtenAnswer: "" };
    let choices = "";
    if (q.hasChoices) {
      const opts = Q.optionsOf(q.id);
      const dis = locked ? "disabled" : "";
      choices = `<fieldset class="qb-opts-field" ${dis}>
        <legend class="qb-legend">Choose one option</legend>
        ${opts.map(o => {
        const id = "qbr_" + q.id + "_" + o.label;
        return `<div class="qb-opt">
            <input type="radio" id="${id}" name="qq_${esc(q.id)}" value="${esc(o.label)}"
              ${a.selectedLabel === o.label ? "checked" : ""} ${dis}
              onchange="qbPick('${esc(copyId)}','${esc(q.id)}','${esc(o.label)}')">
            <label for="${id}"><span class="qb-opt-label" aria-hidden="true">${esc(o.label)}</span> ${o.text ? esc(o.text) : `<i class="muted">no text</i>`}</label>
          </div>`;
      }).join("")}
      </fieldset>`;
    }
    let written = "";
    if (q.hasWritten) {
      const wid = "qbw_" + q.id;
      written = `<div class="qb-written">
        <label class="qb-written-label" for="${wid}">${esc(q.writtenLabel || "Written answer")}</label>
        <textarea id="${wid}" rows="3" ${locked ? "disabled" : ""}
          placeholder="${locked ? "" : "Type your answer here"}"
          onchange="qbType('${esc(copyId)}','${esc(q.id)}','${wid}')"
          aria-label="Written answer for question ${esc(q.qNo)}: ${esc(q.text)}">${esc(a.writtenAnswer || "")}</textarea>
      </div>`;
    }
    return `<div class="qb-q">
      <div class="qb-qhead"><span class="qb-qno">Question ${esc(q.qNo)}</span></div>
      <div class="qb-qtext">${esc(q.text)}</div>
      ${choices}
      ${written}
    </div>`;
  }

  // ================================================================ RESULTS
  function openResults(copyId) {
    ui.resultsCopyId = copyId;
    window.setView("qbookResults");
    renderResults();
    window.renderTopbar();
  }

  function renderResults() {
    const c = document.getElementById("view-qbookResults");
    if (!c) return;
    const cp = Q.copy(ui.resultsCopyId);
    if (!cp) {
      c.innerHTML = `<div class="card"><div class="empty"><div class="big">Book not available</div>
        <button class="btn mt8" onclick="window.setView('library')">← Back to library</button></div></div>`;
      return;
    }
    const b = Q.book(cp.bookId);
    if (!b) { c.innerHTML = `<div class="card"><div class="empty"><div class="big">Book not available</div></div></div>`; return; }

    const answers = {};
    Q.answersOf(cp.id).forEach(a => { answers[a.questionId] = a; });
    const pages = Q.pagesOf(b.id);
    const nq = Q.questionCount(b.id);

    const pagesHtml = pages.map((p, i) => {
      const qs = Q.questionsOfPage(p.id);
      const body = qs.length ? qs.map(q => {
        const a = answers[q.id] || {};
        let opts = "";
        if (q.hasChoices) {
          opts = `<ul class="qb-opts">${Q.optionsOf(q.id).map(o => {
            const picked = a.selectedLabel === o.label;
            return `<li class="${picked ? "picked" : ""}">
              <span class="qb-opt-label" aria-hidden="true">${esc(o.label)}</span>
              <span class="qb-opt-text">${o.text ? esc(o.text) : `<i class="muted">empty</i>`}</span>
              ${picked ? `<span class="badge badge-green">Chosen</span>` : ""}
            </li>`;
          }).join("")}</ul>`;
        }
        let written = "";
        if (q.hasWritten) {
          written = `<div class="qb-written result">
            <div class="qb-written-label">${esc(q.writtenLabel || "Written answer")}</div>
            <div class="qb-answer-text">${(a.writtenAnswer || "").trim() ? esc(a.writtenAnswer) : `<i class="muted">No written answer given</i>`}</div>
          </div>`;
        }
        return `<div class="qb-q">
          <div class="qb-qhead"><span class="qb-qno">Question ${esc(q.qNo)}</span></div>
          <div class="qb-qtext">${esc(q.text)}</div>
          ${opts}
          ${written}
        </div>`;
      }).join("") : `<div class="qb-empty-line">This page has no questions.</div>`;

      return `<div class="qb-page" role="group" aria-label="Lined notebook page ${i + 1} of ${pages.length}">
        ${body}
      </div>
      <div class="qb-page-foot">Page ${i + 1} of ${pages.length}</div>`;
    }).join("");

    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="flex1">
            <h2>${esc(b.title)} — answers</h2>
            <div class="small muted">Answered by <b>${esc(nameOf(cp.recipientId))}</b></div>
            <div class="small muted">Submitted ${esc(fmtWhen(cp.submittedAt))}${cp.returnedAt ? ` • returned ${esc(fmtWhen(cp.returnedAt))}` : ""}</div>
            <div class="small muted">${nq} question${nq === 1 ? "" : "s"} • revision ${cp.revision}</div>
          </div>
          ${statusBadge(cp.status)}
        </div>
        <div class="card-pad">
          ${cp.status === STATUS.SUBMITTED ? `<button class="btn btn-primary mb8" onclick="qbRequestRevision('${esc(cp.id)}')"
            aria-label="Ask ${esc(nameOf(cp.recipientId))} to revise their answers">↻ Ask for a revision</button>` : ""}
          ${pagesHtml}
          <div class="row mt8">
            <button class="btn btn-sm" onclick="window.setView('library')" aria-label="Go back to the library">← Back to library</button>
          </div>
        </div>
      </div>`;
  }

  // ================================================================ actions
  /**
   * Wraps every question-book action.
   *
   * Three things the owner asked for, in one place:
   *   • a visible "Saving…" while the write is on its way to the server,
   *   • the real error message if the network or the database refuses,
   *   • a plain confirmation when it worked.
   * The book itself is never left half-changed: the database writes are
   * single statements, and a failure simply leaves the old values in place.
   */
  async function guard(fn, okMsg) {
    const busy = !S.isDemo();
    if (busy) toast("Saving…", 900);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      renderAll();
      renderQuestionBooks();
    } catch (e) {
      const msg = e && e.message ? e.message : "Something went wrong.";
      toast(msg, 4200);
      if (window.console) console.warn("[qbooks]", e);
    }
  }

  function qbOpenCreate() {
    const modal = document.getElementById("qbCreateModal");
    const input = document.getElementById("qbCreateTitle");
    const pages = document.getElementById("qbCreatePages");
    if (!modal) return;
    if (input) input.value = "";
    if (pages) pages.value = String(Q.DEFAULT_PAGES);
    modal.classList.add("open");
    if (input) setTimeout(() => input.focus(), 60);
  }
  function qbCloseCreate() {
    const modal = document.getElementById("qbCreateModal");
    if (modal) modal.classList.remove("open");
  }
  async function qbCreateBook() {
    const title = (document.getElementById("qbCreateTitle").value || "").trim();
    const pages = parseInt(document.getElementById("qbCreatePages").value, 10) || Q.DEFAULT_PAGES;
    if (!title) { toast("Give the book a title first."); return; }
    qbCloseCreate();
    let id = null;
    await guard(async () => { id = await Q.createBook(title, pages); }, "Question book created.");
    if (id) openEditor(id);
  }

  function qbOpenEditor(id) { openEditor(id); }
  function qbEditorPage(n) { ui.page = n; renderEditor(); }

  function qbToggleChoices() {
    const box = document.getElementById("qbChoicesBox");
    const cb = document.getElementById("qbNewChoices");
    if (box && cb) box.style.display = cb.checked ? "block" : "none";
  }
  function qbToggleWritten() {
    const box = document.getElementById("qbWrittenBox");
    const cb = document.getElementById("qbNewWritten");
    if (box && cb) box.style.display = cb.checked ? "block" : "none";
  }

  function qbAddQuestion() {
    const b = Q.book(ui.bookId);
    const pages = Q.pagesOf(ui.bookId);
    const page = pages[ui.page - 1];
    if (!b || !page) return;
    const text = (document.getElementById("qbNewText").value || "").trim();
    const hasChoices = document.getElementById("qbNewChoices").checked;
    const hasWritten = document.getElementById("qbNewWritten").checked;
    if (!text) { toast("Write the question text first."); return; }
    const options = {};
    ["A", "B", "C", "D"].forEach(l => {
      const el = document.getElementById("qbNew" + l);
      options[l] = el ? el.value.trim() : "";
    });
    const writtenLabel = (document.getElementById("qbNewWrittenLabel").value || "").trim() || "Written answer";
    guard(async () => {
      await Q.addQuestion(ui.bookId, page.id, { text, hasChoices, hasWritten, options, writtenLabel });
    }, "Question added.");
  }

  function qbEditQuestion(qid) {
    const q = (S.data.qquestions || []).find(x => x.id === qid);
    if (!q) return;
    ui.editing = qid;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set("qbEditText", q.text);
    const cbC = document.getElementById("qbEditChoices");
    const cbW = document.getElementById("qbEditWritten");
    if (cbC) cbC.checked = !!q.hasChoices;
    if (cbW) cbW.checked = !!q.hasWritten;
    const opts = Q.optionsOf(q.id);
    opts.forEach(o => set("qbEdit" + o.label, o.text || ""));
    set("qbEditWrittenLabel", q.writtenLabel || "Written answer");
    qbToggleEdit();
    const m = document.getElementById("qbEditModal");
    if (m) { m.classList.add("open"); setTimeout(() => { const t = document.getElementById("qbEditText"); if (t) t.focus(); }, 60); }
  }
  function qbCloseEdit() {
    const m = document.getElementById("qbEditModal");
    if (m) m.classList.remove("open");
    ui.editing = null;
  }
  function qbToggleEdit() {
    const bC = document.getElementById("qbEditChoicesBox");
    const cC = document.getElementById("qbEditChoices");
    if (bC && cC) bC.style.display = cC.checked ? "block" : "none";
    const bW = document.getElementById("qbEditWrittenBox");
    const cW = document.getElementById("qbEditWritten");
    if (bW && cW) bW.style.display = cW.checked ? "block" : "none";
  }
  function qbSaveEdit() {
    const qid = ui.editing;
    if (!qid) return;
    const text = (document.getElementById("qbEditText").value || "").trim();
    if (!text) { toast("The question needs some text."); return; }
    const hasChoices = document.getElementById("qbEditChoices").checked;
    const hasWritten = document.getElementById("qbEditWritten").checked;
    const options = {};
    ["A", "B", "C", "D"].forEach(l => {
      const el = document.getElementById("qbEdit" + l);
      options[l] = el ? el.value.trim() : "";
    });
    const writtenLabel = (document.getElementById("qbEditWrittenLabel").value || "").trim() || "Written answer";
    qbCloseEdit();
    guard(async () => {
      await Q.updateQuestion(qid, { text, hasChoices, hasWritten, options, writtenLabel });
    }, "Question updated.");
  }

  function qbDeleteQuestion(qid) {
    if (!window.confirm("Delete this question? This cannot be undone.")) return;
    guard(async () => { await Q.deleteQuestion(qid); }, "Question deleted.");
  }

  function qbAddPage(bookId) {
    guard(async () => { await Q.addPage(bookId); ui.page = Q.pagesOf(bookId).length; }, "Page added.");
  }

  function qbRenameBook(bookId) {
    const b = Q.book(bookId);
    if (!b) return;
    const t = window.prompt("Rename this question book", b.title || "");
    if (t == null) return;
    const title = t.trim();
    if (!title) { toast("The title cannot be empty."); return; }
    guard(async () => { await Q.renameBook(bookId, title); }, "Renamed.");
  }

  function qbDeleteBook(bookId) {
    const b = Q.book(bookId);
    if (!b) return;
    if (!window.confirm(`Delete “${b.title}”? Every question, every copy and every answer in it will be removed. This cannot be undone.`)) return;
    guard(async () => { await Q.deleteBook(bookId); }, "Question book deleted.");
  }

  // ------------------------------------------------------------- send flow
  function qbOpenSend(bookId) {
    ui.sendBookId = bookId;
    ui.sendPick = null;
    const m = document.getElementById("qbSendModal");
    const inp = document.getElementById("qbSendUser");
    const note = document.getElementById("qbSendNote");
    const res = document.getElementById("qbSendResult");
    const nm = document.getElementById("qbSendBookName");
    const b = Q.book(bookId);
    if (nm) nm.textContent = b ? b.title : "";
    if (inp) inp.value = "";
    if (note) note.value = "";
    if (res) res.innerHTML = `<div class="small muted">Type a name or user ID and tap “Find person”.</div>`;
    if (m) { m.classList.add("open"); setTimeout(() => { if (inp) inp.focus(); }, 60); }
  }
  function qbCloseSend() {
    const m = document.getElementById("qbSendModal");
    if (m) m.classList.remove("open");
    ui.sendBookId = null;
    ui.sendPick = null;
  }
  function qbFindSendUser() {
    const raw = (document.getElementById("qbSendUser").value || "").trim();
    const res = document.getElementById("qbSendResult");
    if (!raw) {
      ui.sendPick = null;
      if (res) res.innerHTML = `<div class="small muted">Type a name or user ID and tap “Find person”.</div>`;
      return;
    }
    const u = Q.findUserForSend(raw);
    ui.sendPick = u;
    if (res) {
      res.innerHTML = u
        ? `<div class="small"><b>${esc(u.name || u.email)}</b> found. Tap “Send book” to deliver it.</div>`
        : `<div class="small" style="color:#b91c1c">No registered user matches “${esc(raw)}”. Check the spelling, or ask them for their user ID.</div>`;
    }
  }
  function qbDoSend() {
    if (!ui.sendPick) { toast("Find a registered person first."); return; }
    // Read everything we need BEFORE closing the modal, because closing it
    // clears ui.sendPick.
    const bookId = ui.sendBookId;
    const recipientId = ui.sendPick.id;
    const who = nameOf(recipientId);
    const note = (document.getElementById("qbSendNote").value || "").trim();
    qbCloseSend();
    guard(async () => {
      await Q.sendBook(bookId, recipientId, note);
    }, `Sent to ${who}.`);
  }

  // ----------------------------------------------------------- answer flow
  function qbOpenAnswer(copyId) { openAnswer(copyId); }
  function qbAnswerPage(n) { ui.answerPage = n; renderAnswer(); }

  function qbPick(copyId, questionId, label) {
    guard(async () => { await Q.saveAnswer(copyId, questionId, { selectedLabel: label }); }, "Answer saved.");
  }
  function qbType(copyId, questionId, elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    guard(async () => { await Q.saveAnswer(copyId, questionId, { writtenAnswer: el.value }); }, "Answer saved.");
  }
  function qbSaveAnswers() {
    const cp = Q.copy(ui.copyId);
    if (!cp) return;
    const pages = Q.pagesOf(cp.bookId);
    const page = pages[ui.answerPage - 1];
    if (!page) return;
    const qs = Q.questionsOfPage(page.id);
    guard(async () => {
      for (const q of qs) {
        const wEl = document.getElementById("qbw_" + q.id);
        const rEl = document.querySelector('input[name="qq_' + q.id + '"]:checked');
        const patch = {};
        if (wEl) patch.writtenAnswer = wEl.value;
        if (rEl) patch.selectedLabel = rEl.value;
        if (Object.keys(patch).length) await Q.saveAnswer(cp.id, q.id, patch);
      }
    }, "Progress saved. You can close the app and come back.");
  }
  function qbSubmitAnswers() {
    qbSaveAnswers();
    const cp = Q.copy(ui.copyId);
    if (!cp) return;
    const nq = Q.questionCount(cp.bookId);
    const answered = Q.answersOf(cp.id).filter(a => a.selectedLabel || (a.writtenAnswer || "").trim()).length;
    if (!window.confirm(`Submit your answers? ${answered} of ${nq} question${nq === 1 ? "" : "s"} are answered. You cannot edit them after submitting — unless the creator asks for a revision.`)) return;
    guard(async () => { await Q.submitAnswers(cp.id); }, "Answers submitted.");
  }
  function qbSendBack() {
    const cp = Q.copy(ui.copyId);
    if (!cp) return;
    if (!window.confirm(`Send the completed book back to ${nameOf(cp.senderId)}?`)) return;
    guard(async () => { await Q.returnCompletedBook(cp.id); }, "Book returned to its creator.");
  }

  function qbOpenResults(copyId) { openResults(copyId); }
  function qbRequestRevision(copyId) {
    const cp = Q.copy(copyId);
    if (!cp) return;
    if (!window.confirm(`Ask ${nameOf(cp.recipientId)} to revise their answers? The book goes back to them and they can edit it again.`)) return;
    guard(async () => { await Q.requestRevision(copyId); }, "Revision requested.");
  }

  // Re-paints whichever question-book screen is on screen (called by
  // renderAll, so a save in one place updates everything else too).
  function refresh() {
    if (ui.bookId && !Q.book(ui.bookId)) { ui.bookId = null; window.setView("library"); return; }
    if (ui.copyId && !Q.copy(ui.copyId)) { ui.copyId = null; window.setView("library"); return; }
    if (ui.resultsCopyId && !Q.copy(ui.resultsCopyId)) { ui.resultsCopyId = null; window.setView("library"); return; }
    const active = activeView();
    if (active === "qbookEditor" && ui.bookId) renderEditor();
    else if (active === "qbookAnswer" && ui.copyId) renderAnswer();
    else if (active === "qbookResults" && ui.resultsCopyId) renderResults();
  }

  // Which question-book screen is on screen, by looking at the DOM.
  function activeView() {
    const names = ["qbookEditor", "qbookAnswer", "qbookResults"];
    for (let i = 0; i < names.length; i++) {
      const el = document.getElementById("view-" + names[i]);
      if (el && el.style.display !== "none") return names[i];
    }
    return null;
  }

  // ---------------------------------------------------------------- expose
  window.RBQBooksUI = { render: renderQuestionBooks, refresh, openEditor, openAnswer, openResults };
  Object.assign(window, {
    qbOpenCreate, qbCloseCreate, qbCreateBook,
    qbOpenEditor, qbEditorPage,
    qbToggleChoices, qbToggleWritten, qbAddQuestion,
    qbEditQuestion, qbCloseEdit, qbToggleEdit, qbSaveEdit, qbDeleteQuestion,
    qbAddPage, qbRenameBook, qbDeleteBook,
    qbOpenSend, qbCloseSend, qbFindSendUser, qbDoSend,
    qbOpenAnswer, qbAnswerPage, qbPick, qbType, qbSaveAnswers, qbSubmitAnswers, qbSendBack,
    qbOpenResults, qbRequestRevision
  });
})();
