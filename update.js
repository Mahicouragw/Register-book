// update.js — the built-in self-update for the Android APK.
//
// What it does, in order:
//   1. fetch version.json from a hosted URL (short timeout, never throws)
//   2. compare it with the version that is ACTUALLY installed
//   3. if newer, show an in-app panel (Update / Later, or forced)
//   4. on Update: check "allow install from this app" → download with live
//      progress → hand the file to the Android installer
//
// Nothing here opens a browser: the download happens inside the app and the
// system installer is launched automatically. That is the whole point — the
// owner should never have to hunt for a downloaded file again.
//
// Two layers live in this file on purpose:
//   • RBSemver + RBApkUpdateLogic — pure functions, no DOM, no network. The
//     tests exercise these directly (tests/apk-update.test.js).
//   • the UI wiring at the bottom — only runs in the browser/WebView.
//
// On the website (no Capacitor) the update check is skipped entirely: a PWA
// updates itself through the service worker (see setupAutoUpdate in app.js),
// so showing an APK panel there would be wrong.
(function () {
  "use strict";

  // ------------------------------------------------------------------ semver

  /**
   * Parses "1.0.12", "1.0.12-beta", "v1.0.12" into comparable numbers.
   * Returns null for anything unusable, so callers can say "bad manifest"
   * instead of silently pretending the app is up to date.
   */
  function parseVersion(value) {
    const raw = String(value == null ? "" : value).trim().replace(/^v/i, "");
    if (!raw) return null;
    const m = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return null;
    return {
      major: Number(m[1]) || 0,
      minor: Number(m[2]) || 0,
      patch: Number(m[3]) || 0,
      raw
    };
  }

  /** >0 when a is newer, <0 when older, 0 when equal (or unparsable). */
  function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return 0;
    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.minor !== pb.minor) return pa.minor - pb.minor;
    return pa.patch - pb.patch;
  }

  // ------------------------------------------------------------- validation

  /**
   * Validates the JSON the owner publishes.
   *
   * Returns { ok: true, update } or { ok: false, reason }. A bad manifest must
   * never crash the app and must never trigger a broken download, so every
   * field is checked here and the reason is human-readable.
   */
  function parseManifest(json) {
    if (!json || typeof json !== "object") {
      return { ok: false, reason: "The update file is not valid JSON." };
    }
    const versionName = String(json.version_name == null ? "" : json.version_name).trim();
    if (!versionName) {
      return { ok: false, reason: "version_name is missing from version.json." };
    }
    if (!parseVersion(versionName)) {
      return { ok: false, reason: "version_name \"" + versionName + "\" is not a version number like 1.0.2." };
    }

    const rawCode = json.version_code;
    const versionCode = Number(rawCode);
    if (!Number.isFinite(versionCode) || versionCode <= 0 || Math.floor(versionCode) !== versionCode) {
      return { ok: false, reason: "version_code must be a whole number like 3." };
    }

    const apkUrl = String(json.apk_url == null ? "" : json.apk_url).trim();
    // A manifest may publish a bundle-only release. In that case apk_url is
    // intentionally absent; APK fields remain validated whenever supplied.
    if (apkUrl) {
      // Only https: an APK over http could be swapped in transit, and Android
      // itself refuses cleartext downloads on modern versions anyway.
      if (!/^https:\/\//i.test(apkUrl)) {
        return { ok: false, reason: "apk_url must start with https://" };
      }
      if (!/\.apk(\?|#|$)/i.test(apkUrl)) {
        return { ok: false, reason: "apk_url does not point at a .apk file." }
      }
    }

    return {
      ok: true,
      update: {
        versionName,
        versionCode,
        title: String(json.title == null || json.title === "" ? "Update to the latest version" : json.title),
        changelog: String(json.changelog == null ? "" : json.changelog),
        apkUrl,
        forceUpdate: json.force_update === true,
        // Part 2: the optional content bundle. Absent or malformed means
        // "this manifest has no content update", never an error — an APK-only
        // release must keep working.
        bundle: parseBundle(json)
      }
    };
  }

  /**
   * Reads the optional content-bundle section of version.json.
   *
   * Returns null when there is none, or when what is there cannot be trusted.
   * The fields are:
   *
   *   bundle_url      https://.../bundle.zip
   *   bundle_version  a whole number that only ever goes up
   *   bundle_sha256   hash of the files inside, see tools/make-bundle.js
   *   bundle_notes    optional, shown as the reason for the update
   *
   * A bundle must be https and must carry a positive integer version; the hash
   * is optional but strongly recommended, because it is what lets the phone
   * refuse a corrupted or tampered download.
   */
  function parseBundle(json) {
    if (!json || typeof json !== "object") return null;
    const url = String(json.bundle_url == null ? "" : json.bundle_url).trim();
    if (!url) return null;
    if (!/^https:\/\//i.test(url)) return null;
    if (!/\.zip(\?|#|$)/i.test(url)) return null;

    const version = usableCode(json.bundle_version);
    if (version == null) return null;

    const sha = String(json.bundle_sha256 == null ? "" : json.bundle_sha256).trim().toLowerCase();
    const validSha = /^[a-f0-9]{64}$/.test(sha) ? sha : "";

    return {
      url,
      version,
      sha256: validSha,
      notes: String(json.bundle_notes == null ? "" : json.bundle_notes)
    };
  }

  /**
   * Should this phone fetch the content bundle?
   *
   * The rule is deliberately conservative: only a strictly higher
   * bundle_version is worth a download, and never when the APK itself is
   * about to be replaced — the new APK carries its own content, so pulling a
   * bundle first would be wasted work and an extra 30 seconds of setup.
   */
  function shouldUpdateBundle(bundle, installedBundle, apkUpdateAvailable) {
    if (!bundle) return false;
    if (apkUpdateAvailable) return false;
    const have = usableCode(installedBundle && installedBundle.version);
    if (have == null) return true;
    return bundle.version > have;
  }

  /**
   * Decides whether the remote manifest is a real upgrade.
   *
   * versionCode is the authority, because it is exactly what Android's
   * installer compares. Two rules follow from that and both matter:
   *
   *   • A HIGHER code is an update.
   *   • An EQUAL or lower code is NOT, even when version_name looks bigger.
   *     Android refuses to install over an equal versionCode ("App not
   *     installed"), so offering it would send the user through a download
   *     that can only fail.
   *
   * The version name is only consulted when one side has no usable code.
   */
  function isNewer(remote, installed) {
    if (!remote || !installed) return false;
    const remoteCode = usableCode(remote.versionCode);
    const localCode = usableCode(installed.versionCode);
    if (remoteCode != null && localCode != null) {
      return remoteCode > localCode;
    }
    return compareVersions(remote.versionName, installed.versionName) > 0;
  }

  /** null unless the value is a real positive whole number. */
  function usableCode(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return null;
    return n;
  }

  /** "1.0.4 (code 4)" — used in the panel and in Settings. */
  function describeVersion(versionName, versionCode) {
    const name = String(versionName == null ? "" : versionName).trim() || "unknown";
    const code = usableCode(versionCode);
    return code == null ? name : name + " (code " + code + ")";
  }

  /** "62%" or "Downloading…" when the server sent no Content-Length. */
  function progressLabel(received, total) {
    const r = Number(received) || 0;
    const t = Number(total) || 0;
    if (t > 0) {
      const pct = Math.min(100, Math.floor((r * 100) / t));
      return pct + "%";
    }
    // Unknown size: show megabytes so the bar is not the only feedback.
    return (r / (1024 * 1024)).toFixed(1) + " MB";
  }

  /** Turns a download failure into something a person can act on. */
  function friendlyDownloadError(message) {
    const text = String(message == null ? "" : message);
    if (/ENOSPC|no space|space/i.test(text)) return "There is not enough free space for the update. Free some space and try again.";
    if (/network|unreachable|timeout|timed out|SocketTimeout|connect/i.test(text)) return "The update could not be downloaded — check your internet and try again.";
    if (/HTTP 4\d\d/.test(text)) return "The update link is not working (" + (text.match(/HTTP \d+/) || [""])[0] + "). Ask the owner to re-publish it.";
    if (/HTTP 5\d\d/.test(text)) return "The update server had a problem. Please try again in a few minutes.";
    if (/empty/i.test(text)) return "The downloaded file was empty. The update link is probably wrong.";
    if (/stopped early|truncated/i.test(text)) return "The download stopped early. Please try again.";
    return text ? "The update could not be downloaded: " + text : "The update could not be downloaded.";
  }

  // ------------------------------------------------------------- pure export

  const Logic = {
    parseVersion,
    compareVersions,
    parseManifest,
    parseBundle,
    shouldUpdateBundle,
    isNewer,
    describeVersion,
    progressLabel,
    friendlyDownloadError,
    bundleLabel: function (state) {
      if (!state || !state.active) return "Built into the app";
      return "Content v" + state.version;
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Logic;
  if (typeof window !== "undefined") window.RBUpdateLogic = Logic;

  // -------------------------------------------------------------------- UI
  // Everything below needs a DOM; the tests never reach it because Node
  // imports this file with `module` defined and `window` undefined.
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // The manifest is fetched from GitHub Pages, which serves the repo root.
  // Keep this in step with SITE_URL in config.js.
  const DEFAULT_MANIFEST_URL = "https://mahicouragw.github.io/Register-book/version.json";
  const CHECK_TIMEOUT_MS = 8000;
  // Do not nag: after "Later", wait this long before the panel appears again.
  const SNOOZE_MS = 6 * 60 * 60 * 1000;
  const SNOOZE_KEY = "rb-update-snoozed";

  function cfg() {
    return (window.RB_CONFIG || {});
  }
  function manifestUrl() {
    const c = cfg();
    return String(c.UPDATE_URL || DEFAULT_MANIFEST_URL);
  }

  function isNative() {
    try {
      return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }

  /** Plugin access that matches the rest of the codebase (push.js/app.js). */
  function plugin() {
    try {
      const cap = window.Capacitor;
      if (!cap) return null;
      if (cap.Plugins && cap.Plugins.ApkUpdater) return cap.Plugins.ApkUpdater;
      if (typeof cap.getPlugin === "function") return cap.getPlugin("ApkUpdater") || null;
    } catch (e) {}
    return null;
  }

  function snoozeKey() {
    try {
      const me = window.RBStore && window.RBStore.me;
      return SNOOZE_KEY + ":" + ((me && me.id) || "anon");
    } catch (e) {
      return SNOOZE_KEY;
    }
  }
  function snoozedUntil() {
    try { return Number(window.localStorage.getItem(snoozeKey())) || 0; } catch (e) { return 0; }
  }
  function snooze() {
    try { window.localStorage.setItem(snoozeKey(), String(Date.now() + SNOOZE_MS)); } catch (e) {}
  }
  function clearSnooze() {
    try { window.localStorage.removeItem(snoozeKey()); } catch (e) {}
  }

  /**
   * fetch() with a hard timeout.
   *
   * AbortController is the only way to stop a fetch that is hanging; without
   * it a dead network leaves the "checking…" spinner forever. The catch turns
   * every failure into { ok:false } so no caller has to try/catch.
   */
  async function fetchJson(url, timeoutMs) {
    const ms = Number(timeoutMs) || CHECK_TIMEOUT_MS;
    let timer = null;
    let controller = null;
    try {
      if (typeof AbortController === "function") {
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), ms);
      }
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
      const json = await res.json();
      return { ok: true, json };
    } catch (e) {
      const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message)));
      return { ok: false, reason: aborted ? "timeout" : String((e && e.message) || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ state
  const state = {
    installed: null,   // { versionName, versionCode }
    update: null,      // parsed manifest of an available update
    status: "idle",    // idle | checking | available | downloading | ready | error
    progress: { received: 0, total: -1, percent: -1 },
    message: "",
    downloadedPath: "",
    lastChecked: 0,
    busy: false
  };

  function listeners() {
    return window.RBUpdater && Array.isArray(window.RBUpdater._listeners) ? window.RBUpdater._listeners : [];
  }
  function emit() {
    listeners().forEach(fn => { try { fn(state); } catch (e) {} });
  }

  /** The running version. Native reads the real package; web uses the build stamp. */
  async function installedVersion() {
    if (state.installed) return state.installed;
    if (isNative()) {
      const p = plugin();
      if (p && typeof p.getAppInfo === "function") {
        try {
          const info = await p.getAppInfo();
          state.installed = {
            versionName: String(info.versionName || ""),
            versionCode: Number(info.versionCode) || 0
          };
          return state.installed;
        } catch (e) { /* fall through to the web value */ }
      }
    }
    // On the website there is no native package; the service worker owns
    // updates. Report the APK-format version only so Settings can show it.
    const build = window.RB_BUILD || {};
    state.installed = {
      versionName: String(build.versionName || "web"),
      versionCode: Number(build.versionCode) || 0
    };
    return state.installed;
  }

  // ---------------------------------------------------------------- checking

  /**
   * Fetches the manifest and decides whether to show the panel.
   * `opts.manual` = the user pressed "Check for updates": report the result
   * even when there is nothing new (silence would look broken).
   */
  async function check(opts) {
    const manual = !!(opts && opts.manual);
    // A web/PWA page has its own updater; never offer an APK here.
    if (!isNative()) {
      state.status = "web";
      emit();
      if (manual) return { ok: true, native: false, reason: "This is the website build — it updates itself automatically." };
      return { ok: false, native: false };
    }

    state.status = "checking";
    state.message = "";
    emit();

    const installed = await installedVersion();
    const res = await fetchJson(manifestUrl());

    if (!res.ok) {
      state.status = "error";
      state.lastChecked = Date.now();
      // Offline is normal, not an error the user must act on.
      state.message = res.reason === "timeout"
        ? "The update check timed out. You can keep using the app."
        : "Could not check for updates right now.";
      emit();
      return { ok: false, native: true, reason: res.reason, installed };
    }

    const parsed = parseManifest(res.json);
    if (!parsed.ok) {
      state.status = "error";
      state.lastChecked = Date.now();
      state.message = "The update information is broken: " + parsed.reason;
      emit();
      return { ok: false, native: true, reason: parsed.reason, installed };
    }

    state.lastChecked = Date.now();

    if (!parsed.update.apkUrl || !isNewer(parsed.update, installed)) {
      state.status = "idle";
      state.update = null;
      emit();
      // No new APK — but there may still be new content. This runs in the
      // background and must never make the panel appear or hold up the UI.
      const content = await maybeUpdateBundle(parsed.update.bundle, false);
      let message = "You are on the latest version (" + describeVersion(installed.versionName, installed.versionCode) + ").";
      if (content && content.updated) message += " New content was downloaded and is ready.";
      return {
        ok: true,
        native: true,
        available: false,
        installed,
        latest: parsed.update.versionName,
        content,
        message
      };
    }

    state.update = parsed.update;
    state.status = "available";
    // A new APK carries the content it was built with, so a bundle would be
    // wasted work. Record that we deliberately skipped it instead.
    if (parsed.update.bundle) state.bundleSkipped = "apk-first";
    emit();

    const forced = parsed.update.forceUpdate;
    if (manual || forced || Date.now() >= snoozedUntil()) {
      openPanel();
    }
    return { ok: true, native: true, available: true, installed, latest: parsed.update.versionName };
  }

  // ----------------------------------------------------- Part 2: content (OTA)

  /**
   * Fetches a content bundle if one is genuinely newer than what is on the
   * phone, and activates it for the next launch.
   *
   * SILENT BY DESIGN
   * ----------------
   * This is the BandLab-style part: no dialog, no "an update is available",
   * no interruption. The user opens the app one day and a fix that shipped as
   * a 40 KB bundle is simply there.
   *
   * What it will NOT do: reload the UI underneath the user. Swapping files
   * mid-session leaves half the screen on old code, and any in-flight request
   * would read a file that just changed. The new content goes live at the next
   * cold start, where {@code AssetRouter} picks it up before the WebView loads.
   *
   * Everything here is best-effort: a failed content update must be invisible.
   * The app keeps running on the content it already has.
   *
   * @param bundle the parsed bundle section of version.json, or null
   * @param interactive true when the user explicitly asked (shows errors)
   */
  async function maybeUpdateBundle(bundle, interactive) {
    if (!bundle) return null;
    const p = plugin();
    if (!p || typeof p.updateBundle !== "function") return null;

    // What is already installed, so an old bundle is never re-downloaded.
    let installed = null;
    try {
      if (typeof p.getBundleInfo === "function") installed = await p.getBundleInfo();
    } catch (e) { /* treat as none */ }

    if (!shouldUpdateBundle(bundle, installed, false)) {
      return { updated: false, reason: "current", installed };
    }

    // A bundle is only worth downloading on a connection that can take it.
    // navigator.connection is not on every WebView; absence means "unknown".
    try {
      const conn = window.navigator && window.navigator.connection;
      if (conn && conn.saveData) {
        return { updated: false, reason: "save-data", installed };
      }
    } catch (e) {}

    state.bundle = state.bundle || { status: "idle" };
    state.bundle.status = "downloading";
    state.bundle.version = bundle.version;
    emit();

    // Progress is reported so Settings can show it, but nothing is blocked on
    // it and no panel opens.
    wireBundleProgress(p);

    try {
      const res = await p.updateBundle({
        url: bundle.url,
        version: bundle.version,
        sha256: bundle.sha256 || ""
      });
      state.bundle.status = "ready";
      state.bundle.version = bundle.version;
      state.bundle.pendingRestart = true;
      emit();
      return { updated: true, version: bundle.version, state: res, installed };
    } catch (e) {
      state.bundle.status = "error";
      state.bundle.message = String((e && e.message) || e);
      emit();
      if (interactive) {
        state.message = "The content update could not be installed: " + state.bundle.message;
        emit();
      }
      return { updated: false, reason: "failed", error: state.bundle.message };
    }
  }

  let bundleProgressWired = false;
  function wireBundleProgress(p) {
    if (bundleProgressWired || !p || typeof p.addListener !== "function") return;
    bundleProgressWired = true;
    try {
      p.addListener("bundleDownloadProgress", info => {
        state.bundle = state.bundle || {};
        state.bundle.progress = {
          received: Number(info && info.received) || 0,
          total: info && info.total != null ? Number(info.total) : -1,
          percent: info && info.percent != null ? Number(info.percent) : -1
        };
        emit();
      });
    } catch (e) { /* the update still works without progress */ }
  }

  /**
   * Cleans up the update files, and says what it reclaimed.
   *
   * Called at three moments:
   *   • right after the installed version is seen to equal or exceed the one
   *     that was downloaded (Android's installer finished, we came back up)
   *   • when the panel is dismissed without updating
   *   • on startup, via the native sweep in MainActivity
   */
  async function cleanupFiles(silent) {
    const p = plugin();
    if (!p || typeof p.cleanup !== "function") return { files: 0, bytes: 0 };
    try {
      const res = await p.cleanup();
      const files = Number(res && res.files) || 0;
      if (files > 0 && !silent) {
        const mb = ((Number(res.bytes) || 0) / (1024 * 1024)).toFixed(1);
        // No toast here on purpose: update.js must not depend on app.js's UI
        // helpers, and this file's own message channel already renders.
        state.message = "Cleared " + files + " leftover update file" + (files === 1 ? "" : "s") + " (" + mb + " MB).";
        emit();
      }
      return { files, bytes: Number(res && res.bytes) || 0 };
    } catch (e) {
      return { files: 0, bytes: 0 };
    }
  }

  /**
   * The guarantee behind "0 MB wasted": once the app that is running is at
   * least as new as the file we downloaded, that file is dead weight.
   *
   * This covers the case the startup sweep cannot: the installer finished and
   * relaunched the app within the same session, so no fresh launch happened.
   */
  async function dropStaleDownload() {
    const p = plugin();
    if (!p || typeof p.getStorageInfo !== "function") return false;
    try {
      const info = await p.getStorageInfo();
      if (!info || !info.apkExists) return false;
      // Something is sitting in the cache. If we are no longer being offered an
      // update — i.e. the installed code matches what we downloaded — it is
      // already installed and can go.
      if (state.update && isNewer(state.update, state.installed)) return false;
      await cleanupFiles(true);
      return true;
    } catch (e) {
      return false;
    }
  }

  // -------------------------------------------------------------------- panel

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * Builds the panel once and re-uses it.
   *
   * It is its own overlay (not one of the existing modals) because the update
   * panel must be able to appear before sign-in and must never be dismissed by
   * the app's normal modal code — especially when force_update is true.
   */
  function buildPanel() {
    if (document.getElementById("updatePanel")) return;
    const wrap = el("div", "modal");
    wrap.id = "updatePanel";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "updateTitle");

    const card = el("div", "modal-card update-card");
    const head = el("div", "modal-head");
    const title = el("h3", "", "Update to the latest version");
    title.id = "updateTitle";
    const close = el("button", "btn btn-sm", "✕");
    close.id = "updateClose";
    close.setAttribute("aria-label", "Close");
    close.onclick = () => closePanel(true);
    head.appendChild(title);
    head.appendChild(close);

    const body = el("div", "modal-body update-body");
    const versions = el("div", "update-versions");
    versions.id = "updateVersions";
    const notes = el("div", "update-notes");
    notes.id = "updateNotes";
    const progress = el("div", "update-progress");
    progress.id = "updateProgress";
    progress.style.display = "none";
    const bar = el("div", "update-bar");
    const fill = el("div", "update-fill");
    fill.id = "updateFill";
    bar.appendChild(fill);
    const progressText = el("div", "update-progress-text small", "");
    progressText.id = "updateProgressText";
    progress.appendChild(bar);
    progress.appendChild(progressText);
    const msg = el("div", "update-msg small", "");
    msg.id = "updateMsg";

    body.appendChild(versions);
    body.appendChild(notes);
    body.appendChild(progress);
    body.appendChild(msg);

    const foot = el("div", "update-foot");
    const later = el("button", "btn btn-sm", "Later");
    later.id = "updateLater";
    later.onclick = () => closePanel(true);
    const go = el("button", "btn btn-sm btn-primary", "Update");
    go.id = "updateGo";
    go.onclick = () => startUpdate();
    foot.appendChild(later);
    foot.appendChild(go);

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
  }

  function openPanel() {
    buildPanel();
    renderPanel();
    const panel = document.getElementById("updatePanel");
    if (panel) panel.classList.add("open");
  }

  function closePanel(fromUser) {
    const panel = document.getElementById("updatePanel");
    if (!panel) return;
    const forced = state.update && state.update.forceUpdate;
    // A required update cannot be dismissed — not by ✕, not by "Later".
    if (forced && fromUser && state.status !== "ready") return;
    panel.classList.remove("open");
    if (fromUser && !forced) snooze();
    // The user declined for now. If a download was started and stopped, the
    // file is useless until they tap Update again; deleting it here is what
    // stops a dismissed panel from leaving an APK in the cache for days.
    if (fromUser && state.status !== "downloading" && state.status !== "installing") {
      cleanupFiles(true);
    }
  }

  /** One render function for every state, so the panel never drifts. */
  function renderPanel() {
    const u = state.update;
    if (!u) return;
    const installed = state.installed || {};

    const versions = document.getElementById("updateVersions");
    if (versions) {
      versions.textContent = "";
      versions.appendChild(el("span", "badge badge-gray", "Installed " + describeVersion(installed.versionName, installed.versionCode)));
      versions.appendChild(el("span", "update-arrow", "→"));
      versions.appendChild(el("span", "badge badge-green", "New " + u.versionName));
    }

    const notes = document.getElementById("updateNotes");
    if (notes) {
      notes.textContent = "";
      const lines = String(u.changelog || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) {
        notes.appendChild(el("div", "small", "Bug fixes and improvements."));
      } else if (lines.length === 1) {
        notes.appendChild(el("div", "", lines[0]));
      } else {
        const list = el("ul", "update-list");
        lines.forEach(line => {
          // Accept "- item" and "• item" style notes as bullet text.
          const text = line.replace(/^[-*•]\s*/, "");
          list.appendChild(el("li", "", text));
        });
        notes.appendChild(list);
      }
    }

    const titleEl = document.getElementById("updateTitle");
    if (titleEl) titleEl.textContent = u.title || "Update to the latest version";

    const progress = document.getElementById("updateProgress");
    const msg = document.getElementById("updateMsg");
    const go = document.getElementById("updateGo");
    const later = document.getElementById("updateLater");
    const close = document.getElementById("updateClose");

    const busy = state.status === "downloading";
    if (progress) progress.style.display = busy || state.status === "ready" ? "block" : "none";
    if (msg) msg.textContent = state.message || "";

    if (go) {
      go.disabled = busy;
      go.textContent = state.status === "ready" ? "Install" : busy ? "Downloading…" : "Update";
      // On a forced update the only button is Update.
      go.style.display = "";
    }
    if (later) later.style.display = u.forceUpdate ? "none" : "";
    if (close) close.style.display = u.forceUpdate ? "none" : "";

    const fill = document.getElementById("updateFill");
    const text = document.getElementById("updateProgressText");
    const pct = state.progress && state.progress.percent >= 0 ? state.progress.percent : -1;
    if (fill) {
      fill.style.width = (state.status === "ready" ? 100 : Math.max(0, pct)) + "%";
    }
    if (text) {
      if (state.status === "ready") text.textContent = "Downloaded — opening the installer…";
      else if (busy) text.textContent = "Downloading " + progressLabel(state.progress.received, state.progress.total);
      else text.textContent = "";
    }
  }

  // ---------------------------------------------------------------- updating

  /** Where the update is in a single tap: permission → download → install. */
  async function startUpdate() {
    if (!state.update || state.busy) return;
    const p = plugin();
    // An older APK may be running this newer page (the WebView loads the live
    // site). Without downloadApk/installApk in the native layer, an in-app
    // update is impossible — say so instead of failing silently.
    if (!p || typeof p.downloadApk !== "function" || typeof p.installApk !== "function") {
      state.message = "This version of the app cannot install updates by itself. Please install the newest APK once from the website — after that, updates happen inside the app.";
      emit(); renderPanel();
      return;
    }
    state.busy = true;
    state.message = "";

    try {
      // ---- 1. "allow install from this app" ------------------------------
      const allowed = await ensureInstallPermission(p);
      if (!allowed) {
        state.message = "Turn on \"Allow from this source\" for RegisterBook, then come back and tap Update again.";
        emit(); renderPanel();
        return;
      }

      // ---- 2. download ----------------------------------------------------
      state.status = "downloading";
      state.progress = { received: 0, total: -1, percent: -1 };
      emit(); renderPanel();

      let res;
      try {
        // No fileName: the native side always writes cache/updates/update.apk.
        // Letting JavaScript name the file is what used to allow a second copy
        // (update(1).apk) to accumulate.
        res = await p.downloadApk({ url: state.update.apkUrl });
      } catch (e) {
        state.status = "available";
        state.message = friendlyDownloadError((e && e.message) || e);
        emit(); renderPanel();
        return;
      }
      if (!res || !res.path) {
        state.status = "available";
        state.message = "The download finished but the file could not be found. Please try again.";
        emit(); renderPanel();
        return;
      }
      state.downloadedPath = res.path;
      state.status = "ready";
      state.progress = { received: res.bytes || 0, total: res.bytes || 0, percent: 100 };
      emit(); renderPanel();

      // ---- 3. hand it to the Android installer ----------------------------
      await install(p, res.path);

      // ---- 4. clean up ----------------------------------------------------
      // installApk now resolves only when the installer activity has finished,
      // so by here we know the outcome. If the user cancelled, the native side
      // has already deleted the file; this also covers a completed install and
      // makes the reclaimed space visible.
      if (state.status !== "installing") {
        await cleanupFiles(true);
        state.status = "available";
      }
    } finally {
      state.busy = false;
    }
  }

  /**
   * Checks the Android 8.0+ "install unknown apps" permission, and sends the
   * user to the settings screen when it is missing.
   *
   * Resolves true when the app may install. The caller re-runs on App resume,
   * so the user comes back to a working Update button instead of a dead end.
   */
  async function ensureInstallPermission(p) {
    if (typeof p.canInstallPackages !== "function") return true; // pre-8.0 / no plugin
    try {
      const st = await p.canInstallPackages();
      if (st && st.canInstall) return true;
      state.pendingInstallPermission = true;
      if (typeof p.openInstallSettings === "function") await p.openInstallSettings();
      return false;
    } catch (e) {
      // If the plugin cannot answer, let the installer itself decide.
      return true;
    }
  }

  function isPermissionError(e) {
    const text = String((e && e.message) || e || "");
    return /permission|SecurityException|not allowed|unknown source/i.test(text);
  }

  async function install(p, path) {
    try {
      const res = await p.installApk({ path });
      if (res && res.needsPermission) {
        state.pendingInstallPermission = true;
        state.message = "Allow installing from this app, then tap Install.";
        if (typeof p.openInstallSettings === "function") await p.openInstallSettings();
        renderPanel();
        return;
      }
      if (res && res.installed) {
        // The installer finished and the user went through with it. Android
        // normally restarts the process, so reaching here means the upgrade set
        // us back up; the new APK is in place and our copy is gone.
        state.status = "ready";
        state.message = "Update installed.";
        cleanupFiles(true);
        renderPanel();
        return;
      }
      if (res && res.cancelled) {
        // The user changed their mind, or the install failed. The native side
        // deleted the file already, so the cache is clean; say so plainly.
        state.status = "available";
        state.message = "Update cancelled. The downloaded file was removed.";
        renderPanel();
        return;
      }
      state.message = "The installer did not open. Please try again.";
      renderPanel();
    } catch (e) {
      if (isPermissionError(e)) {
        state.pendingInstallPermission = true;
        state.message = "Allow installing from this app, then tap Install.";
        try { await p.openInstallSettings(); } catch (_e) {}
      } else {
        state.message = "The installer could not open: " + ((e && e.message) || e);
      }
      renderPanel();
    }
  }

  // ---------------------------------------------------------------- progress

  function wireProgressListener(p) {
    if (!p || typeof p.addListener !== "function") return;
    try {
      p.addListener("apkDownloadProgress", info => {
        state.progress = {
          received: Number(info && info.received) || 0,
          total: info && info.total != null ? Number(info.total) : -1,
          percent: info && info.percent != null ? Number(info.percent) : -1
        };
        emit();
        renderPanel();
      });
    } catch (e) {}
  }

  // ------------------------------------------------------------- App resume

  /**
   * After the user returns from the settings screen, re-check the permission
   * and continue the download — that is the "resume cleanly" requirement.
   */
  function wireResume() {
    try {
      const cap = window.Capacitor;
      const app = cap && cap.Plugins ? cap.Plugins.App : null;
      if (!app || typeof app.addListener !== "function") return;
      app.addListener("resume", async () => {
        if (!state.pendingInstallPermission) return;
        const p = plugin();
        if (!p) return;
        try {
          if (typeof p.canInstallPackages !== "function") return;
          const st = await p.canInstallPackages();
          if (st && st.canInstall) {
            state.pendingInstallPermission = false;
            clearSnooze();
            state.message = "Allowed. Tap Update to continue.";
            if (state.status === "ready" && state.downloadedPath) await install(p, state.downloadedPath);
            else if (state.status === "available") {
              // Resume the original one-tap request after Android's required
              // settings detour; do not make the user tap Update a second time.
              await startUpdate();
            }
            renderPanel();
          }
        } catch (e) {}
      });
    } catch (e) {}
  }

  // ----------------------------------------------------------------- public

  window.RBUpdater = {
    _listeners: [],
    get state() { return state; },
    isNative,
    installedVersion,
    check,
    startUpdate,
    openPanel,
    closePanel,
    /** Snooze was set by "Later"; a manual check ignores it. */
    clearSnooze,
    describeVersion,
    progressLabel,
    friendlyDownloadError,
    /**
     * Called once at startup: wires the progress listener and does the first
     * silent check. Safe on the website (it does nothing).
     */
    init() {
      if (!isNative()) return;
      const p = plugin();
      wireProgressListener(p);
      wireResume();
      // Let the app finish booting before spending bandwidth on a check.
      setTimeout(() => {
        // Startup housekeeping first: if the previous run left an APK behind
        // (an install that completed, or a panel the user swiped away), it goes
        // now rather than sitting in the cache for days.
        dropStaleDownload()
          .catch(() => {})
          .then(() => check({ manual: false }))
          .catch(() => {});
      }, 2500);
    },

    // ---- Part 2, exposed for Settings and tests --------------------------
    /** The content version installed on this phone, or { active:false }. */
    async bundleInfo() {
      const p = plugin();
      if (!p || typeof p.getBundleInfo !== "function") return { active: false };
      try { return await p.getBundleInfo(); } catch (e) { return { active: false }; }
    },
    /** Force a content update check now (used by "Check for updates"). */
    async updateContent() {
      const res = await fetchJson(manifestUrl());
      if (!res.ok) return { ok: false, reason: res.reason };
      const parsed = parseManifest(res.json);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      if (!parsed.update.bundle) return { ok: true, updated: false, reason: "no-bundle" };
      return maybeUpdateBundle(parsed.update.bundle, true);
    },
    /** Delete every leftover update file and report what was reclaimed. */
    async clearUpdateFiles() {
      return cleanupFiles(false);
    },
    /** Throw away downloaded content and go back to the files inside the APK. */
    async resetContent() {
      const p = plugin();
      if (!p || typeof p.resetBundle !== "function") return { ok: false };
      try { return await p.resetBundle(); } catch (e) { return { ok: false, reason: String(e && e.message) }; }
    },
    onChange(fn) {
      if (typeof fn === "function") window.RBUpdater._listeners.push(fn);
    }
  };
})();
