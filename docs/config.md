# Configuration

`kiview.config.ts` (or `.mts`, `.js`, `.mjs`) in the project root:

```ts
import { defineConfig } from '@zdv/kiview'

export default defineConfig({
  title: 'My boards',
  boards: ['hardware'],            // dirs or globs, relative to the root
  maskColor: { Prototype: 'Black' },
  server: { host: true, port: 8080 },
})
```

The schema is `UserConfig` in `packages/vite-plugin/src/config.ts`; that file is the
reference. CLI flags (`--base`, `--out-dir`, `--cache-dir`, `--host`, `--port`,
`--kicad-cli`) override the file.

| key | default | status | |
| --- | --- | --- | --- |
| `title` | `'KiCad boards'` | phase 1 | top bar and page title |
| `description` | none | phase 1 | line on the home page |
| `logo` | none | phase 1 | URL, `data:` URI or an image path relative to the root |
| `theme.appearance` | `'dark'` | P2-d | `'dark'`, `'light'` or `'auto'` (follows the system); the default of the theme toggle, whose choice each browser remembers |
| `theme.accent`, `theme.vars` | none | phase 1 | CSS colour (both themes); raw CSS custom properties (override the tokens in `client/src/style.css`) |
| `boards` | `['.']` | phase 1 | a dir lists `<dir>/<Name>.kicad_pcb` and `<dir>/<Name>/<Name>.kicad_pcb`; a glob lists matching `.kicad_pcb` / `.kicad_pro` |
| `base` | `'/'` | phase 1 | public path, must start and end with `/` |
| `outDir` | `.kiview/dist` | phase 1 | |
| `cacheDir` | `.kiview/cache` | phase 1 | export cache, probe cache, Vite cache |
| `kicad.cli` | discovered | phase 1 | explicit kicad-cli; when set, the only native install used |
| `kicad.version` | `'auto'` | phase 1 | `"9"`, `">=8"`, `">=8 <10"` |
| `kicad.prefer` | `'newest'` | P2-a | `'newest'` or `'oldest'` of the installs that can open a file (see below) |
| `kicad.modelDir` | the install's | phase 1 | stock 3D model library |
| `kicad.backend` | `'auto'` | P2-a | force `'cli-modern'`, `'cli-7-8'`, `'pcbnew-python'` (KiCad's Python) or `'docker'` (images only) |
| `kicad.docker` | `{ enabled: false }` | P2-a | `{ enabled, image: 'kicad/kicad:{version}', versions: ['8.0', '9.0'] }`; without `versions`, the local `kicad/kicad` images (never pulled) |
| `env` | `{}` | phase 1 | extra KiCad path variables (and process env), e.g. `{ MYLIB_3D: '/libs/3d' }` |
| `maskColor` | the stackup's | phase 1 | string for all boards or `{ [board]: colour }` |
| `modelFormat` | `'vrml'` | phase 1 | or `'glb'` |
| `thumbnail` | `{ width: 640, height: 400 }` | phase 1 | or `false` |
| `margin` | `1` | phase 1 | mm around the outline in the layer viewBox |
| `concurrency` | `min(4, cores/2)` | phase 1 | KiCad processes at once |
| `fab` | `'generic'` | phase 1 (hook), P2-c (generic) | `false`, `'generic'`, a function, or `{ build, recipe }` |
| `revision` | `{ git: true, versionFile: 'VERSION', diff: false }` | P2-c | see below |
| `schematic.drawingSheet` | `true` | P2-b | draw the frame / title block on the schematic sheets |
| `schematic.theme` | the project's | P2-b | kicad-cli colour theme for the sheets |
| `bom.showDnp` | `false` | assembly | list DNP parts in the BOM table (own section); `true`, or `{ [board]: true }`. Off, DNP parts never appear in the BOM pane |
| `assembly.sideOrder` | `'back-first'` | assembly | `'back-first'` or `'front-first'`: which side the step list starts with |
| `assembly.notesFile` | `'ASSEMBLY.md'` | assembly | markdown file next to the board shown at the top of the Assembly tab; `false` for none |
| `assembly.notes` | none | assembly | markdown shown after the notes file |
| `assembly.refNotes` | `{}` | assembly | notes by refdes, shown on the part's step: `{ R1: '100 Ω on the bus master' }` |
| `assembly.order` | `[]` | assembly | refdes in the order their steps should come (within a side), before the default order |
| `assembly.variants` | `{}` | assembly | build variants: `{ master: { label, fit, dnp, values, note } }` (below) |
| `assembly.noteFields` | `['Assembly Note', 'Assembly Notes', 'Assembly']` | assembly | footprint / symbol fields read as per-part notes |
| `assembly.boards` | `{}` | assembly | per board name: any of the keys above except `noteFields`; a board's entry wins key by key (`refNotes` are merged) |
| `server.host/port/strictPort` | Vite's | phase 1 | dev and preview servers |
| `server.allowedHosts` | `true` (any host) | phase 1 | a list of host names restricts the dev and preview servers to them |

## Assembly mode

The board page's **Assembly** pane (`?pane=layers,assembly`) is a hand-assembly
checklist. It has no board view of its own: the current step's marks (pin 1 / cathode
/ + pad, placed parts, parts to leave empty) and a caption are drawn in the **Layers**
pane, which turns to the step's side; opening Assembly opens Layers along. It needs the board's part
data (the `crossProbe` feature: the parsed `.kicad_pcb`); the BOM, when there is a
schematic, gives the grouping, MPNs and fields, and the netlist gives the pin names used
for polarity.

