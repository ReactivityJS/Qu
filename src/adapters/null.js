// "Nur Event-Bus" braucht keinen Sonderpfad in Runtime/Store: ein Adapter,
// der nie etwas zurückgibt und nie etwas behält, reicht. QuStore.put()
// findet nie ein `existing`, akzeptiert also immer -> Dispatch feuert ganz
// normal über den regulären ingest()-Pfad, nur dass get()/query() danach
// nichts mehr liefern. Live-Events, Presence-Pings, Tippindikatoren etc.
// laufen so durch dieselbe API wie persistente Daten, ohne dass eine App
// zwischen "echtem" publish() und einem separaten Broadcast-Call
// unterscheiden müsste.
export class NullAdapter {
  async get() { return null; }
  async put() {}
  async delete() {}
  async getAll() { return []; }
}
