import type { BBox, HeelMeasurement } from "./types";

const NOISE_SKIP = 2;

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
  blobMaxY:  number,
  pxPerMm:   number,
): HeelMeasurement | null {
  const { x: bx, y: by, w: bw, h: bh } = heelBbox;

  const gray  = regionGray(frame, heelBbox);
  const darkT = Math.min(otsu(gray), 160);

  // ── Step 1: Bottom of outsole ──────────────────────────────────────────────
  //
  // Problem: blob detection includes the dark table surface (dark shoes on dark
  // table merge into one blob). blobMaxY is the bottom of the merged blob,
  // which is the table, not the shoe outsole.
  //
  // Solution: build a per-row fill profile across the full heelBbox height,
  // then find the outsole bottom as the LAST LOCAL PEAK before fill drops.
  //
  // Profile shape (top → bottom):
  //   near-zero     → empty air above shoe
  //   rising         → ankle/throat area
  //   plateau        → heel body (shoe)
  //   sharp drop     → outsole bottom edge / transition to surface
  //   rises again    → table/surface pixels  ← DO NOT INCLUDE
  //
  // We find the outsole bottom by scanning upward from blobMaxY and stopping
  // at the first row where: (a) fill is >= shoe-body fill level AND
  // (b) the rows immediately above have significantly higher fill (peak).
  //
  // Concretely: build smoothed fill profile, scan bottom-up from blobMaxY,
  // find where the profile transitions from low (table gap or transition) to
  // the shoe body — that boundary row is the outsole bottom.
  //
  // If no table is present (light background), the profile drops to near-zero
  // below the outsole and the scan correctly finds the lowest non-zero row.

  const scanBottomRow = Math.min(bh - 1 - NOISE_SKIP, blobMaxY - by);

  // Build per-row fill profile for the full heelBbox
  const fillProfile = new Int32Array(bh);
  for (let ry = 0; ry < bh; ry++) {
    let count = 0;
    for (let rx = 0; rx < bw; rx++) {
      if (gray[ry * bw + rx] <= darkT) count++;
    }
    fillProfile[ry] = count;
  }
  const smoothedFill = smooth(fillProfile, 4);

  // Find the shoe body's characteristic fill level = median of the middle 40%
  // of the heelBbox (where the heel body rows are most reliably sampled)
  const midStart = Math.floor(bh * 0.20);
  const midEnd   = Math.floor(bh * 0.60);
  const midFills: number[] = [];
  for (let ry = midStart; ry <= midEnd; ry++) midFills.push(smoothedFill[ry]);
  const shoeBodyFill = median(midFills.map(Math.round));

  // Minimum threshold to count as "shoe pixel row" = 25% of shoe body fill
  const soleThresh = Math.max(2, shoeBodyFill * 0.25);

  // Scan upward from blobMaxY. Find the lowest row that:
  //   1. Has fill >= soleThresh (is part of the shoe, not empty air)
  //   2. Is followed above by at least 3 consecutive rows also above threshold
  //      (prevents landing on a table-edge noise row)
  let soleRow = -1;
  for (let ry = scanBottomRow; ry >= NOISE_SKIP + 3; ry--) {
    if (smoothedFill[ry] >= soleThresh) {
      // Check that rows above are also shoe rows (not a noise spike)
      let consecutiveAbove = 0;
      for (let k = 1; k <= 4; k++) {
        if (ry - k >= 0 && smoothedFill[ry - k] >= soleThresh) consecutiveAbove++;
      }
      if (consecutiveAbove >= 3) { soleRow = ry; break; }
    }
  }

  // Fallback: lowest row with any dark pixels, capped to blobMaxY
  if (soleRow < 0) {
    for (let ry = scanBottomRow; ry >= NOISE_SKIP; ry--) {
      if (fillProfile[ry] >= 2) { soleRow = ry; break; }
    }
  }
  if (soleRow < 0) return null;

  const medBottomY = by + soleRow;

  // ── Step 2: Heel collar top ────────────────────────────────────────────────
  const topY = computeTopY(gray, bw, bh, darkT, by, NOISE_SKIP);
  if (topY === null) return null;

  return buildResult(medBottomY, heelBbox, pxPerMm, topY);
}

function computeTopY(
  gray: Uint8Array, bw: number, bh: number, darkT: number, by: number, noiseSkip: number,
): number | null {
  const profile  = rowWidthProfile(gray, bw, bh, darkT);
  const smoothed = smooth(profile, 5);

  let shoeTopRow = -1;
  for (let ry = noiseSkip; ry < bh - noiseSkip; ry++) {
    if (profile[ry] >= 2) { shoeTopRow = ry; break; }
  }
  if (shoeTopRow < 0) return null;

  const searchEnd = Math.min(bh - noiseSkip, shoeTopRow + Math.round(bh * 0.55));

  let peakWidth = 0;
  for (let ry = shoeTopRow; ry <= searchEnd; ry++) {
    if (smoothed[ry] > peakWidth) peakWidth = smoothed[ry];
  }
  if (peakWidth === 0) return null;

  // 70% threshold: collar rim is the rising edge of the heel body
  const threshold = peakWidth * 0.70;
  let collarRow   = shoeTopRow;
  for (let ry = shoeTopRow; ry <= searchEnd; ry++) {
    if (smoothed[ry] >= threshold) { collarRow = ry; break; }
  }

  return by + collarRow;
}

function buildResult(
  medBottomY: number, heelBbox: BBox, pxPerMm: number, topY: number,
): HeelMeasurement | null {
  const heightPx = medBottomY - topY;
  if (heightPx <= 0) return null;
  return {
    topY,
    bottomY:  medBottomY,
    heightPx,
    heightMm: parseFloat((heightPx / pxPerMm).toFixed(1)),
    heelBbox,
  };
}
