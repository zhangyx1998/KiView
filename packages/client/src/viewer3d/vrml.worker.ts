// Parse worker: VRML text in, merged per-material triangle batches out, so the
// ~1 s parse of the largest board never blocks the page. Terminating the worker
// is how a stale parse is cancelled.
import { parseAndMergeVrml, transferables } from './vrmlMerge'

export interface ParseRequest { buffer: ArrayBuffer; base: string }

interface WorkerScope {
  onmessage: ((e: MessageEvent<ParseRequest>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
}
const scope = self as unknown as WorkerScope

scope.onmessage = (e) => {
  try {
    const text = new TextDecoder().decode(e.data.buffer)
    const model = parseAndMergeVrml(text, e.data.base)
    scope.postMessage({ ok: true, model }, transferables(model))
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }, [])
  }
}
