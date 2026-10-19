# kiview: board exports through KiCad's pcbnew Python module.
#
# Runs under the Python that ships with a KiCad install (KiCad 5 to 10), for the
# pcbnew-python backend (packages/kicad/src/backends/pcbnew-python.ts):
#
#   python kwv_pcbnew.py probe
#   python kwv_pcbnew.py svg   <pcb> <outdir> <holes 0|1> <layer,layer,...>
#   python kwv_pcbnew.py vrml  <pcb> <out.wrl> <xref mm> <yref mm> <nodnp 0|1>
#   python kwv_pcbnew.py fab   <pcb> <outdir> <zip>
#   python kwv_pcbnew.py vrml-selftest <out.wrl>
#
# vrml-selftest exports an empty board: standalone VRML export aborts in some builds
# (KiCad 10.0.6 on macOS asserts in Pgm() and dies), so the probe tries it once in its
# own process instead of trusting that EXPORTER_VRML exists.
#
# The last stdout line is "@@KWV " + JSON (the result, or {"error": ...}); everything
# before it is KiCad's own chatter. Python 2.7 compatible (KiCad 5 bundles 2.7 on some
# platforms): no f-strings, no pathlib.
#
# API differences handled (KiCad 5 -> 6 -> 7 -> 9):
#   - drill marks: PCB_PLOT_PARAMS.FULL_DRILL_SHAPE (5, 6) -> pcbnew.DRILL_MARKS_FULL_DRILL_SHAPE (7+)
#   - SetExcludeEdgeLayer exists up to 6 only (7+ plots only the selected layer anyway)
#   - SetSvgPrecision(precision, useInch) in 6, SetSvgPrecision(precision) in 7+, absent in 5
#   - EXCELLON_WRITER.SetOptions offset: wxPoint (5, 6) -> VECTOR2I (7+)
#   - VRML: EXPORTER_VRML(board).ExportVRML_File(project, ...) where SWIG exposes it (7+);
#     the older free function ExportVRML() needs the PCB editor's board, so standalone
#     5/6 report VRML as unavailable. [uncertain: some 6.0.x builds may expose
#     EXPORTER_VRML too; the probe checks for it rather than assuming]
#   - PLACE_FILE_EXPORTER (position files) since 6 [uncertain for 5]
#   - SVG units: 5 writes 1/10000 inch user units, 6+ mm; the Node side rescales by
#     comparing the root width/height (mm) with the viewBox, so nothing is done here.

from __future__ import print_function

import json
import os
import sys
import traceback
import zipfile

import pcbnew


def result(obj):
    sys.stdout.write('\n@@KWV ' + json.dumps(obj) + '\n')
    sys.stdout.flush()


def version():
    try:
        return pcbnew.Version()
    except Exception:
        return pcbnew.GetBuildVersion() if hasattr(pcbnew, 'GetBuildVersion') else ''


def drill_marks(full):
    if hasattr(pcbnew, 'DRILL_MARKS_FULL_DRILL_SHAPE'):
        return pcbnew.DRILL_MARKS_FULL_DRILL_SHAPE if full else pcbnew.DRILL_MARKS_NO_DRILL_SHAPE
    P = pcbnew.PCB_PLOT_PARAMS
    return P.FULL_DRILL_SHAPE if full else P.NO_DRILL_SHAPE


def has_vrml():
    return hasattr(pcbnew, 'EXPORTER_VRML') and hasattr(pcbnew.EXPORTER_VRML, 'ExportVRML_File')


def probe():
    return {
        'version': version(),
        'python': sys.version.split()[0],
        'svg': hasattr(pcbnew, 'PLOT_FORMAT_SVG'),
        'gerber': hasattr(pcbnew, 'PLOT_FORMAT_GERBER'),
        'drill': hasattr(pcbnew, 'EXCELLON_WRITER'),
        'pos': hasattr(pcbnew, 'PLACE_FILE_EXPORTER'),
        'vrml': has_vrml(),
    }


