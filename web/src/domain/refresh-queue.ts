/** Coalesce refreshes, but let a write await the refresh requested after that write. */
export function createRefreshQueue(
  work: () => Promise<void>,
): () => Promise<void> {
  let active: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (!active) {
      active = work().finally(() => {
        active = null;
      });
      return active;
    }
    if (!queued) {
      const next = () => {
        queued = null;
        return refresh();
      };
      queued = active.then(next, next);
    }
    return queued;
  }

  return refresh;
}
