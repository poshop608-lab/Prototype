import type { BBox, DetectedShoe, ShoeDetectionResult } from "./types";
import { frameToGrayscale } from "./frame";

// ─── Core image ops ───────────────────────────────────────────────────────────

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

// Histogram equalization — helps low-contrast scenes (dark shoes on dark table)
function histEq(gray: Uint8Array): Uint8Array {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const cdf = new Int32Array(256);
  cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i-1] + hist[i];
  const minCdf = cdf.find(v => v > 0) ?? 1;
  const scale  = 255 / (gray.length - minCdf);
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++)
    out[i] = Math.round((cdf[gray[i]] - minCdf) * scale);
  return out;
}

// Sobel magnitude — edge-based; works when colour contrast is low
function sobelMag(gray: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let y = 1; y < h-1; y++) {
    for (let x = 1; x < w-1; x++) {
      const gx =
        -gray[(y-1)*w+(x-1)] - 2*gray[y*w+(x-1)] - gray[(y+1)*w+(x-1)] +
         gray[(y-1)*w+(x+1)] + 2*gray[y*w+(x+1)] + gray[(y+1)*w+(x+1)];
      const gy =
        -gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)] +
         gray[(y+1)*w+(x-1)] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+(x+1)];
      out[y*w+x] = Math.min(255, Math.round(Math.sqrt(gx*gx + gy*gy)));
    }
  }
  return out;
}

function morphOp(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const out    = new Uint8Array(src.length);
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

// ─── Connected components ─────────────────────────────────────────────────────

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
      const idx  = y*w+x;
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

// ─── Valley split ─────────────────────────────────────────────────────────────

function findValley(bin: Uint8Array, w: number, minX: number, maxX: number, minY: number, maxY: number): number {
  // Search middle 60% of blob width for the thinnest vertical column
  const mid      = Math.floor((minX + maxX) / 2);
  const searchW  = Math.floor((maxX - minX) * 0.30);
  let valleyX    = mid;
  let minFill    = Infinity;
  for (let x = mid - searchW; x <= mid + searchW; x++) {
    let fill = 0;
    for (let y = minY; y <= maxY; y++) fill += bin[y * w + x];
    if (fill < minFill) { minFill = fill; valleyX = x; }
  }
  return valleyX;
}

function expandToSole(bbox: BBox, frameH: number, borderY: number): BBox {
  return { ...bbox, h: (frameH - borderY) - bbox.y };
}

// ─── Blob → shoe pair extraction ─────────────────────────────────────────────
// Given a set of valid blobs, try to find left+right shoe pair.
// Returns [left, right] or null.

interface AttemptResult {
  left: DetectedShoe;
  right: DetectedShoe;
  confidence: number;
}

function blobsToShoes(
  comps: Component[],
  closed: Uint8Array,
  w: number,
  h: number,
  borderY: number,
  minAreaFrac: number,
  maxAreaFrac: number,
  minAspect: number,
  maxAspect: number,
  borderX: number,
  label: string,
): AttemptResult | null {
  const frameArea = w * h;

  const valid = comps.filter(c => {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const aspect = bw / bh;
    return (
      c.area > frameArea * minAreaFrac &&
      c.area < frameArea * maxAreaFrac &&
      aspect >= minAspect &&
      aspect <= maxAspect &&
      c.minX >= borderX &&
      c.maxX <= w - borderX
    );
  });

  valid.sort((a, b) => b.area - a.area);

  if (process.env.NODE_ENV === "development") {
    console.debug(`[detector:${label}] valid blobs=${valid.length}`, valid.slice(0,5).map(c => ({
      w: c.maxX-c.minX+1, h: c.maxY-c.minY+1,
      aspect: +((c.maxX-c.minX+1)/(c.maxY-c.minY+1)).toFixed(2),
      areaFrac: +(c.area/frameArea*100).toFixed(1)+'%',
    })));
  }

  // Helper
  function contains(a: Component, b: Component): boolean {
    return b.minX >= a.minX - 20 && b.maxX <= a.maxX + 20;
  }

  // Case A: two separate non-overlapping blobs
  const nonContained = valid.filter((c, i) =>
    !valid.slice(0, i).some(bigger => contains(bigger, c))
  );

  if (nonContained.length >= 2) {
    const top2 = nonContained.slice(0, 2);
    top2.sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX));
    const [l, r] = top2;
    const overlapX = Math.max(0, l.maxX - r.minX);
    const minWidth = Math.min(l.maxX - l.minX, r.maxX - r.minX);
    if (overlapX < minWidth * 0.5) {  // was 0.3 — allow more overlap (shoes close together)
      if (process.env.NODE_ENV === "development")
        console.debug(`[detector:${label}] Case A success — two separate blobs`);
      return {
        left:  { bbox: expandToSole({ x: l.minX, y: l.minY, w: l.maxX-l.minX+1, h: l.maxY-l.minY+1 }, h, borderY), confidence: 0.95 },
        right: { bbox: expandToSole({ x: r.minX, y: r.minY, w: r.maxX-r.minX+1, h: r.maxY-r.minY+1 }, h, borderY), confidence: 0.95 },
        confidence: 0.95,
      };
    }
  }

  // Case B: single wide merged blob — valley split
  if (valid.length >= 1) {
    const merged = valid[0];
    const bw = merged.maxX - merged.minX + 1;
    if (bw > w * 0.20) {  // was 0.30 — try split even on narrower merged blobs
      const valleyX = findValley(closed, w, merged.minX, merged.maxX, merged.minY, merged.maxY);
      const lBbox = expandToSole({ x: merged.minX, y: merged.minY, w: valleyX - merged.minX,     h: merged.maxY-merged.minY+1 }, h, borderY);
      const rBbox = expandToSole({ x: valleyX,     y: merged.minY, w: merged.maxX - valleyX + 1, h: merged.maxY-merged.minY+1 }, h, borderY);
      if (lBbox.w > w * 0.07 && rBbox.w > w * 0.07) {  // was 0.10
        if (process.env.NODE_ENV === "development")
          console.debug(`[detector:${label}] Case B success — valley split at x=${valleyX}`);
        return {
          left:  { bbox: lBbox, confidence: 0.80 },
          right: { bbox: rBbox, confidence: 0.80 },
          confidence: 0.80,
        };
      }
    }
  }

  if (process.env.NODE_ENV === "development")
    console.debug(`[detector:${label}] No pair found`);
  return null;
}

