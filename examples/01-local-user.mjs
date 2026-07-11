// Beispiel 1: Ein lokaler User — kein Netzwerk, kein Relay.
//
// Das ist die kleinstmögliche QU-Nutzung: eine Identität, ein lokaler
// Speicher, schreiben und lesen. Läuft komplett offline — nichts hier
// verlässt den Prozess.
//
// Ausführen: node examples/01-local-user.mjs

import { Qu } from '../src/index.js';

async function main() {
  // Qu.create() erzeugt automatisch eine neue Identität (Schlüsselpaar)
  // UND ein eigenes, unabhängiges Gerät (eigene Runtime, eigener Store).
  // Kein manuelles Verdrahten von Runtime/Store/Session nötig.
  const alice = await Qu.create();
  console.log('Alice’ Fingerprint:', alice.fingerprint);

  // publish() schreibt einen benannten, veränderlichen Wert (LWW-Register)
  // — ideal für "eine Sache mit einer festen Adresse", z. B. ein Profilfeld.
  await alice.publish('notes/shopping-list', { text: 'Milch, Brot, Kaffee' });

  // get() liest ihn wieder — auch ohne jedes Netzwerk, weil alles lokal
  // im Speicher der Runtime liegt.
  const note = await alice.get('notes/shopping-list');
  console.log('Notiz:', note.value.text);

  // append() ist der zweite Schreibmodus: für Sammlungen mit potenziell
  // mehreren Einträgen (hier nur einer, aber das Prinzip zählt) — jeder
  // Aufruf bekommt automatisch eine eigene, kollisionssichere ID.
  await alice.append('notes/journal', { text: 'Erster Eintrag' });
  await alice.append('notes/journal', { text: 'Zweiter Eintrag' });

  // query() liest mehrere QuBits über ein Muster — '**' steht für
  // "alles darunter, beliebig tief".
  const journal = await alice.query('notes/journal/**');
  console.log(
    'Journal:',
    journal.map((q) => q.value.text),
  );

  // on() reagiert live auf neue Einträge — auch rein lokal nützlich, z. B.
  // um eine Oberfläche zu aktualisieren, sobald sich Daten ändern.
  alice.on('notes/journal/**', (q) => console.log('Live-Update:', q.value.text));
  await alice.append('notes/journal', { text: 'Dritter Eintrag (live gesehen)' });
}

main();
