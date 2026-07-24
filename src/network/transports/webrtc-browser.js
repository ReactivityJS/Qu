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

// Mehr als ein STUN-Server — ein einzelner Anbieter kann aus Gründen
// unerreichbar sein, die nichts mit diesem Deployment zu tun haben (eigener
// Ausfall, eine Route/DNS-Eigenheit im Netz genau eines Peers, IPv6-
// Bindungsfehler wie sie konkret gegen diesen Server beobachtet wurden) —
// mehrere aufzulisten kostet nichts (EIN erfolgreicher Server reicht, um
// die eigene reflexive Adresse zu erfahren) und macht daraus "funktioniert
// trotzdem, nur über einen anderen Server" statt eines harten Anruf-
// Fehlschlags. Nur der Fallback, falls index.js's `/webrtc/ice-servers`
// (server/webrtc-routes.mjs) nicht erreichbar war — normalerweise liefert
// der Server dieselbe erweiterte Liste (plus optional TURN, QU_TURN_URLS).
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

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
 * "host"/"srflx"/"relay"/"prflx" aus einem RTCIceCandidate — `.type` ist
 * in modernen Browsern direkt gesetzt, der Regex-Fallback liest es aus
 * dem rohen SDP-Kandidatenstring (`candidate:... typ <type> ...`), falls
 * nicht. Zum Debuggen entscheidend: nur "host" gesammelt heißt "STUN hat
 * nie geantwortet" (Firewall/Netzwerk blockiert UDP zum STUN-Server, oder
 * der Server ist falsch/nicht erreichbar) — ohne mindestens EIN "srflx"
 * (oder "relay") auf mindestens einer Seite kann eine Verbindung über
 * getrennte Netzwerke hinweg (zwei Heim-NATs, Handy-Netz) gar nicht erst
 * zustande kommen, unabhängig von TURN.
 */