// ─── Preprocessing strategies ────────────────────────────────────────────────

interface Strategy {
  label:       string;
  makeBinary:  (gray: Uint8Array, w: number, h: number) => Uint8Array;
  closeRadius: number;
  minAreaFrac: number;
  maxAreaFrac: number;
  minAspect:   number;
  maxAspect:   number;
  borderXFrac: number;
}

function makeBinaryOtsu(gray: Uint8Array, cap: number, invert: boolean): Uint8Array {
  const t   = Math.min(otsuThreshold(gray), cap);
  const bin = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++)
    bin[i] = invert ? (gray[i] > t ? 1 : 0) : (gray[i] <= t ? 1 : 0);
  return bin;
}

function makeBinaryFixed(gray: Uint8Array, t: number, invert: boolean): Uint8Array {
  const bin = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++)
    bin[i] = invert ? (gray[i] > t ? 1 : 0) : (gray[i] <= t ? 1 : 0);
  return bin;
}

function makeBinaryEdge(gray: Uint8Array, w: number, h: number, edgeT: number): Uint8Array {
  const mag = sobelMag(gray, w, h);
  const bin = new Uint8Array(gray.length);
  for (let i = 0; i < mag.length; i++) bin[i] = mag[i] > edgeT ? 1 : 0;
  return bin;
}

// ─── Public detector ──────────────────────────────────────────────────────────

