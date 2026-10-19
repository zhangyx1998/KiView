import { createRouter, createWebHistory } from 'vue-router'
import HomePage from './pages/HomePage.vue'

// Path history (/board/<Name>): the server must answer unknown paths with index.html.
// The Vite dev and preview servers do; a static host needs that one rewrite rule.
// Links from before the switch to path history (#/board/<Name>) still land on their page.
if (location.hash.startsWith('#/'))
  history.replaceState(null, '', import.meta.env.BASE_URL.replace(/\/$/, '') + location.hash.slice(1))

// The viewer page is a separate chunk; three.js only loads inside it, with the 3D pane.
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/board/:name/diff', name: 'board-diff', component: () => import('./pages/DiffPage.vue'), props: true }, // [P2-c]
    { path: '/board/:name', name: 'board', component: () => import('./pages/BoardPage.vue'), props: true },
    { path: '/board/:name/:report(drc|erc)', name: 'report', component: () => import('./pages/ReportPage.vue'), props: true },   // [P2-d]
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
