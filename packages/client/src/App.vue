<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import { site } from './site'
import ThemeToggle from './components/ThemeToggle.vue'   // [P2-d]
</script>

<template>
  <div class="app">
    <header class="topbar">
      <RouterLink to="/" class="home">
        <img v-if="site.logo" :src="site.logo" alt="" class="logo" />{{ site.title }}
      </RouterLink>
      <div id="topbar-slot" class="slot"></div>
      <ThemeToggle />
    </header>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100%; }
.topbar {
  flex: 0 0 var(--topbar-h);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.home { font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }
.home { display: inline-flex; align-items: center; gap: 8px; }
.logo { height: 22px; width: auto; display: block; }
.slot { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; }
.main { flex: 1; min-height: 0; overflow: auto; }
.topbar { overflow: hidden; }
@media (max-width: 820px) {
  .topbar { gap: 8px; padding: 0 8px; }
  .home { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
}
/* [P2-d] phones: the board's controls need the room */
@media (max-width: 560px) {
  .topbar { gap: 6px; padding: 0 6px; }
  .slot { gap: 6px; }
  .home { max-width: 24vw; }
  .topbar:has(.slot:empty) .home { max-width: 70vw; }
}
/* [assembly] narrow phones: the board page's controls need a little more */
@media (max-width: 420px) { .topbar:has(.slot:not(:empty)) .home { max-width: 14vw; } }
</style>
