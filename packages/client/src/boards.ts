// The boards, reactive. In dev the plugin pushes a board when a late export stage
// (the fab bundle) finishes, so e.g. a download link appears without a reload.
import { reactive } from 'vue'
import { boards as initial } from 'virtual:kiview/boards'
import type { Board, BoardEvent } from './types'

export const boards: Board[] = reactive(initial.map(b => ({ ...b }))) as Board[]

export function boardByName(name: string): Board | undefined {
  return boards.find(b => b.name === name)
}

if (import.meta.hot) {
  import.meta.hot.on('kiview:board', (d: BoardEvent) => {
    const i = boards.findIndex(b => b.name === d.name)
    if (d.board && i >= 0) boards[i] = d.board
    else if (d.board) boards.push(d.board)
    else if (i >= 0) boards.splice(i, 1)
  })
}
