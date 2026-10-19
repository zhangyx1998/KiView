import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { applyTheme } from './site'
import './style.css'

applyTheme()
createApp(App).use(router).mount('#app')
