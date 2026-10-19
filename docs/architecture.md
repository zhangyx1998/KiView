# Architecture

KiView turns a folder of KiCad projects into a static website, the way vitepress
turns Markdown into one. `kiview dev|build|preview [root]` runs Vite on the
bundled Vue client; a Vite plugin exports every project through a KiCad abstraction
layer into a content-addressed cache and hands the client metadata plus asset URLs.

```
packages/
  kicad/        @kiview/kicad        Node only, no Vite. KiCad abstraction layer.
    src/types.ts            CONTRACT: backends, capabilities, operation inputs/outputs
    src/select.ts           openKicad(): discover, probe, pick a backend per file
    src/installs.ts         install discovery (config, env, macOS bundles, Linux, Flatpak, Snap, Windows, PATH)
    src/probe.ts            `kicad-cli version` + `--help` parsing (and pcbnew / docker probes) -> Capabilities (cached)
    src/versions.ts         file (version YYYYMMDD) -> minimum KiCad major
    src/features.ts         feature -> required operations (graceful degradation)
    src/backends/           cli-modern, cli-7-8, pcbnew-python, docker (+ cli-ops.ts shared by cli-7-8 / docker)
  kicad/python/kwv_pcbnew.py  the pcbnew-python backend's script (runs under KiCad's Python, 2.7 / 3)
    src/board-file.ts       s-expression parser, readBoard() (layers, outline, title block, stackup)
    src/layers.ts svg.ts png.ts board-edit.ts process.ts   ported helpers
  vite-plugin/  @kiview/vite-plugin  discovery, stage pipeline, cache, dev watch, virtual modules
    src/contract.ts         CONTRACT: client data (Board, SiteData, virtual module names)
    src/config.ts           CONTRACT: config schema (UserConfig), defaults, resolveConfig()
    src/stages/types.ts     CONTRACT: the Stage interface (one export step per module)
    src/stages/*.ts         layers, model, thumbnail, fab (+ phase-2 stages)
    src/pipeline.ts         runs stages per board with caching and stale fallback
    src/board.ts            assembles the client Board from stage results
    src/discover.ts         boards: dirs and globs
    src/index.ts            the Vite plugin
  client/       @kiview/client       the Vue 3 app, shipped as source (Vite root)
  cli/          @kiview/cli          the bin, config loading, programmatic Vite
examples/boards/            sample projects (Blinky; Legacy7, Legacy8, FourLayer, Hierarchy from examples/scripts/)
tests/                      unit / contract tests (node --test, no KiCad needed); tests/contract/run.ts, the CI export check (docs/ci.md)
```

Dependency direction: `cli -> vite-plugin -> kicad`; the client imports **types only**
from `vite-plugin/contract` and `kicad/types`.

## 1. The KiCad layer (`packages/kicad/src/types.ts`)

```ts
interface KicadBackend {
  id: 'cli-modern' | 'cli-7-8' | 'pcbnew-python' | 'docker'
  install: KicadInstall; version: KicadVersion | null; capabilities: Capabilities
  boardInfo(pcb): Promise<BoardInfo>
  exportLayerSvgs(pcb, layers, { holes }, ctx): Promise<LayerSvgFile[]>
  export3d(pcb, { format, noDnp }, ctx): Promise<Model3dResult>
  renderThumbnail(pcb, { width, height, side }, ctx): Promise<ThumbnailResult>
  exportSchematicSvgs(sch, ctx): Promise<SchematicSheet[]>
  exportBom({ sch?, pcb? }, opts, ctx): Promise<BomRow[]>
  netlist(sch, ctx): Promise<Netlist>
  exportFab(pcb, { sch?, model? }, ctx): Promise<FabResult>
  drc(pcb, { sch? }, ctx) / erc(sch, ctx): Promise<CheckReport>
  stats(pcb, ctx): Promise<BoardStatsResult>
}
```

- All paths are absolute. Inputs are snapshots the caller owns; outputs go into
  `ctx.workDir`. `ctx.vars` are KiCad path variables (`-D NAME=value`): the pipeline
  passes `KIPRJMOD` (the real project dir, so `${KIPRJMOD}/...` models resolve) and
  the config's `env`; the backend adds `KICAD6..N_3DMODEL_DIR` from the install.
