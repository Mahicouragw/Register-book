/* qbooks.js — "Create Questions Register Book".
 *
 * A question book is a notebook the creator writes and then SENDS to another
 * member of staff. The recipient answers it and SENDS IT BACK.
 *
 * The one rule everything else follows from:
 *   THE ORIGINAL BOOK IS NEVER OVERWRITTEN.
 * Every send creates its own "copy" row (rb_qbook_copies), and every answer
 * belongs to that copy. So Tiger's questions stay exactly as Tiger wrote them,
 * however many times Silver submits.
 *
 * Lifecycle of one copy:
 *   sent -> received -> in_progress -> submitted -> returned_to_creator
 * The creator can send it again (a new revision), or ask for a revision.
 *
 * Works in both modes:
 *   demo  — localStorage, via RBStore.data + persistDemo()
 *   cloud — Supabase, via RBStore.cloudInsert / cloudUpdate / cloudDelete
 */
(function () {
  "use strict";

  const S = window.RBStore;
  const uid = (window.RBUtil && window.RBUtil.uid) || (p => p + "_" + Math.random().toString(36).slice(2, 8));

  // The six statuses the owner asked for.
  const STATUS = {
    DRAFT: "draft",
    SENT: "sent",
    RECEIVED: "received",
    IN_PROGRESS: "in_progress",
    SUBMITTED: "submitted",
    RETURNED: "returned_to_creator"
  };

  const STATUS_LABEL = {
    draft: "Draft",
    sent: "Sent",
    received: "Received",
    in_progress: "In progress",
    submitted: "Submitted",
    returned_to_creator: "Returned to creator"
  };

  const OPTION_LABELS = ["A", "B", "C", "D"];
  const DEFAULT_PAGES = 20;

  function statusLabel(s) { return STATUS_LABEL[s] || s || "Draft"; }
  function db() { return S.data; }
  function nowIso() { return new Date().toISOString(); }

  // ---- ownership guards -------------------------------------------------
  // A recipient answers a COPY, so they must never be able to touch the
  // creator's questions or options. Postgres enforces that with RLS; these
  // guards make demo mode behave the same way and give a clear message
  // instead of a silent no-op.
  function requireOwner(bookId) {
    const b = book(bookId);
    if (!b) throw new Error("That question book no longer exists.");
    if (b.ownerId !== (S.me && S.me.id)) throw new Error("Only the creator can change this book.");
    return b;
  }
  function requireOwnerOfQuestion(questionId) {
    const q = db().qquestions.find(x => x.id === questionId);
    if (!q) throw new Error("That question no longer exists.");
    requireOwner(q.bookId);
    return q;
  }

  // ------------------------------------------------------------------ reads
  function myBooks() {
    const me = S.me && S.me.id;
    return db().qbooks.filter(b => b.ownerId === me);
  }

  /** Copies other people sent to me (my "Received Books" inbox). */
  function receivedCopies() {
    const me = S.me && S.me.id;
    return db().qcopies.filter(c => c.recipientId === me);
  }

  /** Copies I sent to other people. */
  function sentCopies() {
    const me = S.me && S.me.id;
    return db().qcopies.filter(c => c.senderId === me);
  }

  /** Completed books that came back to me (my "Completed Books" section). */
  function completedCopies() {
    return sentCopies().filter(c => c.status === STATUS.RETURNED || c.status === STATUS.SUBMITTED);
  }

  function book(bookId) { return db().qbooks.find(b => b.id === bookId) || null; }
  function copy(copyId) { return db().qcopies.find(c => c.id === copyId) || null; }

  function pagesOf(bookId) {
    return db().qpages.filter(p => p.bookId === bookId).sort((a, b) => a.pageNo - b.pageNo);
  }
  function questionsOf(bookId) {
    return db().qquestions.filter(q => q.bookId === bookId).sort((a, b) => a.qNo - b.qNo);
  }
  function questionsOfPage(pageId) {
    return db().qquestions.filter(q => q.pageId === pageId).sort((a, b) => a.qNo - b.qNo);
  }
  function optionsOf(questionId) {
    return OPTION_LABELS.map(label => {
      const found = db().qoptions.find(o => o.questionId === questionId && o.label === label);
      return { label, text: found ? found.text : "" };
    });
  }
  /** Every answer given to one copy, as an array. */
  function answersOf(copyId) {
    return db().qanswers.filter(a => a.copyId === copyId);
  }

  /** The headline status the OWNER sees on their book. */
  function bookStatus(bookId) {
    const copies = db().qcopies.filter(c => c.bookId === bookId);
    if (!copies.length) return STATUS.DRAFT;
    if (copies.some(c => c.status === STATUS.RETURNED)) return STATUS.RETURNED;
    if (copies.some(c => c.status === STATUS.SUBMITTED)) return STATUS.SUBMITTED;
    if (copies.some(c => c.status === STATUS.IN_PROGRESS || c.status === STATUS.RECEIVED)) return STATUS.SENT;
    return STATUS.SENT;
  }

  function questionCount(bookId) { return questionsOf(bookId).length; }

  // ------------------------------------------------------------------ writes: book
  async function createBook(title, pageCount) {
    const t = String(title || "").trim();
    if (!t) throw new Error("Give the book a title first.");
    const pages = Math.max(1, parseInt(pageCount, 10) || DEFAULT_PAGES);
    const id = uid("qb");
    const bookRow = { id, ownerId: S.me.id, title: t, createdAt: nowIso(), updatedAt: nowIso() };
    const pageRows = [];
    for (let i = 1; i <= pages; i++) pageRows.push({ id: uid("qp"), bookId: id, pageNo: i });

    if (S.isDemo()) {
      db().qbooks.unshift(bookRow);
      pageRows.forEach(p => db().qpages.push(p));
      S.persistDemo();
      return id;
    }
    await S.cloudInsert("rb_qbooks", [{
      id, owner_id: bookRow.ownerId, title: t, created_at: bookRow.createdAt, updated_at: bookRow.updatedAt
    }]);
    await S.cloudInsert("rb_qpages", pageRows.map(p => ({ id: p.id, book_id: id, page_no: p.pageNo })));
    await S.cloudRefresh();
    return id;
  }

  async function renameBook(bookId, title) {
    const t = String(title || "").trim();
    if (!t) throw new Error("The title cannot be empty.");
    requireOwner(bookId);
    if (S.isDemo()) {
      const b = book(bookId); if (!b) return;
      b.title = t; b.updatedAt = nowIso();
      S.persistDemo(); return;
    }
    await S.cloudUpdate("rb_qbooks", bookId, { title: t, updated_at: nowIso() });
    await S.cloudRefresh();
  }

  async function deleteBook(bookId) {
    requireOwner(bookId);
    if (S.isDemo()) {
      const qIds = questionsOf(bookId).map(q => q.id);
      const pIds = pagesOf(bookId).map(p => p.id);
      const cIds = db().qcopies.filter(c => c.bookId === bookId).map(c => c.id);
      db().qanswers = db().qanswers.filter(a => cIds.indexOf(a.copyId) === -1);
      db().qcopies = db().qcopies.filter(c => c.bookId !== bookId);
      db().qoptions = db().qoptions.filter(o => qIds.indexOf(o.questionId) === -1);
      db().qquestions = db().qquestions.filter(q => q.bookId !== bookId);
      db().qpages = db().qpages.filter(p => p.bookId !== bookId && pIds.indexOf(p.id) === -1);
      db().qbooks = db().qbooks.filter(b => b.id !== bookId);
      S.persistDemo(); return;
    }
    // The database cascades pages, questions, options, copies and answers.
    await S.cloudDelete("rb_qbooks", "id", bookId);
    await S.cloudRefresh();
  }

  async function addPage(bookId) {
    requireOwner(bookId);
    const existing = pagesOf(bookId);
    const pageNo = existing.length ? existing[existing.length - 1].pageNo + 1 : 1;
    const row = { id: uid("qp"), bookId, pageNo };
    if (S.isDemo()) {
      db().qpages.push(row); S.persistDemo(); return row;
    }
    await S.cloudInsert("rb_qpages", [{ id: row.id, book_id: bookId, page_no: pageNo }]);
    await S.cloudRefresh();
    return db().qpages.find(p => p.id === row.id) || row;
  }

  // ------------------------------------------------------------------ writes: questions
  /**
   * Adds one question. `hasChoices` and `hasWritten` can both be true, so a
   * question can offer A–D, a written answer, or both.
   */
  async function addQuestion(bookId, pageId, spec) {
    const s = spec || {};
    const text = String(s.text || "").trim();
    const hasChoices = s.hasChoices !== false;
    const hasWritten = !!s.hasWritten;
    if (!text && !hasWritten && !hasChoices) throw new Error("Write the question first.");
    if (!hasChoices && !hasWritten) throw new Error("A question needs options, a written answer, or both.");
    requireOwner(bookId);

    const all = questionsOf(bookId);
    const qNo = all.length ? all[all.length - 1].qNo + 1 : 1;
    const id = uid("qq");
    const writtenLabel = String(s.writtenLabel || "Written answer").trim() || "Written answer";

    if (S.isDemo()) {
      db().qquestions.push({
        id, bookId, pageId, qNo, text, hasChoices, hasWritten, writtenLabel
      });
      if (hasChoices) {
        OPTION_LABELS.forEach(label => {
          db().qoptions.push({ id: uid("qo"), questionId: id, label, text: String((s.options && s.options[label]) || "") });
        });
      }
      S.persistDemo();
      return id;
    }

    await S.cloudInsert("rb_questions", [{
      id, book_id: bookId, page_id: pageId, q_no: qNo, text,
      has_choices: hasChoices, has_written: hasWritten, written_label: writtenLabel
    }]);
    if (hasChoices) {
      await S.cloudInsert("rb_qoptions", OPTION_LABELS.map(label => ({
        id: uid("qo"), question_id: id, label, text: String((s.options && s.options[label]) || "")
      })));
    }
    await S.cloudUpdate("rb_qbooks", bookId, { updated_at: nowIso() });
    await S.cloudRefresh();
    return id;
  }

  async function updateQuestion(questionId, patch) {
    requireOwnerOfQuestion(questionId);
    const p = patch || {};
    if (S.isDemo()) {
      const q = db().qquestions.find(x => x.id === questionId);
      if (!q) return;
      if (p.text !== undefined) q.text = p.text;
      if (p.hasChoices !== undefined) q.hasChoices = !!p.hasChoices;
      if (p.hasWritten !== undefined) q.hasWritten = !!p.hasWritten;
      if (p.writtenLabel !== undefined) q.writtenLabel = p.writtenLabel;
      if (p.options) {
        OPTION_LABELS.forEach(label => {
          let o = db().qoptions.find(x => x.questionId === questionId && x.label === label);
          if (!o) { o = { id: uid("qo"), questionId, label, text: "" }; db().qoptions.push(o); }
          o.text = String(p.options[label] || "");
        });
      }
      S.persistDemo(); return;
    }
    const row = {};
    if (p.text !== undefined) row.text = p.text;
    if (p.hasChoices !== undefined) row.has_choices = !!p.hasChoices;
    if (p.hasWritten !== undefined) row.has_written = !!p.hasWritten;
    if (p.writtenLabel !== undefined) row.written_label = p.writtenLabel;
    if (Object.keys(row).length) await S.cloudUpdate("rb_questions", questionId, row);
    if (p.options) {
      for (const label of OPTION_LABELS) {
        const existing = db().qoptions.find(o => o.questionId === questionId && o.label === label);
        const text = String(p.options[label] || "");
        if (existing) {
          await S.cloudUpdate("rb_qoptions", existing.id, { text });
        } else {
          await S.cloudInsert("rb_qoptions", [{ id: uid("qo"), question_id: questionId, label, text }]);
        }
      }
    }
    await S.cloudRefresh();
  }

  async function deleteQuestion(questionId) {
    requireOwnerOfQuestion(questionId);
    if (S.isDemo()) {
      db().qoptions = db().qoptions.filter(o => o.questionId !== questionId);
      db().qanswers = db().qanswers.filter(a => a.questionId !== questionId);
      db().qquestions = db().qquestions.filter(q => q.id !== questionId);
      S.persistDemo(); return;
    }
    await S.cloudDelete("rb_qanswers", "question_id", questionId);
    await S.cloudDelete("rb_qoptions", "question_id", questionId);
    await S.cloudDelete("rb_questions", "id", questionId);
    await S.cloudRefresh();
  }

  // ------------------------------------------------------------------ sending
  /**
   * Finds one registered user by username or by user id.
   * Returns { id, name } or null. Never matches yourself.
   */
  function findUserForSend(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return null;
    const me = S.me && S.me.id;
    const people = (S.otherProfiles ? S.otherProfiles() : db().profiles.filter(p => p.id !== me));
    const exactId = people.find(p => String(p.id).toLowerCase() === q);
    if (exactId) return exactId;
    const exactName = people.find(p => String(p.name || "").toLowerCase() === q);
    if (exactName) return exactName;
    const partial = people.filter(p => String(p.name || "").toLowerCase().indexOf(q) === 0);
    if (partial.length === 1) return partial[0];
    return null;
  }

  /**
   * Sends the book to someone. This ALWAYS creates a new copy row, so the
   * original book and any earlier submission are never overwritten.
   */
  async function sendBook(bookId, recipientId, note) {
    const b = book(bookId);
    if (!b) throw new Error("That book no longer exists.");
    if (b.ownerId !== S.me.id) throw new Error("Only the creator can send this book.");
    if (!recipientId) throw new Error("Choose who to send it to.");
    if (recipientId === S.me.id) throw new Error("You cannot send a book to yourself.");

    const person = db().profiles.find(p => p.id === recipientId);
    if (!person) throw new Error("No registered user matches that name or id.");

    if (!questionCount(bookId)) throw new Error("Add at least one question before sending.");

    const previous = db().qcopies.filter(c => c.bookId === bookId && c.recipientId === recipientId);
    const revision = previous.length ? Math.max.apply(null, previous.map(c => c.revision || 1)) + 1 : 1;
    const id = uid("qc");
    const row = {
      id, bookId, senderId: S.me.id, recipientId,
      status: STATUS.SENT, revision,
      senderNote: String(note || ""),
      sentAt: nowIso(), receivedAt: null, submittedAt: null, returnedAt: null
    };

    if (S.isDemo()) {
      db().qcopies.unshift(row);
      S.persistDemo();
      return row;
    }
    await S.cloudInsert("rb_qbook_copies", [{
      id, book_id: bookId, sender_id: S.me.id, recipient_id: recipientId,
      status: STATUS.SENT, revision, sender_note: row.senderNote, sent_at: row.sentAt
    }]);
    // Let the recipient know, exactly like a message would.
    try {
      await S.notifyRemote({
        type: "system",
        recipientId,
        title: S.me.name + " sent you a question book",
        text: b.title
      });
    } catch (e) { /* a failed push must never lose the book itself */ }
    await S.cloudRefresh();
    return row;
  }

  // ------------------------------------------------------------------ answering
  async function markReceived(copyId) {
    const c = copy(copyId);
    if (!c || c.recipientId !== S.me.id) return;
    if (c.status !== STATUS.SENT) return;
    await setCopyStatus(copyId, STATUS.RECEIVED, { receivedAt: nowIso() });
  }

  /** Saves one answer. Safe to call repeatedly — it upserts. */
  async function saveAnswer(copyId, questionId, patch) {
    const c = copy(copyId);
    if (!c) throw new Error("That book no longer exists.");
    if (c.recipientId !== S.me.id) throw new Error("Only the person it was sent to can answer it.");
    if (c.status === STATUS.SUBMITTED || c.status === STATUS.RETURNED) {
      throw new Error("You already submitted this book. Ask " + "the creator" + " to reopen it if it needs changing.");
    }

    const selectedLabel = patch && patch.selectedLabel !== undefined ? (patch.selectedLabel || "") : undefined;
    const writtenAnswer = patch && patch.writtenAnswer !== undefined ? (patch.writtenAnswer || "") : undefined;

    if (S.isDemo()) {
      let a = db().qanswers.find(x => x.copyId === copyId && x.questionId === questionId);
      if (!a) {
        a = { id: uid("qa"), copyId, questionId, selectedLabel: "", writtenAnswer: "", updatedAt: nowIso() };
        db().qanswers.push(a);
      }
      if (selectedLabel !== undefined) a.selectedLabel = selectedLabel;
      if (writtenAnswer !== undefined) a.writtenAnswer = writtenAnswer;
      a.updatedAt = nowIso();
      S.persistDemo();
      // first answer moves the copy into "in progress"
      if (c.status === STATUS.RECEIVED || c.status === STATUS.SENT) {
        c.status = STATUS.IN_PROGRESS; S.persistDemo();
      }
      return a;
    }

    const row = { copy_id: copyId, question_id: questionId, updated_at: nowIso() };
    if (selectedLabel !== undefined) row.selected_label = selectedLabel || null;
    if (writtenAnswer !== undefined) row.written_answer = writtenAnswer || null;

    await S.cloudUpsert("rb_qanswers", row, "copy_id,question_id");

    if (c.status === STATUS.SENT || c.status === STATUS.RECEIVED) {
      await setCopyStatus(copyId, STATUS.IN_PROGRESS, {});
    } else {
      await S.cloudRefresh();
    }
    return row;
  }

  async function submitAnswers(copyId) {
    const c = copy(copyId);
    if (!c) throw new Error("That book no longer exists.");
    if (c.recipientId !== S.me.id) throw new Error("Only the person it was sent to can submit it.");
    if (c.status === STATUS.SUBMITTED || c.status === STATUS.RETURNED) {
      throw new Error("You already submitted this book.");
    }
    await setCopyStatus(copyId, STATUS.SUBMITTED, { submittedAt: nowIso() });
  }

  async function returnCompletedBook(copyId) {
    const c = copy(copyId);
    if (!c) throw new Error("That book no longer exists.");
    if (c.recipientId !== S.me.id) throw new Error("Only the person it was sent to can return it.");
    if (c.status !== STATUS.SUBMITTED) throw new Error("Submit your answers first, then send it back.");
    await setCopyStatus(copyId, STATUS.RETURNED, { returnedAt: nowIso() });
    // Tell the creator their completed book has landed.
    try {
      const b = book(c.bookId);
      await S.notifyRemote({
        type: "system",
        recipientId: c.senderId,
        title: S.me.name + " returned a completed question book",
        text: b ? b.title : ""
      });
    } catch (e) { /* never lose the return itself */ }
  }

  /** Creator asks for changes; the recipient may then edit and resubmit. */
  async function requestRevision(copyId) {
    const c = copy(copyId);
    if (!c) throw new Error("That book no longer exists.");
    if (c.senderId !== S.me.id) throw new Error("Only the creator can ask for a revision.");
    if (c.status !== STATUS.SUBMITTED && c.status !== STATUS.RETURNED) {
      throw new Error("That book has not been submitted yet.");
    }
    await setCopyStatus(copyId, STATUS.IN_PROGRESS, {});
  }

  async function setCopyStatus(copyId, status, extra) {
    if (S.isDemo()) {
      const c = copy(copyId);
      if (!c) return;
      c.status = status;
      Object.keys(extra || {}).forEach(k => { c[k] = extra[k]; });
      S.persistDemo();
      return;
    }
    const patch = { status };
    Object.keys(extra || {}).forEach(k => {
      patch[{ receivedAt: "received_at", submittedAt: "submitted_at", returnedAt: "returned_at" }[k] || k] = extra[k];
    });
    await S.cloudUpdate("rb_qbook_copies", copyId, patch);
    await S.cloudRefresh();
  }

  // ------------------------------------------------------------------ export
  window.RBQBooks = {
    STATUS, OPTION_LABELS, DEFAULT_PAGES, statusLabel,
    myBooks, receivedCopies, sentCopies, completedCopies,
    book, copy, bookStatus, questionCount,
    pagesOf, questionsOf, questionsOfPage, optionsOf, answersOf,
    createBook, renameBook, deleteBook, addPage,
    addQuestion, updateQuestion, deleteQuestion,
    findUserForSend, sendBook,
    markReceived, saveAnswer, submitAnswers, returnCompletedBook, requestRevision
  };
})();
