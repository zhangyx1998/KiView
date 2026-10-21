import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { applyTheme, site } from './site'
import './style.css'

applyTheme()
// the built page carries the title; the dev page may not yet (a single-board site's default is the board's)
if (document.title !== site.title) document.title = site.title
createApp(App).use(router).mount('#app')
