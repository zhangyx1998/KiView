# Hierarchy

Generated sample project for KiView: a KiCad 8 format project with a 3-level hierarchical schematic: the root sheet places `channels/channel.kicad_sch` twice (Channel A, Channel B), and each channel places `channels/led.kicad_sch`, a sheet in a sub-directory; 5 parts, red mask.

Written by `examples/scripts/generate-samples.mjs` (do not edit by hand; re-run the
script). Files: `Hierarchy.kicad_pcb`, `Hierarchy.kicad_pro`, `Hierarchy.kicad_sch`, `channels/channel.kicad_sch`, `channels/led.kicad_sch`.

The design files in this folder are dedicated to the public domain under CC0 1.0. The
symbols and footprints are drawn by the generator; only the 3D model paths point at
KiCad's stock model library, which is not included.
