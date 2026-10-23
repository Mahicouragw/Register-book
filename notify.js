// notify.js — the exact wording of every push notification, in one place.
//
// Pure functions, no DOM, no network. Used by:
//   • the browser (window.RBNotifyText) to preview a notification,
//   • the rb-notify Edge Function (identical wording, imported copy),
//   • the automated tests (require("./notify.js")) so the wording is locked in.
//
// Flutter can reuse the same strings later; nothing here is web-specific.
(function () {
  "use strict";

  // Letters and digits without the confusing ones (no O/0, I/1, L, U).
  const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

  function randomCode(len, rng) {
    const rand = rng || Math.random;
    const n = len || 8;
    let out = "";
    for (let i = 0; i < n; i++) {
      out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
    }
    return out;
  }

  // The site lives in a sub-folder on GitHub Pages, so the trailing "/" matters:
  // https://mahicouragw.github.io/Register-book/#join=ABCD2345
  function joinUrl(base, code) {
    const b = String(base || "").replace(/\/+$/, "");
    return `${b}/#join=${encodeURIComponent(code || "")}`;
  }

  function clip(text, max) {
    const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    const n = max || 60;
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // The four notification types. `actions` are the buttons shown on the phone
  // banner (Android Chrome shows them; iOS shows a plain banner until you tap).
  function wording(ev) {
    const e = ev || {};
    const who = e.sender || e.caller || e.inviter || "Someone";
    const group = e.group || "a group";

    switch (e.type) {
      case "message":
        return {
          type: "message",
          title: `${who}: you have a new message`,
          body: e.text ? clip(e.text) : "Tap to open the chat.",
          actions: [
            { action: "open", title: "Open" },
            { action: "reply_later", title: "Reply later" }
          ],
          tag: "rb-message",
          renotify: true
        };

      case "friend":
        return {
          type: "friend",
          title: `${who} sent you a friend request`,
          body: "Tap Accept to connect, or Decline.",
          actions: [
            { action: "accept", title: "Accept" },
            { action: "decline", title: "Decline" }
          ],
          tag: "rb-friend",
          renotify: true
        };

      case "invite":
        return {
          type: "invite",
          title: `You're invited to ${group}`,
          body: e.text ? clip(e.text) : `${who} invited you to join “${group}”.`,
          actions: [
            { action: "join", title: "Join" },
            { action: "decline", title: "Decline" }
          ],
          tag: "rb-invite",
          renotify: true
        };

      case "call":
        return {
          type: "call",
          title: `${who} is calling (${e.kind === "video" ? "video" : "audio"})`,
          body: "Tap Answer to talk now, or Decline.",
          actions: [
            { action: "answer", title: "Answer" },
            { action: "decline", title: "Decline" }
          ],
          tag: "rb-call",
          renotify: true,
          requireInteraction: true
        };

      case "system":
      default:
        return {
          type: "system",
          title: e.title || "RegisterBook",
          body: e.text || "Test notification — if you can read this, push works.",
          actions: [{ action: "open", title: "Open" }],
          tag: "rb-system",
          renotify: false
        };
    }
  }

  // Which screen inside the app a notification should open.
  // Returns a deep-link fragment that the app understands, e.g. "#chat=<id>".
  function deepLink(e) {
    const ev = e || {};
    switch (ev.type) {
      case "message": return `#chat=${encodeURIComponent(ev.senderId || "")}`;
      case "friend":  return `#requests=1`;
      case "invite":  return `#join=${encodeURIComponent(ev.code || "")}`;
      case "call":    return `#call=${encodeURIComponent(ev.callId || "")}`;
      default:        return `#home=1`;
    }
  }

  const API = { CODE_ALPHABET, randomCode, joinUrl, clip, wording, deepLink };

  if (typeof window !== "undefined") window.RBNotifyText = API;
  if (typeof globalThis !== "undefined") globalThis.RBNotifyText = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
