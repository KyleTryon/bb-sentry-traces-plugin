/** Running work one at a time per key, without holding on to finished work. */

/** Runs `work` after everything already queued under `key`, whether that failed or not. */
export function queue<T>(chains: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(work, work);
  chains.set(key, next);
  void next
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  return next;
}
