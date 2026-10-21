// The boards, reactive. In dev the plugin pushes a board whenever its data changed: a
// re-export after an edit, a late stage (the fab bundle) finishing, a board added or
// removed. Swapping the Board object is the whole update: the views follow the fields
// they use, and an asset is refetched only when its content-hashed URL changed, so an
// edit to one layer redraws that layer and nothing else (no page reload).
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
    else if (d.board) boards.splice(boards.findIndex(b => b.name.localeCompare(d.name) > 0) + 1 || boards.length, 0, d.board)   // keeps the name order
    else if (i >= 0) boards.splice(i, 1)
  })
}
