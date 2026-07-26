import { authenticateChannel } from './handshake.js';
import { DefaultReplication } from './replication/default.js';
import { createWebRTCChannel } from './transports/webrtc-browser.js';
import { debug } from '../core/debug.js';

/**
 * Verwaltet WebRTC-Direktverbindungen zu einzelnen Peers (per Fingerprint)
 * — die "primär als Weg zu einer Node ohne Relay" gedachte Nutzung, nicht
 * ein Ersatz für Räume mit vielen Teilnehmern (die bleiben sinnvoll
 * relay-vermittelt, siehe Whitepaper-Diskussion zu Routing).
 *
 * Sicherheitskritischer Schritt: WebRTC/DTLS verschlüsselt den Kanal, das
 * beweist aber nicht, WER am anderen Ende ist. Genau wie der Relay wird
 * jede neue Direktverbindung nach dem Aufbau erneut per QU-Handshake
 * (core/handshake.js — Challenge-Response, derselbe Standard wie bei
 * jeder QuBit-Signatur) verifiziert, bevor sie für Replication freigegeben
 * wird. Der Fingerprint, mit dem man verbinden WOLLTE, und der tatsächlich
 * beim Handshake bewiesene müssen übereinstimmen.
 */
export class PeerConnectionManager {
  #qu;
  #router;
  #signalingChannel;
  #connections = new Map(); // peerFingerprint -> { channel, repl }
  #pendingIncoming = new Set(); // peerFingerprint, während #onIncomingConnection()/#establish() noch laufen (siehe #handleIncoming())
  #pendingOutgoing = new Set(); // peerFingerprint, während UNSERE eigene connectDirect()/#establish() noch läuft (siehe #handleIncoming())
  #pendingSignals = new Map(); // peerFingerprint -> msg[], siehe #handleIncoming()s Zwischenspeicherung während des Klingelns
  #offIncoming;
  #onIncomingConnection;
  #connectListeners = new Set();
  #connectFailedListeners = new Set();
  #iceServers;

  /**
   * `onIncomingConnection(peerFingerprint)`: optionaler Hook, wird
   * aufgerufen, wenn jemand uns unaufgefordert kontaktiert (Signaling-
   * Nachricht von einem Fingerprint, zu dem wir noch keine Verbindung
   * haben). Rückgabe `{ pushTopics, group?, metric? }` nimmt an — `null`/
   * `undefined` lehnt die Verbindung ab (es wird einfach keine
   * WebRTCChannel für sie erzeugt). Ohne Hook: alle eingehenden
   * Verbindungen werden mit `pushTopics: []` angenommen (Kanal steht,
   * repliziert aber nichts, bis die App das explizit konfiguriert) —
   * sicherer Default, kein automatisches Datenteilen mit Unbekannten.
   *
   * `iceServers`: passed straight through to every RTCPeerConnection this
   * manager creates (createWebRTCChannel()'s own `iceServers`) —
   * `undefined` keeps that function's STUN-only default.
   */
  constructor(qu, { router = null, signalingChannel, onIncomingConnection = null, iceServers } = {}) {
    this.#qu = qu;
    this.#router = router;
    this.#signalingChannel = signalingChannel;
    this.#onIncomingConnection = onIncomingConnection ?? (async () => ({ pushTopics: [] }));
    this.#iceServers = iceServers;
    this.#offIncoming = signalingChannel.onMessage((msg) => this.#handleIncoming(msg));
  }

