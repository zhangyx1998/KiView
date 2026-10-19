# CI and the contract tests

`.github/workflows/ci.yml` has three jobs:

| job | runs in | what |
| --- | --- | --- |
| `check` | `ubuntu-latest`, Node 24 | `npm run typecheck` (packages, client, tests), `npm test` (no KiCad), and `npm run build` plus `npm pack --dry-run ./dist` (the npm package, `scripts/dist-package.ts`) |
| `export` | one job per `kicad/kicad` image (matrix below) | builds `examples/boards` with the KiCad in the image and checks the output against the contract (`tests/contract/run.ts`); uploads the site, the manifest, the reports and the raw `kicad-cli --help` texts |
| `build-site` | `kicad/kicad:10.0-full` | builds the examples site with `--base /<repository>/` and uploads it; a GitHub Pages deploy is prepared, commented out |

`export` and `build-site` start after `check` passes.

## The export matrix

| KiCad | image | samples it can open | backend the probe selects | must export (`expectations.json`) |
| --- | --- | --- | --- | --- |
| 7.0 | `kicad/kicad:7.0` | Legacy7 | `cli-7-8` | layers, thumbnail (layer composite), schematic, BOM, cross-probe, netlist, stats |
| 8.0 | `kicad/kicad:8.0` | Legacy7, Legacy8, Hierarchy | `cli-7-8` | same as 7.0 (DRC / ERC and the 3D model are checked by the capability rules, not required) |
| 9.0 | `kicad/kicad:9.0-full` | + FourLayer | `cli-modern` | every feature: layers, 3D model, thumbnail, schematic, BOM, cross-probe, netlist, fab, DRC, ERC, stats |
| 10.0 | `kicad/kicad:10.0-full` | all five | `cli-modern` | every feature |
| nightly | `kicad/kicad:nightly-full` | all five | `cli-modern` | same; **allowed to fail** (`continue-on-error`) |

Tags as published on Docker Hub (checked 2026-10-09): `7.0` (7.0.11) and `8.0` (8.0.9)
exist only without a `-full` variant, so those images have no stock 3D models (the
model stage exports the bare board and warns); `9.0`, `10.0` and `nightly` have `-full`
variants that include `/usr/share/kicad/3dmodels`, which the install discovery finds.
All images are amd64 Debian with `kicad-cli` at `/usr/bin/kicad-cli`.

Per job: run as root in the image, install Node 24 with `actions/setup-node`, `npm ci`,
`npm run build`, then the contract runner under `xvfb-run` (`kicad-cli pcb render`
draws with OpenGL). `--expect-kicad` makes the run fail when the probe does not find
the image's KiCad (so a broken discovery cannot pass by exporting nothing).

**User and permissions.** The images set `USER kicad` (uid 1000, passwordless sudo).
GitHub mounts the workspace, the tool cache and `$HOME` (`/github/home`) owned by the
runner's uid 1001, and the JavaScript actions (checkout, setup-node, upload-artifact)
write there, so the jobs use `options: --user root`. KiCad then keeps its settings in
`/github/home/.config/kicad`; nothing in the export needs the `kicad` user's library
tables.

**Artifacts** (`contract-kicad-<version>`, kept 14 days): `dist/` (the built site),
`boards.json` (the boards module payload), `status.json` (installs and every stage's
outcome), `contract-report.json` / `.md` (also on the job summary), `pipeline.log`, and
`help/<kicad version>/<command>.txt`: the raw `--help` text of every command the probe
reads, the material for the probe's help-text fixtures (`tests/fixtures/help/`, owned
by the backends stream).

## The contract runner

```sh
npm run build
npm run contract -- --expect-kicad 10            # = node tests/contract/run.ts ...
npm run contract -- --kicad-version "<10"        # pretend only older installs exist
npm run contract -- --skip-build                 # re-check .contract-out/dist
```

Options: `--root` (default `examples/boards`), `--out` (default `.contract-out`, holds
`dist/`, `cache/` and the reports; the cache makes re-runs fast), `--kicad-cli`,
`--kicad-version`, `--expect-kicad`, `--expectations`, `--skip-build`, `--clean`. Exit
code 1 on any error. Node 22.18+ (type stripping) runs the `.ts` files directly.

It builds the site exactly like `kiview build`, then re-opens the pipeline on the
warm cache to get the boards module payload and each stage's outcome, and checks:

1. **Schema**: the `Board[]` payload validates against `tests/contract/schema.ts`
   (closed objects, every `FeatureId` present, URLs, enums), sorted, unique names.
2. **Board facts**: format version, minimum KiCad and copper count as listed in
   `tests/contract/expectations.json` (every sample must be listed there).
3. **Selection**: a backend is selected exactly when a usable install is new enough for
   the file format, and `Board.kicad.backend` / `exportedWith` say which.
4. **Assets**: every URL in the manifest is a file in `dist/` (non-empty, sizes as
   stated), every layer SVG's viewBox equals `bounds`, the exported copper layers match
   `copperLayers`, the thumbnail is a PNG of the stated size, and the built JS embeds
   every board.
