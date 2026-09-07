export interface WriteAttempt<T> {
  readonly signature: string;
  readonly key: string;
  readonly body: T;
}

/** Freeze generated IDs together with the request so an uncertain retry is the same write. */
export function prepareWriteAttempt<T>(
  previous: WriteAttempt<T> | null,
  signature: string,
  createBody: () => T,
): WriteAttempt<T> {
  return previous?.signature === signature
    ? previous
    : { signature, key: crypto.randomUUID(), body: createBody() };
}
