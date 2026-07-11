import { debug } from '../../core/debug.js';
import { sendRoutedEvent, onRoutedEvent } from '../routed-events.js';

// WICHTIGER HINWEIS ZUR TESTABDECKUNG: Diese Datei fasst echte
// RTCPeerConnection-APIs an, die es in dieser Sandbox nicht gibt (kein
// Browser, kein WebRTC in Node ohne natives Binding) — sie ist nicht
// automatisiert getestet, nur sorgfältig nach dem MDN-Referenzmuster
// ("Perfect Negotiation") gebaut. Alles DRUMHERUM (Router, Signaling-
// Weiterleitung im Relay, DefaultReplication-Integration) IST getestet,
// weil es hinter demselben Channel-Contract steht — ein echter Test in
// einem echten Browser bleibt hier der letzte Schritt.

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/**
 * Zwei Fingerprints, ein deterministisches Ergebnis auf beiden Seiten,
 * ohne Koordination: der lexikographisch kleinere Fingerprint ist "polite"
 * (nimmt bei kollidierenden Offers nach) und wartet auf den Datenkanal
 * statt ihn selbst zu erzeugen — Standardmuster aus WebRTC-Tutorials,
 * hier nur an Fingerprints statt Zufalls-IDs gebunden.
 */
function isPolite(myFingerprint, peerFingerprint) {
  return myFingerprint < peerFingerprint;
}

/**
 * Erfüllt den bestehenden Channel-Contract (core/channel.js) — alles
 * darüber (DefaultReplication, DefaultFileTransfer, der QU-Handshake)
 * funktioniert unverändert, weil es nur diesen Contract kennt, nie
 * RTCPeerConnection direkt.
 *
 * Signaling läuft über einen BESTEHENDEN Channel (typischerweise die
 * Relay-Verbindung) — siehe relay/relay.mjs's Signaling-Weiterleitung.
 * Diese Datei spricht nie direkt mit dem Relay, nur mit dem generischen
 * `signalingChannel`, den sie übergeben bekommt — dadurch bleibt der
 * Transport für das Signaling selbst austauschbar.
 *
 * `initialSignal`: falls dieser Channel REAKTIV entsteht (jemand ruft uns
 * an), muss die Nachricht, die das ausgelöst hat, hier mitgegeben werden —
 * der eigene `onMessage`-Listener wird erst NACH diesem Aufruf registriert
 * und würde sie sonst verpassen (siehe PeerConnectionManager).
 */
export function createWebRTCChannel({
  signalingChannel,
  myFingerprint,
  peerFingerprint,
  iceServers = DEFAULT_ICE_SERVERS,
  initialSignal = null,
} = {}) {
  const polite = isPolite(myFingerprint, peerFingerprint);
  const pc = new RTCPeerConnection({ iceServers });

  let dc = null;
  let closed = false;
  let makingOffer = false;
  let ignoreOffer = false;
  const messageListeners = new Set();
  const closeListeners = new Set();
  let pending = [];
  let openResolve;
  let openReject;
  const openPromise = new Promise((res, rej) => { openResolve = res; openReject = rej; });

  const dispatch = (obj) => {
    if (messageListeners.size === 0) { pending.push(obj); return; }
    messageListeners.forEach((fn) => {
      try { fn(obj); } catch (e) { console.error('[webrtc-channel] listener error:', e); }
    });
  };

  function wireDataChannel(channel) {
    dc = channel;
    dc.onopen = () => { debug('webrtc', 'datachannel-open', { peerFingerprint }); openResolve(); };
    dc.onclose = () => { fireClose(); };
    dc.onerror = (ev) => debug('webrtc', 'datachannel-error', { peerFingerprint, error: ev?.error?.message ?? String(ev) });
    dc.onmessage = (ev) => {
      let obj;
      try { obj = JSON.parse(ev.data); } catch (e) { debug('webrtc', 'parse-error', { peerFingerprint, error: e.message }); return; }
      debug('webrtc', 'message-in', { peerFingerprint, type: obj?.type });
      dispatch(obj);
    };
  }

  function fireClose() {
    if (closed) return;
    closed = true;
    openReject?.(new Error('[webrtc-channel] closed before opening'));
    closeListeners.forEach((fn) => fn());
  }

  // Nur die "unpolite" Seite erzeugt proaktiv den Datenkanal — die polite
  // Seite empfängt ihn über ondatachannel. Deterministisch aus beiden
  // Fingerprints, keine Koordinationsnachricht nötig.
  if (!polite) wireDataChannel(pc.createDataChannel('qu'));
  pc.ondatachannel = (ev) => { if (polite) wireDataChannel(ev.channel); };

  // --- Perfect Negotiation (MDN-Referenzmuster) ---
  async function handleSignal(msg) {
    if (msg.from !== peerFingerprint) return; // onRoutedEvent already filtered by event name; this filters by sender
    try {
      if (msg.payload.kind === 'sdp') {
        const description = msg.payload.data;
        const offerCollision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) { debug('webrtc', 'offer-ignored-glare', { peerFingerprint }); return; }
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          await sendRoutedEvent(signalingChannel, peerFingerprint, 'webrtc-signal', { kind: 'sdp', data: pc.localDescription });
        }
      } else if (msg.payload.kind === 'ice') {
        try {
          await pc.addIceCandidate(msg.payload.data);
        } catch (e) {
          if (!ignoreOffer) throw e; // ein ICE-Kandidat für ein ignoriertes Offer darf ruhig scheitern
        }
      }
    } catch (e) {
      debug('webrtc', 'signal-handling-error', { peerFingerprint, error: e.message });
      console.error('[webrtc-channel] error handling signal:', e);
    }
  }

  const offSignal = onRoutedEvent(signalingChannel, 'webrtc-signal', (msg) => { handleSignal(msg); });
  if (initialSignal) handleSignal(initialSignal); // siehe Doku oben — der eigene Listener oben wurde zu spät registriert, um diese Nachricht selbst zu sehen

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      await sendRoutedEvent(signalingChannel, peerFingerprint, 'webrtc-signal', { kind: 'sdp', data: pc.localDescription });
    } catch (e) {
      debug('webrtc', 'negotiation-error', { peerFingerprint, error: e.message });
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendRoutedEvent(signalingChannel, peerFingerprint, 'webrtc-signal', { kind: 'ice', data: candidate });
  };

  pc.onconnectionstatechange = () => {
    debug('webrtc', 'connection-state', { peerFingerprint, state: pc.connectionState });
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fireClose();
  };

  return {
    id: `webrtc:${peerFingerprint}`,

    async connect() { await openPromise; },

    async send(obj) {
      if (closed || !dc || dc.readyState !== 'open') return;
      debug('webrtc', 'message-out', { peerFingerprint, type: obj?.type });
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
      offSignal();
      dc?.close();
      pc.close();
      closeListeners.forEach((fn) => fn());
    },

    // Fluchttüren für PeerConnectionManager (Metrik-Sampling via getStats(),
    // spätere A/V-Erweiterung) — nicht Teil des Channel-Contracts selbst.
    get peerConnection() { return pc; },
    get connectionState() { return pc.connectionState; },
  };
}