- **Steps.** One per BOM line (value + footprint + fields) and side. Default order: the
  side order (`assembly.sideOrder`, bottom first unless configured), then `assembly.order`
  if given, then SMD before through-hole, then low and small parts before tall ones (a
  height class from the package: chip passives; small discretes, LEDs, DFN / QFN; ICs;
  tall SMD parts; through-hole passives; connectors; modules), then the package, the
  value and the first refdes. Mounting holes, fiducials and other pad-less footprints
  get no step; parts excluded from the BOM (not DNP) neither.
- **Each step** shows the value, package, footprint, MPN and maker, quantity, side
  (Top / Bottom), the refdes as large toggles, a polarity line and the part notes.
  Polarity: the cathode of diodes and LEDs (symbol pin `K`, else the other pin of `A`,
  else pad 1, KiCad's convention), the `+` pad of polarized capacitors, pin 1 of ICs,
  networks, transistors, modules and connectors; none for resistors and other plain
  two-terminal parts. The direction is the pad's direction from the part's centre in
  board coordinates (KiCad's top view, north up); for bottom parts the direction as seen
  from the bottom (east and west swapped) is added.
- **Highlighting.** Choosing a step selects its parts in the cross-probe store (the 3D
  markers, schematic and BOM follow), turns the 2D view to the step's side (that side's
  copper, mask, silkscreen and fab layers) and marks the pin-1 / cathode / `+` pad of
  each part (a magenta pad and dot); placed parts of the step get a green box. A part
  tapped in another view opens its step.
- **Progress.** Ticks per refdes or per step, stored in the browser (`localStorage`)
  per board, revision label and variant; a progress bar; Reset; Export / Import (a JSON
  file, checked against the board, revision and refdes) to move a session between
  devices. Keys: `J` / `↓` next step, `K` / `↑` previous, `Space` marks the step placed
  and moves to the next open one.
- **Leave empty.** DNP parts (as designed, or as the variant says) are listed only
  there, never as steps; "Show on board" marks them with red crossed boxes.
- **Print.** Print (or the browser's print) gives a paper checklist: notes, then one row
  per step with tick boxes per refdes, side, value, package, MPN, polarity and notes,
  then the leave-empty list.

Notes come from `ASSEMBLY.md` next to the board (`assembly.notesFile`) and
`assembly.notes`, rendered as markdown (headings, lists, bold / italic, code, links,
quotes; HTML is escaped). Per-part notes come from `assembly.refNotes` and from the
fields named in `assembly.noteFields` (e.g. a footprint or symbol field
"Assembly Note"), so a design can carry them, or the site config can when the design
should not be touched.

Variants describe builds of one design. `fit` lists DNP parts the variant fits (they get
steps), `dnp` fitted parts it leaves empty, `values` value overrides (that part gets its
own step and a note "Bus master: 100 (designed 330 (100 master))"), `note` a markdown
line shown under the picker. Each variant keeps its own progress.

```ts
assembly: {
  boards: {
    Prototype: {
      sideOrder: 'front-first',          // the board's notes: the LED face first
      order: ['D1', 'U1', 'RN1', 'R2', 'R1', 'R6', 'A1', 'J1', 'J3'],
      refNotes: {
        R1: '100 Ω on the bus master, 330 Ω on slaves',
        R6: '4.7 kΩ, fitted on the bus master only',
      },
      variants: {
        master: { label: 'Bus master', fit: ['R6'], values: { R1: '100', R6: '4k7' }, note: 'R1 = 100 Ω, R6 fitted.' },
        slave: { label: 'Slave', values: { R1: '330' }, note: 'R1 = 330 Ω, R6 empty.' },
      },
    },
  },
},
bom: { showDnp: false },   // the default: DNP parts stay out of the BOM table
```

## Generic fab bundle

`fab: 'generic'` (the default) builds `<Name>-fab-<rev>.zip` with kicad-cli, where `<rev>`
is the revision label (below):

| folder | contents |
| --- | --- |
| `gerbers/` | Gerber X2 for every copper layer, both masks, Edge.Cuts, and paste / silk when used; the `.gbrjob`; Excellon drill, PTH and NPTH separate; IPC-D-356 |
| `assembly/` | position CSVs (mm, one per side that has parts, DNP left out); BOM CSV from the schematic (grouped by value + footprint, DNP left out) |
| `docs/` | schematic PDF; drill maps (PDF) |
| `3d/` | the board as STEP (GLB when the KiCad cannot write STEP) |

Each item is recorded as produced, skipped (with the reason: no schematic, the
KiCad cannot do it) or failed; the download's file list shows them. The bundle is
*incomplete* when the Gerbers, the drill files or the board outline are missing.

## Revision

`Board.rev.label` is the first of: the `VERSION` file next to the board
(`revision.versionFile`, a semantic version; `false` to ignore), the exact git tag
of the last commit touching the project directory, the title-block rev, the short
content hash. With `revision.git` (default true) the board card and page also show
that commit and mark uncommitted changes. git is only read (`git -C <dir>`); a
project outside a repository just has no git info.

`revision.diff` (default off) compares each board with an earlier revision:

```ts
revision: { diff: true }            // 'previous': the version before the current one
revision: { diff: 'previous-tag' }  // the newest tag before the current version
revision: { diff: 'HEAD~1' }        // any git revision: a tag, a branch, a hash
```

The board files of that revision are taken with `git archive` into the cache (the
repository is never checked out), plotted, and compared layer by layer. The board
page links to a changes page: a summary (changed layers; parts added, removed or
moved once footprints are parsed) and, per changed layer, an overlay with added
geometry green and removed red, or a before / after blend. Results are cached per
board content and base commit.

## Custom fab hook

```ts
fab: {
  async build({ name, pcb, sch, pro, workDir, backend, hash, rev, log }) {   // rev: Board.rev (P2-c)
    // pcb / sch / pro are snapshot copies; write into workDir
    return { zip: `${workDir}/${name}.zip`, status: 'ok', contents: ['Gerbers', 'Drill'] }
  },
  recipe: () => 'my-tool-v3',   // part of the cache key; change it to rebuild bundles
},
```

Return a zip path, a `FabHookResult`, or `null` for no download. The zip is copied into
the cache; it is rebuilt when the board, schematic or project file changes, or when
`recipe()` returns something new (default: the hook's source text).

## Which KiCad exports a board

Every KiCad found (`kicad.cli`, `KICAD_CLI`, `KICAD_CLI_<ver>`, `/Applications/KiCad*`,
`/usr/bin`, Flatpak, Snap, `Program Files\KiCad\<ver>`, `PATH`, and with
`kicad.docker.enabled` the `kicad/kicad` images) is probed once (`kicad-cli --help` of
each command, cached per binary). For each board file:

1. its `(version YYYYMMDD)` gives the oldest KiCad that opens it (a KiCad 8 board needs 8+);
2. installs at or above it that match `kicad.version` qualify; kicad-cli installs come
   first, then KiCad's Python (KiCad 5 / 6 bundles, or the 3D model of KiCad 7), then
   Docker images;
3. `kicad.prefer` picks within each group: `'newest'` (default) exports with the most
   capable one (the richest features), `'oldest'` with the KiCad closest to the one
   that saved the file;
4. what the chosen KiCad cannot do comes from the next one that can (KiCad 7 / 8 have no
   `pcb render`: with KiCad 10 also installed, the card thumbnail is rendered by 10;
   with nothing else, the card shows a top view composed from the copper, mask and
   silkscreen plots).

When no install qualifies, the log says which KiCad version the file needs.

```ts
kicad: { prefer: 'oldest' }                                    // the oldest that opens the file
kicad: { version: '8' }                                        // only KiCad 8
kicad: { docker: { enabled: true, versions: ['8.0', '9.0'] } } // docker pull kicad/kicad:8.0 first
```
