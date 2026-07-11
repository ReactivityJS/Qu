// Beispiel 2: Zwei Clients verbinden und Daten austauschen.
//
// Hier laufen Alice und Bob im selben Prozess, aber mit komplett
// getrennten Identitäten UND getrennten Geräten (jede Qu.create()-Instanz
// hat ihre eigene Runtime/eigenen Store) — genau wie zwei echte Nutzer auf
// zwei echten Geräten. Verbunden werden sie über einen "Loopback-Channel":
// denselben Vertrag (Channel-Contract), den auch eine echte WebSocket-
// Verbindung erfüllt, nur ohne echtes Netzwerk — deshalb läuft dieses
// Beispiel ohne Server/Relay.
//
// (Für eine ECHTE Netzwerkverbindung zwischen zwei Browser-Tabs: siehe
// demo/live-chat.mjs — dieselbe qu.connect()-API, nur mit
// createWebSocketChannel(url) statt createLoopbackChannelPair().)
//
// Ausführen: node examples/02-two-clients.mjs

import { Qu, createLoopbackChannelPair, createNetworkPlugin } from '../src/index.js';

async function main() {
  const alice = (await Qu.create()).use(createNetworkPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin());
  console.log('Alice:', alice.fingerprint);
  console.log('Bob:  ', bob.fingerprint);

  // Ein Channel-Paar — a gehört zu Alice' Seite, b zu Bobs Seite.
  const { a: channelForAlice, b: channelForBob } = createLoopbackChannelPair();

  // connect() macht drei Dinge in einem Aufruf: beweist die Identität der
  // Gegenseite per Challenge-Response-Handshake, richtet Replication ein,
  // und liefert ein Objekt mit .sync()/.repair()/.snapshot()/.close().
  const [replAlice, replBob] = await Promise.all([
    alice.connect(channelForAlice, { pushTopics: ['room/'] }),
    bob.connect(channelForBob, { pushTopics: ['room/'] }),
  ]);
  console.log('Handshake bestätigt — Alice sieht Bob als:', replAlice.peerFingerprint);

  // Bob hört live auf alles unter "room/**".
  bob.on('room/**', (q) => console.log(`Bob empfängt live: "${q.value.text}" von ${q.writer.slice(0, 8)}…`));

  // Alice schreibt — weil "room/" in ihren pushTopics steht, wird das
  // sofort an Bob gepusht. Kein sync() nötig.
  await alice.append('room/msgs', { text: 'Hallo Bob!' });
  await new Promise((r) => setTimeout(r, 50)); // dem Push kurz Zeit geben

  // Ephemere Events (keine Speicherung) eignen sich für Dinge wie
  // Tippindikatoren — runtime.emit() ist der "flüchtige" Gegenpart zu
  // publish()/append(), die immer persistieren.
  alice.runtime.emit('room/typing', { who: alice.fingerprint });

  // Reziproker Sync: Bob schreibt, ohne dass Alice aktiv benachrichtigt
  // wird. Ein einziger sync()-Aufruf von Alice holt Bobs neuen Eintrag
  // trotzdem, weil die Gegenseite automatisch zurückfragt.
  await bob.publish('room/msgs/note-from-bob', { text: 'Hier ist Bob' });
  await replAlice.sync({ topic: 'room', since: 0 });
  const aliceView = await alice.query('room/msgs/**');
  console.log(
    'Alice sieht nach einem einzigen sync():',
    aliceView.map((q) => q.value.text),
  );

  replAlice.close();
  replBob.close();
}

main();
