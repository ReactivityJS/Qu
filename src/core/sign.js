// Signing happens exclusively in Session (see session.js) - a Session's
// own identity is call-scoped, not registered globally on a Runtime, which
// is what makes "multiple Sessions over one Runtime" safe. canonical()
// defines the exact byte shape that gets signed/verified, shared here so
// Session and the verify plugin can never drift out of sync with each
// other.
//
// `refs` is included in the signed payload: without that, a QuBit's
// reference list (attachments, space-links, list pointers) could be
// swapped out after signing without Verify noticing - same class of bug
// as the original tamper-detection gap, just on a field added later.
export function canonical(qubit) {
  const v = typeof qubit.value === 'string' ? qubit.value : JSON.stringify(qubit.value);
  const r = JSON.stringify(qubit.refs ?? []);
  return `${qubit.id}|${v}|${qubit.ts}|${r}`;
}
