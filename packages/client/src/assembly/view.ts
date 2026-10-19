// [assembly] What the assembly pane shows in the board's Layers pane: the current step's
// pin 1 / cathode / + marks, the placed parts, the parts to leave empty, a caption, and
// the side to turn the view to. The assembly pane writes it while it is shown and clears
// it when hidden; the Layers pane (LayerBrowser.vue) draws it over the layer stack.
import { reactive } from 'vue'
import type { Footprint } from '../types'
import type { Side } from './model.ts'

export interface AsmMark { ref: string; x: number; y: number; pad: string | null; kind: string; padD: string | null; box: Footprint['bbox']; placed: boolean }
export interface AsmCaption { step: string; text: string; legend: string | null; empty: boolean }

export const asmView = reactive({
  /** Board the marks belong to; null when the assembly pane is not shown. */
  board: null as string | null,
  marks: [] as AsmMark[],
  empty: [] as Footprint[],
  caption: null as AsmCaption | null,
  /** Side asked for, applied by the Layers pane each time `sideSeq` changes. */
  side: null as Side | null,
  sideSeq: 0,
})

export function showSide(board: string, side: Side): void {
  asmView.board = board
  asmView.side = side
  asmView.sideSeq++
}

export function clearAsmView(board: string): void {
  if (asmView.board !== board) return
  asmView.board = null
  asmView.marks = []
  asmView.empty = []
  asmView.caption = null
}
