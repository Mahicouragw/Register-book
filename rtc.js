// rtc.js — real audio + video calling over the internet (WebRTC).
//
// Signalling goes through Supabase:
//   1. caller writes a row in rb_calls            (status 'ringing')
//   2. caller pushes an offer into rb_call_signals
//   3. callee reads it, answers, writes 'answer' + its own ICE candidates
//   4. both sides exchange ICE until media flows
//
// Honesty rules built in:
//   • We never say "connected" until iceConnectionState is really connected.
//   • If ICE fails we say plainly that a TURN relay is needed.
//   • In demo mode there is no second phone, so it says so instead of faking.
(function () {
  "use strict";

  const S = window.RBStore;

  const DEFAULT_ICE = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ];

  const state = {
    phase: "idle",            // idle | outgoing | incoming | connecting | connected | ended
    callId: null,
    peerId: null,
    kind: "audio",
    pc: null,
    localStream: null,
    remoteStream: null,
    muted: false,
    cameraOff: false,
    signalTimer: null,
    seenSignals: {},
    lastSignalCount: 0,
    realtime: null,
    startedAt: 0,
    ringTimer: null,
    failureTimer: null
  };

  const H = {};               // handlers set by app.js

  function emit(name, a, b) { if (typeof H[name] === "function") { try { H[name](a, b); } catch (e) { console.warn(e); } } }

  function iceServers() {
    const servers = DEFAULT_ICE.slice();
    const c = window.RB_CONFIG || {};
    if (c.TURN_URLS && c.TURN_USERNAME && c.TURN_CREDENTIAL) {
      servers.push({ urls: c.TURN_URLS, username: c.TURN_USERNAME, credential: c.TURN_CREDENTIAL });
    }
    return servers;
  }
  function hasTurn() {
    const c = window.RB_CONFIG || {};
    return !!(c.TURN_URLS && c.TURN_USERNAME && c.TURN_CREDENTIAL);
  }

  // ------------------------------------------------------------ permissions
  async function getLocalStream(kind) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser cannot open the microphone/camera. Use Chrome (Android) or Safari after adding the app to your Home Screen.");
    }
    emit("localstatus", "Asking for microphone" + (kind === "video" ? " and camera" : "") + "…");
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: kind === "video" ? { facingMode: "user", width: { ideal: 640 } } : false
      });
    } catch (e) {
      const name = (e && e.name) || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error("Microphone/camera permission was refused. Allow it for this site, then call again.");
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        throw new Error("No microphone" + (kind === "video" ? " or camera" : "") + " was found on this device.");
      }
      throw new Error((e && e.message) || "Could not open the microphone.");
    }
  }

  // ------------------------------------------------------------ peer connection
  function makePeer() {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });

    pc.onicecandidate = ev => {
      if (ev.candidate && state.callId) {
        S.sendCallSignal(state.callId, "ice", ev.candidate.toJSON()).catch(() => {});
      }
    };

    pc.ontrack = ev => {
      if (!state.remoteStream) state.remoteStream = new MediaStream();
      ev.streams[0] ? (state.remoteStream = ev.streams[0]) : state.remoteStream.addTrack(ev.track);
      emit("remotestream", state.remoteStream);
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        clearTimeout(state.failureTimer);
        setPhase("connected");
      } else if (s === "failed") {
        clearTimeout(state.failureTimer);
        emit("error", "Your network needs a relay — TURN is not configured yet. Call over mobile data or ask the owner to add a TURN server.");
        setPhase("ended");
      } else if (s === "disconnected") {
        state.failureTimer = setTimeout(() => {
          if (pc.iceConnectionState === "disconnected") {
            emit("error", "The connection dropped. Tap Call again — if it keeps failing, your network needs a TURN relay.");
          }
        }, 6000);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") emit("error", "The connection failed. Your network blocks direct peer-to-peer; a TURN relay is needed.");
    };

    return pc;
  }

  function attachLocalTracks() {
    if (!state.pc || !state.localStream) return;
    state.localStream.getTracks().forEach(t => {
      try { state.pc.addTrack(t, state.localStream); } catch (e) { /* already added */ }
    });
  }

  function setPhase(p) {
    state.phase = p;
    emit("phase", p);
  }

  // ------------------------------------------------------------ signalling in
  async function pumpSignals() {
    if (!state.callId) return;
    let rows = [];
    try { rows = await S.fetchCallSignals(state.callId); } catch (e) { return; }
    for (const s of rows) {
      const key = s.id;
      if (state.seenSignals[key]) continue;
      state.seenSignals[key] = true;
      if (s.fromUser === S.me.id) continue;      // ignore our own echo
      try { await handleSignal(s); } catch (e) { console.warn("[rtc] signal error", e); }
    }
  }

  async function handleSignal(s) {
    const pc = state.pc;
    if (!pc) return;
    if (s.kind === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(s.payload));
      await drainIce();
      await pc.setLocalDescription(await pc.createAnswer());
      await S.sendCallSignal(state.callId, "answer", pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription);
      setPhase("connecting");
    } else if (s.kind === "answer") {
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription(new RTCSessionDescription(s.payload));
      await drainIce();
      setPhase("connecting");
    } else if (s.kind === "ice") {
      try { await pc.addIceCandidate(new RTCIceCandidate(s.payload)); }
      catch (e) { pending.push(s.payload); }
    }
  }

  let pending = [];
  async function drainIce() {
    for (const c of pending) {
      try { await state.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
    }
    pending = [];
  }

  function startPolling() {
    stopPolling();
    state.signalTimer = setInterval(pumpSignals, 1200);
    pumpSignals();
  }
  function stopPolling() {
    if (state.signalTimer) { clearInterval(state.signalTimer); state.signalTimer = null; }
  }

  // Realtime makes it near-instant; polling is the safety net.
  function startRealtime() {
    try {
      const c = S.getClient ? S.getClient() : (window.RBAuth ? window.RBAuth.getClient() : null);
      if (!c || !c.channel || S.isDemo()) return;
      state.realtime = c.channel("rb-call-" + state.callId)
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "rb_call_signals", filter: "call_id=eq." + state.callId },
          payload => { handleSignal({
            id: String(payload.new.id), callId: payload.new.call_id, fromUser: payload.new.from_user,
            kind: payload.new.kind, payload: payload.new.payload, createdAt: payload.new.created_at
          }).catch(e => console.warn(e)); })
        .subscribe();
    } catch (e) { /* polling covers it */ }
  }
  function stopRealtime() {
    try {
      const c = S.getClient ? S.getClient() : (window.RBAuth ? window.RBAuth.getClient() : null);
      if (c && state.realtime) c.removeChannel(state.realtime);
    } catch (e) {}
    state.realtime = null;
  }

  // ------------------------------------------------------------ public actions
  async function call(userId, kind) {
    reset();
    state.kind = kind === "video" ? "video" : "audio";
    state.peerId = userId;

    if (S.isDemo()) {
      // No second phone exists in demo mode — say so instead of faking audio.
      state.callId = "demo_call_" + Date.now();
      state.phase = "outgoing";
      emit("phase", "outgoing");
      emit("demo", true);
      return { id: state.callId, demo: true };
    }

    state.localStream = await getLocalStream(state.kind);
    emit("localstream", state.localStream);

    const row = await S.startCall(userId, state.kind);
    state.callId = row.id;
    state.startedAt = Date.now();

    state.pc = makePeer();
    attachLocalTracks();
    await state.pc.setLocalDescription(await state.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: state.kind === "video" }));
    await S.sendCallSignal(state.callId, "offer", state.pc.localDescription.toJSON ? state.pc.localDescription.toJSON() : state.pc.localDescription);

    setPhase("outgoing");
    startPolling();
    startRealtime();

    // give up after 45 seconds of ringing
    state.ringTimer = setTimeout(() => {
      if (state.phase === "outgoing") {
        S.updateCallStatus(state.callId, "missed").catch(() => {});
        emit("error", "No answer.");
        setPhase("ended");
        cleanupMedia();
      }
    }, 45000);

    return row;
  }

  async function answer(callId) {
    state.callId = callId;
    const row = S.data.calls.find(c => c.id === callId);
    state.kind = row ? (row.kind || "audio") : "audio";
    state.peerId = row ? (row.callerId === S.me.id ? row.calleeId : row.callerId) : null;

    if (S.isDemo()) {
      setPhase("connected");
      emit("demo", true);
      emit("error", "Demo mode: there is no second phone, so this screen is a preview only — not a real call.");
      return;
    }

    state.localStream = await getLocalStream(state.kind);
    emit("localstream", state.localStream);
    state.pc = makePeer();
    attachLocalTracks();

    await S.updateCallStatus(callId, "accepted");
    setPhase("connecting");
    startPolling();
    startRealtime();
    // the offer may already be waiting for us
    await pumpSignals();
  }

  async function decline(callId) {
    const id = callId || state.callId;
    if (id && !S.isDemo()) { try { await S.updateCallStatus(id, "declined"); } catch (e) {} }
    emit("declined", id);
    setPhase("ended");
    cleanup();
  }

  async function hangup() {
    const id = state.callId;
    if (id && !S.isDemo()) {
      try { await S.updateCallStatus(id, state.phase === "connected" ? "ended" : "missed"); } catch (e) {}
    }
    setPhase("ended");
    cleanup();
  }

  function cleanupMedia() {
    if (state.localStream) { state.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); }
    state.localStream = null;
    state.remoteStream = null;
    emit("remotestream", null);
    emit("localstream", null);
  }
  function cleanup() {
    clearTimeout(state.ringTimer);
    clearTimeout(state.failureTimer);
    stopPolling();
    stopRealtime();
    if (state.pc) { try { state.pc.close(); } catch (e) {} }
    state.pc = null;
    cleanupMedia();
    state.callId = null;
    state.peerId = null;
    state.seenSignals = {};
    pending = [];
  }
  function reset() { cleanup(); state.muted = false; state.cameraOff = false; }

  function toggleMute() {
    state.muted = !state.muted;
    if (state.localStream) state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.muted; });
    emit("muted", state.muted);
    return state.muted;
  }
  function toggleCamera() {
    state.cameraOff = !state.cameraOff;
    if (state.localStream) state.localStream.getVideoTracks().forEach(t => { t.enabled = !state.cameraOff; });
    emit("cameraoff", state.cameraOff);
    return state.cameraOff;
  }

  // ------------------------------------------------------------ incoming (UI)
  // Used by the app when a ringing call row arrives (Realtime or refresh).
  function incomingCall(call) {
    if (state.phase === "connected" || state.phase === "connecting") return false;
    state.callId = call.id;
    state.kind = call.kind || "audio";
    state.peerId = call.callerId;
    setPhase("incoming");
    return true;
  }

  // Demo helper so the owner can see the incoming screen on one phone.
  function simulateIncoming(kind) {
    state.callId = "demo_in_" + Date.now();
    state.kind = kind === "video" ? "video" : "audio";
    setPhase("incoming");
    emit("demo", true);
    return state.callId;
  }

  window.RBRtc = {
    init(handlers) { Object.keys(handlers || {}).forEach(k => { H[k] = handlers[k]; }); },
    call, answer, decline, hangup, incomingCall, simulateIncoming,
    toggleMute, toggleCamera,
    hasTurn,
    get phase() { return state.phase; },
    get callId() { return state.callId; },
    get kind() { return state.kind; },
    get muted() { return state.muted; },
    get cameraOff() { return state.cameraOff; },
    get peerId() { return state.peerId; },
    get localStream() { return state.localStream; },
    get remoteStream() { return state.remoteStream; },
    reset
  };
})();
