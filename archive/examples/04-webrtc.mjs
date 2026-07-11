// Beispiel 4: WebRTC-Direktverbindung zu einem Fingerprint.
//
// WICHTIGER HINWEIS ZUR TESTABDECKUNG: dieses Beispiel nutzt echte
// RTCPeerConnection/getUserMedia-APIs — in der Sandbox, in der dieses
// Projekt gebaut wurde, gibt es weder einen Browser noch WebRTC in Node,
// also konnte dieses Beispiel dort nicht automatisiert ausgeführt werden.
// Sorgfältig nach dem bestehenden, getesteten PeerConnectionManager
// gebaut — ein echter Test in zwei Browser-Tabs steht noch aus.
//
// Zeigt:
//   1. Signaling über den bestehenden Relay (kein eigener Server-Code).
//   2. connectDirect(fingerprint) — Aufbau, erneuter QU-Handshake über den
//      neuen Kanal, danach normale Replication (qu.append/qu.on) über die
//      Direktverbindung statt über den Relay.
//   3. disconnect() — sauberes Trennen.
//   4. Audio/Video als zusätzliche Tracks auf DERSELBEN RTCPeerConnection,
//      nicht als zweite Verbindung.

import { Qu, createWebSocketChannel, createNetworkPlugin, createSpacesPlugin } from '../src/index.js';

const IDENTITY_KEY = 'qu-webrtc-example-identity';

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const myFpEl = el('my-fp');
const peerFpInput = el('peer-fp');
const connectBtn = el('connect-btn');
const disconnectBtn = el('disconnect-btn');
const connStateEl = el('conn-state');
const msgsEl = el('msgs');
const msgForm = el('msg-form');
const msgInput = el('msg-text');
const audioBtn = el('audio-btn');
const videoBtn = el('video-btn');
const remoteVideoEl = el('remote-video');
const remoteAudioEl = el('remote-audio');
const incomingEl = el('incoming-call');

async function loadOrCreateIdentity() {
  const saved = localStorage.getItem(IDENTITY_KEY);
  if (saved) return Qu.create({ identity: JSON.parse(saved) });
  const qu = await Qu.create();
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(await qu.exportKeys()));
  return qu;
}

