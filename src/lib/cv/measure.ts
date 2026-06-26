import type { BBox, HeelMeasurement } from "./types";
import { extractForeground } from "./detector";

const MIN_COLUMNS = 4;

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}

export function measureHeel(
  frame:    ImageData,
  heelBbox: BBox,
  shoeBbox: BBox,
  pxPerMm:  number,
): HeelMeasurement | null {
  const mask = extractForeground(frame, heelBbox);
  const bw   = heelBbox.w;
  const bh   = heelBbox.h;

  const topRows: number[] = [];
  for (let rx = 0; rx < bw; rx++) {
    let topRow = -1;
    for (let ry = 0; ry < bh; ry++) {
      if (mask[ry * bw + rx]) { topRow = ry; break; }
    }
    if (topRow >= 0) topRows.push(heelBbox.y + topRow);
  }

  if (topRows.length < MIN_COLUMNS) return null;

  const medTopY  = Math.round(median(topRows));
  const bottomY  = shoeBbox.y + shoeBbox.h;
  const heightPx = bottomY - medTopY;
  if (heightPx <= 0) return null;

  return {
    topY:     medTopY,
    bottomY,
    heightPx,
    heightMm: parseFloat((heightPx / pxPerMm).toFixed(1)),
    heelBbox,
  };
}
