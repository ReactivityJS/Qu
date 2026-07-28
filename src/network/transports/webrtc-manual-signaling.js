import { debug } from '../../core/debug.js';

// The out-of-band counterpart to webrtc-browser.js's createWebRTCChannel():
// THAT file's Perfect Negotiation trickles SDP/ICE over an ALREADY-LIVE
// signalingChannel (in practice, the relay connection) — this file exists
// specifically for the case where no such channel exists yet at all, e.g.
// two devices in the same room, or a deliberately relay-less pairing. The
// two peers exchange exactly TWO short text blobs by whatever out-of-band
// means they like (QR code, copy-paste, NFC) — this module only produces/
// consumes those blobs, it has no opinion on how they physically travel.
//
// Same DEFAULT_ICE_SERVERS list as webrtc-browser.js — duplicated rather
// than imported, since importing from a sibling transport file would wire
// this module to that one's internals for zero shared behavior (the two
// files intentionally do NOT share a negotiation strategy, see below).
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Deliberately NOT Perfect Negotiation (webrtc-browser.js's polite/impolite
 * glare handling) — that pattern exists to survive RENEGOTIATION races on
 * an already-established, ongoing connection. A manual-signaling exchange
 * only ever negotiates ONCE (this is how the connection gets bootstrapped
 * in the first place; there is no prior connection to race against), and
 * the two roles are known explicitly by whichever side scans vs. shows the
 * first QR code — no fingerprint-comparison trick needed to break a tie.
 *
 * Also deliberately NON-TRICKLE: candidates are gathered fully BEFORE
 * producing a blob (`pc.iceGatheringState === 'complete'`), so each side's
 * `localDescription` already embeds every candidate as inline SDP —
 * exactly TWO blobs total (offer, answer), never a growing stream of
 * separate ICE-candidate messages, which is what makes this fit in a QR
 * code / paste box at all. Trade-off: a few seconds of extra setup latency
 * (waiting out the full gathering timeout) for not needing any live
 * channel to trickle candidates over.
 *
 * `role`: `'offerer'` (creates the data channel + the first offer) or
 * `'answerer'` (waits for an incoming data channel + replies to the
 * offer) — the caller already knows which side is which (e.g. "I'm
 * showing the QR code" vs. "I'm scanning it"), so this is an explicit
 * parameter, not inferred.
 *
 * `gatherTimeoutMs` (default 8000): a hard ceiling on waiting for
 * `iceGatheringState === 'complete'` — a network where the configured
 * STUN/TURN servers are unreachable would otherwise hang
 * `produceLocalSignal()` forever. Producing the blob with whatever
 * candidates gathered so far (even zero — host candidates alone still
 * work on a shared local network) is the same "degrade, don't hang"
 * stance `webrtc-browser.js`'s own IPv4 fallback takes on a different
 * failure.
 */
export function createManualSignalingChannel({
  myFingerprint,
  peerFingerprint,
  iceServers = DEFAULT_ICE_SERVERS,
  role,
  gatherTimeoutMs = 8000,
} = {}) {
  if (role !== 'offerer' && role !== 'answerer') {
    throw new Error(`[webrtc-manual-signaling] role must be 'offerer' or 'answerer', got: ${role}`);
  }

  const pc = new RTCPeerConnection({ iceServers });
  let dc = null;
  let closed = false;
  const messageListeners = new Set();
  const closeListeners = new Set();
  let pending = [];
  let openResolve;
  let openReject;
  const openPromise = new Promise((res, rej) => { openResolve = res; openReject = rej; });

  const dispatch = (obj) => {
    if (messageListeners.size === 0) { pending.push(obj); return; }
    messageListeners.forEach((fn) => {
      try { fn(obj); } catch (e) { console.error('[webrtc-manual-signaling] listener error:', e); }
    });
  };

  function wireDataChannel(channel) {
    dc = channel;
    dc.onopen = () => { debug('webrtc-manual', 'datachannel-open', { peerFingerprint }); openResolve(); };
    dc.onclose = () => { debug('webrtc-manual', 'datachannel-close', { peerFingerprint }); fireClose(); };
    dc.onerror = (ev) => debug('webrtc-manual', 'datachannel-error', { peerFingerprint, error: ev?.error?.message ?? String(ev) });
    dc.onmessage = (ev) => {
      let obj;
      try { obj = JSON.parse(ev.data); } catch (e) { debug('webrtc-manual', 'parse-error', { peerFingerprint, error: e.message }); return; }
      debug('webrtc-manual', 'message-in', { peerFingerprint, type: obj?.type });
      dispatch(obj);
    };
  }

  function fireClose() {
    if (closed) return;
    closed = true;
    openReject?.(new Error('[webrtc-manual-signaling] closed before opening'));
    closeListeners.forEach((fn) => fn());
  }

  if (role === 'offerer') wireDataChannel(pc.createDataChannel('qu'));
  pc.ondatachannel = (ev) => { if (role !== 'offerer') wireDataChannel(ev.channel); };

  pc.onconnectionstatechange = () => {
    debug('webrtc-manual', 'connection-state', { peerFingerprint, state: pc.connectionState });
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fireClose();
  };

  function waitForIceGatheringComplete() {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', onChange); resolve(); }, gatherTimeoutMs);
      function onChange() {
        if (pc.iceGatheringState !== 'complete') return;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  return {
    id: `webrtc-manual:${peerFingerprint}`,

    async connect() { await openPromise; },

    async send(obj) {
      if (closed || !dc || dc.readyState !== 'open') return;
      debug('webrtc-manual', 'message-out', { peerFingerprint, type: obj?.type });
      dc.send(JSON.stringify(obj));
    },

    onMessage(fn) {
      messageListeners.add(fn);
      if (pending.length) {
        const buffered = pending;
        pending = [];
        for (const obj of buffered) messageListeners.forEach((f) => f(obj));
      }
      return () => messageListeners.delete(fn);
    },
    onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },

    async close() {
      if (closed) return;
      closed = true;
      dc?.close();
      pc.close();
      closeListeners.forEach((fn) => fn());
    },

    /**
     * Produces this side's next signal blob — a plain-JSON `{type, sdp}`
     * string, safe to encode into a QR code or paste as text.
     *   - `role: 'offerer'`, first call: creates the offer.
     *   - `role: 'answerer'`, first call: creates the answer — MUST be
     *     called AFTER `consumeRemoteSignal()` has already set the offer as
     *     the remote description (`createAnswer()` requires it).
     * Idempotent-ish: a second call after `localDescription` is already set
     * just re-returns it (no re-negotiation — see file doc on why this
     * module never renegotiates).
     */
    async produceLocalSignal() {
      if (!pc.localDescription) {
        const desc = role === 'offerer' ? await pc.createOffer() : await pc.createAnswer();
        await pc.setLocalDescription(desc);
      }
      await waitForIceGatheringComplete();
      debug('webrtc-manual', 'signal-produced', { peerFingerprint, type: pc.localDescription.type });
      return JSON.stringify({ type: pc.localDescription.type, sdp: pc.localDescription.sdp });
    },

    /**
     * Consumes the OTHER side's blob (from `produceLocalSignal()`) —
     * `role: 'offerer'` consumes an answer, `role: 'answerer'` consumes an
     * offer (before producing its own answer, see above).
     */
    async consumeRemoteSignal(blob) {
      const description = JSON.parse(blob);
      debug('webrtc-manual', 'signal-consumed', { peerFingerprint, type: description.type });
      await pc.setRemoteDescription(description);
    },

    get peerConnection() { return pc; },
    get connectionState() { return pc.connectionState; },
  };
}
