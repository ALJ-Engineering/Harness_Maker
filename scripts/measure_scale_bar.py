#!/usr/bin/env python3
"""Measure the 100 mm scale-check bar in a 300 dpi greyscale PGM of one PDF page.

Called by scripts/check-pdf-scale.mjs. Python 3 stdlib only (no PIL).

The bar (src/shared/print/template.ts, `<g class="scale-bar-page">`) is drawn in
PAGE space on the 1:1 drawing page, in the info strip along the bottom of the sheet: a
100 mm horizontal line with a 1.5 mm vertical end tick at each end, all stroked
0.5 mm, its centreline TEMPLATE_MARGIN(8) + TILE_STRIP_H(13) - SCALE_BAR_ROW_Y(4)
= 17 mm above the bottom paper edge and starting 16 mm in from the left.

So the longest dark run through the bar's own row is 100.5 mm wide (the ticks
add half a stroke at each end).  The honest 100 mm is tick centre to tick
centre, which is what a steel rule reads, so that is what we measure: a row
just above the bar crosses only the two ticks, and their intensity-weighted
centroids are exactly 100 mm apart.

Finding the bar is deliberately narrow, because a drawing page is full of long
horizontal rules that are NOT the scale bar: a pinout table's ~98 mm header rule
has tick-like verticals at both ends and, scanned from the top, is hit first --
which is how this script used to report a confident false FAIL of -2.4 %.  Two
things rule it out: only the bottom SEARCH_BAND_MM of the page is searched (the
info strip is the bottom 21 mm and holds nothing else long), and among the
candidates in that band the one whose run length is closest to the bar's true
100.5 mm wins.

Exit 0 = bar found and within tolerance, 1 = not found, 2 = found but out of
tolerance.
"""
import sys

DPI = 300
PX_PER_MM = DPI / 25.4          # 11.811
EXPECT_PX = 100.0 * PX_PER_MM   # 1181.10
TOL_PX = 3
THRESH = 128                    # 8-bit grey below this counts as ink
SEARCH_BAND_MM = 30             # only the bottom of the page holds the page-space bar
BAR_RUN_MM = 100.5              # bar + half an end-tick stroke at each end


def read_pgm(path):
    """Return (width, height, bytes) for a binary P5 PGM."""
    buf = open(path, 'rb').read()
    i, fields = 0, []
    while len(fields) < 4:
        while buf[i:i + 1].isspace():
            i += 1
        if buf[i:i + 1] == b'#':
            while buf[i:i + 1] not in (b'\n', b''):
                i += 1
            continue
        j = i
        while not buf[j:j + 1].isspace():
            j += 1
        fields.append(buf[i:j])
        i = j
    magic, w, h, _maxval = fields
    if magic != b'P5':
        raise SystemExit(f'{path}: not a binary PGM (got {magic!r})')
    return int(w), int(h), buf[i + 1:]


def runs(row, w):
    """Yield (start, end) inclusive spans of dark pixels."""
    x = 0
    while x < w:
        if row[x] < THRESH:
            s = x
            while x < w and row[x] < THRESH:
                x += 1
            yield s, x - 1
        else:
            x += 1


def centroid(row, a, b):
    """Intensity-weighted centre of the ink between columns a..b."""
    num = den = 0.0
    for x in range(a, b + 1):
        ink = (255 - row[x]) / 255.0
        num += ink * (x + 0.5)
        den += ink
    return (num / den) if den else None


def main():
    path = sys.argv[1]
    page = sys.argv[2] if len(sys.argv) > 2 else '?'
    w, h, px = read_pgm(path)

    # 1. Find the bar's row.  Search a deliberately WIDE length window (95 mm ..
    #    106 mm) so a mis-scaled drawing is reported as an out-of-tolerance
    #    measurement rather than silently "not found"; the pass/fail tolerance
    #    below is still +/- 3 px.  A candidate must have the bar's structure:
    #    a vertical end tick above AND below each end, and clear paper between.
    #
    #    Two guards keep a pinout table's header rule (~98 mm, tick-like
    #    verticals at both ends) from being mistaken for the bar: the search is
    #    confined to the bottom SEARCH_BAND_MM of the page, where only the
    #    info strip lives, and the winner is the candidate whose run length is
    #    closest to the bar's own 100.5 mm.
    lo, hi = int(round(95.0 * PX_PER_MM)), int(round(106.0 * PX_PER_MM))
    tick = int(round(1.0 * PX_PER_MM))   # rows +/- 1 mm are on the ticks, off the bar
    band_top = max(0, h - int(round(SEARCH_BAND_MM * PX_PER_MM)))
    want_run = BAR_RUN_MM * PX_PER_MM

    def has_ticks(y, s, e):
        for dy in (-tick, tick):
            yy = y + dy
            if not (0 <= yy < h):
                return False
            r = px[yy * w:(yy + 1) * w]
            near_s = any(r[x] < THRESH for x in range(max(0, s - 2), min(w, s + 8)))
            near_e = any(r[x] < THRESH for x in range(max(0, e - 7), min(w, e + 3)))
            if not (near_s and near_e and r[(s + e) // 2] >= THRESH):
                return False
        return True

    candidates = []
    for y in range(h - 1, band_top - 1, -1):   # from the bottom edge upward
        row = px[y * w:(y + 1) * w]
        for s, e in runs(row, w):
            if lo <= e - s + 1 <= hi and has_ticks(y, s, e):
                candidates.append((y, s, e))
    if not candidates:
        return 1
    found = min(candidates, key=lambda c: abs((c[2] - c[1] + 1) - want_run))

    ybar, s, e = found

    # 2. Measure tick centre to tick centre on rows above/below the bar itself.
    #    The ticks span 1.5 mm (~18 px) either side of the bar; the bar's own
    #    stroke is 0.5 mm (~6 px), so +/-8 px clears it and stays on the ticks.
    win = int(round(1.5 * PX_PER_MM))
    spans = []
    for dy in list(range(-16, -7)) + list(range(8, 17)):
        y = ybar + dy
        if not (0 <= y < h):
            continue
        row = px[y * w:(y + 1) * w]
        if row[(s + e) // 2] < THRESH:
            continue                     # still on the bar / on the caption
        left = centroid(row, max(0, s - win), min(w - 1, s + win))
        right = centroid(row, max(0, e - win), min(w - 1, e + win))
        if left is None or right is None:
            continue
        spans.append(right - left)
    if not spans:
        return 1

    span = sum(spans) / len(spans)
    mm = span / PX_PER_MM
    err = (mm - 100.0) / 100.0 * 100.0

    print(f'page {page}: raster {w} x {h} px @ {DPI} dpi')
    print(f'  scale bar found at row {ybar}, cols {s}..{e} '
          f'(run {e - s + 1} px = bar + 2 x half tick stroke)')
    print(f'  tick centre to tick centre, mean of {len(spans)} rows: '
          f'{span:.3f} px = {mm:.4f} mm  (ideal {EXPECT_PX:.2f} px / 100 mm; '
          f'error {err:+.4f} %)')
    ok = abs(span - EXPECT_PX) <= TOL_PX
    print('  PASS' if ok else f'  FAIL — expected {EXPECT_PX:.0f} px +/- {TOL_PX}')
    return 0 if ok else 2


if __name__ == '__main__':
    sys.exit(main())
