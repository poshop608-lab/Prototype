import type { BBox, DetectedShoe, ShoeDetectionResult } from "./types";
import { frameToGrayscale } from "./frame";

// ─── Tunables ─────────────────────────────────────────────────────────────────
const CLOSE_RADIUS    = 18;    // large close to merge fragmented shoe uppers
const MIN_AREA_FRAC   = 0.03;  // single shoe upper ≥ 3% of frame
const MAX_AREA_FRAC   = 0.70;  // merged pair blob can be large; filtered separately
const MIN_ASPECT      = 0.8;   // dark upper alone can be ~square
const MAX_ASPECT      = 10.0;
const BORDER_PAD_FRAC = 0.005; // very thin border exclusion

// ─── Otsu's threshold ─────────────────────────────────────────────────────────
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
  const k = [1,2,1,2,4,2,1,2,1];
  const out = new Uint8Array(gray.length);
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          s += gray[(y+dy)*w+(x+dx)] * k[(dy+1)*3+(dx+1)];
      out[y*w+x] = s >> 4;
    }
  for (let x = 0; x < w; x++) { out[x]=gray[x]; out[(h-1)*w+x]=gray[(h-1)*w+x]; }
  for (let y = 0; y < h; y++) { out[y*w]=gray[y*w]; out[y*w+w-1]=gray[y*w+w-1]; }
  return out;
}

// ─── Morphological ops ────────────────────────────────────────────────────────
function morphOp(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(src.length);
  const target = dilate ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = !dilate;
      outer: for (let dy = -r; dy <= r; dy++) {
        const ny = y+dy; if (ny<0||ny>=h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x+dx; if (nx<0||nx>=w) continue;
          if (src[ny*w+nx]===target) { hit=dilate; break outer; }
        }
      }
      out[y*w+x] = hit ? 1 : 0;
    }
  }
  return out;
}

function morphClose(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morphOp(morphOp(bin, w, h, r, true), w, h, r, false);
}

// ─── Connected components (union-find) ────────────────────────────────────────
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
      const idx = y*w+x;
      if (!bin[idx]) continue;
      const up   = y > 0 ? labels[(y-1)*w+x] : 0;
      const left = x > 0 ? labels[idx-1]      : 0;
      if (!up && !left) { labels[idx]=nextLabel; parent.push(nextLabel); nextLabel++; }
      else if (up  && !left) labels[idx] = up;
      else if (!up && left)  labels[idx] = left;
      else { labels[idx]=up; union(up,left); }
    }
  }

  const comps = new Map<number, Component>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lbl = labels[y*w+x]; if (!lbl) continue;
      const root = find(lbl);
      let c = comps.get(root);
      if (!c) { c={minX:x,maxX:x,minY:y,maxY:y,area:0}; comps.set(root,c); }
      if (x<c.minX) c.minX=x; if (x>c.maxX) c.maxX=x;
      if (y<c.minY) c.minY=y; if (y>c.maxY) c.maxY=y;
      c.area++;
    }
  }
  return Array.from(comps.values());
}

// ─── Vertical valley split ────────────────────────────────────────────────────
// If two shoes merged into one blob, find the vertical column with least
// foreground pixels between x0 and x1, split there.
function findValley(bin: Uint8Array, w: number, minX: number, maxX: number, minY: number, maxY: number): number {
  let valleyX = Math.floor((minX + maxX) / 2);
  let minFill = Infinity;
  const mid = Math.floor((minX + maxX) / 2);
  const searchW = Math.floor((maxX - minX) * 0.25); // search middle 50%
  for (let x = mid - searchW; x <= mid + searchW; x++) {
    let fill = 0;
    for (let y = minY; y <= maxY; y++) fill += bin[y * w + x];
    if (fill < minFill) { minFill = fill; valleyX = x; }
  }
  return valleyX;
}

// ─── Expand bbox to include sole ─────────────────────────────────────────────
// The dark upper detection doesn't capture the white sole.
// Extend the bbox bottom to near the frame bottom to include the full shoe height.
function expandToSole(bbox: BBox, frameH: number, borderY: number): BBox {
  return { ...bbox, h: (frameH - borderY) - bbox.y };
}

