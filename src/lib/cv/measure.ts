import type { BBox, HeelMeasurement } from "./types";

const MIN_COLLAR_COLUMNS = 3;  // min columns with valid collar top
const MIN_SOLE_COLUMNS   = 3;  // min columns with valid sole bottom
const NOISE_SKIP         = 2;  // ignore outermost N px to skip JPEG fringing

// Heel collar sits in the rearmost ~8% of shoe width.
// Using a narrow strip at the extreme heel end isolates the collar
// from mid-shoe features (tongue, padding bumps, ankle tab edge).
const COLLAR_FRAC = 0.08;

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

export function measureHeel(
  frame:     ImageData,
  heelBbox:  BBox,
  _shoeBbox: BBox,   // kept for API compatibility
  pxPerMm:   number,
): HeelMeasurement | null {
  const { x: bx, y: by, w: bw, h: bh } = heelBbox;

  // ── Step 1: Collar top — scan narrow strip at extreme heel end ──────────
  //
  // The heel collar opening is at the rearmost edge of the shoe.
  // heelBbox is already positioned at the heel end (by findHeelSide).
  // We take only the rear COLLAR_FRAC of that bbox to get a tight column
  // directly over the collar rim, away from mid-shoe body features.
  //
  // heelBbox.side = "left"  → heel is on the LEFT  side of shoe → collar at heelBbox.x (left edge)
  // heelBbox.side = "right" → heel is on the RIGHT side of shoe → collar at heelBbox.x+w (right edge)
  //
  // Since we don't have side info here, we scan ALL columns and take the
  // topmost COLLAR_FRAC (smallest Y) rows — those come from the heel end.

  const gray  = regionGray(frame, heelBbox);
  const darkT = Math.min(otsu(gray), 160);  // generous cap; dark leather can be 100–150
  const bgT   = 210;                         // definitely background (wall, table surface)

  // Collect per-column first-dark-pixel and last-non-bg-pixel
  const collarRows: number[] = [];
  const soleRows:   number[] = [];

  for (let rx = 0; rx < bw; rx++) {
    let firstDark = -1;
    let lastNonBg = -1;

    for (let ry = NOISE_SKIP; ry < bh - NOISE_SKIP; ry++) {
      if (gray[ry * bw + rx] <= darkT) { firstDark = ry; break; }
    }
    if (firstDark < 0) continue;

    for (let ry = bh - 1 - NOISE_SKIP; ry > firstDark; ry--) {
      if (gray[ry * bw + rx] < bgT) { lastNonBg = ry; break; }
    }
    if (lastNonBg < 0) lastNonBg = firstDark;

    collarRows.push(by + firstDark);
    soleRows.push(by + lastNonBg);
  }

  if (collarRows.length < MIN_COLLAR_COLUMNS) return null;
  if (soleRows.length   < MIN_SOLE_COLUMNS)   return null;

  // ── Step 2: Collar top — use the HIGHEST (lowest Y) readings ───────────
  //
  // The heel collar opening is the topmost feature of the heel region.
  // Mid-shoe columns will also report a top-pixel, but it will be lower
  // (larger Y) than the true collar top. By taking the 20th percentile
  // (near-minimum) of collarRows rather than the median, we reliably
  // land on the collar rim without being dragged down by body columns.
  //
  // 20th percentile = sort ascending, take index at 20% of length.
  // This filters out stray high noise pixels while capturing the true
  // top of the collar opening.

  const sortedCollar = [...collarRows].sort((a, b) => a - b);
  const p20idx = Math.max(0, Math.floor(sortedCollar.length * 0.20) - 1);
  const medTopY = sortedCollar[p20idx];

  // ── Step 3: Sole bottom — use median (robust to noise at sole edge) ────
  const medBottomY = Math.round(median(soleRows));

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
