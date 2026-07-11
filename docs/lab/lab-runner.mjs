// Generic step executor — unchanged from the old demo/run-steps.mjs, plus
// an externally-supplied `ctx`: the interactive lab runs sections
// independently (one "Run" button per section, not one big auto-run), and
// later sections need what earlier ones produced (an identity created in
// the Identity section, reused by the Spaces section) — a fresh ctx per
// call would lose that. Passing the same ctx back in across calls, and
// exposing it on `window` (see labs/index.mjs), is also what makes the
// page pokeable from the real browser console, not just from the buttons.
export async function runSteps(steps, onStep, ctx = {}) {
  const results = [];
  for (const step of steps) {
    let result;
    let error;
    let ok;
    try {
      result = await step.run(ctx);
      ok = !step.expectFailure;
    } catch (e) {
      error = e;
      ok = !!step.expectFailure;
    }
    const entry = { ...step, ok, result, error };
    results.push(entry);
    await onStep?.(entry);
  }
  return results;
}
