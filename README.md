# KiView

Turn a folder of KiCad projects into a static website: one card per board, and per
board a 3D viewer, a layer browser, the schematic, the BOM with cross-probing, assembly
steps and fab downloads, opened side by side as panes
([docs/architecture.md](docs/architecture.md)). It works like vitepress: a dev server
that re-exports a board when its files change, and a static build for any static host.

```sh
npx @zdv/kiview dev path/to/projects      # dev server
npx @zdv/kiview build path/to/projects    # static site in path/to/projects/.kiview/dist
npx @zdv/kiview preview path/to/projects
```

Every `<Name>/<Name>.kicad_pcb` (and `<Name>.kicad_pcb`) under the folder becomes a
board; configure it with `kiview.config.ts` ([docs/config.md](docs/config.md)). A folder
with one board is a single-board site: the root URL is the viewer, with no home page
(`single: false` keeps the card page; `single: 'Name'` picks one of several).

## Requirements

- Node 22.14+ (developed on Node 26, npm 11).
- KiCad 7 to 10 with `kicad-cli` (found in `/Applications/KiCad*`, `/usr/bin`, Flatpak,
  Snap, `Program Files\KiCad\<ver>`, on `PATH`, or via `KICAD_CLI` / `KICAD_CLI_<ver>` /
  `kicad.cli`); KiCad 9+ for every feature (7 / 8 have no `pcb render`, 7 no VRML).
  KiCad 5 / 6 work through KiCad's Python (layers, fab files), and `kicad/kicad` Docker
  images with `kicad.docker.enabled`. Which install exports a board: [docs/config.md](docs/config.md#which-kicad-exports-a-board).
- The stock 3D model library of that install (found automatically for the macOS
  bundle and `/usr/share/kicad/3dmodels`; `kicad.modelDir` overrides).

## Repository layout

| package | |
| --- | --- |
| `packages/kicad` (`@kiview/kicad`) | KiCad abstraction layer: backends, probing, install selection, board-file parser |
| `packages/vite-plugin` (`@kiview/vite-plugin`) | discovery, stage pipeline and cache, dev watching, virtual modules |
| `packages/client` (`@kiview/client`) | the Vue 3 app (shipped as source) |
| `packages/cli` (`@kiview/cli`) | the `kiview` command and `defineConfig`; published, with the other three bundled in, as `@zdv/kiview` |
| `examples/boards` | sample projects: Blinky (KiCad 10), Legacy7 / Legacy8 (KiCad 7 / 8 formats), FourLayer (4 layers, planes), Hierarchy (3-level, sheets in a sub-directory) |
| `examples/scripts` | the generator of the samples other than Blinky |
| `tests/` | unit tests without KiCad, and the contract runner the CI export matrix uses |
| `docs/` | architecture and contracts, config reference, CI and releases (a `v*` tag publishes to npm with provenance, [docs/ci.md](docs/ci.md#release)) |

## Supported KiCad versions

CI exports every sample in the official `kicad/kicad` Docker images and checks the
result against the contract ([docs/ci.md](docs/ci.md)):

| KiCad | image | backend | exported today |
| --- | --- | --- | --- |
| 7.0 | `kicad/kicad:7.0` | `cli-7-8` | boards are opened and selected; exports land with phase 2 (P2-a) |
| 8.0 | `kicad/kicad:8.0` | `cli-7-8` | as 7.0 |
| 9.0 | `kicad/kicad:9.0-full` | `cli-modern` | layers, 3D model, thumbnail |
| 10.0 | `kicad/kicad:10.0-full` | `cli-modern` | layers, 3D model, thumbnail |
| nightly | `kicad/kicad:nightly-full` | `cli-modern` | as 10.0; allowed to fail |

A board needs a KiCad at least as new as the version that wrote it (Legacy7 opens in
all five, Blinky only in 10.0 and nightly); with several installs the newest one that
can open the file is used. Features a version cannot provide are listed as unavailable
with the reason, and the UI hides them.

## Development

```sh
npm install
npm run build          # tsc -b (packages/*/dist), then the npm package in dist/
npm run typecheck      # tsc -b and vue-tsc on the client
npm test               # unit and contract tests (node --test, no KiCad needed)
npm run contract       # build examples/boards with the local KiCad and check the output
npm run samples        # regenerate the sample projects and run DRC / ERC on them

npm run example:build  # = node packages/cli/bin/kiview.js build examples/boards
npm run example:dev    # dev server on the example

# against another folder, keeping cache and output out of it (read-only use):
node packages/cli/bin/kiview.js build /path/to/boards \
  --out-dir /tmp/kwv/dist --cache-dir /tmp/kwv/cache
node packages/cli/bin/kiview.js dev /path/to/boards --cache-dir /tmp/kwv/cache --port 5391
```

The CLI runs from `packages/*/dist/`, so run `npm run build` (or just `tsc -b`) after
changing a Node package (the client needs no build step).

**The npm package** is `dist/`, not the repository root: the root `package.json` holds
the package metadata and is private, like every workspace. `npm run build` bundles the
workspaces' compiled output into `dist/lib/` with rollup (`rollup.config.ts`) and
`scripts/dist-package.ts` writes `dist/package.json` from the root one (the runtime
dependencies are the workspaces' own), with the README, LICENSE, the client sources
(`dist/client/`, built by Vite on the user's machine) and the pcbnew helper
(`dist/python/`). Every workspace carries the root version; the build fails otherwise.
`npm pack ./dist` makes the tarball. In dev, `/__kiview.json` shows the KiCad installs,
the manifest, and every board's stage status.

Verified for phase 1 (macOS, KiCad 10.0.6, Node 26): `build` of `examples/boards` and of
a folder of six real 2-layer boards (cold about 17 s at concurrency 4, warm about 1 s;
layer SVGs byte-identical to the viewer this was ported from), `dev` serving the
viewer with re-export and reload on a board edit, a config file with a custom fab
hook and a mask override, `npm run typecheck`, `npm test`.

## License

MIT for the code. The example design files are CC0 (see the README.md of each sample in `examples/boards/`).