- **Capabilities** (`ops` per `Operation`, plus detail flags such as
  `layerSvg.multiFile`, `model3d.formats`, `thumbnail.render`) are derived from
  `kicad-cli version` and the parsed `--help` of every command path in `HELP_PATHS`
  (`probe.ts`; a path is read only when its parent lists it). Help facts are
  cached on disk per binary (path + size + mtime) in the cache dir. Help texts of
  7.0.0 ... 10.0.6 are test fixtures (`tests/fixtures/help/`). A backend then
  masks the probe with the operations it implements (`IMPLEMENTED` in
  `cli-modern.ts`): the cli-modern probe on KiCad 10 reports everything, but only
  boardInfo / layerSvg / model3d / thumbnail are on until phase 2 lands the rest.
- An unimplemented / unsupported operation throws `UnsupportedError`. Callers check
  `capabilities.ops` first.
- **Selection** (`select.ts`): the file's `(version YYYYMMDD)` gives the oldest KiCad
  that opens it (`versions.ts`, a table of *file formats*, not of features; a file
  opens in the first release whose format version is at or above its own). The
  usable installs at or above that major and matching `kicad.version` ("9", ">=8 <10")
  are ranked in tiers (kicad-cli installs, then pcbnew Python, then Docker images) and
  within a tier by `kicad.prefer` (`'newest'`, the default, or `'oldest'`). The first
  one is the backend; operations it lacks go to the next one that has them
  (`FallbackBackend`: with `prefer: 'oldest'` a KiCad 8 board is plotted by KiCad 8 and rendered by KiCad 10).
  The backend id comes from the probe (`backendForCaps`: multi-file SVG -> cli-modern,
  SVG -> cli-7-8, no kicad-cli -> pcbnew-python, image -> docker) or `kicad.backend`.
  No fit: `backendFor()` is null and `explain()` names the KiCad version needed.
- **Features** (`features.ts`): each UI feature lists required operations and project
  files; `featureBlocker()` gives the reason a feature is unavailable.

`BoardInfo` carries `formatVersion`, `minKicad`, `titleBlock`, `layers`,
`usedLayers`, `outline`, `stackup` (mask / silk colours, finish, thickness, copper
count) and `footprints` (empty until P2-b). `Footprint` has ref, value, footprint id,
side, position, rotation, bbox, pads (number, type, shape, position, size, drill,
layers, net), fields, DNP / exclude flags and the schematic symbol path, which is what
cross-probing joins on (BOM refs <-> footprints <-> schematic symbols).

## 2. The stage pipeline (`packages/vite-plugin/src/stages/types.ts`)

Each export step is a `Stage`: `{ name, version, inputs, provides, late?, skip(),
recipe(), run(ctx), apply(board, result, url) }`, one module per stage, registered in
`stages/index.ts`. A stage:

- runs only when `skip()` returns null (else its features show the reason);
- is keyed by `sha256(name, version, recipe, backend id + KiCad version, content of
  its input files)`; the result lives in `<cacheDir>/<Name>/<stage>/<key>/` (its files
  plus `stage.json`), written atomically (work dir, then rename) and served as
  immutable `<base>board-assets/<Name>/<stage>/<key>/<file>`;
- runs concurrently with the other stages of the board; every backend call goes
  through the shared semaphore (`concurrency` KiCad processes at once);
- on failure falls back to the newest earlier result of that stage (stale) and logs.

Changing one setting only re-runs the stages whose recipe includes it (e.g. a
`maskColor` change re-runs model and thumbnail, not layers). Core stages (layers,
model, thumbnail) hold back the board; **late** stages (fab) do not: a build waits
for them, the dev server pushes the updated board when they finish. All stages of one
refresh read the same snapshot of the project files (`ctx.snapshot()`), so a file
being rewritten cannot mix two versions.

A board is listed when its layers or model stage has a result. The status of every
stage is at `<base>__kiview.json` in dev.

## 3. The client data contract (`packages/vite-plugin/src/contract.ts`)

```ts
import { boards } from 'virtual:kiview/boards'   // Board[], sorted by name
import { site } from 'virtual:kiview/site'       // SiteData (title, logo, theme, kicad)
```

`Board` keeps every field of the MirrorLinkPCB viewer (`name`, `title`, `model`,
`layers`, `bounds`, `size`, `thumbnail`, `copperLayers`, `revision`, `download`) and adds:

