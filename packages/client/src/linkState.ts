// [P2-d] Deep-link state of the board page.
//
// The board page parses the URL once per board into `pending`; the layer browser,
// the 3D view and the layer tools each take their part of it when they are ready
// (takeLinkPart) and report their current state back (setLinkPart). The board page
// mirrors `current` into the URL (history.replace, debounced), so a reload or a
// copied link shows the same view. Only the board page writes the URL; elsewhere
// (the report page) the parts are ignored.

import { onBeforeUnmount, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { formatViewLink, otherParams, parseViewLink, type ViewLink } from './deepLink'

interface LinkState {
  /** Board whose page owns the URL, or null. */
  board: string | null
  pending: ViewLink
  current: ViewLink
}

export const linkState: LinkState = reactive({ board: null, pending: {}, current: {} }) as LinkState

/** Take (once) a part of the URL the page was opened with, for this board. */
export function takeLinkPart<K extends keyof ViewLink>(board: string, key: K): ViewLink[K] | undefined {
  if (linkState.board !== board) return undefined
  const v = linkState.pending[key]
  if (v !== undefined) delete linkState.pending[key]
  return v
}

/** Report the current state of a part (undefined: leave it out of the URL). */
export function setLinkPart(board: string, part: Partial<ViewLink>): void {
  if (linkState.board !== board) return
  for (const [k, v] of Object.entries(part) as [keyof ViewLink, unknown][]) {
    if (v === undefined) delete linkState.current[k]
    else (linkState.current as Record<string, unknown>)[k] = v
  }
}

let flushPending: (() => void) | null = null
/** Write a pending URL update now (before copying the link). */
export function flushLink(): void { flushPending?.() }

/**
 * Board page: parse the URL per board, hand `pane` (and the legacy `tab`) to the page's
 * `applyPanes`, keep the URL in step with the open panes and the current state.
 */
export function useBoardLink(name: () => string, panes: () => string[],
                             applyPanes: (pane: string | undefined, tab: string | undefined) => void): void {
  const route = useRoute()
  const router = useRouter()

  function open(board: string): void {
    linkState.board = board
    linkState.pending = parseViewLink(route.query as Record<string, string>)
    linkState.current = {}
    applyPanes(linkState.pending.pane, linkState.pending.tab)
    delete linkState.pending.pane
    delete linkState.pending.tab
    linkState.current.pane = panes().join(',')
  }
  open(name())
  watch(name, open)
  watch(() => panes().join(','), p => setLinkPart(name(), { pane: p }))

  let timer: ReturnType<typeof setTimeout> | null = null
  const write = () => {
    if (timer) clearTimeout(timer)
    timer = null
    flushPending = null
    if (linkState.board !== name() || route.name !== 'board') return
    const query = { ...otherParams(route.query as Record<string, string>), ...formatViewLink(linkState.current) }
    const same = JSON.stringify(query) === JSON.stringify(route.query)
    // the hash is the cross-probe selection (#part=, crossprobe/store.ts), written with
    // history.replaceState behind the router's back: keep the live one, not route.hash
    if (!same) void router.replace({ query, hash: location.hash })
  }
  watch(() => JSON.stringify(linkState.current), () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(write, 400)
    flushPending = write
  })
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
    flushPending = null
    linkState.board = null
  })
}