5. **Features** (`tests/contract/features.ts`):
   - a feature is available exactly when its data is there (`layers` non-empty,
     `model`, `thumbnail`, `schematic`, `bom`, `parts` for crossProbe, `netlist`,
     `download` for fab, `reports.drc` / `.erc`, `stats`), and unavailable ones carry a
     reason;
   - a feature no stage provides is unavailable, with the capability / file blocker
     (`featureBlocker`) or "not implemented yet" as the reason;
   - a feature a stage provides follows the stage: an export failure is an error, a
     skip must carry the skip reason, and a feature that nothing blocks must be
     exported; a blocked feature delivered anyway (a fallback, e.g. a thumbnail
     without `pcb render`) is reported as a note;
   - the per-backend floor in `expectations.json` (`require`) is available.
6. A board missing from the manifest is fine only when no install can open it or its
   layers and model stages were skipped (not failed); every feature is then listed as
   unavailable with the reason.

The report lists, per board, the backend, the available features, every unavailable
feature with its reason, the errors, and notes (stage warnings such as missing 3D
models, fallbacks).

**The floor after phase 2** (`expectations.json` `require`): `cli-modern` must deliver
every feature; `cli-7-8` and `docker` the layers, the thumbnail (render or the layer
composite), schematic, BOM, cross-probe, netlist and stats (the board file's numbers
without `pcb export stats`); `pcbnew-python` the layers. DRC / ERC (kicad-cli 8+) and
the 3D model on KiCad 7 / 8 are left to the capability rules: a feature nothing blocks
must still be exported. The runner also validates the JSON payloads behind the asset
URLs (BOM, parts, netlist, geometry, DRC / ERC reports) against their schemas in
`schema.ts`. The features check needs no change: it reads the stages' `provides`.

## Unit tests without KiCad

| file | covers |
| --- | --- |
| `tests/kicad.contract.test.ts` | version parsing, help parsing, capabilities, format table, `readBoard` |
| `tests/contract-schema.test.ts` | the schema on `tests/fixtures/contract/` (the KiCad 10 manifest of the examples, a board with every phase-2 field filled, a site payload) and on mutated copies |
| `tests/contract-features.test.ts` | the feature table, stage `provides`, `featureBlocker`, and the three feature rules on fixtures |
| `tests/samples.test.ts` | every sample: format version, minimum KiCad, copper count, sheet hierarchy (sheet files resolve relative to the sheet that places them), footprint paths that join to schematic symbols |

Refresh `boards-kicad10.json` from `.contract-out/boards.json` after a contract change
(`npm run contract -- --expect-kicad 10`).

## Sample projects

| board | file format | what it tests |
| --- | --- | --- |
| `Blinky` | KiCad 10 | 2 layers, GND zone, 2-sheet hierarchy (made in KiCad) |
| `Legacy7` | KiCad 7 (pcb 20221018, sch 20230121) | selection on the oldest format kicad-cli exports; `tstamp`, `fp_text` tokens |
| `Legacy8` | KiCad 8 (pcb 20240108, sch 20231120) | KiCad 8 tokens, a back-side LED, black mask |
| `FourLayer` | KiCad 9 (pcb 20241229, sch 20250114) | 4 layers with the KiCad 9 layer numbering, GND / VIN planes on In1 / In2 with vias, stackup, blue mask |
| `Hierarchy` | KiCad 8 | 3 levels: root -> `channels/channel.kicad_sch` twice -> `channels/led.kicad_sch` (sheets in a sub-directory, a reused sheet, per-instance references) |

All but Blinky are written by `examples/scripts/generate-samples.mjs` (CC0); see the
header of the script. `npm run samples` regenerates them (byte-identical output) and
validates each with the local KiCad: `pcb drc --schematic-parity`, `sch erc`, board
and schematic SVG export. With KiCad 10.0.6 every sample has 0 DRC errors (including
schematic parity) and 0 ERC errors; the only warnings are about the `Samples:` symbol
and footprint library not being installed.

## GitHub Pages

The `build-site` job ends with two commented steps and a commented `deploy-pages` job.
To publish the examples on pushes to `main`: set Settings > Pages > Source to "GitHub
Actions", uncomment them, and keep `--base '/<repository>/'` (use `/` for a user page
or a custom domain). Pages has no rewrites, so the commented step copies `index.html`
to `404.html`, which serves the `/board/<name>` routes.

## Not verified locally

There is no Docker on the development machine, so the container jobs have only been
checked with actionlint 1.7.12 and by running the same runner natively with KiCad
10.0.6 on macOS. Unverified until CI runs on GitHub: the root/permissions setup,
setup-node inside each image, `apt-get install xvfb` on the 7.0 / 8.0 images, whether
`pcb render` works under Xvfb in the 9.0 / 10.0 / nightly images, the install
discovery and probe inside each image, and whether KiCad 7.0 / 8.0 open the generated
Legacy7 / Legacy8 / Hierarchy files. KiCad 10 opens them all; the KiCad 8 and 9 tokens
follow files written by those versions, the KiCad 7 tokens follow the KiCad 7 format
without a KiCad 7 file at hand to compare against.