| field | filled by | |
| --- | --- | --- |
| `maskColor`, `titleBlock`, `kicad`, `files` | phase 1 | stackup colour (or override), title block, format version / exporting KiCad / backend, project file paths |
| `features: Record<FeatureId, FeatureStatus>` | phase 1 | `{ available: true }` or `{ available: false, reason }`; the UI hides what is unavailable |
| `rev: BoardRevision` | phase 1 (hash, title-block rev, label), **P2-c** (VERSION file, git) | |
| `download?: BoardDownload` | phase 1 (custom hook), **P2-c** (generic) | `status: 'ok' \| 'incomplete'`, `missing`, `contents` |
| `schematic: { sheets: SchematicSheetRef[] }` | **P2-b** | per-sheet SVG URL, path / parent hierarchy, symbol boxes |
| `bom`, `parts`, `netlist: AssetRef` | **P2-b** | lazily fetched JSON: `BomData`, `PartsData` (footprints), `NetlistData` |
| `stats: BoardStats` | **P2-d** | |
| `reports: { drc, erc }` | **P2-d** | `ReportSummary` with counts and a `CheckReport` JSON URL |

Until a phase-2 stage exists, its fields are `null` and its features say
"not implemented yet" (or why the backend cannot do it).

Dev updates: core stage changes invalidate the module and full-reload the page;
late stage results arrive as the HMR event `kiview:board` (`BoardEvent`),
applied by the reactive store `client/src/boards.ts`.

### Layer SVGs (unchanged from the source viewer)

Every layer of a board has the same viewBox (`bounds`: Edge.Cuts outline plus
`margin`, KiCad board coordinates, mm, y down) and `width`/`height` in mm, so layers
overlay exactly. Geometry uses `currentColor`; the root has
`style="color: var(--layer-color, <suggested colour>)"`. Drill holes are real
cut-outs: the drawing is a `<g mask="url(#holes-<Board>-<Layer>)">`. Holes are found
by diffing a plot with drill shapes against one without (`kicad/src/svg.ts`).
Order bottom to top: back courtyard, fab, silk, paste, mask, B.Cu, inner copper,
F.Cu, front mask, paste, silk, fab, courtyard, edge cuts, other layers.

### 3D model

VRML by default (`kicad-cli pcb export vrml --units mm --no-dnp`): it carries every part
including VRML-only models; GLB is built from STEP models only and drops VRML-only
parts, but names nodes by refdes (useful for 3D cross-probing, P2-b). VRML units are
mm, Z up, origin at the centre of the outline: `x = kx - cx`, `y = -(ky - cy)` with
`c` the centre of `bounds`. The mask colour is the stackup's unless `maskColor`
overrides it (written into a copy of the board).

## 4. The config schema (`packages/vite-plugin/src/config.ts`)

See [config.md](config.md). `defineConfig` is re-exported by `@zdv/kiview`. The CLI
loads `kiview.config.{ts,mts,js,mjs}` through Vite's config loader, merges CLI
flags over it and passes the resolved config to the plugin.

## 5. CLI and Vite

The client package is the Vite root (`root = @kiview/client`), the user's
folder is only read by the plugin. Vite's own cache goes to `<cacheDir>/.vite`, the
build to `outDir`, `server.fs.allow` covers the client, the cache and the project
root. Routes are real paths (`/` and `/board/<name>`); static hosts need one rewrite
to `index.html` (`public/_redirects` ships it for Cloudflare / Netlify). The build
also writes `_headers` so fab zips download under their own name.

## Phase-2 work, by owner

The markers `[P2-a]` ... `[P2-e]` in the sources point at each placeholder.

- **(a) Backends, probing, docker, version selection**: `kicad/src/backends/{cli-7-8,pcbnew-python,docker}.ts`,
  `kicad/src/{probe,installs,select,versions}.ts`, new `kicad/python/`. Thumbnail
  fallback (copper SVG) in `vite-plugin/src/stages/thumbnail.ts`.
- **(b) Schematic, BOM, cross-probing**: `cli-modern.ts` (`exportSchematicSvgs`, `exportBom`,
  `netlist` + add to `IMPLEMENTED`), footprints in `kicad/src/board-file.ts` (new
  `footprints.ts`), new stages `vite-plugin/src/stages/{schematic,bom,parts,netlist}.ts`,
  client `src/schematic/`, `src/bom/`, a cross-probe store, highlight hooks in
  `LayerBrowser.vue` / `BoardView3D.vue`, routes in `router.ts`.
- **(c) Fab and revision / diff**: `cli-modern.ts` `exportFab` (+ a zip writer in
  `kicad/src/zip.ts`), `vite-plugin/src/stages/fab.ts`, new `stages/revision.ts`
  (VERSION, git), layer diff between commits, client `FabDownload.vue`, a diff view.
