export async function runSteps(steps, onStep) {
  const ctx = {};
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