function candidateType(candidate) {
  if (!candidate) return null;
  if (candidate.type) return candidate.type;
  const m = /\btyp (\w+)/.exec(candidate.candidate ?? '');
  return m ? m[1] : 'unknown';
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
 * `initialSignals`: falls dieser Channel REAKTIV entsteht (jemand ruft uns
 * an), müssen ALLE Nachrichten, die vor diesem Aufruf schon für diesen
 * Peer eintrafen (das ursprüngliche Offer UND jeder ICE-Kandidat, der
 * während des Klingelns/vor dem tatsächlichen Verbindungsaufbau schon
 * ankam), hier mitgegeben werden — der eigene `onMessage`-Listener wird
 * erst NACH diesem Aufruf registriert und würde sie sonst verpassen
 * (siehe PeerConnectionManager, das genau deshalb selbst zwischenspeichert).
 * In der ursprünglichen Eintreffreihenfolge, Offer zuerst.
 */
export function createWebRTCChannel({
  signalingChannel,
  myFingerprint,
  peerFingerprint,
  iceServers = DEFAULT_ICE_SERVERS,
  initialSignals = [],
  // Wer erzeugt proaktiv den Datenkanal (und löst damit die erste
  // Aushandlung aus)? Per Default die Fingerprint-Regel (Perfect
  // Negotiation, für den unkoordinierten Fall: beide Seiten rufen
  // z. B. gleichzeitig connectDirect() auf, ohne voneinander zu wissen —
  // deterministisch anhand der Fingerprints, damit nicht beide einen
  // Datenkanal aufmachen). ABER: kennt der Aufrufer die Rollen bereits
  // eindeutig (z. B. PeerConnectionManager: "ich rufe selbst
  // connectDirect() auf" vs. "ich reagiere auf ein bereits eingetroffenes
  // Signal"), MUSS das Vorrang vor der Fingerprint-Regel haben — sonst
  // kann die aufrufende Seite per Fingerprint zufällig "polite" sein,
  // selbst nie proaktiv verbinden UND die Gegenseite (die rein reaktiv
  // ist und nie selbst initiiert) ewig auf ein Signal warten lassen, das
  // nie kommt (stiller Deadlock, ca. 50% der Anrufe je nach
  // Fingerprint-Zufall).
  initiator = null,
} = {}) {
  const polite = isPolite(myFingerprint, peerFingerprint);
  const shouldCreateDataChannel = initiator === null ? !polite : initiator;
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
    dc.onclose = () => { debug('webrtc', 'datachannel-close', { peerFingerprint }); fireClose(); };
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

  // Nur eine Seite erzeugt proaktiv den Datenkanal — die andere empfängt
  // ihn über ondatachannel (siehe shouldCreateDataChannel oben).
  debug('webrtc', 'channel-init', { peerFingerprint, polite, shouldCreateDataChannel, initialSignalCount: initialSignals.length, iceServerCount: iceServers.length });
  if (shouldCreateDataChannel) wireDataChannel(pc.createDataChannel('qu'));
  pc.ondatachannel = (ev) => { if (!shouldCreateDataChannel) wireDataChannel(ev.channel); };

  // --- Perfect Negotiation (MDN-Referenzmuster) ---
  async function handleSignal(msg) {
    if (msg.from !== peerFingerprint) return; // onRoutedEvent already filtered by event name; this filters by sender
    const sdpType = msg.payload?.kind === 'sdp' ? msg.payload.data?.type : undefined;
    debug('webrtc', 'signal-received', { peerFingerprint, kind: msg.payload?.kind, sdpType, signalingState: pc.signalingState });
    try {
      if (msg.payload.kind === 'sdp') {
        const description = msg.payload.data;
        const offerCollision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) { debug('webrtc', 'offer-ignored-glare', { peerFingerprint }); return; }
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          debug('webrtc', 'signal-sent', { peerFingerprint, kind: 'sdp', sdpType: pc.localDescription.type });
          await sendRoutedEvent(signalingChannel, peerFingerprint, 'webrtc-signal', { kind: 'sdp', data: pc.localDescription });
        }
      } else if (msg.payload.kind === 'ice') {
        try {
          await pc.addIceCandidate(msg.payload.data);
          debug('webrtc', 'remote-ice-applied', { peerFingerprint, candidateType: candidateType(msg.payload.data) });
        } catch (e) {
          debug('webrtc', 'remote-ice-error', { peerFingerprint, error: e.message, ignoreOffer });
          if (!ignoreOffer) throw e; // ein ICE-Kandidat für ein ignoriertes Offer darf ruhig scheitern
        }
      }
    } catch (e) {
      debug('webrtc', 'signal-handling-error', { peerFingerprint, error: e.message });
      console.error('[webrtc-channel] error handling signal:', e);
    }
  }

  // handleSignal() awaitet intern (setRemoteDescription etc.) — ohne
  // Serialisierung würde ein ICE-Kandidat, der kurz nach dem initialen
  // Offer eintrifft, seinen eigenen handleSignal()-Aufruf schon starten
  // (und addIceCandidate() aufrufen), BEVOR das await von
  // setRemoteDescription() für das Offer fertig ist — "remote description
  // was null". Eine simple Promise-Kette erzwingt strikt sequentielle
  // Verarbeitung in Eintreffreihenfolge.
  let signalChain = Promise.resolve();
  function enqueueSignal(msg) {
    signalChain = signalChain.then(() => handleSignal(msg));
  }

  const offSignal = onRoutedEvent(signalingChannel, 'webrtc-signal', (msg) => { enqueueSignal(msg); });
  for (const sig of initialSignals) enqueueSignal(sig); // siehe Doku oben — der eigene Listener oben wurde zu spät registriert, um diese Nachrichten selbst zu sehen

  pc.onnegotiationneeded = async () => {
    debug('webrtc', 'negotiation-needed', { peerFingerprint, signalingState: pc.signalingState });
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      debug('webrtc', 'signal-sent', { peerFingerprint, kind: 'sdp', sdpType: pc.localDescription.type });
      await sendRoutedEvent(signalingChannel, peerFingerprint, 'webrtc-signal', { kind: 'sdp', data: pc.localDescription });
    } catch (e) {
      debug('webrtc', 'negotiation-error', { peerFingerprint, error: e.message });
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    // `candidate: null` markiert das ENDE der Kandidatensammlung (kein
    // eigenes Signal, nur intern interessant) — siehe onicegatheringstatechange
    // unten für den expliziten "fertig gesammelt"-Zeitpunkt.
    if (!candidate) return;
    debug('webrtc', 'local-ice-candidate', { peerFingerprint, candidateType: candidateType(candidate), protocol: candidate.protocol });
    sendRoutedEvent(signalingChannel, peerFingerprint, 'webrtc-signal', { kind: 'ice', data: candidate });
  };

  // Feuert bei einem Fehler WÄHREND der Kandidatensammlung selbst — z. B.
  // wenn der STUN-/TURN-Server nicht erreichbar ist (DNS-Fehler, Timeout,
  // blockiertes UDP). Das ist der direkteste Hinweis, WARUM nie ein
  // "srflx"/"relay"-Kandidat auftaucht (reine "host"-Kandidaten reichen
  // über zwei getrennte Netzwerke hinweg praktisch nie).
  pc.onicecandidateerror = (ev) => {
    debug('webrtc', 'ice-candidate-error', { peerFingerprint, errorCode: ev.errorCode, errorText: ev.errorText, url: ev.url, address: ev.address, port: ev.port });
  };

  pc.onicegatheringstatechange = () => {
    debug('webrtc', 'ice-gathering-state', { peerFingerprint, state: pc.iceGatheringState });
  };

  pc.oniceconnectionstatechange = () => {
    debug('webrtc', 'ice-connection-state', { peerFingerprint, state: pc.iceConnectionState });
  };

  pc.onsignalingstatechange = () => {
    debug('webrtc', 'signaling-state', { peerFingerprint, state: pc.signalingState });
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
