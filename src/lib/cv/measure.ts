import type { BBox, HeelMeasurement } from "./types";
import { extractForeground } from "./detector";

const MIN_COLUMNS = 4;

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Approximate pixels-per-mm from frame width.
// Assumes ~700mm visible width at typical factory stand heights (40–80cm).
// Accurate enough for display; pass/fail uses the ratio, not this value.
function approxPxPerMm(frameWidth: number): number {
  return frameWidth / 700;
}

export function measureHeel(
  frame:    ImageData,
  heelBbox: BBox,
  shoeBbox: BBox,
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

  const medTopY = Math.round(median(topRows));

  const mean = topRows.reduce((a, b) => a + b, 0) / topRows.length;
  const variance = topRows.reduce((a, b) => a + (b - mean) ** 2, 0) / topRows.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  const confidence = Math.max(0, Math.min(1, 1 - cv / 0.05));

  const bottomY  = shoeBbox.y + shoeBbox.h;
  const heightPx = bottomY - medTopY;
  if (heightPx <= 0) return null;

  const heightMm = parseFloat((heightPx / approxPxPerMm(frame.width)).toFixed(1));

  return {
    topY:      medTopY,
    bottomY,
    heightPx,
    heightMm,
    heelBbox,
    confidence,
  };
}
