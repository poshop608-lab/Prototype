import type { BBox, HeelMeasurement } from "./types";

const MIN_COLUMNS = 4;   // minimum columns that must have valid top+bottom
const NOISE_SKIP  = 2;   // ignore top/bottom N px of bbox to skip jpeg artifacts

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── Grayscale from RGBA ImageData for a sub-region ──────────────────────────
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

// ─── Simple Otsu within array ─────────────────────────────────────────────────
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

// ─── Core measurement ─────────────────────────────────────────────────────────
//
// Strategy: scan the heel column (heelBbox) pixel-by-pixel.
// For each horizontal column of pixels:
//   topRow    = first row where pixel is "shoe" (dark upper or any shoe body)
//   bottomRow = last  row where pixel is "shoe" (includes white sole)
//
// We use TWO thresholds from the same column:
//   darkT  = Otsu on the column → catches dark upper
//   lightT = a fixed generous threshold → also catches white/light sole
//
// A pixel belongs to the shoe if it is either:
//   (a) darker  than darkT  (dark upper, midsole seam)
//   (b) lighter than lightT AND below the dark-upper top (white sole region)
//
// This way:
//   topY    = top of heel collar (dark upper top edge)
//   bottomY = bottom of white outsole (last non-background pixel)
//
// Both landmarks come from actual shoe pixels — no frame reference.

export function measureHeel(
  frame:    ImageData,
  heelBbox: BBox,
  _shoeBbox: BBox,       // kept for API compatibility — no longer used
  pxPerMm:  number,
): HeelMeasurement | null {
  const { width: fw } = frame;
  const { x: bx, y: by, w: bw, h: bh } = heelBbox;

  // Sample grayscale for the full heel column
  const gray = regionGray(frame, heelBbox);

  // Global Otsu on this region to separate dark upper from background
  const darkT = Math.min(otsu(gray), 150);

  // Background threshold: sky/wall/table is usually > 180 in typical factory settings.
  // Anything below 200 could be part of the shoe (dark upper or coloured sole).
  // We use 200 as a generous "definitely background" cutoff.
  const bgT = 200;

  const topRows:    number[] = [];
  const bottomRows: number[] = [];

  for (let rx = 0; rx < bw; rx++) {
    let firstShoe = -1;
    let lastShoe  = -1;

    // Phase 1: find the dark-upper top (scan top → bottom, look for dark pixels)
    for (let ry = NOISE_SKIP; ry < bh - NOISE_SKIP; ry++) {
      const v = gray[ry * bw + rx];
      if (v <= darkT) { firstShoe = ry; break; }
    }

    if (firstShoe < 0) continue; // no dark pixel in this column — skip

    // Phase 2: find outsole bottom (scan bottom → top, look for any non-background pixel)
    // This catches white/cream soles that are above darkT
    for (let ry = bh - 1 - NOISE_SKIP; ry > firstShoe; ry--) {
      const v = gray[ry * bw + rx];
      if (v < bgT) { lastShoe = ry; break; }
    }

    if (lastShoe < 0) lastShoe = firstShoe; // sole not found, use upper bottom as fallback

    topRows.push(by + firstShoe);
    bottomRows.push(by + lastShoe);
  }

  if (topRows.length < MIN_COLUMNS) return null;

  const medTopY    = Math.round(median(topRows));
  const medBottomY = Math.round(median(bottomRows));
  const heightPx   = medBottomY - medTopY;

  if (heightPx <= 0) return null;

  return {
    topY:     medTopY,
    bottomY:  medBottomY,
    heightPx,
    heightMm: parseFloat((heightPx / pxPerMm).toFixed(1)),
    heelBbox,
  };
}
