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
  #offIncoming;
  #onIncomingConnection;
  #connectListeners = new Set();

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
   */
  constructor(qu, { router = null, signalingChannel, onIncomingConnection = null } = {}) {
    this.#qu = qu;
    this.#router = router;
    this.#signalingChannel = signalingChannel;
    this.#onIncomingConnection = onIncomingConnection ?? (async () => ({ pushTopics: [] }));
    this.#offIncoming = signalingChannel.onMessage((msg) => this.#handleIncoming(msg));
  }

  async #handleIncoming(msg) {
    if (msg.type !== 'qu.route' || msg.event !== 'webrtc-signal' || !msg.from) return;
    // Schon verbunden ODER im Aufbau (inkl. noch klingelnd, d.h.
    // #onIncomingConnection() hängt noch auf eine Nutzer-Entscheidung):
    // ohne diese zweite Prüfung würde JEDER weitere ICE-Kandidat, der
    // während des Klingelns eintrifft, hier erneut hereinkommen (derselbe
    // `msg.from`, aber noch kein Eintrag in #connections) und
    // #onIncomingConnection() ein weiteres Mal aufrufen — der Aufrufer
    // (z. B. die Chat-App) würde seinen "Anruf annehmen"-Resolver dabei
    // überschreiben, sodass beim tatsächlichen Annehmen der FALSCHE
    // `initialSignal` (ein ICE-Kandidat statt des ursprünglichen SDP-
    // Offers) an #establish() übergeben wird — genau das führte zu
    // "remote description was null" in createWebRTCChannel().
    if (this.#connections.has(msg.from) || this.#pendingIncoming.has(msg.from)) return;
    this.#pendingIncoming.add(msg.from);
    try {
      const opts = await this.#onIncomingConnection(msg.from);
      if (!opts) { debug('webrtc-pm', 'incoming-declined', { from: msg.from }); return; }
      await this.#establish(msg.from, { ...opts, initialSignal: msg });
    } catch (e) {
      debug('webrtc-pm', 'incoming-failed', { from: msg.from, error: e.message });
      console.error('[PeerConnectionManager] incoming connection failed:', e);
    } finally {
      this.#pendingIncoming.delete(msg.from);
    }
  }

  /** Baut (falls noch nicht vorhanden) eine Direktverbindung zu `peerFingerprint` auf und registriert sie im Router. */
  async connectDirect(peerFingerprint, opts = {}) {
    if (this.#connections.has(peerFingerprint)) return this.#connections.get(peerFingerprint);
    return this.#establish(peerFingerprint, opts);
  }

  async #establish(peerFingerprint, { pushTopics = [], group = `peer:${peerFingerprint}`, metric = 10, initialSignal = null } = {}) {
    const channel = createWebRTCChannel({
      signalingChannel: this.#signalingChannel,
      myFingerprint: this.#qu.fingerprint,
      peerFingerprint,
      initialSignal,
      // #establish() weiß hier eindeutig, welche Rolle diese Seite hat:
      // ohne initialSignal ruft DIESE Seite gerade selbst connectDirect()
      // auf (= Initiator), MIT initialSignal reagieren wir auf ein
      // bereits eingetroffenes Signal der Gegenseite (= die Gegenseite
      // hat längst initiiert). Siehe createWebRTCChannel()s
      // initiator-Doku für die Fingerprint-Zufalls-Falle, die das
      // vermeidet.
      initiator: !initialSignal,
    });

    await channel.connect(); // wartet auf offenen Datenkanal

    const provenFp = await authenticateChannel(channel, this.#qu.identity);
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
  }

  /** `callback(peerFingerprint, { channel, repl })` — feuert für JEDE erfolgreich aufgebaute Verbindung, ausgehend über connectDirect() oder eingehend, ohne dass Aufrufer beide Fälle getrennt behandeln müssen. */
  onConnect(callback) {
    this.#connectListeners.add(callback);
    return () => this.#connectListeners.delete(callback);
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
