import type { BBox, DetectedShoe, ShoeDetectionResult } from "./types";
import { frameToGrayscale } from "./frame";

// ─── Tunables ─────────────────────────────────────────────────────────────────
const CLOSE_RADIUS    = 12;     // morphological close to fill gaps in shoe outline
const MIN_AREA_FRAC   = 0.005;  // blob ≥ 0.5% of frame area
const MAX_AREA_FRAC   = 0.55;   // blob ≤ 55% of frame area
const MIN_ASPECT      = 1.1;    // shoes are wider than tall
const MAX_ASPECT      = 9.0;
const BORDER_PAD_FRAC = 0.01;

// ─── Otsu's threshold ─────────────────────────────────────────────────────────
// Finds the optimal global threshold to separate dark foreground from light background.
// Works well for dark shoes on light/neutral backgrounds.
function otsuThreshold(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sumB = 0, wB = 0, sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v  = wB * wF * (mB - mF) ** 2;
    if (v > maxVar) { maxVar = v; threshold = t; }
  }
  return threshold;
}

// ─── Gaussian blur 3×3 ────────────────────────────────────────────────────────
function blur3(gray: Uint8Array, w: number, h: number): Uint8Array {
  const k = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const out = new Uint8Array(gray.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          s += gray[(y + dy) * w + (x + dx)] * k[(dy + 1) * 3 + (dx + 1)];
      out[y * w + x] = s >> 4;
    }
  }
  for (let x = 0; x < w; x++) { out[x] = gray[x]; out[(h-1)*w+x] = gray[(h-1)*w+x]; }
  for (let y = 0; y < h; y++) { out[y*w] = gray[y*w]; out[y*w+w-1] = gray[y*w+w-1]; }
  return out;
}

// ─── Morphological close ──────────────────────────────────────────────────────
function morphOp(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
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

function morphClose(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morphOp(morphOp(bin, w, h, r, true), w, h, r, false);
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
      const up   = y > 0 ? labels[(y-1)*w+x] : 0;
      const left = x > 0 ? labels[idx-1]      : 0;
      if (!up && !left) {
        labels[idx] = nextLabel;
        parent.push(nextLabel);
        nextLabel++;
      } else if (up && !left) { labels[idx] = up; }
        else if (!up && left) { labels[idx] = left; }
        else { labels[idx] = up; union(up, left); }
    }
  }

  const comps = new Map<number, Component>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lbl = labels[y * w + x];
      if (!lbl) continue;
      const root = find(lbl);
      let c = comps.get(root);
      if (!c) { c = { minX: x, maxX: x, minY: y, maxY: y, area: 0 }; comps.set(root, c); }
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

  const gray    = frameToGrayscale(frame);
  const blurred = blur3(gray, w, h);

  // Otsu threshold: marks dark objects (shoes) as foreground
  const t      = otsuThreshold(blurred);
  const binary = new Uint8Array(w * h);
  for (let i = 0; i < blurred.length; i++) binary[i] = blurred[i] <= t ? 1 : 0;

  const closed = morphClose(binary, w, h, CLOSE_RADIUS);
  const comps  = connectedComponents(closed, w, h);

  const candidates: DetectedShoe[] = comps
    .filter(c => {
      const bw     = c.maxX - c.minX + 1;
      const bh     = c.maxY - c.minY + 1;
      const aspect = bw / bh;
      return (
        c.area > frameArea * MIN_AREA_FRAC &&
        c.area < frameArea * MAX_AREA_FRAC &&
        aspect > MIN_ASPECT &&
        aspect < MAX_ASPECT &&
        c.minX > borderX    &&
        c.maxX < w - borderX &&
        c.minY > borderY    &&
        c.maxY < h - borderY
      );
    })
    .map(c => ({
      bbox:       { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 },
      confidence: 1.0,
    }));

  if (candidates.length < 2) return { found: false, left: null, right: null };

  // Two largest blobs by filled area (most foreground pixels)
  candidates.sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  const top2 = candidates.slice(0, 2);
  top2.sort((a, b) => (a.bbox.x + a.bbox.w / 2) - (b.bbox.x + b.bbox.w / 2));

  const [left, right] = top2;

  // x-centers must be meaningfully separated
  const leftCx  = left.bbox.x  + left.bbox.w  / 2;
  const rightCx = right.bbox.x + right.bbox.w / 2;
  if (rightCx - leftCx < w * 0.08) return { found: false, left: null, right: null };

  return { found: true, left, right };
}

// ─── Foreground mask for heel measurement ────────────────────────────────────
// Within shoe bbox, marks pixels darker than Otsu threshold as foreground.
// This catches the dark shoe body (heel collar area) reliably.
export function extractForeground(
  frame:     ImageData,
  bbox:      BBox,
): Uint8Array {
  const { data, width: fw } = frame;
  const { x: bx, y: by, w: bw, h: bh } = bbox;

  // Sample grayscale values in the bbox to compute local Otsu threshold
  const samples = new Uint8Array(bw * bh);
  for (let ry = 0; ry < bh; ry++) {
    for (let rx = 0; rx < bw; rx++) {
      const fi = ((by + ry) * fw + (bx + rx)) * 4;
      samples[ry * bw + rx] = (data[fi] * 77 + data[fi+1] * 150 + data[fi+2] * 29) >> 8;
    }
  }

  const t    = otsuThreshold(samples);
  const mask = new Uint8Array(bw * bh);
  for (let i = 0; i < samples.length; i++) mask[i] = samples[i] <= t ? 1 : 0;
  return mask;
}
