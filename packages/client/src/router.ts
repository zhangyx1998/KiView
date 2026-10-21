import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import HomePage from './pages/HomePage.vue'
import { site } from './site'

// Path history (/board/<Name>): the server must answer unknown paths with index.html.
// The Vite dev and preview servers do; a static host needs that one rewrite rule.
// Links from before the switch to path history (#/board/<Name>) still land on their page.
if (location.hash.startsWith('#/'))
  history.replaceState(null, '', import.meta.env.BASE_URL.replace(/\/$/, '') + location.hash.slice(1))

// The viewer page is a separate chunk; three.js only loads inside it, with the 3D pane.
const BoardPage = () => import('./pages/BoardPage.vue')
const DiffPage = () => import('./pages/DiffPage.vue')      // [P2-c]
const ReportPage = () => import('./pages/ReportPage.vue')  // [P2-d]

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: HomePage },
  { path: '/board/:name/diff', name: 'board-diff', component: DiffPage, props: true },
  { path: '/board/:name', name: 'board', component: BoardPage, props: true },
  { path: '/board/:name/:report(drc|erc)', name: 'report', component: ReportPage, props: true },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

// Single-board site (config `single`): the board's pages at the root, no home page.
// The route names stay, so links built by routes.ts work on both layouts; the
// /board/<Name>/... paths of a multi-board site land on the same pages.
const single = (name: string): RouteRecordRaw[] => [
  { path: '/', name: 'board', component: BoardPage, props: { name } },
  { path: '/diff', name: 'board-diff', component: DiffPage, props: { name } },
  { path: '/:report(drc|erc)', name: 'report', component: ReportPage, props: r => ({ name, report: r.params.report }) },
  { path: '/board/:name/:rest(.*)*', redirect: r => ({ path: '/' + (r.params.rest as string[]).join('/'), query: r.query, hash: r.hash }) },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: site.single ? single(site.single) : routes,
})
