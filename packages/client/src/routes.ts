// Locations of the board pages. On a single-board site (config `single`, SiteData.single)
// the board's pages sit at the root: `/`, `/diff`, `/drc`, `/erc`, with no board name in
// the path; elsewhere under `/board/<Name>`. Links go through these so that both work.
import type { RouteLocationRaw } from 'vue-router'
import { site } from './site'

type Query = Record<string, string>

const params = (name: string, more: Record<string, string> = {}) => (site.single ? more : { name, ...more })

/** The board page; `query` carries a deep link (deepLink.ts). */
export const boardRoute = (name: string, query?: Query): RouteLocationRaw => ({ name: 'board', params: params(name), ...(query && { query }) })
/** The "changes since" page of a board. */
export const diffRoute = (name: string): RouteLocationRaw => ({ name: 'board-diff', params: params(name) })
/** A board's DRC or ERC report page. */
export const reportRoute = (name: string, report: 'drc' | 'erc'): RouteLocationRaw => ({ name: 'report', params: params(name, { report }) })
