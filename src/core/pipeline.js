export class QuPipeline {
  #stages = [];

  use(fn) {
    this.#stages.push(fn);
    return this;
  }

  async run(ctx, final) {
    const stages = this.#stages;
    let i = -1;
    const dispatch = async (idx) => {
      if (idx <= i) throw new Error('[QuPipeline] next() called multiple times');
      i = idx;
      const fn = stages[idx];
      if (fn) return fn(ctx, () => dispatch(idx + 1));
      return final(ctx);
    };
    return dispatch(0);
  }
}
