// QU unterscheidet drei grundsätzlich verschiedene Kategorien von
// Information, nicht zwei:
//
//   1. GESPEICHERTE DATEN (publish/append) — signiert, ACL-geprüft,
//      dauerhaft (außer NullAdapter-Mount), an alle Subscriber eines
//      Topics verteilt ("shared").
//   2. LOKALE EPHEMERE EVENTS (runtime.emit) — nie gespeichert, verlassen
//      den Prozess nie, reiner lokaler Signalmechanismus.
//   3. GEROUTETE EPHEMERE EVENTS (diese Datei) — nie gespeichert, aber
//      auch nicht lokal: an genau EINEN Fingerprint adressiert, über
//      einen bestehenden Channel geroutet (typischerweise den Relay, der
//      den Payload nie interpretiert — siehe relay/relay.mjs), nicht an
//      alle Subscriber eines Topics gesendet. WebRTC-Signaling (SDP/ICE)
//      ist die erste, aber nicht die einzige denkbare Nutzung — jede
//      Punkt-zu-Punkt-Ephemer-Kommunikation (z. B. ein Anruf-Invite, ein
//      Tippindikator an eine bestimmte Person statt einen ganzen Raum)
//      gehört hierher, nicht in publish()/append().
//
// Der Envelope ist bewusst generisch (`event`-Feld statt eines fest
// verdrahteten `type` pro Anwendungsfall) — der Relay muss dadurch für
// neue Nutzungen dieser Kategorie nicht geändert werden.

export function sendRoutedEvent(channel, toFingerprint, event, payload) {
  return channel.send({ type: 'qu.route', to: toFingerprint, event, payload });
}

/** `callback(msg)` erhält die volle Nachricht (`{ from, event, payload }`) — `from` ist die vom Relay bewiesene, nicht die vom Absender behauptete Identität (siehe relay/relay.mjs). */
export function onRoutedEvent(channel, event, callback) {
  return channel.onMessage((msg) => {
    if (msg.type === 'qu.route' && msg.event === event) callback(msg);
  });
}
