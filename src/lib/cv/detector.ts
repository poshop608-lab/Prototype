// Deterministic shoe detector.
// Algorithm: grayscale → CLAHE-lite → Gaussian blur → adaptive threshold →
//            morphological close → connected components → aspect-ratio filter →
//            pick two largest blobs → sort left/right.
//
// Color-independent: operates on luminance contrast only.
// Implements ShoeDetector interface — swap with YOLO by replacing this file.

import type { BBox, DetectedShoe, ShoeDetectionResult } from "./types";
import { frameToGrayscale } from "./frame";

// ─── Tunables ─────────────────────────────────────────────────────────────────
// Expressed as fractions of frame dimensions so they scale with resolution.
const ADAPTIVE_BLOCK   = 51;      // px — local neighbourhood for threshold
const ADAPTIVE_C       = 4;       // constant subtracted from local mean (lower = more sensitive)
const CLOSE_RADIUS     = 10;      // morphological close kernel radius (px)
const MIN_AREA_FRAC    = 0.008;   // blob must be ≥0.8% of frame area
const MAX_AREA_FRAC    = 0.60;    // blob must be ≤60% of frame area
const MIN_ASPECT       = 1.2;     // width/height: shoes are always wider than tall
const MAX_ASPECT       = 8.0;
const BORDER_PAD_FRAC  = 0.01;    // blobs touching within 1% of frame edge = invalid

// ─── Grayscale CLAHE-lite (per-tile contrast stretch) ────────────────────────
// Divides image into tiles, stretches each tile's histogram independently.
// Cancels global auto-exposure changes and dark-shoe-on-dark-bg problems.
function clahe(gray: Uint8Array, w: number, h: number, tileW = 64, tileH = 64): Uint8Array {
  const out = new Uint8Array(gray.length);
  const cols = Math.ceil(w / tileW);
  const rows = Math.ceil(h / tileH);

  for (let tr = 0; tr < rows; tr++) {
    for (let tc = 0; tc < cols; tc++) {
      const x0 = tc * tileW, y0 = tr * tileH;
      const x1 = Math.min(x0 + tileW, w);
      const y1 = Math.min(y0 + tileH, h);

      let mn = 255, mx = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = gray[y * w + x];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      const range = mx - mn || 1;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          out[y * w + x] = Math.round(((gray[y * w + x] - mn) / range) * 255);
        }
      }
    }
  }
  return out;
}

// ─── Gaussian blur 3×3 ────────────────────────────────────────────────────────
function blur3(gray: Uint8Array, w: number, h: number): Uint8Array {
  const k = [1, 2, 1, 2, 4, 2, 1, 2, 1]; // kernel (sum=16)
  const out = new Uint8Array(gray.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          s += gray[(y + dy) * w + (x + dx)] * k[(dy + 1) * 3 + (dx + 1)];
        }
      }
      out[y * w + x] = s >> 4;
    }
  }
  // Copy border pixels unchanged
  for (let x = 0; x < w; x++) { out[x] = gray[x]; out[(h - 1) * w + x] = gray[(h - 1) * w + x]; }
  for (let y = 0; y < h; y++) { out[y * w] = gray[y * w]; out[y * w + w - 1] = gray[y * w + w - 1]; }
  return out;
}

// ─── Adaptive threshold (local mean − C) ─────────────────────────────────────
// Uses a box-filter integral image for O(1) per-pixel neighbourhood mean.
function adaptiveThreshold(gray: Uint8Array, w: number, h: number): Uint8Array {
  const half = Math.floor(ADAPTIVE_BLOCK / 2);
  // Build integral image (sum table)
  const ii = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ii[(y + 1) * (w + 1) + (x + 1)] =
        gray[y * w + x] +
        ii[y * (w + 1) + (x + 1)] +
        ii[(y + 1) * (w + 1) + x] -
        ii[y * (w + 1) + x];
    }
  }

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      const count = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum   = ii[(y1 + 1) * (w + 1) + (x1 + 1)]
                  - ii[y0       * (w + 1) + (x1 + 1)]
                  - ii[(y1 + 1) * (w + 1) + x0]
                  + ii[y0       * (w + 1) + x0];
      const mean = sum / count;
      const diff = gray[y * w + x] - mean;
      // Foreground = darker OR brighter than local mean by threshold
      // Captures both dark shoe bodies and bright white soles against mid-tone backgrounds
      out[y * w + x] = (diff < -ADAPTIVE_C || diff > ADAPTIVE_C * 3) ? 1 : 0;
    }
  }
  return out;
}

// ─── Morphological close (dilate then erode) ──────────────────────────────────
// Fills gaps in broken shoe outlines (shoelaces, gaps between shoe parts).
function morphClose(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const dilated = morphOp(bin, w, h, r, true);
  return morphOp(dilated, w, h, r, false);
}

function morphOp(
  src: Uint8Array, w: number, h: number, r: number, dilate: boolean,
): Uint8Array {
  const out = new Uint8Array(src.length);
  const target = dilate ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = !dilate;
      outer: for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (src[ny * w + nx] === target) { hit = dilate; break outer; }
        }
      }
      out[y * w + x] = hit ? 1 : 0;
    }
  }
  return out;
}

