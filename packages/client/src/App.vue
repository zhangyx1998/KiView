<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import { site } from './site'
import ThemeToggle from './components/ThemeToggle.vue'   // [P2-d]
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div id="topbar-lead" class="lead"></div><!-- the board page's list toggle -->
      <RouterLink to="/" class="home" :title="site.title">
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
  gap: 8px;
  padding: 0;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  overflow: hidden;
}
.lead { display: flex; align-self: stretch; }
.lead:empty { display: none; }
.lead:empty + .home { margin-left: 12px; }
/* the title gets the width the controls leave (they never shrink), then ellipsises */
.home { flex: 0 1 auto; min-width: 0; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.home { display: inline-flex; align-items: center; gap: 8px; }
.logo { height: 22px; width: auto; display: block; flex: 0 0 auto; }
.slot { flex: 1 1 0; min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 6px; }
.main { flex: 1; min-height: 0; overflow: auto; }
@media (max-width: 820px) {
  .lead:empty + .home { margin-left: 8px; }
}
</style>
