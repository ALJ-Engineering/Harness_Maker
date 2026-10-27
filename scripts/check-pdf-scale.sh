#!/usr/bin/env bash
# Usage: scripts/check-pdf-scale.sh <drawing-set.pdf> [page]
#
# End-to-end 1:1 check on an exported drawing set's 1:1 drawing page:
#   1. reports the page count and MediaBox from pdfinfo;
#   2. rasterises the page(s) at 300 dpi and MEASURES the 100 mm scale-check bar
#      end-tick centre to end-tick centre, in pixels.
#
# 100 mm at 300 dpi = 1181.10 px, so expect 1181 px +/- 3.
# The bar is drawn in PAGE space in the info strip along the bottom of the 1:1
# drawing page (page 1 of the set); pass [page] to pin it. With no [page]
# argument every page is scanned until the bar is found, which also skips the
# A4 document pages (BOM / Wiring Table / Cutlist), that carry no bar.
#
# NOTE on the page size: Chromium quantises the PDF page box to 1/300 in
# (0.24 pt), so an A4-landscape template reports 841.92 x 594.96 pts, not the
# nominal 841.89 x 595.28.
#
# Needs poppler (`brew install poppler` -> /opt/homebrew/bin) and python3.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

f="${1:?usage: check-pdf-scale.sh <drawing-set.pdf> [page]}"

pdfinfo "$f" | grep -E "^(Pages|Page size)"
npages=$(pdfinfo "$f" | awk '/^Pages:/ {print $2}')

if [ $# -ge 2 ]; then
  pages="$2"
else
  pages=$(seq 1 "$npages")
fi

out="${TMPDIR:-/tmp}/harness-scale-check"
rm -f "${out}"-*.pgm "${out}"-*.png

status=1
for p in $pages; do
  # PGM (P5) is trivially parseable from the Python stdlib; the PNG is for eyeballing.
  pdftoppm -r 300 -gray -f "$p" -l "$p" "$f" "$out"
  pdftoppm -r 300 -f "$p" -l "$p" -png "$f" "$out"
  pgm=$(ls "${out}"-*.pgm | head -1)
  if python3 "$(dirname "$0")/measure_scale_bar.py" "$pgm" "$p"; then
    status=0
    echo "PNG for visual inspection: $(ls "${out}"-*.png | head -1)"
    break
  fi
  rm -f "${out}"-*.pgm "${out}"-*.png
done

if [ "$status" -ne 0 ]; then
  echo "FAIL — no 100 mm scale bar found in ${f}"
fi
exit "$status"