  async #handleIncoming(msg) {
    if (msg.type !== 'qu.route' || msg.event !== 'webrtc-signal' || !msg.from) return;
    debug('webrtc-pm', 'incoming-signal', { from: msg.from, kind: msg.payload?.kind, alreadyConnected: this.#connections.has(msg.from), alreadyPending: this.#pendingIncoming.has(msg.from), ownOutgoingInFlight: this.#pendingOutgoing.has(msg.from) });
    if (this.#connections.has(msg.from)) return;
    // WIR haben selbst gerade connectDirect() zu diesem Fingerprint
    // aufgerufen (#establish() unten läuft noch, VOR dem Eintrag in
    // #connections) — dieses Signal ist die Antwort (Answer/ICE) DARAUF,
    // kein neuer unaufgeforderter Anruf. Der eigene createWebRTCChannel()
    // dieser laufenden #establish() hat SEINEN EIGENEN onRoutedEvent-
    // Listener längst registriert (synchron bei seiner Erzeugung, vor
    // jedem await) und verarbeitet dieses Signal bereits korrekt — ohne
    // diese Prüfung würde #handleIncoming() es fälschlich als neue
    // eingehende Verbindung behandeln, #onIncomingConnection() für einen
    // Anruf aufrufen, den niemand je annimmt/ablehnt, und #pendingIncoming
    // für diesen Fingerprint DAUERHAFT hängen lassen — jeder SPÄTERE
    // echte eingehende Anruf von genau diesem Fingerprint würde dann nur
    // noch stumm gepuffert (siehe #pendingSignals unten), aber nie mehr
    // tatsächlich verarbeitet.
    if (this.#pendingOutgoing.has(msg.from)) return;
    // Schon am Klingeln (#onIncomingConnection() hängt noch auf eine
    // Nutzer-Entscheidung, RTCPeerConnection existiert für diese Seite
    // noch GAR NICHT — die entsteht erst unten in #establish(), NACHDEM
    // angenommen wurde): dieses Signal ist typischerweise ein
    // ICE-Kandidat, den die Gegenseite schickt, während wir noch klingeln
    // (Kandidaten trudeln oft schon Sekundenbruchteile nach dem Anruf
    // ein, ein Mensch braucht zum Rangehen aber typischerweise deutlich
    // länger). Es einfach zu verwerfen (wie es hier früher passierte)
    // verliert diese Kandidaten UNWIDERBRINGLICH — der Channel, dessen
    // eigener onRoutedEvent-Listener sie sonst auffangen würde, existiert
    // ja noch nicht. Je nachdem, wie viele ICE-Kandidaten so verloren
    // gehen, kann die Verbindung trotzdem zufällig zustande kommen (die
    // übrigen, NACH dem Annehmen eingetroffenen Kandidaten reichen manchmal)
    // oder eben nicht — genau das Bild "verbindet sehr unzuverlässig".
    // Zwischenspeichern und beim tatsächlichen Aufbau unten (initialSignals)
    // in derselben Reihenfolge nachreichen behebt das strukturell, nicht
    // nur zufällig.
    if (this.#pendingIncoming.has(msg.from)) {
      this.#pendingSignals.get(msg.from)?.push(msg);
      return;
    }
    this.#pendingIncoming.add(msg.from);
    this.#pendingSignals.set(msg.from, []);
    try {
      const opts = await this.#onIncomingConnection(msg.from);
      if (!opts) { debug('webrtc-pm', 'incoming-declined', { from: msg.from }); return; }
      const buffered = this.#pendingSignals.get(msg.from) ?? [];
      debug('webrtc-pm', 'incoming-accepted', { from: msg.from, bufferedSignalCount: buffered.length });
      await this.#establish(msg.from, { ...opts, initialSignals: [msg, ...buffered] });
    } catch (e) {
      debug('webrtc-pm', 'incoming-failed', { from: msg.from, error: e.message });
      console.error('[PeerConnectionManager] incoming connection failed:', e);
      // Ohne dies erfährt die reagierende Seite (die #onIncomingConnection()
      // selbst nie proaktiv aufruft, siehe connectDirect() vs. hier) NIE,
      // dass es nicht geklappt hat — nur die AUSGEHENDE Seite bekommt einen
      // Fehler direkt aus ihrem eigenen await connectDirect() zurück. Ohne
      // diesen Hook bliebe z. B. eine Anruf-UI beim Angerufenen für immer
      // auf "verbindet …" hängen, wenn die Verbindung (z. B. mangels
      // TURN-Server hinter NAT) nie zustande kommt.
      this.#connectFailedListeners.forEach((fn) => {
        try { fn(msg.from, e); } catch (listenerErr) { console.error('[PeerConnectionManager] onConnectFailed listener error:', listenerErr); }
      });
    } finally {
      this.#pendingIncoming.delete(msg.from);
      this.#pendingSignals.delete(msg.from);
    }
  }

  /** Baut (falls noch nicht vorhanden) eine Direktverbindung zu `peerFingerprint` auf und registriert sie im Router. */
  async connectDirect(peerFingerprint, opts = {}) {
    debug('webrtc-pm', 'connect-direct', { peerFingerprint, alreadyConnected: this.#connections.has(peerFingerprint) });
    if (this.#connections.has(peerFingerprint)) return this.#connections.get(peerFingerprint);
    return this.#establish(peerFingerprint, opts);
  }

  async #establish(peerFingerprint, { pushTopics = [], group = `peer:${peerFingerprint}`, metric = 10, initialSignals = [], connectTimeoutMs = 20000 } = {}) {
    const isOutgoing = initialSignals.length === 0;
    // Markiert, solange DIESE Seite selbst gerade eine Verbindung zu
    // `peerFingerprint` aufbaut (via connectDirect(), nicht reaktiv) —
    // #handleIncoming() muss die Antwort (Answer/ICE) darauf ignorieren
    // statt sie fälschlich als neuen eingehenden Anruf zu behandeln (siehe
    // dortiger Kommentar). Nur für den ausgehenden Fall relevant: der
    // eingehende Fall hat mit #pendingIncoming/#pendingSignals bereits
    // sein eigenes Bein dafür.
    if (isOutgoing) this.#pendingOutgoing.add(peerFingerprint);
    try {
      debug('webrtc-pm', 'establish-start', { peerFingerprint, initiator: isOutgoing, initialSignalCount: initialSignals.length });
      const channel = createWebRTCChannel({
        signalingChannel: this.#signalingChannel,
        myFingerprint: this.#qu.fingerprint,
        peerFingerprint,
        initialSignals,
        iceServers: this.#iceServers,
        // #establish() weiß hier eindeutig, welche Rolle diese Seite hat:
        // OHNE initialSignals ruft DIESE Seite gerade selbst connectDirect()
        // auf (= Initiator), MIT initialSignals reagieren wir auf bereits
        // eingetroffene Signale der Gegenseite (= die Gegenseite hat längst
        // initiiert). Siehe createWebRTCChannel()s initiator-Doku für die
        // Fingerprint-Zufalls-Falle, die das vermeidet.
        initiator: isOutgoing,
      });

      // Ohne diesen Timeout hängt ein Peer ohne funktionierenden P2P-Pfad
      // (kein TURN hinter symmetrischem NAT, ICE kommt nie zum Abschluss)
      // hier fest — `await channel.connect()` löst sich dann NIE auf, also
      // läuft dieser async-Funktionskörper auch nie bis zum `finally`
      // unten weiter, und #pendingOutgoing behält diesen Fingerprint
      // dauerhaft als "im Aufbau" (ein erneuter connectDirect() würde eine
      // zweite, ebenso hängende RTCPeerConnection aufbauen statt die erste
      // wiederzuverwenden oder sauber fehlzuschlagen).
      let timeoutHandle;
      const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`[PeerConnectionManager] Verbindungsaufbau zu ${peerFingerprint} nach ${connectTimeoutMs}ms abgebrochen (kein offener Datenkanal)`)), connectTimeoutMs);
      });
      try {
        await Promise.race([channel.connect(), timeout]); // wartet auf offenen Datenkanal
      } catch (e) {
        channel.close();
        throw e;
      } finally {
        clearTimeout(timeoutHandle);
      }
      debug('webrtc-pm', 'establish-datachannel-open', { peerFingerprint });