// ─── Public detector ──────────────────────────────────────────────────────────
export function detectShoes(frame: ImageData): ShoeDetectionResult {
  const { width: w, height: h } = frame;
  const frameArea = w * h;
  const borderX   = Math.round(w * BORDER_PAD_FRAC);
  const borderY   = Math.round(h * BORDER_PAD_FRAC);

  const gray    = frameToGrayscale(frame);
  const blurred = blur3(gray, w, h);

  // Use Otsu to find the dark/light split, but cap at 140 to avoid
  // thresholding bright soles and wall as foreground.
  const t      = Math.min(otsuThreshold(blurred), 140);
  const binary = new Uint8Array(w * h);
  for (let i = 0; i < blurred.length; i++) binary[i] = blurred[i] <= t ? 1 : 0;

  const closed = morphClose(binary, w, h, CLOSE_RADIUS);
  const comps  = connectedComponents(closed, w, h);

  // Filter: pick blobs that could be one shoe OR a merged pair
  const valid = comps.filter(c => {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const aspect = bw / bh;
    return (
      c.area > frameArea * MIN_AREA_FRAC &&
      c.area < frameArea * MAX_AREA_FRAC &&
      aspect > MIN_ASPECT &&
      aspect < MAX_ASPECT &&
      c.minX > borderX    &&
      c.maxX < w - borderX &&
      c.minY > borderY
    );
  });

  // Sort by area descending
  valid.sort((a, b) => b.area - a.area);

  let left: DetectedShoe | null  = null;
  let right: DetectedShoe | null = null;

  // Helper: does blob A horizontally contain blob B (B is a sub-region of A)?
  function contains(a: Component, b: Component): boolean {
    return b.minX >= a.minX - 10 && b.maxX <= a.maxX + 10;
  }

  // Case A: two truly separate blobs — neither contains the other
  // Must be non-overlapping in X (each shoe occupies its own half)
  const nonContained = valid.filter((c, i) =>
    !valid.slice(0, i).some(bigger => contains(bigger, c))
  );

  if (nonContained.length >= 2) {
    const top2 = nonContained.slice(0, 2);
    top2.sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX));
    const [l, r] = top2;
    // Check they don't significantly overlap in X
    const overlapX = Math.max(0, l.maxX - r.minX);
    const minWidth = Math.min(l.maxX - l.minX, r.maxX - r.minX);
    if (overlapX < minWidth * 0.3) {
      left  = { bbox: expandToSole({ x: l.minX, y: l.minY, w: l.maxX-l.minX+1, h: l.maxY-l.minY+1 }, h, borderY), confidence: 1 };
      right = { bbox: expandToSole({ x: r.minX, y: r.minY, w: r.maxX-r.minX+1, h: r.maxY-r.minY+1 }, h, borderY), confidence: 1 };
    }
  }

  // Case B: largest blob is a merged pair (wide aspect) — valley split
  if ((!left || !right) && valid.length >= 1) {
    const merged = valid[0];
    const bw = merged.maxX - merged.minX + 1;
    const bh = merged.maxY - merged.minY + 1;
    // A merged pair fills most of the frame width and has high aspect ratio
    if (bw > w * 0.30) {
      const valleyX = findValley(closed, w, merged.minX, merged.maxX, merged.minY, merged.maxY);
      const lBbox = expandToSole({ x: merged.minX, y: merged.minY, w: valleyX - merged.minX,      h: bh }, h, borderY);
      const rBbox = expandToSole({ x: valleyX,     y: merged.minY, w: merged.maxX - valleyX + 1,  h: bh }, h, borderY);
      if (lBbox.w > w * 0.10 && rBbox.w > w * 0.10) {
        left  = { bbox: lBbox, confidence: 0.85 };
        right = { bbox: rBbox, confidence: 0.85 };
      }
    }
  }

  if (!left || !right) return { found: false, left: null, right: null };
  return { found: true, left, right };
}

// ─── Foreground mask for heel measurement ────────────────────────────────────
// Uses local Otsu within the shoe bbox to find the dark shoe body.
export function extractForeground(frame: ImageData, bbox: BBox): Uint8Array {
  const { data, width: fw } = frame;
  const { x: bx, y: by, w: bw, h: bh } = bbox;

  const samples = new Uint8Array(bw * bh);
  for (let ry = 0; ry < bh; ry++) {
    for (let rx = 0; rx < bw; rx++) {
      const fi = ((by+ry)*fw + (bx+rx)) * 4;
      samples[ry*bw+rx] = (data[fi]*77 + data[fi+1]*150 + data[fi+2]*29) >> 8;
    }
  }

  const t = Math.min(otsuThreshold(samples), 140);
  const mask = new Uint8Array(bw * bh);
  for (let i = 0; i < samples.length; i++) mask[i] = samples[i] <= t ? 1 : 0;
  return mask;
}
