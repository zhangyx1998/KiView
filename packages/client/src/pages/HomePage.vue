<script setup lang="ts">
// Home: one card per board. Loads only the manifest and the thumbnails.
import { RouterLink } from 'vue-router'
import { boards } from '../boards'
import { boardFacts } from '../format'
import { site } from '../site'
import FabDownload from '../components/FabDownload.vue'
import RevisionBadge from '../components/RevisionBadge.vue'
</script>

<template>
  <div class="home-page">
    <p v-if="site.description" class="description">{{ site.description }}</p>
    <p v-if="!boards.length" class="empty">
      No boards found. Each <code>&lt;Name&gt;/&lt;Name&gt;.kicad_pcb</code> under the project folder becomes a card
      (see <code>boards</code> in the config); check the log for export errors.
    </p>
    <ul class="grid">
      <li v-for="b in boards" :key="b.name" class="card">
        <RouterLink :to="{ name: 'board', params: { name: b.name } }" class="open">
          <div class="thumb">
            <img v-if="b.thumbnail" :src="b.thumbnail.url" :width="b.thumbnail.width"
                 :height="b.thumbnail.height" :alt="b.title" loading="lazy" decoding="async" />
            <span v-else class="nothumb">no preview</span>
          </div>
          <div class="text">
            <h2>{{ b.title }}</h2>
            <p class="facts">{{ boardFacts(b) }}</p>
          </div>
        </RouterLink>
        <!-- outside the card's link, so it downloads instead of opening the board -->
        <div class="foot">
          <RevisionBadge :rev="b.rev" :name="b.name" :diff="b.diff" variant="card" />
          <FabDownload v-if="b.download" :download="b.download" variant="card" />
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.home-page { padding: 20px; max-width: 1400px; margin: 0 auto; }
.empty, .description { color: var(--muted); }
.description { margin: 0 0 16px; }
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
}
.card {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color 0.15s;
}
.open { display: flex; flex-direction: column; flex: 1; outline: none; }
.card:has(.open:hover), .card:has(.open:focus-visible) { border-color: var(--accent); }
.thumb {
  aspect-ratio: 16 / 10;
  display: grid;
  place-items: center;
  background: var(--thumb-bg);
}
.thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
.nothumb { color: var(--muted); font-size: 12px; }
.text { padding: 10px 12px 12px; border-top: 1px solid var(--line); }
h2 { margin: 0 0 2px; font-size: 15px; font-weight: 600; }
.facts { margin: 0; color: var(--muted); font-size: 12px; }
.foot { padding: 0 12px 10px; margin-top: -4px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
/* [P2-d] narrow screens: a two-column card grid */
@media (max-width: 560px) {
  .home-page { padding: 12px; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .text { padding: 7px 8px 8px; }
  h2 { font-size: 13px; }
  .facts { font-size: 11px; }
  .foot { padding: 0 8px 8px; }
}
</style>