def layer_id(board, name):
    i = board.GetLayerID(name)
    if i is None or i < 0:
        raise ValueError('unknown layer ' + name)
    return i


def safe(name):
    return ''.join(c if c.isalnum() else '_' for c in name)


def base_plot_options(popt, outdir):
    popt.SetOutputDirectory(outdir)
    popt.SetPlotFrameRef(False)
    popt.SetUseAuxOrigin(False)
    popt.SetAutoScale(False)
    popt.SetScale(1)
    popt.SetMirror(False)
    popt.SetNegative(False)
    if hasattr(popt, 'SetExcludeEdgeLayer'):
        popt.SetExcludeEdgeLayer(True)
    if hasattr(popt, 'SetSubtractMaskFromSilk'):
        popt.SetSubtractMaskFromSilk(False)


def plot_svg(pcb, outdir, holes, layers):
    board = pcbnew.LoadBoard(pcb)
    pc = pcbnew.PLOT_CONTROLLER(board)
    popt = pc.GetPlotOptions()
    base_plot_options(popt, outdir)
    popt.SetDrillMarksType(drill_marks(holes))
    if hasattr(popt, 'SetBlackAndWhite'):
        popt.SetBlackAndWhite(False)
    if hasattr(popt, 'SetSvgPrecision'):
        try:
            popt.SetSvgPrecision(4)
        except TypeError:
            popt.SetSvgPrecision(4, False)   # KiCad 6: (precision, useInch)
    out = []
    for name in layers:
        try:
            lid = layer_id(board, name)
        except ValueError:
            continue
        pc.SetLayer(lid)
        if not pc.OpenPlotfile(safe(name), pcbnew.PLOT_FORMAT_SVG, name):
            continue
        pc.PlotLayer()
        f = pc.GetPlotFileName()
        pc.ClosePlot()
        if f and os.path.exists(f):
            out.append({'layer': name, 'file': os.path.abspath(f)})
    return out


def export_vrml(pcb, out, xref, yref, nodnp):
    if not has_vrml():
        raise RuntimeError('this KiCad has no EXPORTER_VRML in Python')
    board = pcbnew.LoadBoard(pcb)
    exporter = pcbnew.EXPORTER_VRML(board)
    project = board.GetProject() if hasattr(board, 'GetProject') else None
    messages = ''
    ok = exporter.ExportVRML_File(project, messages, out, 1.0, True, not nodnp, False, False, '', xref, yref)
    if not ok or not os.path.exists(out):
        raise RuntimeError('VRML export failed')
    return {'file': os.path.abspath(out)}


def plot_gerbers(board, outdir):
    pc = pcbnew.PLOT_CONTROLLER(board)
    popt = pc.GetPlotOptions()
    base_plot_options(popt, outdir)
    if hasattr(popt, 'SetUseGerberProtelExtensions'):
        popt.SetUseGerberProtelExtensions(False)
    if hasattr(popt, 'SetUseGerberX2format'):
        popt.SetUseGerberX2format(True)
    if hasattr(popt, 'SetIncludeGerberNetlistInfo'):
        popt.SetIncludeGerberNetlistInfo(True)
    if hasattr(popt, 'SetCreateGerberJobFile'):
        popt.SetCreateGerberJobFile(False)
    popt.SetDrillMarksType(drill_marks(False))
    popt.SetPlotReference(True)
    popt.SetPlotValue(True)
    files = []
    enabled = board.GetEnabledLayers()
    copper = board.GetCopperLayerCount()
    wanted = ['F.Cu', 'B.Cu'] + ['In%d.Cu' % i for i in range(1, max(0, copper - 2) + 1)] + \
             ['F.Paste', 'B.Paste', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'Edge.Cuts']
    for name in wanted:
        lid = board.GetLayerID(name)
        if lid is None or lid < 0 or not enabled.Contains(lid):
            continue
        pc.SetLayer(lid)
        if pc.OpenPlotfile(safe(name), pcbnew.PLOT_FORMAT_GERBER, name):
            pc.PlotLayer()
            f = pc.GetPlotFileName()
            pc.ClosePlot()
            if f and os.path.exists(f):
                files.append(f)
    return files