      const provenFp = await authenticateChannel(channel, this.#qu.identity);
      debug('webrtc-pm', 'establish-handshake-done', { peerFingerprint, provenFp, matches: provenFp === peerFingerprint });
      if (provenFp !== peerFingerprint) {
        channel.close();
        throw new Error(`[PeerConnectionManager] Handshake-Mismatch: erwartet ${peerFingerprint}, bewiesen wurde ${provenFp}`);
      }
      debug('webrtc-pm', 'verified', { peerFingerprint });

      const repl = new DefaultReplication(this.#qu.runtime, channel, {
        pushTopics,
        peerFingerprint,
        router: this.#router,
      });
      if (this.#router) {
        this.#router.addRoute({
          channelId: repl.channelId, channel, pushTopics, role: 'sync', group, metric,
          transport: 'webrtc', peerFingerprint,
        });
      }

      const entry = { channel, repl };
      this.#connections.set(peerFingerprint, entry);
      channel.onClose(() => {
        repl.close(); // entfernt auch die Router-Route (siehe DefaultReplication.close())
        this.#connections.delete(peerFingerprint);
        debug('webrtc-pm', 'disconnected', { peerFingerprint });
      });
      this.#connectListeners.forEach((fn) => {
        try { fn(peerFingerprint, entry); } catch (e) { console.error('[PeerConnectionManager] onConnect listener error:', e); }
      });
      return entry;
    } finally {
      // Ab hier (Erfolg ODER Fehlschlag) ist #connections bzw. gar nichts
      // mehr der zuständige Zustand — #pendingOutgoing hat seinen Zweck
      // (die Aufbauphase VOR #connections abzudecken) so oder so erfüllt.
      if (isOutgoing) this.#pendingOutgoing.delete(peerFingerprint);
    }
  }

  /** `callback(peerFingerprint, { channel, repl })` — feuert für JEDE erfolgreich aufgebaute Verbindung, ausgehend über connectDirect() oder eingehend, ohne dass Aufrufer beide Fälle getrennt behandeln müssen. */
  onConnect(callback) {
    this.#connectListeners.add(callback);
    return () => this.#connectListeners.delete(callback);
  }

  /**
   * `callback(peerFingerprint, error)` — feuert, wenn eine EINGEHENDE
   * Verbindung (jemand kontaktiert uns, #handleIncoming()) fehlschlägt,
   * z. B. weil kein P2P-Pfad zustande kommt (fehlender TURN-Server hinter
   * NAT). Für eine SELBST per connectDirect() angestoßene Verbindung
   * braucht es das nicht — deren Promise lehnt sich direkt beim Aufrufer
   * ab. Ohne dieses Gegenstück hätte die rein reaktive Seite gar keine
   * Möglichkeit, je von einem gescheiterten Aufbau zu erfahren.
   */
  onConnectFailed(callback) {
    this.#connectFailedListeners.add(callback);
    return () => this.#connectFailedListeners.delete(callback);
  }

  disconnect(peerFingerprint) {
    this.#connections.get(peerFingerprint)?.channel.close();
  }

  get(peerFingerprint) {
    return this.#connections.get(peerFingerprint) ?? null;
  }

  get connectedFingerprints() {
    return [...this.#connections.keys()];
  }

  close() {
    this.#offIncoming();
    for (const fp of this.connectedFingerprints) this.disconnect(fp);
  }
}
