/** Domain conflict (concurrent write, duplicate id, version mismatch). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Domain invariant violation (illegal state transition, broken link). */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}
