// push.js — real Web Push, permission handling and the "ting" sound.
//
// Two situations:
//   • App is OPEN    → Supabase Realtime delivers the row; we show a banner and
//                      play a short "ting". No service worker needed.
//   • App is CLOSED  → the rb-notify Edge Function sends a Web Push to the
//                      phone; sw.js shows the banner with action buttons.
//
// Honest limits, in plain words:
//   • Android Chrome: works from a normal tab AND from an installed app.
//   • iPhone / iPad Safari: web push only works after Share → Add to Home
//     Screen (iOS 16.4+). In a normal Safari tab, iOS refuses — Settings says
//     "not available in this browser" instead of pretending.
(function () {
  "use strict";

  const S = window.RBStore;

  function cfg() { return window.RB_CONFIG || {}; }

  // ------------------------------------------------------------ capability
  function isSecure() {
    return window.isSecureContext || /^(https:|localhost$|127\.0\.0\.1$)/.test(location.host) || location.protocol === "https:";
  }
  function supported() {
    return !!(window.PushManager && "serviceWorker" in navigator && "Notification" in window);
  }
  // iOS: Notification exists but push is only allowed for home-screen apps.
  function isIos() {
    const ua = navigator.userAgent || "";
    return /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
  }
  function isIosSafari() {
    const ua = navigator.userAgent || "";
    return isIos() && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|QQ|Line|Instagram|FBAN|FBAV|Twitter/.test(ua);
  }
  function isStandalone() {
    // matchMedia is missing in some embedded browsers and in test runners, and
    // a crash here would take the whole Settings screen down with it.
    try {
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
    } catch (e) { /* fall through */ }
    return window.navigator.standalone === true;
  }
  function iosBlocked() {
    return isIosSafari() && !isStandalone();
  }

  function permission() {
    if (!("Notification" in window)) return "unsupported";
    const p = window.Notification.permission;
    return p === "denied" ? "denied" : p === "granted" ? "granted" : "default";
  }

  // A human sentence describing the current state, shown in Settings.
  function statusText() {
    if (!supported()) {
      return {
        state: "unsupported",
        title: "Notifications are not available in this browser",
        body: "This browser cannot receive web push. On Android use Chrome; on iPhone add this page to your Home Screen first (iOS 16.4 or newer), then open it from there.",
        canEnable: false
      };
    }
    if (!isSecure()) {
      return {
        state: "insecure",
        title: "Notifications need a secure (https) page",
        body: "Open the app over https (the GitHub Pages address) — browsers block push on plain http.",
        canEnable: false
      };
    }
    if (iosBlocked()) {
      return {
        state: "ios-needs-install",
        title: "iPhone: add to Home Screen first",
        body: "Apple only allows web push for apps installed on the home screen. Tap Share → Add to Home Screen, then open RegisterBook from the new icon and switch notifications on here.",
        canEnable: true,
        howTo: "Share button (□↑) → Add to Home Screen → open the new icon → Settings → Notifications → switch on."
      };
    }
    if (permission() === "denied") {
      return {
        state: "denied",
        title: "Notifications are blocked for this site",
        body: "You tapped Block earlier. Open your browser settings for this site, set Notifications to Allow, then come back and switch it on again.",
        canEnable: false
      };
    }
    if (permission() === "granted") {
      return { state: "granted", title: "Notifications are ON", body: "You will get a banner and a sound even when the app is closed.", canEnable: false };
    }
    return { state: "default", title: "Notifications are off", body: "Switch them on to get messages, friend requests, group invites and calls while the app is closed.", canEnable: true };
  }

  // ------------------------------------------------------------ service worker
  let swReg = null;
  async function registerSw() {
    if (!("serviceWorker" in navigator)) return null;
    if (swReg) return swReg;
    try {
      swReg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
      return swReg;
    } catch (e) {
      console.warn("[push] service worker registration failed", e);
      return null;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
  }

  // ------------------------------------------------------------ subscribe
  async function enable() {
    const st = statusText();
    if (!st.canEnable) return { ok: false, reason: st.state, message: st.title + " — " + st.body };

    if (!("Notification" in window)) return { ok: false, reason: "unsupported" };
    const perm = await new Promise(resolve => {
      let settled = false;
      try {
        const r = window.Notification.requestPermission(p => { settled = true; resolve(p); });
        if (r && typeof r.then === "function") r.then(p => { settled = true; resolve(p); }).catch(() => { if (!settled) resolve("denied"); });
      } catch (e) { resolve("denied"); }
    });
    if (perm !== "granted") return { ok: false, reason: "not-granted", message: "Permission was not granted." };

    const reg = await registerSw();
    if (!reg) return { ok: false, reason: "no-sw", message: "The service worker could not be registered." };

    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = String(cfg().VAPID_PUBLIC_KEY || "");
      if (!key) return { ok: false, reason: "no-vapid", message: "VAPID public key is missing from config.js." };
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      });
    }
    try {
      await S.savePushSubscription(JSON.parse(JSON.stringify(sub)));
    } catch (e) {
      return { ok: false, reason: "save-failed", message: e.message || "Could not save the subscription." };
    }
    return { ok: true, subscription: sub };
  }

  async function disable() {
    try {
      const reg = await registerSw();
      if (!reg) return { ok: false };
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try { await S.deletePushSubscription(sub.endpoint); } catch (e) {}
        await sub.unsubscribe();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  async function currentSubscription() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch (e) { return null; }
  }

  async function isSubscribed() {
    const sub = await currentSubscription();
    return !!sub;
  }

  // ------------------------------------------------------------ local sound
  let audioCtx = null;
  function ting() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      const now = audioCtx.currentTime;
      [880, 1320].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.22, now + i * 0.09 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.28);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(now + i * 0.09);
        osc.stop(now + i * 0.09 + 0.3);
      });
    } catch (e) { /* sound is a nice-to-have */ }
  }
  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || [120, 60, 120]); } catch (e) {}
  }

  // ------------------------------------------------------------ in-app banner
  function showInApp(n) {
    let box = document.getElementById("rbLiveBanner");
    if (!box) {
      box = document.createElement("div");
      box.id = "rbLiveBanner";
      box.className = "live-banner-wrap";
      document.body.appendChild(box);
    }
    const data = (n && n.data) || {};
    const div = document.createElement("div");
    div.className = "live-banner";
    div.setAttribute("role", "status");
    const go = (window.RBApp && window.RBApp.openNotification) ? "openNotification('" + n.id + "')" : "";
    div.innerHTML =
      '<div class="live-banner-ico" aria-hidden="true">' + (n.type === "call" ? "📞" : n.type === "friend" ? "🧑‍🤝‍🧑" : n.type === "invite" ? "👥" : "💬") + '</div>' +
      '<div class="live-banner-text"><b>' + escapeHtml(n.title || "") + '</b>' +
      (n.body ? '<div class="small">' + escapeHtml(n.body) + '</div>' : "") + '</div>' +
      '<button class="btn btn-sm btn-primary" onclick="' + go + ';this.parentNode.remove()">Open</button>' +
      '<button class="btn btn-sm" onclick="this.parentNode.remove()" aria-label="Dismiss">✕</button>';
    box.appendChild(div);
    ting();
    buzz();
    setTimeout(() => { if (div.parentNode) div.remove(); }, 7000);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ------------------------------------------------------------ test push
  // Sends a real push through the Edge Function, so you can prove it works.
  async function sendTest() {
    if (S.isDemo()) {
      S.data.notifications.push({
        id: "demo_nt_" + Date.now(), userId: S.me.id, type: "system",
        title: "Test notification ✓", body: "Demo mode: this stayed on your phone (no server needed).",
        data: {}, read: false, createdAt: new Date().toISOString()
      });
      return { ok: true, demo: true, message: "Demo test notification added to your inbox." };
    }
    const res = await S.notifyRemote({
      type: "system",
      title: "RegisterBook test ✓",
      text: "If you can read this, real push notifications work on your phone."
    });
    if (!res.ok) {
      return { ok: false, message: "Could not send: " + (res.reason || "unknown error") };
    }
    if (!res.delivered) {
      return { ok: true, delivered: 0, message: "The server accepted it, but this phone has no push subscription yet. Switch notifications on above and try again." };
    }
    return { ok: true, delivered: res.delivered, message: "Sent to " + res.delivered + " device(s)." };
  }

  // ------------------------------------------------------------ install (PWA)
  // This is the piece that makes push actually work across apps and networks.
  //
  // A push message is delivered to the SERVICE WORKER, not to a tab. Android
  // only gives a web app that delivery path once it is INSTALLED (Chrome turns
  // it into a WebAPK); a bookmarked tab silently stops receiving pushes once
  // its tab is closed or backgrounded. iPhone Safari needs Share → Add to Home
  // Screen (iOS 16.4+). So "install" is not a nicety here — it is the thing
  // that turns notifications from "works while the app is open" into "works
  // whenever the other person sends something".
  let deferredPrompt = null;

  function installPlatform() {
    const ua = navigator.userAgent || "";
    if (isIos()) return "ios";
    if (/Android/.test(ua)) return "android";
    return "desktop";
  }

  function isInstalled() {
    return isStandalone() || window.navigator.standalone === true;
  }

  /** True when the browser is offering to install right now (Android/Chrome). */
  function canPromptInstall() { return !!deferredPrompt; }

  /** How to install by hand, in plain words, for the phone you are holding. */
  function installHowTo() {
    if (installPlatform() === "ios") {
      return "Tap the Share button at the bottom of Safari (the square with an arrow), scroll down, choose “Add to Home Screen”, then tap Add. Afterwards, always open RegisterBook from the new icon on your home screen.";
    }
    if (installPlatform() === "android") {
      return "Tap the three dots (⋮) in the top-right corner of Chrome, then choose “Install app” or “Add to Home screen”. Afterwards, always open RegisterBook from the new icon on your home screen.";
    }
    return "Open your browser menu and choose “Install RegisterBook” or “Add to Home screen”.";
  }

  function installStatus() {
    const installed = isInstalled();
    return {
      installed,
      canPrompt: !installed && canPromptInstall(),
      platform: installPlatform(),
      howTo: installHowTo(),
      // Why this matters, in one sentence the owner can read on a phone.
      why: installed
        ? "Installed ✓ — RegisterBook can now wake up and show messages and calls even when it is closed and you are using a different app."
        : "Until RegisterBook is installed on this home screen, messages and calls only arrive while the app is open. Install it and they arrive whenever someone sends them."
    };
  }

  /** Shows the phone's own install sheet. Returns { ok, outcome }. */
  async function promptInstall() {
    const evt = deferredPrompt;
    if (!evt) return { ok: false, reason: "no-prompt", message: installHowTo() };
    deferredPrompt = null;
    try {
      if (evt.prompt) evt.prompt();
      const choice = evt.userChoice ? await evt.userChoice : null;
      if (choice && choice.outcome === "accepted") {
        notifyInstallChange();
        return { ok: true, outcome: "accepted" };
      }
      return { ok: false, reason: "dismissed", outcome: choice ? choice.outcome : "unknown" };
    } catch (e) {
      return { ok: false, reason: "error", message: String((e && e.message) || e) };
    }
  }

  // Set by app.js so the Settings screen can redraw the moment the phone
  // becomes installable (or gets installed).
  function notifyInstallChange() {
    if (window.RBPush && typeof window.RBPush.onInstallChange === "function") {
      try { window.RBPush.onInstallChange(); } catch (e) { /* never break on a redraw */ }
    }
  }

  // Chrome on Android: fires when the app is installable. We hold the event so
  // our own big "Install" button can trigger the phone's install sheet later.
  window.addEventListener("beforeinstallprompt", e => {
    try { e.preventDefault(); } catch (err) {}
    deferredPrompt = e;
    notifyInstallChange();
  });

  // Fires on every platform once the app really is on the home screen.
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notifyInstallChange();
  });

  // iOS has no install event at all, so re-check when the display mode changes.
  try {
    const mq = window.matchMedia("(display-mode: standalone)");
    const onChange = () => notifyInstallChange();
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) { /* older browsers */ }


  window.RBPush = {
    supported, isIos, isIosSafari, isStandalone, iosBlocked, permission, statusText,
    registerSw, enable, disable, isSubscribed, currentSubscription,
    ting, buzz, showInApp, sendTest,
    // install (what makes push work when the app is closed)
    isInstalled, canPromptInstall, installPlatform, installHowTo, installStatus, promptInstall
  };
})();