export function detectShoes(frame: ImageData): ShoeDetectionResult {
  const { width: w, height: h } = frame;
  const gray    = frameToGrayscale(frame);
  const blurred = blur3(gray, w, h);
  const equalized = histEq(blurred);

  // All strategies run in order; first success wins.
  // Filters relax progressively so we accept more variation each pass.
  const strategies: Strategy[] = [
    {
      // Pass 1: standard — dark objects on light background (Otsu capped at 140)
      label: "otsu-dark-obj",
      makeBinary:  (g) => makeBinaryOtsu(g, 140, false),
      closeRadius: 6,
      minAreaFrac: 0.020, maxAreaFrac: 0.70,
      minAspect:   0.5,   maxAspect:   12,
      borderXFrac: 0.005,
    },
    {
      // Pass 2: hist-eq then Otsu — rescues low-contrast scenes (dark shoe on dark table)
      label: "histeq-otsu",
      makeBinary:  (_g, _w, _h) => makeBinaryOtsu(equalized, 160, false),
      closeRadius: 6,
      minAreaFrac: 0.015, maxAreaFrac: 0.75,
      minAspect:   0.4,   maxAspect:   14,
      borderXFrac: 0.002,
    },
    {
      // Pass 3: inverted — light objects on dark background (white/light shoes)
      label: "otsu-light-obj",
      makeBinary:  (g) => makeBinaryOtsu(g, 220, true),
      closeRadius: 6,
      minAreaFrac: 0.015, maxAreaFrac: 0.75,
      minAspect:   0.4,   maxAspect:   14,
      borderXFrac: 0.002,
    },
    {
      // Pass 4: fixed dark threshold 100 — catches very dark shoes any background
      label: "fixed-dark-100",
      makeBinary:  (g) => makeBinaryFixed(g, 100, false),
      closeRadius: 8,
      minAreaFrac: 0.010, maxAreaFrac: 0.80,
      minAspect:   0.3,   maxAspect:   16,
      borderXFrac: 0.0,
    },
    {
      // Pass 5: fixed dark threshold 80 — very dark shoes / harsh shadows
      label: "fixed-dark-80",
      makeBinary:  (g) => makeBinaryFixed(g, 80, false),
      closeRadius: 8,
      minAreaFrac: 0.008, maxAreaFrac: 0.80,
      minAspect:   0.3,   maxAspect:   18,
      borderXFrac: 0.0,
    },
    {
      // Pass 6: hist-eq + fixed threshold 120
      label: "histeq-fixed-120",
      makeBinary:  () => makeBinaryFixed(equalized, 120, false),
      closeRadius: 7,
      minAreaFrac: 0.010, maxAreaFrac: 0.80,
      minAspect:   0.3,   maxAspect:   18,
      borderXFrac: 0.0,
    },
    {
      // Pass 7: edge-based — works when colour contrast is very low but shoe outline visible
      label: "edge-sobel",
      makeBinary:  (g, gw, gh) => makeBinaryEdge(g, gw, gh, 20),
      closeRadius: 5,
      minAreaFrac: 0.008, maxAreaFrac: 0.85,
      minAspect:   0.3,   maxAspect:   20,
      borderXFrac: 0.0,
    },
    {
      // Pass 8: edge-based, very sensitive — last resort
      label: "edge-sobel-loose",
      makeBinary:  (g, gw, gh) => makeBinaryEdge(g, gw, gh, 12),
      closeRadius: 6,
      minAreaFrac: 0.005, maxAreaFrac: 0.90,
      minAspect:   0.2,   maxAspect:   24,
      borderXFrac: 0.0,
    },
  ];

  const borderY = Math.round(h * 0.002);

  for (const s of strategies) {
    const borderX = Math.round(w * s.borderXFrac);
    const binary  = s.makeBinary(blurred, w, h);
    const closed  = morphClose(binary, w, h, s.closeRadius);
    const comps   = connectedComponents(closed, w, h);

    const result = blobsToShoes(
      comps, closed, w, h, borderY,
      s.minAreaFrac, s.maxAreaFrac,
      s.minAspect,   s.maxAspect,
      borderX,       s.label,
    );

    if (result) {
      if (process.env.NODE_ENV === "development")
        console.info(`[detector] SUCCESS via strategy "${s.label}" confidence=${result.confidence}`);
      return { found: true, left: result.left, right: result.right };
    }
  }

  if (process.env.NODE_ENV === "development")
    console.warn("[detector] All 8 strategies failed — returning NO_SHOES");
  return { found: false, left: null, right: null };
}

// ─── Foreground mask for heel measurement (unchanged) ─────────────────────────
export function extractForeground(frame: ImageData, bbox: BBox): Uint8Array {
  const { data, width: fw } = frame;
  const { x: bx, y: by, w: bw, h: bh } = bbox;

  const samples = new Uint8Array(bw * bh);
  for (let ry = 0; ry < bh; ry++)
    for (let rx = 0; rx < bw; rx++) {
      const fi = ((by+ry)*fw + (bx+rx)) * 4;
      samples[ry*bw+rx] = (data[fi]*77 + data[fi+1]*150 + data[fi+2]*29) >> 8;
    }

  const t = Math.min(otsuThreshold(samples), 140);
  const mask = new Uint8Array(bw * bh);
  for (let i = 0; i < samples.length; i++) mask[i] = samples[i] <= t ? 1 : 0;
  return mask;
}
