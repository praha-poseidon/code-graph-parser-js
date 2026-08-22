export const user = {
  effects: {
    save(payload: unknown) { return payload; },
    cancel() { return undefined; }
  }
};
