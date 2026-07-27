// Router: the ONE place that decides "which channels get this qubit
// pushed to them right now" — deliberately separate from DefaultReplication
// (which still owns the actual send/visibility-check mechanics per
// channel) so the routing STRATEGY can change later without touching
// Replication, Files, or anything above them. This file knows nothing
// about WebRTC, relays, or transports — it only knows routes.
//
// Two kinds of route:
//   - role: 'mirror'  — always included, never competes with anything.
//     This is what a client's own storage-relay connection should be
//     registered as: a node's writes must reach its designated mirror
//     unconditionally, regardless of whatever peer-routing decisions are
//     made elsewhere. Losing durability because a "better" path elsewhere
//     out-competed it would be a real bug, not an optimization.
//   - role: 'sync'    — a candidate path to replicate data somewhere
//     (relay-routed or a direct peer channel). Competes ONLY against other
//     'sync' routes that share the same explicit `group` — routes with no
//     group (the default) are never treated as alternatives to one
//     another and are simply all included. Grouping is something the
//     caller opts into on purpose (e.g. "this relay path and this WebRTC
//     path are both ways to reach the same peer, pick the better one"),
//     not something the Router infers — inferring it wrong risks silently
//     dropping a path that was actually still needed.
export class Router {
  #routes = new Map(); // channelId -> route

  /**
   * route: {
   *   channelId: string,
   *   channel: Channel,
   *   pushTopics: string[],
   *   role: 'mirror' | 'sync',
   *   group?: string | null,   // only meaningful for role: 'sync'
   *   metric?: number,          // lower = preferred; default 0
   *   transport?: string,        // free-form label ('relay' | 'webrtc' | ...), for introspection/debugging only
   *   peerFingerprint?: string | null,
   * }
   */
  addRoute(route) {
    if (!route.channelId) throw new Error('[Router] route.channelId is required');
    this.#routes.set(route.channelId, { metric: 0, group: null, transport: null, peerFingerprint: null, ...route });
  }

  removeRoute(channelId) {
    this.#routes.delete(channelId);
  }

  updateMetric(channelId, metric) {
    // A non-finite metric would otherwise silently break resolve()'s
    // `r.metric === best` tie check below: Math.min() with a NaN operand
    // returns NaN, and nothing ever equals NaN, so that whole group would
    // resolve to zero chosen routes (a qubit silently never pushed to
    // ANY route in the group) instead of falling back to routing by the
    // routes that do have a real metric.
    if (!Number.isFinite(metric)) return;
    const r = this.#routes.get(channelId);
    if (r) r.metric = metric;
  }

  getRoute(channelId) {
    return this.#routes.get(channelId) ?? null;
  }

  get routes() {
    return [...this.#routes.values()];
  }

  #matches(route, qubit) {
    return route.pushTopics.some((t) => qubit.id.startsWith(t));
  }

  /** The channels that should receive `qubit` right now — mirrors always, plus the best sync route per group, plus every ungrouped sync route. */
  resolve(qubit) {
    const active = this.routes.filter((r) => this.#matches(r, qubit));
    const mirrors = active.filter((r) => r.role === 'mirror');
    const syncRoutes = active.filter((r) => r.role === 'sync');

    const grouped = new Map();
    const ungrouped = [];
    for (const r of syncRoutes) {
      if (r.group == null) { ungrouped.push(r); continue; }
      if (!grouped.has(r.group)) grouped.set(r.group, []);
      grouped.get(r.group).push(r);
    }

    const chosen = [...ungrouped];
    for (const candidates of grouped.values()) {
      const best = Math.min(...candidates.map((r) => r.metric));
      chosen.push(...candidates.filter((r) => r.metric === best)); // tie -> all of them, per spec
    }

    return [...mirrors, ...chosen];
  }

  /** Convenience for a single route to ask "am I one of the chosen ones for this qubit?" — what DefaultReplication actually calls. */
  isChosen(channelId, qubit) {
    return this.resolve(qubit).some((r) => r.channelId === channelId);
  }
}
