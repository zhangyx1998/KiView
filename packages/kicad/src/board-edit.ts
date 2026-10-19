// Edits applied to a board snapshot before exporting (never to the user's file).

/**
 * Set the solder-mask colour in the stackup (for the 3D model and the thumbnail).
 * Only used when the config overrides `maskColor`; by default the board's own
 * stackup colour is used as is. A board without a stackup gets a minimal 2-layer one.
 */
export function withMaskColour(pcb: string, colour: string): string {
  if (pcb.includes('(stackup')) {
    for (const layer of ['Top Solder Mask', 'Bottom Solder Mask']) {
      const re = new RegExp(`(\\(type "${layer}"\\))(\\s*\\(color "[^"]*"\\))?`)
      pcb = pcb.replace(re, `$1 (color "${colour}")`)
    }
    return pcb
  }
  const stackup = `\t\t(stackup
\t\t\t(layer "F.SilkS" (type "Top Silk Screen"))
\t\t\t(layer "F.Paste" (type "Top Solder Paste"))
\t\t\t(layer "F.Mask" (type "Top Solder Mask") (color "${colour}") (thickness 0.01))
\t\t\t(layer "F.Cu" (type "copper") (thickness 0.035))
\t\t\t(layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
\t\t\t(layer "B.Cu" (type "copper") (thickness 0.035))
\t\t\t(layer "B.Mask" (type "Bottom Solder Mask") (color "${colour}") (thickness 0.01))
\t\t\t(layer "B.Paste" (type "Bottom Solder Paste"))
\t\t\t(layer "B.SilkS" (type "Bottom Silk Screen"))
\t\t\t(copper_finish "None")
\t\t\t(dielectric_constraints no)
\t\t)
`
  return pcb.replace(/\t\(setup\r?\n/, m => m + stackup)
}
