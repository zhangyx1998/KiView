// File format version -> oldest KiCad major that opens the file.
//
// This is a fact about KiCad's FILE FORMATS, not a feature table (what an install can
// DO is probed, probe.ts). Each release series writes one `(version YYYYMMDD)` and
// refuses files newer than it, so a file opens in the first release whose version is
// at or above the file's. Development (nightly) files fall between two releases and
// map to the later one; a file newer than every known release asks for the next major.
//
// Verified against the KiCad sources at the first and the last tag of each series
// (gitlab.com/kicad/code/kicad); no patch release changed the number:
//   pcb  SEXPR_BOARD_FILE_VERSION
//        5.0.0, 5.1.10  pcbnew/kicad_plugin.h                              20171130
//        6.0.0, 6.0.11  pcbnew/plugins/kicad/pcb_plugin.h                  20211014
//        7.0.0, 7.0.11  pcbnew/plugins/kicad/pcb_plugin.h                  20221018
//        8.0.0, 8.0.9   pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h     20240108
//        9.0.0, 9.0.7   pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h     20241229
//       10.0.0, 10.0.6  pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h     20260206
//   sch  SEXPR_SCHEMATIC_FILE_VERSION, eeschema/sch_file_versions.h
//        6: 20211123   7: 20230121   8: 20231120   9: 20250114   10: 20260306
//        (KiCad 5 schematics are the legacy .sch format, not s-expressions)
// Board files older than s-expression version 20171130 (KiCad 4: "version 4") open in 5.

/** The format version each KiCad major release writes (and the newest it reads), per file kind. */
export const FORMAT_VERSIONS: Record<'pcb' | 'sch', [major: number, version: number][]> = {
  pcb: [
    [5, 20171130],
    [6, 20211014],
    [7, 20221018],
    [8, 20240108],
    [9, 20241229],
    [10, 20260206],
  ],
  sch: [
    [6, 20211123],
    [7, 20230121],
    [8, 20231120],
    [9, 20250114],
    [10, 20260306],
  ],
}

/**
 * Oldest KiCad major able to open a file of this format version: the first release
 * whose own version is >= the file's. Version 0 (unknown) maps to the oldest release;
 * anything newer than the newest known release to that release + 1.
 */
export function minKicadFor(formatVersion: number, kind: 'pcb' | 'sch'): number {
  const table = FORMAT_VERSIONS[kind]
  for (const [major, version] of table) if (formatVersion <= version) return major
  return table[table.length - 1]![0] + 1
}

/** One-line reason a file cannot be opened by the installs at hand. */
export function needsKicadMessage(formatVersion: number, kind: 'pcb' | 'sch'): string {
  const major = minKicadFor(formatVersion, kind)
  const newest = FORMAT_VERSIONS[kind][FORMAT_VERSIONS[kind].length - 1]![0]
  return major > newest
    ? `the file (format ${formatVersion}) is newer than KiCad ${newest}: it needs KiCad ${major} or a nightly build`
    : `the file (format ${formatVersion}) needs KiCad ${major} or newer`
}
