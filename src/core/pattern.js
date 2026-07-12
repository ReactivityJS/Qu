// Canonical pattern semantics, shared by every matcher in Core: the
// one-shot regex scan behind Runtime.query() AND the live Trie behind
// QuSubscriptionEngine (Runtime.on()/Session.on()/QuSpace.on()/.map()).
// MQTT-inspired ('*' = exactly one path segment, '**' = this node and
// everything below), including MQTT's own rule for its multi-level
// wildcard ('#'): the deep wildcard is only ever valid as the FINAL
// segment.
//
// That rule is enforced HERE, once, rather than left for each matcher to
// reinvent — because they used to disagree silently. A pattern like
// "posts/**/01" partially "worked": the regex behind query() correctly
// matched only the literal ".../01" ids, but the Trie behind on()/map()
// stops descending the instant it sees '**' and subscribes at that
// level — everything after it in the pattern string was silently
// ignored, so the live subscription actually behaved like "posts/**"
// (delivers everything below "posts/", not just the 1st of each month).
// The result was a split-brain bug: subscribeWithOptions()'s initial
// catch-up batch (via query()) looked correctly filtered, while the
// ongoing live stream (via on()) quietly leaked unrelated data — exactly
// the kind of thing that's obvious in a test and easy to miss in
// production. Rejecting the pattern outright, in both matchers, turns
// that silent divergence into an immediate, clear error instead.
export function splitPath(pattern) {
  const clean = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  return clean.length ? clean.split('/') : [];
}

/** Throws if `**` appears anywhere but as the pattern's final segment. */
export function assertValidPattern(pattern) {
  const segments = splitPath(pattern);
  const deepIndex = segments.indexOf('**');
  if (deepIndex !== -1 && deepIndex !== segments.length - 1) {
    throw new Error(`[Pattern] "**" ist nur als letztes Segment erlaubt, nicht mittig: "${pattern}"`);
  }
}
