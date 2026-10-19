import type { BackendId, Operation } from './types.ts'

/** An operation this backend cannot perform. Callers check `capabilities.ops` first. */
export class UnsupportedError extends Error {
  constructor(readonly backend: BackendId, readonly op: Operation, reason = 'not supported by this backend') {
    super(`${backend}: ${op}: ${reason}`)
    this.name = 'UnsupportedError'
  }
}

/** Placeholder for operations phase 2 implements. Throws UnsupportedError. */
export function notYet(backend: BackendId, op: Operation, owner: string): never {
  throw new UnsupportedError(backend, op, `not implemented yet (${owner})`)
}