- **(d) Stats, net highlight, measure, DRC/ERC pages, deep links, mobile, themes**:
  `cli-modern.ts` `drc` / `erc` / `stats`, new stages `stats.ts`, `drc.ts`, `erc.ts`,
  client pages and layer-browser tools, `style.css` light theme, `site.ts`.
- **(e) CI and samples**: `.github/workflows/`, `tests/`, more `examples/`.

Shared files every stream may touch (keep edits to one line or one block):
`packages/vite-plugin/src/stages/index.ts` (register a stage),
`packages/kicad/src/backends/cli-modern.ts` (one method each + `IMPLEMENTED`),
`packages/client/src/router.ts`, `packages/client/src/pages/BoardPage.vue` (pane list).
Changes to the three contract files go through this document.

## Changes by P2-c

All additive; nothing existing changed shape.

- `kicad/src/types.ts`: `FabOptions.zipName?`; new `FabItemId`, `FabItem`; `FabResult.items: FabItem[]`
  (every deliverable with `status: 'ok' | 'skipped' | 'failed'`, `reason`, `required`, files in the zip).
- `kicad/src/index.ts` exports `zipBuffer`, `writeZip`, `listZip` (`kicad/src/zip.ts`, deterministic:
  sorted entries, 1980-01-01 timestamps, 0644, deflate level 9 or store) and `gerberLayers`.
- `vite-plugin/src/contract.ts`: `BoardDownload.items?: FabItem[]`; `BoardRevision.git.describe?`,
  `.subject?`; new `LayerDiff`, `PartsDiff`, `BoardDiff`; `Board.diff?: BoardDiff | null`.
- `vite-plugin/src/config.ts`: `revision.diff?: boolean | string` (resolved `string | null`,
  `true` = `'previous'`); `FabHookContext.rev?: BoardRevision`.

