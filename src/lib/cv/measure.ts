import type { BBox, HeelMeasurement } from "./types";

const MIN_COLUMNS  = 3;
const NOISE_SKIP   = 2;

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function regionGray(frame: ImageData, bbox: BBox): Uint8Array {
  const { data, width: fw } = frame;
  const { x: bx, y: by, w: bw, h: bh } = bbox;
  const out = new Uint8Array(bw * bh);
  for (let ry = 0; ry < bh; ry++)
    for (let rx = 0; rx < bw; rx++) {
      const fi = ((by + ry) * fw + (bx + rx)) * 4;
      out[ry * bw + rx] = (data[fi] * 77 + data[fi + 1] * 150 + data[fi + 2] * 29) >> 8;
    }
  return out;
}

function otsu(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumB = 0, wB = 0, sum = 0, maxVar = 0, t = 128;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > maxVar) { maxVar = v; t = i; }
  }
  return t;
}

// ── Row-width profile ─────────────────────────────────────────────────────────
//
// For each row in the heelBbox, count how many columns are foreground.
// Returns array of length bh, each entry = foreground pixel count for that row.
//
// The heel collar rim is the row where the heel body is at MAXIMUM width.
// Anatomy:
//   Above collar rim → shoe narrows into ankle / throat
//   At collar rim    → widest point of heel upper  ← TARGET
//   Below collar rim → heel cup, then outsole
//
// This is independent of absolute pixel brightness and works for any shoe colour.

function rowWidthProfile(gray: Uint8Array, bw: number, bh: number, darkT: number): Int32Array {
  const profile = new Int32Array(bh);
  for (let ry = 0; ry < bh; ry++) {
    let count = 0;
    for (let rx = 0; rx < bw; rx++) {
      if (gray[ry * bw + rx] <= darkT) count++;
    }
    profile[ry] = count;
  }
  return profile;
}

// ── Smooth a 1-D array with a simple box filter ───────────────────────────────
function smooth(arr: Int32Array, radius: number): Float64Array {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let d = -radius; d <= radius; d++) {
      const j = i + d;
      if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
    }
    out[i] = s / n;
  }
  return out;
}

export function measureHeel(
  frame:     ImageData,
  heelBbox:  BBox,
  _shoeBbox: BBox,
  pxPerMm:   number,
): HeelMeasurement | null {
  const { x: bx, y: by, w: bw, h: bh } = heelBbox;

  const gray  = regionGray(frame, heelBbox);
  const darkT = Math.min(otsu(gray), 160);
  const bgT   = 210;

  // ── Step 1: Bottom of outsole — scan each column bottom-up ───────────────
  // The outsole bottom is the last non-background pixel per column.
  // Background = wall/table (very light) OR empty space below shoe.
  // We use bgT = 210 as "definitely background".
  const soleRows: number[] = [];
  for (let rx = 0; rx < bw; rx++) {
    for (let ry = bh - 1 - NOISE_SKIP; ry >= NOISE_SKIP; ry--) {
      if (gray[ry * bw + rx] < bgT) {
        soleRows.push(by + ry);
        break;
      }
    }
  }
  if (soleRows.length < MIN_COLUMNS) return null;
  const medBottomY = Math.round(median(soleRows));

  // ── Step 2: Heel collar top — first row where profile reaches ≥70% of peak ──
  //
  // The row-width profile rises from near-zero (ankle/throat area above collar)
  // to a plateau (the full heel body width). The collar rim = the first row
  // where the profile crosses 70% of the peak value found in the upper half.
  //
  // Using first-threshold-crossing is more stable than argmax because:
  //   - argmax chases the single noisiest peak (jumps scan-to-scan)
  //   - The 70% crossing point is on the rising edge which is consistent
  //     regardless of slight shoe position shifts
  //
  // Search window: shoeTopRow → shoeTopRow + 50% of bbox height
  // (collar is always in the upper half of the heel bbox)

  const profile  = rowWidthProfile(gray, bw, bh, darkT);
  const smoothed = smooth(profile, 5); // wider smooth for stability

  // Find topmost row with any dark pixels
  let shoeTopRow = -1;
  for (let ry = NOISE_SKIP; ry < bh - NOISE_SKIP; ry++) {
    if (profile[ry] >= 2) { shoeTopRow = ry; break; }
  }
  if (shoeTopRow < 0) return null;

  const searchEnd = Math.min(bh - NOISE_SKIP, shoeTopRow + Math.round(bh * 0.55));

  // Find peak width in search window
  let peakWidth = 0;
  for (let ry = shoeTopRow; ry <= searchEnd; ry++) {
    if (smoothed[ry] > peakWidth) peakWidth = smoothed[ry];
  }

  // First row that reaches 70% of peak = collar rim
  const threshold = peakWidth * 0.70;
  let collarRow   = shoeTopRow;
  for (let ry = shoeTopRow; ry <= searchEnd; ry++) {
    if (smoothed[ry] >= threshold) { collarRow = ry; break; }
  }

  const medTopY = by + collarRow;

  const heightPx = medBottomY - medTopY;
  if (heightPx <= 0) return null;

  return {
    topY:     medTopY,
    bottomY:  medBottomY,
    heightPx,
    heightMm: parseFloat((heightPx / pxPerMm).toFixed(1)),
    heelBbox,
  };
}
