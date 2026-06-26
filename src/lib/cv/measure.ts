// Heel height measurement.
//
// Inputs:
//   frame    — full-resolution ImageData from the live camera
//   heelBbox — narrow column at the heel end (from heel-finder.ts)
//   surfaceY — calibrated surface line Y coordinate (pixels, fixed per installation)
//   pxPerMm  — pixels per millimetre (from calibration)
//
// Output: HeelMeasurement
//
// Top boundary:
//   Topmost foreground pixel in the heel column = top of heel collar.
//   Uses extractForeground() which is color-independent (local contrast delta).
//
// Bottom boundary:
//   surfaceY — calibrated once at installation, never detected per-frame.
//   The camera is fixed. The table never moves. The surface line is constant.
//   This eliminates the white-outsole-on-white-cloth detection problem entirely.
//
// Confidence:
//   Coefficient of variation of per-column top-Y values.
//   Low spread → consistent top boundary → high confidence.

import type { BBox, HeelMeasurement } from "./types";
import { extractForeground } from "./detector";

const MIN_COLUMNS = 4;   // need at least this many foreground columns to measure

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function measureHeel(
  frame:    ImageData,
  heelBbox: BBox,
  surfaceY: number,
  pxPerMm:  number,
): HeelMeasurement | null {
  const mask = extractForeground(frame, heelBbox);
  const bw   = heelBbox.w;
  const bh   = heelBbox.h;

  // Per-column: find topmost foreground row
  const topRows: number[] = [];

  for (let rx = 0; rx < bw; rx++) {
    let topRow = -1;
    for (let ry = 0; ry < bh; ry++) {
      if (mask[ry * bw + rx]) { topRow = ry; break; }
    }
    if (topRow >= 0) topRows.push(heelBbox.y + topRow); // convert to frame coords
  }

  if (topRows.length < MIN_COLUMNS) return null;

  const medTopY  = Math.round(median(topRows));

  // Confidence: coefficient of variation of top-row positions
  const mean = topRows.reduce((a, b) => a + b, 0) / topRows.length;
  const variance = topRows.reduce((a, b) => a + (b - mean) ** 2, 0) / topRows.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  const confidence = Math.max(0, Math.min(1, 1 - cv / 0.05));

  const heightPx = surfaceY - medTopY;
  if (heightPx <= 0) return null;

  return {
    topY:       medTopY,
    surfaceY,
    heightPx,
    heightMm:   parseFloat((heightPx / pxPerMm).toFixed(1)),
    heelBbox,
    confidence,
  };
}