function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/relay`;
}

// Deterministisches, für beide Seiten identisches Gesprächs-Topic — egal
// wer zuerst "Verbinden" klickt, beide landen im selben Space.
function conversationTopic(fpA, fpB) {
  const [a, b] = [fpA, fpB].sort();
  return `direct/${a}-${b}`;
}

async function main() {
  const qu = (await loadOrCreateIdentity()).use(createNetworkPlugin()).use(createSpacesPlugin());
  myFpEl.textContent = qu.fingerprint;

  // Signaling-Kanal: die normale Relay-Verbindung. WebRTC selbst kennt
  // den Relay nicht — nur qu.webrtc() bekommt ihn als "wo laufen SDP/ICE
  // durch" gereicht (siehe relay/relay.mjs's generische qu.route-
  // Weiterleitung, core/routed-events.js).
  const signalingChannel = createWebSocketChannel(relayUrl());
  await signalingChannel.connect();
  await qu.connect(signalingChannel, { pushTopics: [] }); // nur für den Fall, dass später auch relay-vermittelte Topics gebraucht werden
  statusEl.textContent = 'Signaling verbunden';

  let currentPeerFp = null;
  let currentEntry = null; // { channel, repl }
  let offMessages = null;

  function renderMsg(q) {
    const li = document.createElement('li');
    const mine = q.writer === qu.fingerprint;
    li.textContent = `${mine ? 'ich' : q.writer.slice(0, 8) + '…'}: ${q.value.text}`;
    msgsEl.appendChild(li);
  }

  function updateConnState() {
    const state = currentEntry?.channel.connectionState ?? 'getrennt';
    connStateEl.textContent = state;
    const connected = state === 'connected';
    msgForm.hidden = !connected;
    audioBtn.hidden = !connected;
    videoBtn.hidden = !connected;
    disconnectBtn.hidden = !connected;
    connectBtn.hidden = connected;
  }

  async function attachTo(peerFp, entry) {
    currentPeerFp = peerFp;
    currentEntry = entry;
    msgsEl.textContent = '';

    // Eingehende Media-Tracks der Gegenseite anzeigen — pc.ontrack ist
    // eine bewusste Fluchttür in webrtc-channel-browser.mjs
    // (channel.peerConnection), kein Teil des Channel-Contracts selbst.
    entry.channel.peerConnection.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (ev.track.kind === 'video') remoteVideoEl.srcObject = stream;
      if (ev.track.kind === 'audio') remoteAudioEl.srcObject = stream;
    };

    entry.channel.onClose(() => {
      updateConnState();
      currentEntry = null;
    });

    const topic = conversationTopic(qu.fingerprint, peerFp);
    // Historie + live weiterhören in einem Aufruf (siehe on()-Optionen).
    offMessages?.();
    offMessages = qu.on(`${topic}/msgs/**`, renderMsg, { initial: true });

    updateConnState();
  }

  connectBtn.addEventListener('click', async () => {
    const peerFp = peerFpInput.value.trim();
    if (!peerFp) return;
    connectBtn.disabled = true;
    statusEl.textContent = 'Verbinde direkt …';
    try {
      const topic = conversationTopic(qu.fingerprint, peerFp);
      await pm.connectDirect(peerFp, { pushTopics: [`${topic}/`] }); // attachTo() läuft über onConnect() unten, für beide Richtungen identisch
      statusEl.textContent = 'Direktverbindung steht';
    } catch (e) {
      statusEl.textContent = `Verbindung fehlgeschlagen: ${e.message}`;
      console.error('[webrtc-example] connect failed:', e);
    } finally {
      connectBtn.disabled = false;
    }
  });

  disconnectBtn.addEventListener('click', () => {
    if (currentPeerFp) pm.disconnect(currentPeerFp);
    currentEntry = null;
    currentPeerFp = null;
    updateConnState();
    statusEl.textContent = 'Getrennt';
  });

  msgForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = msgInput.value.trim();
    if (!text || !currentPeerFp) return;
    const topic = conversationTopic(qu.fingerprint, currentPeerFp);
    await qu.append(`${topic}/msgs`, { text });
    msgInput.value = '';
  });

  audioBtn.addEventListener('click', async () => {
    if (!currentEntry) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // addTrack löst automatisch eine Renegotiation aus (Perfect
      // Negotiation ist in webrtc-channel-browser.mjs bereits verdrahtet,
      // dafür war kein zusätzlicher Code hier nötig).
      for (const track of stream.getTracks()) currentEntry.channel.peerConnection.addTrack(track, stream);
      audioBtn.textContent = 'Audio läuft';
      audioBtn.disabled = true;
    } catch (e) {
      statusEl.textContent = `Mikrofon-Zugriff fehlgeschlagen: ${e.message}`;
    }
  });

  videoBtn.addEventListener('click', async () => {
    if (!currentEntry) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const track of stream.getTracks()) currentEntry.channel.peerConnection.addTrack(track, stream);
      videoBtn.textContent = 'Video läuft';
      videoBtn.disabled = true;
    } catch (e) {
      statusEl.textContent = `Kamera-Zugriff fehlgeschlagen: ${e.message}`;
    }
  });

  // Eingehende Verbindungen: einfache Demo-Politik — automatisch annehmen,
  // sichtbar machen, wer angerufen hat. Eine echte App würde hier fragen
  // statt automatisch anzunehmen.
  const pm = qu.webrtc(signalingChannel, {
    onIncomingConnection: async (fromFp) => {
      incomingEl.textContent = `Eingehende Verbindung von ${fromFp.slice(0, 12)}… — angenommen.`;
      incomingEl.hidden = false;
      const topic = conversationTopic(qu.fingerprint, fromFp);
      return { pushTopics: [`${topic}/`] };
    },
  });

  // Dieselbe attachTo()-Logik für beide Richtungen — onConnect() feuert
  // unabhängig davon, ob die Verbindung über connectDirect() (ausgehend)
  // oder reaktiv (eingehend) zustande kam.
  pm.onConnect((peerFp, entry) => { attachTo(peerFp, entry); });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