Implementation: `cli-modern.exportFab` delegates to `backends/fab-cli.ts`; stages
`revision` (core, no files: its recipe *is* the resolved revision, so a new commit or
VERSION re-keys it) and `diff` (late, keyed by board content + base commit) in
`vite-plugin/src/stages/`; read-only git helpers in `vite-plugin/src/git.ts`
(`GIT_OPTIONAL_LOCKS=0`, `git archive | tar` into the stage's scratch dir). The fab
stage names generic zips `<Name>-fab-<rev label>.zip`. Client: `RevisionBadge.vue`
(card and board page), `FabDownload.vue` file list, `pages/DiffPage.vue` at
`/board/<name>/diff` (canvas overlay: added green, removed red, unchanged grey).

## Changes by P2-d (stats, DRC / ERC, layer tools, deep links, themes)

Contract changes (all additive):

- `kicad/src/types.ts`
  - `BoardStatsResult`: new optional fields `layerCount`, `area`, `parts` (by side and
    SMD / THT / other), `padTypes`, `tracks` (count, length, widths), `viaSizes`,
    `drills`, `minAnnularRing`, `rules` (design-rule minimums from the `.kicad_pro`),
    `stackup` (the `Stackup` summary plus `layers: StackupLayer[]`), `source`.
  - New `StackupLayer`, `GeometryPad`, `BoardGeometry` (copper by net: tracks with
    arcs flattened, vias, pads, zone outlines; nets as indices into `nets`).
- `vite-plugin/src/contract.ts`
  - `Board.geometry?: AssetRef | null`: the `GeometryData` (= `BoardGeometry`) JSON,
    filled by the stats stage. Optional, so nothing else has to set it.
  - `GeometryData` type; `BoardGeometry` re-exported.
- `stages/types.ts`, `config.ts`: unchanged (`theme.appearance` already had
  `'light' | 'auto'`; they now work).

Backend (`cli-modern.ts`, `drc` / `erc` / `stats` added to `IMPLEMENTED`):

- `drc(pcb, { sch })`: `pcb drc --format json --units mm --severity-all`, plus
  `--schematic-parity` when the schematic exists. `erc(sch)`: `sch erc --format json`.
  Both parse into `CheckReport` (`kicad/src/checks.ts`). kicad-cli 10.0.6 writes ERC
  positions in units of 100 mm despite `"coordinate_units": "mm"`; the parser scales
  them when every position is within 10 units (no sheet is that small).
- `stats(pcb)`: `kicad/src/stats.ts` parses the board (and the `.kicad_pro` next to
  it), then `pcb export stats --format json` adds the measured minimum clearance, the
  area and kicad-cli's numbers for size / thickness / minimum track and drill. A failed
  kicad-cli run falls back to the file numbers with a warning.
- `kicad/src/geometry.ts`: copper geometry by net. Pads come from
  `BoardInfo.footprints` when a backend fills them (P2-b); otherwise its own small
  pad walk (absolute position, rotation, net, wildcard layers expanded) is used.

Stages (all late; registered in `stages/index.ts`):

- `stats` (feature `stats`): `Board.stats` and `geometry.json` (`Board.geometry`).
  Runs without a KiCad that has `pcb export stats` (file numbers only).
- `drc` (feature `drc`), `erc` (feature `erc`): `drc.json` / `erc.json`
  (`CheckReport`) and `Board.reports.{drc,erc}` (`ReportSummary`). They run on a
  private copy of the project that also carries `<Name>.kicad_dru`, `fp-lib-table`
  and `sym-lib-table` (`stages/project-copy.ts`); those files' hashes are in the
  recipe.

Client:

- Board facts in the board page sidebar (`components/BoardInfo.vue`): checks summary
  linking to the reports, size, layers, stackup, parts, pads, vias, holes, tracks,
  minimums (used vs. rule), drill table, stackup table.
- Report pages `/board/<Name>/drc` and `/board/<Name>/erc` (`pages/ReportPage.vue`):
  severity counts as filters, sections (violations, unconnected, schematic parity)
  grouped by type, items with positions. For DRC the layer view sits beside the list;
  clicking an item pans it there and marks it, the arrow opens the board page at that
  spot.
- Layer-browser tools (`layers/LayerTools.vue`, `hitTest.ts`, `bus.ts`): net highlight
  (click pad / via / track / zone; "net highlight unavailable: <reason>" without
  geometry), measure (distance, dx / dy, angle; snaps to pad and via centres), and the
  focus event `focusLayerView({ board, x, y, zoom?, label? })` other parts may call.
- Deep links (`deepLink.ts`, `linkState.ts`, `layers/link.ts`): query parameters
  `pane`, `preset` | `layers`, `side`, `view` (centre mm + zoom relative to fit),
  `cam` (3D target, quaternion, height, fov), `net`, `at`. The board page keeps the
  URL current (history replace, debounced); the copy-link button copies it. The hash
  is left alone (P2-b's `#part=`).
- Themes: light / dark / auto tokens in `style.css` keyed on
  `<html data-theme>`, set by `site.ts` from the config and the theme toggle in the
  top bar. Layer colours are adjusted per theme to a 3:1 contrast with the canvas
  (`layers/colors.ts`).
- Mobile: the board sidebar is a drawer with a scrim on narrow screens, the top bar
  drops the board title and squeezes the site title on phones, the home page shows
  two card columns under 560 px, the report page stacks list and layer view. Touch
  pan / pinch were already in the 2D (`panZoom.ts`) and 3D (OrbitControls) views; the
  tools only act on taps, so gestures keep working.

Shared-file edits: `stages/index.ts` (one block), `cli-modern.ts` (`IMPLEMENTED` and
the three methods), `router.ts` (one route), `BoardPage.vue` (imports, one
`useBoardLink` line, `CopyLink` / `BoardInfo` / scrim in the template, sidebar width
and drawer CSS), `LayerBrowser.vue` (imports, `useLayerLink` line, `LayerTools` and
themed colour in the template), `BoardView3D.vue` (camera to / from the link),
`viewer3d/viewer.ts` (`onRender`, `userPose`, `setUserPose`), `App.vue` (theme toggle,
phone top bar), `HomePage.vue` (root class renamed to `home-page`: App's scoped
`.home` leaked onto it; two-column grid). Hard-coded surface colours in the existing
components became tokens.

## Changes by P2-b

Schematic, BOM, netlist and cross-probing. All contract changes are additive.

**Contract changes**

- `kicad/src/types.ts`:
  - `SchematicSheet.symbolBox?: Rect | null` gives the box of a sheet's symbol on its parent sheet, in parent sheet mm, for click-to-open. It is null for the root.
  - New `SchematicSvgOptions { drawingSheet?, theme? }`, and `KicadBackend.exportSchematicSvgs(sch, ctx, opts?)` takes it as a third, optional argument.
- `vite-plugin/src/contract.ts`: `PartsData.thickness?: number | null` is the board thickness for the 3D markers.
- `vite-plugin/src/config.ts`: `schematic?: { drawingSheet?: boolean; theme?: string }`, resolved to `{ drawingSheet: true, theme: null }`. See config.md.

**KiCad layer**

- `footprints.ts` holds `readFootprints()`; `readBoard()` now fills `BoardInfo.footprints`. Each footprint has:
  - ref, value, lib id, side, position and rotation;
  - a box: the courtyard, else the pads plus fab and silk graphics;
  - pads with absolute position, rotation, size, drill, expanded layer wildcards and net. KiCad 10 writes `(net "name")` and older versions `(net n "name")`; nets without a code are numbered by first use.
  - fields, the DNP and exclude flags, and the symbol `path`.

  It handles the `module` and `fp_text` forms of KiCad 5 to 7.
- `schematic.ts` holds `readSchematicTree()`:
  - It returns one record per sheet instance. Paths have the form `/`, `/<uuid>/` and so on, without the root uuid, the same form as netlist `tstamps` and footprint `path`.
  - Page numbers come from the sheet `instances`, or from the root `sheet_instances` for KiCad 6.
  - Sheet files resolve relative to the referencing file, then to the root dir.
  - Each placed symbol gets a box built from the library graphics and pins of its unit and body style, through KiCad's symbol TRANSFORM: lib Y is up, rotation is counter-clockwise, and mirror is applied after rotation.
    - The transform is checked against the pin points of every rotated or mirrored symbol in the MirrorLinkPCB boards and the KiCad templates: 263 of 263 land on a wire, label or pin.
    - The `symbolTransform` test pins the convention.

  `schematicFileSet()` lists every reachable sheet file, sub-directories included.
- `netlist.ts` holds `parseNetlist()` for the kicadsexpr netlist.
  - It gives components with all fields, the `dnp`, `exclude_from_bom` and `exclude_from_board` flags and the symbol path, plus nets with their nodes.
  - `groupBom()` groups by value, footprint, DNP and exclude flags, and every field except Description. Grouping is lossless, so the client derives the per-part view.
- `backends/cli-sch.ts` is shared by the kicad-cli backends:
  - `sch export svg`: one call for all sheets. Files are matched to sheets by kicad-cli's naming, `<root>-<name>-<name>.svg` with `/` replaced by `_`, then by page order.
  - `sch export netlist --format kicadsexpr`: the single source for both BOM and nets. It needs no field names up front.
  - `exportBom({ pcb })` without a schematic builds the BOM from the footprints.
- `cli-modern` now implements `schematicSvg`, `bom` and `netlist` (`IMPLEMENTED`).

**Stages** (`vite-plugin/src/stages/`)

| stage | inputs | provides | late | assets |
| --- | --- | --- | --- | --- |
| `schematic` | sch, pro | schematic | yes | `sheet-<n>.svg`, `sheets.json`; the tree goes inline into `Board.schematic` |
| `bom` | sch, pcb | bom | yes | `bom.json` (`BomData`, grouped rows plus field columns in display order) |
| `parts` | pcb | crossProbe | no (no KiCad call) | `parts.json` (`PartsData`) |
| `netlist` | sch | netlist | yes | `netlist.json` (`NetlistData`) |

`pipeline.ts` `schematicFiles()` adds every sheet file the hierarchy references, also in sub-directories, to the snapshot and the cache key. Sheet files outside the project dir are logged and left out. The dev watcher re-exports a board when a `.kicad_sch` below its dir changes.

**Client**

- `crossprobe/store.ts` is the selection: board, refs and source. It is mirrored to `#part=R5` (several refs: `#part=C1,C2`) with `replaceState`, and other hash keys are kept.
- `crossprobe/data.ts` fetches the JSON assets lazily and caches them per URL. `partAt()` hit-tests a point, preferring the viewed side.
- Cross-probing in each view:
  - **2D** (`crossprobe/layers.ts`, mounted by `LayerBrowser.vue`): the selected parts' box and pad outlines are drawn over the stack, with a dashed outline under the cursor. A tap selects a part. A selection made elsewhere is centred when it is out of view.
  - **3D** (`crossprobe/view3d.ts`, `highlight3d.ts`, `Viewer.setOverlay()`): the VRML is merged into a few meshes per material in a worker, so part meshes cannot be matched to refdes. Each selected part instead gets a translucent box over its footprint box, on its board face (z = ±thickness / 2; the model is centred on the outline).
  - **Schematic** (`schematic/SchematicView.vue`): the kicad-cli SVG has no per-symbol grouping, so it is not searched. The pane overlays the symbol boxes from the sheet tree, which use the same sheet mm as the SVG.
    - A tap selects a part, and a tap on a sheet symbol opens that sheet.
    - The pane has a sheet tree, breadcrumbs and the layer browser's pan and zoom.
    - A part selected elsewhere opens its sheet and is centred.
- `bom/BomTable.vue` has grouped and per-part views, column sort, a search over refdes, value and MPN, and separate "Do not populate" and "Not in BOM" sections. A ref chip selects one part and a line selects the whole group.
- `BoardPage.vue`: the second pane is a tab list (Layers, Schematic, BOM). A tab is shown only when `board.features` allows it. (Superseded: see "Peer panes" below.)

## Integration of P2-b, P2-c and P2-d

- Layer-browser taps: exactly one tool acts on a tap (`LayerTool` in `layers/bus.ts`,
  owned by `LayerBrowser.vue`, `v-model:tool` on `LayerTools.vue`). "Select" (S) is
  the default when the board has part data (`features.crossProbe`): a tap selects the
  part under it and the hover outline shows what it would pick. "Net" (N) and
  "Measure" (M) take the taps while chosen; part selection and hover are off then.
  Without part data the default is "Net", as before.
- Deep links: the query keeps the view (P2-d), the hash keeps the selection
  (`#part=`, P2-b). The board page's URL writer passes the live `location.hash`,
  since the cross-probe store writes it with `history.replaceState`. New query
  parameter `tab` (`schematic`, `bom`; `layers` is the default) for the second
  pane's tab.
- Copper geometry (`geometry.json`) takes its pads from `BoardInfo.footprints` now
  that `boardInfo` parses them. `kicad/src/index.ts` exports P2-b's
  `expandLayers(names, layerTable)`; P2-d's copper-only variant is exported as
  `expandCopperLayers`.

## Changes by P2-a

Contract (`packages/kicad/src/types.ts`), additive only:

- `KicadOptions.prefer?: 'oldest' | 'newest'`: which of the installs that open a file
  is used (default `'newest'`, the richest features, as in phase 1; integration
  changed P2-a's `'oldest'`).
- `KicadToolkit.explain?(formatVersion, kind?)`: one line saying why `backendFor()` is
  null ("the file (format 20260206) needs KiCad 10 or newer; found KiCad 9.0.7 (...)").
  `pipeline.ts` uses it in its "no KiCad install can open" warning.
- Doc comments of `KicadOptions.version` and `docker` updated (defaults stated).

Behaviour changes:

- `minKicadFor` maps a format version to the first release whose version is >= it
  (was: the last release whose version is <= it). Same result for release files;
  nightly files between two releases now map to the later one. The table was checked
  against the sources of every 5.0 ... 10.0.6 tag (comment in `versions.ts`).
- `kicad.cli` set means only that native install is used (it used to be one of many
  and could lose to a newer one).
- The thumbnail stage (`t2`) falls back to a layer composite (`thumbnail.svg`, a top
  view in the stackup colours) when the backend has no `pcb render` or the render
  fails; `Board.thumbnail` may now point at an SVG.
- `@kiview/kicad` ships `python/` (package `files`).

Backends: `cli-7-8` (per-layer SVG, vrml / glb / step by probed flags, no render),
`pcbnew-python` (layer SVG, VRML when its self-test passes, fab zip of Gerbers / drill /
position file marked incomplete), `docker` (kicad-cli in `kicad/kicad:<ver>`, read-only
and read-write bind mounts at `/kwv/r<i>`, `/kwv/w<i>`, paths mapped both ways). The
three implement boardInfo / layerSvg / model3d / thumbnail (pcbnew-python: fab instead
of thumbnail); the other operations throw `UnsupportedError` and report false.
Integration: `cli-7-8` and `docker` also implement schematicSvg, netlist and bom
(`sch export svg` / `sch export netlist`, KiCad 7+; the BOM comes from the netlist,
`withNetlistBom`), drc / erc (`--format json`, KiCad 8+) and stats (the file's numbers,
plus `pcb export stats` on 10+) through `cli-ops.ts`, each on only where the probed
help lists the command and passing only the flags it lists. fab stays cli-modern's.

## Changes by assembly mode

All contract changes are additive.

**Contract**

- `vite-plugin/src/contract.ts`:
  - `Board.assembly?: BoardAssembly | null`: `sideOrder` (`['back', 'front']` or the reverse),
    `notes` (`{ source, markdown }[]`: the notes file, then the config's), `refNotes`,
    `noteFields`, `order` (refdes), `variants` (`AssemblyVariantInfo`: `id`, `label`, `fit`,
    `dnp`, `values`, `note`).
  - `Board.bomOptions?: { showDnp: boolean }` (config `bom.showDnp`).
- `vite-plugin/src/config.ts`: `UserConfig.bom?: { showDnp }`, `UserConfig.assembly?`
  (`AssemblyBoardConfig` plus `noteFields` and `boards`), `AssemblyVariant`,
  `AssemblySideOrder`; resolved as `bom.showDnp(board)` and `assembly(board)`
  (`ResolvedAssembly`). See config.md.
- `tests/contract/schema.ts` validates both fields; the runner checks that every board
  has them and that the Blinky sample's `ASSEMBLY.md` is read.

**Server.** Stage `assembly` (`stages/assembly.ts`, core, no KiCad call, no files): the
board's resolved settings plus the notes file's text are its recipe, so editing either
re-keys it; `apply` sets `Board.assembly`. `board.ts` sets `bomOptions`. The dev watcher
treats `ASSEMBLY.md` (and a configured `notesFile` name) in a board's directory like a
project file (`isProjectFile(file, extra)`).

**Client** (`client/src/assembly/`)

- `model.ts`: `buildPlan()` (steps from the BOM lines or, without a BOM, footprints
  grouped by value + footprint; split by side and by variant value; the leave-empty
  list; part notes), `sortSteps()`, `packageOf()`, `heightClass()`, `mountOf()`.
- `polarity.ts`: `detectPolarity(footprint, pins)` (cathode / `+` / pin 1, from the pad's
  or the netlist's pin function and type, else pad 1), `compass()`, `mirrored()`.
- `progress.ts`: storage key `kiview.assembly:<board>@<rev label>[#<variant>]`,
  the progress file (`kind: 'kiview-assembly'`, `version: 1`) and its checks.
- `markdown.ts`: the escaped markdown subset for notes.
- `AssemblyPane.vue`: the checklist pane. It has no board view of its own: while shown
  it writes the current step's marks, a caption and the side to show into `view.ts`
  (`asmView`), and the board's Layers pane draws them (`AssemblyMarks.vue` over the
  stack, the caption under the board; a side request turns the view to that side's
  preset plus its fab layer). Hidden (zero width) or unmounted, it clears them. The
  printable checklist is teleported to `<body>` while the pane is shown; its
  `@media print` rules hide the app.
- `crossprobe/store.ts`: `ProbeSource` adds `'assembly'`.
- `BoardPage.vue`: one pane entry (`assembly`, shown with `features.crossProbe`).
- `bom/BomTable.vue`: DNP lines are left out of the table, the counts and the search
  unless `board.bomOptions.showDnp` (`bom/model.ts` `visibleRows`).

## Peer panes

- `BoardPage.vue`: 3D, Layers, Schematic, BOM and Assembly are peers. Any of them can be
  open at once, side by side (stacked on narrow screens), in that order; a pane is
  listed only when `board.features` allows it, and at least one stays open. Opening
  Assembly opens Layers along, where its marks are drawn.
- Wide screens: one toggle button per pane in the top bar, a × on each pane header.
  Phones (≤ 820 px): the board-list button and the pane toggles fold into one burger
  menu (Boards…, then a checkbox per pane), fixed under the button because the top bar
  clips overflow.
- A pane is mounted the first time it is shown and only hidden (`v-show`) when closed,
  so it keeps its view; the assembly pane reads zero width as "not shown".
- Splitters sit between neighbouring open panes; each pane's size is a flex weight
  (`viewer.weights` in localStorage), dragged or nudged with the arrow keys, at least
  120 px.
- State: `viewer.panes` in localStorage (the old `viewer.mode` / `viewer.tab` are read
  once). Deep link `?pane=3d,layers,bom`; old links (`?pane=split&tab=bom`,
  `?pane=layers`, `?tab=assembly`) still open the same view (`parsePanes`), and `tab`
  is no longer written. `useBoardLink` (`linkState.ts`) takes the open panes as a getter
  and a callback for the linked `pane` / `tab`.
