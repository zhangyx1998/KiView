// @kiview/kicad: one interface over several ways of driving KiCad.
// The contract is types.ts; docs/architecture.md describes it.

export type * from './types.ts'
export { openKicad, createBackend, versionMatches } from './select.ts'
export { discoverInstalls } from './installs.ts'
export { probeCli, parseHelp, parseVersion, capabilitiesFromHelp, backendForCaps } from './probe.ts'
export { FEATURES, featureBlocker } from './features.ts'
export { FORMAT_VERSIONS, minKicadFor } from './versions.ts'
export { UnsupportedError } from './errors.ts'
export { parseSExpr, readBoard, readTitleBlock, formatVersionOf, titleFromName, type SExpr } from './board-file.ts'
export { selectLayers, type LayerSpec } from './layers.ts'
export { normaliseLayerSvg, readViewBox } from './svg.ts'
export { decodePng, encodePng, trimAndShrink, type Image } from './png.ts'
export { withMaskColour } from './board-edit.ts'
export { run, Semaphore, type RunResult, type RunOptions } from './process.ts'
export { zipBuffer, writeZip, listZip, type ZipEntry, type ZipListing } from './zip.ts'
export { gerberLayers } from './backends/fab-cli.ts'
// [P2-d] stats, copper geometry, DRC / ERC reports
export { computeBoardStats, parseKicadStatsJson, mergeStats, readProjectRules, type KicadStatsReport } from './stats.ts'
export { readGeometry, readRawFootprints, arcPolyline, expandLayers as expandCopperLayers, type RawFootprint, type RawPad } from './geometry.ts'
export { parseCheckReport, countSeverities } from './checks.ts'
// [P2-b] footprints, schematic sheet tree, netlist and BOM
export { readFootprints, expandLayers } from './footprints.ts'
export { readSchematicTree, schematicFileSet, sheetFileRefs, schematicSvgName, symbolTransform, type SheetNode } from './schematic.ts'
export { parseNetlist, groupBom, compareRefs, bomItemsFromNetlist, bomItemsFromFootprints, type ParsedNetlist, type NetlistComponent } from './netlist.ts'
// [P2-a] backends, probing, selection
export { FallbackBackend, rankCandidates, explainNoFit, toolkitFromProbes, type SelectionOptions } from './select.ts'
export { HELP_PATHS, readHelpTree, helpText, helpHasFlag, probeResult, probePython, probeDocker, pythonHelp, scriptResult,
  dockerProbeScript, parseDockerProbe, noCapabilities, PCBNEW_SCRIPT, type PythonFacts } from './probe.ts'
export { fromCli, dockerInstalls, nodeDiscoveryEnv, type DiscoveryEnv } from './installs.ts'
export { needsKicadMessage } from './versions.ts'
export { DockerBackend, DockerRunner, dockerCommand, splitMultiOutput, shQuote, dockerImages, listDockerImages,
  type DockerCommand, type DockerCommandInput, type Mount } from './backends/docker.ts'
export { svgToMillimetres } from './backends/pcbnew-python.ts'
export { CliOps, NativeRunner, type CliRunner, type ExecOptions } from './backends/cli-ops.ts'
export { Cli78Backend } from './backends/cli-7-8.ts'
export { PcbnewPythonBackend } from './backends/pcbnew-python.ts'