// ─── Connected components (union-find, 4-connectivity) ───────────────────────
interface Component {
  minX: number; maxX: number; minY: number; maxY: number; area: number;
}

function connectedComponents(bin: Uint8Array, w: number, h: number): Component[] {
  const labels = new Int32Array(w * h);
  const parent: number[] = [];

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }

  let nextLabel = 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!bin[idx]) continue;

      const up   = y > 0     ? labels[(y - 1) * w + x] : 0;
      const left = x > 0     ? labels[idx - 1]          : 0;

      if (!up && !left) {
        labels[idx] = nextLabel;
        parent.push(nextLabel); // parent[nextLabel] = nextLabel
        nextLabel++;
      } else if (up && !left) {
        labels[idx] = up;
      } else if (!up && left) {
        labels[idx] = left;
      } else {
        labels[idx] = up;
        union(up, left);
      }
    }
  }

  // Second pass: collect bounding boxes
  const comps = new Map<number, Component>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lbl = labels[y * w + x];
      if (!lbl) continue;
      const root = find(lbl);
      let c = comps.get(root);
      if (!c) {
        c = { minX: x, maxX: x, minY: y, maxY: y, area: 0 };
        comps.set(root, c);
      }
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      c.area++;
    }
  }
  return Array.from(comps.values());
}

// ─── Public detector ──────────────────────────────────────────────────────────
export function detectShoes(frame: ImageData): ShoeDetectionResult {
  const { width: w, height: h } = frame;
  const frameArea = w * h;
  const borderX   = Math.round(w * BORDER_PAD_FRAC);
  const borderY   = Math.round(h * BORDER_PAD_FRAC);

  const raw       = frameToGrayscale(frame);
  const stretched = clahe(raw, w, h);
  const blurred   = blur3(stretched, w, h);
  const binary    = adaptiveThreshold(blurred, w, h);
  const closed    = morphClose(binary, w, h, CLOSE_RADIUS);
  const comps     = connectedComponents(closed, w, h);

  const candidates: DetectedShoe[] = comps
    .filter(c => {
      const bw     = c.maxX - c.minX + 1;
      const bh     = c.maxY - c.minY + 1;
      const aspect = bw / bh;
      const area   = c.area;
      return (
        area   > frameArea * MIN_AREA_FRAC &&
        area   < frameArea * MAX_AREA_FRAC &&
        aspect > MIN_ASPECT               &&
        aspect < MAX_ASPECT               &&
        c.minX > borderX                  &&
        c.maxX < w - borderX              &&
        c.minY > borderY                  &&
        c.maxY < h - borderY
      );
    })
    .map(c => ({
      bbox:       { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 },
      confidence: 1.0,
    }));

  if (candidates.length < 2) {
    return { found: false, left: null, right: null };
  }

  // Pick two largest by bbox area
  candidates.sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  const top2 = candidates.slice(0, 2);

  // Sort left/right by x-center
  top2.sort((a, b) => (a.bbox.x + a.bbox.w / 2) - (b.bbox.x + b.bbox.w / 2));

  const [left, right] = top2;

  // Sanity: x-centers must be separated (not the same object split in two)
  const leftCx  = left.bbox.x  + left.bbox.w  / 2;
  const rightCx = right.bbox.x + right.bbox.w / 2;
  if (rightCx - leftCx < w * 0.08) {
    return { found: false, left: null, right: null };
  }

  return { found: true, left, right };
}

// Foreground mask for a single shoe bbox (used by heel measurement).
// Returns a Uint8Array where 1 = foreground relative to the FRAME's local contrast.
// Color-independent: a pixel is foreground if it differs from the local mean by > threshold.
export function extractForeground(
  frame:      ImageData,
  bbox:       BBox,
  blockSize = 31,
  threshold = 10,
): Uint8Array {
  const { data, width: fw } = frame;
  const { x: bx, y: by, w: bw, h: bh } = bbox;
  const mask = new Uint8Array(bw * bh);

  for (let ry = 0; ry < bh; ry++) {
    for (let rx = 0; rx < bw; rx++) {
      const fx = bx + rx;
      const fy = by + ry;
      const fi = (fy * fw + fx) * 4;
      const pix = (data[fi] * 77 + data[fi + 1] * 150 + data[fi + 2] * 29) >> 8;

      // Local mean in a small neighbourhood
      const half  = Math.floor(blockSize / 2);
      let sum = 0, n = 0;
      for (let dy = -half; dy <= half; dy += 3) {
        const ny = fy + dy;
        if (ny < 0 || ny >= frame.height) continue;
        for (let dx = -half; dx <= half; dx += 3) {
          const nx = fx + dx;
          if (nx < 0 || nx >= fw) continue;
          const ni = (ny * fw + nx) * 4;
          sum += (data[ni] * 77 + data[ni + 1] * 150 + data[ni + 2] * 29) >> 8;
          n++;
        }
      }
      const localMean = n > 0 ? sum / n : 128;
      // Foreground = significantly different from local mean (either darker OR lighter)
      mask[ry * bw + rx] = Math.abs(pix - localMean) > threshold ? 1 : 0;
    }
  }
  return mask;
}
