/* RegisterBook — service worker.
 *
 * Two jobs:
 *   1. Make the app installable and usable offline (app-shell cache).
 *   2. Deliver real push notifications when the app is CLOSED, with action
 *      buttons (Open / Accept / Decline / Join / Answer).
 *
 * Network-first for same-origin files, so you always get the newest code when
 * you are online and the cached copy when you are not.
 */
const VERSION = "rb-2026-10-29a";
const CACHE = "registerbook-" + VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./notify.js",
  "./auth.js",
  "./store.js",
  "./qbooks.js",
  "./qbooks-ui.js",
  "./push.js",
  "./rtc.js",
  "./app.js",
  "./vendor/supabase.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "rb-skip-waiting") self.skipWaiting();
});

// ------------------------------------------------------------------ offline
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Supabase traffic must always go straight to the network.
  if (!sameOrigin) return;

  // App shell navigation: network first, then cache, then the cached index.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html").then(r => r || caches.match("./")))
    );
    return;
  }

  // Code (js/css/json) must always be fresh - otherwise a phone keeps running
  // last week's app after we deploy. Network first, cache only when offline.
  const isCode = /\.(js|css|json|webmanifest)$/i.test(url.pathname) || url.pathname === "/sw.js";
  if (isCode) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(r => r || Response.error()))
    );
    return;
  }

  // Images and everything else on our own origin: cache first, refresh later.
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ------------------------------------------------------------------ push
self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "RegisterBook", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "RegisterBook";
  const options = {
    body: data.body || "",
    tag: data.tag || "rb-" + (data.type || "system"),
    renotify: !!data.renotify,
    requireInteraction: !!data.requireInteraction,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    timestamp: Date.now(),
    // phones vibrate / speak this with the screen reader
    vibrate: [200, 100, 200],
    data: {
      type: data.type || "system",
      deepLink: data.deepLink || "#home=1",
      senderId: data.senderId || "",
      groupId: data.groupId || "",
      code: data.code || "",
      callId: data.callId || "",
      requestId: data.requestId || "",
      inviteId: data.inviteId || ""
    },
    actions: (data.actions || []).slice(0, 2)
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ------------------------------------------------------------------ click
function actionUrl(base, action, data) {
  const u = new URL(base, self.location.href);
  let hash = data.deepLink || "#home=1";
  if (action && action !== "open") {
    hash += (hash.indexOf("=") >= 0 ? "&" : "") + "rbaction=" + encodeURIComponent(action);
  }
  u.hash = hash.replace(/^#/, "");
  return u.toString();
}

async function openOrFocus(url, action, data) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of all) {
    if (new URL(c.url).origin === new URL(url).origin) {
      if ("focus" in c) await c.focus();
      // tell the open app first: it performs the action straight away
      try { c.postMessage({ type: "rb-notification-action", action, data, url }); } catch (e) {}
      if (typeof c.navigate === "function") {
        try { await c.navigate(url); } catch (e) { /* older browsers */ }
      }
      return;
    }
  }
  if (self.clients.openWindow) await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", event => {
  const notif = event.notification;
  const data = (notif && notif.data) || {};
  const action = event.action || "open";
  notif.close();
  const url = actionUrl("./index.html", action, data);
  event.waitUntil(openOrFocus(url, action, data));
});