def write_drill(board, outdir):
    w = pcbnew.EXCELLON_WRITER(board)
    origin = pcbnew.VECTOR2I(0, 0) if hasattr(pcbnew, 'VECTOR2I') else pcbnew.wxPoint(0, 0)
    w.SetOptions(False, False, origin, False)
    w.SetFormat(True)   # metric
    before = set(os.listdir(outdir))
    w.CreateDrillandMapFilesSet(outdir, True, False)
    return [os.path.join(outdir, f) for f in sorted(set(os.listdir(outdir)) - before)]


def write_pos(board, outdir, stem):
    out = os.path.join(outdir, stem + '-pos.csv')
    # PLACE_FILE_EXPORTER(board, unitsMM, onlySMD, excludeAllTH, [excludeDNP, [excludeBOM,]]
    #                     top, bottom, csv, useAuxOrigin, negateBottomX)
    # 10: with excludeDNP and excludeBOM; 8/9: excludeDNP [uncertain]; 6/7: neither
    ex = None
    for extra in ([True, False], [True], []):
        try:
            ex = pcbnew.PLACE_FILE_EXPORTER(board, True, False, False, *(extra + [True, True, True, False, False]))
            break
        except TypeError:
            continue
    if ex is None:
        raise RuntimeError('unknown PLACE_FILE_EXPORTER signature')
    text = ex.GenPositionData()
    with open(out, 'w') as fh:
        fh.write(text)
    return out


def fab(pcb, outdir, zip_path):
    board = pcbnew.LoadBoard(pcb)
    stem = os.path.splitext(os.path.basename(pcb))[0]
    gerber_dir = os.path.join(outdir, 'gerbers')
    if not os.path.isdir(gerber_dir):
        os.makedirs(gerber_dir)
    files = plot_gerbers(board, gerber_dir)
    missing, warnings = [], []
    if hasattr(pcbnew, 'EXCELLON_WRITER'):
        files += write_drill(board, gerber_dir)
    else:
        missing.append('Drill files')
    pos = None
    if hasattr(pcbnew, 'PLACE_FILE_EXPORTER'):
        try:
            pos = write_pos(board, outdir, stem)
        except Exception as e:
            warnings.append('position file: %s' % e)
    if not pos:
        missing.append('Position file')
    contents = []
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in files:
            name = 'gerbers/' + os.path.basename(f)
            z.write(f, name)
            contents.append(name)
        if pos:
            z.write(pos, os.path.basename(pos))
            contents.append(os.path.basename(pos))
    if not any(c.endswith('.drl') for c in contents):
        if 'Drill files' not in missing:
            warnings.append('no drill file written')
    return {'zip': os.path.abspath(zip_path), 'contents': contents, 'missing': missing, 'warnings': warnings}


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'probe':
        return probe()
    if cmd == 'svg':
        return plot_svg(argv[2], argv[3], argv[4] == '1', [l for l in argv[5].split(',') if l])
    if cmd == 'vrml':
        return export_vrml(argv[2], argv[3], float(argv[4]), float(argv[5]), argv[6] == '1')
    if cmd == 'vrml-selftest':
        if not has_vrml():
            return {'ok': False}
        ok = pcbnew.EXPORTER_VRML(pcbnew.BOARD()).ExportVRML_File(None, '', argv[2], 1.0, True, True, False, False, '', 0, 0)
        return {'ok': bool(ok) and os.path.exists(argv[2])}
    if cmd == 'fab':
        return fab(argv[2], argv[3], argv[4])
    raise ValueError('unknown command ' + cmd)


if __name__ == '__main__':
    try:
        result(main(sys.argv))
    except Exception as e:
        traceback.print_exc()
        result({'error': '%s: %s' % (type(e).__name__, e)})
        sys.exit(1)
