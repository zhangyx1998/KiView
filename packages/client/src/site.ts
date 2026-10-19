// Site settings from kiview.config.ts; the theme is applied once at startup.
//
// [P2-d] Themes: `theme.appearance` from the config ('dark' | 'light' | 'auto') is the
// default; the viewer's own choice (the theme toggle) is remembered per browser and
// wins. 'auto' follows the system setting live. The resolved theme is
// <html data-theme="light|dark">, which style.css keys its tokens on; the configured
// accent and raw CSS variables apply to both.
import { reactive } from 'vue'
import { site } from 'virtual:kiview/site'

export { site }

export type ThemePref = 'auto' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORE_KEY = 'kiview.theme'
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

function storedPref(): ThemePref | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === 'auto' || v === 'light' || v === 'dark' ? v : null
  } catch { return null }
}

export const theme = reactive<{ pref: ThemePref; resolved: ResolvedTheme }>({
  pref: storedPref() ?? site.theme.appearance,
  resolved: 'dark',
})

const resolve = (p: ThemePref): ResolvedTheme => (p === 'auto' ? (darkQuery?.matches ?? true ? 'dark' : 'light') : p)

function sync(): void {
  theme.resolved = resolve(theme.pref)
  const root = document.documentElement
  root.dataset.theme = theme.resolved
  root.style.colorScheme = theme.resolved
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.resolved)
}

/** Set (and remember) the viewer's choice; forgotten again when it equals the config default. */
export function setThemePref(p: ThemePref): void {
  theme.pref = p
  try {
    if (p === site.theme.appearance) localStorage.removeItem(STORE_KEY)
    else localStorage.setItem(STORE_KEY, p)
  } catch { /* private mode */ }
  sync()
}

export function applyTheme(): void {
  const root = document.documentElement
  root.dataset.appearance = site.theme.appearance
  if (site.theme.accent) root.style.setProperty('--accent', site.theme.accent)
  for (const [k, v] of Object.entries(site.theme.vars)) root.style.setProperty(k.startsWith('--') ? k : `--${k}`, v)
  sync()
  darkQuery?.addEventListener('change', () => { if (theme.pref === 'auto') sync() })
}
