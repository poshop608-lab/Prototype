// ArUco 4x4_50 marker detection — pure canvas, no OpenCV
// Detects markers, returns px/mm given a known physical marker size.

export interface ArucoResult {
  found: boolean;
  markerId: number;
  pxPerMm: number;
  cornersPx: [number, number][];  // 4 corners in image coords
  sidePixels: number;             // average side length in pixels
}

// DICT_4X4_50 — 50 markers, each a 4×4 binary grid
// Each entry is a 16-bit number where bit 15 = top-left, bit 0 = bottom-right
// (row-major, MSB first). Only first 10 IDs needed for factory use.
const DICT_4X4_50: number[] = [
  0b0111001001110000, // 0
  0b0110000101000001, // 1
  0b0110011001000110, // 2
  0b0111000001001001, // 3
  0b0100001100110011, // 4
  0b0111001101000011, // 5
  0b0100010001000110, // 6
  0b0110001101110001, // 7
  0b0110000001001011, // 8
  0b0100010001110011, // 9
  // Fill remaining with 0 (won't match noise)
  ...Array(40).fill(0),
];

function grayscale(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
  }
  return g;
}

function adaptiveThreshold(gray: Uint8Array, w: number, h: number, blockSize = 15): Uint8Array {
  const out = new Uint8Array(w * h);
  const half = Math.floor(blockSize / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -half; dy <= half; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -half; dx <= half; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += gray[ny * w + nx]; n++;
        }
      }
      out[y * w + x] = gray[y * w + x] < (sum / n) - 7 ? 0 : 255;
    }
  }
  return out;
}

// Find candidate squares via connected component analysis on thresholded image
function findQuads(bin: Uint8Array, w: number, h: number): [number, number][][] {
  const visited = new Uint8Array(w * h);
  const quads: [number, number][][] = [];

  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const idx = y * w + x;
      if (bin[idx] !== 0 || visited[idx]) continue;

      // BFS to find black blob
      const pixels: [number, number][] = [];
      const q = [idx]; visited[idx] = 1; let qi = 0;
      while (qi < q.length) {
        const cur = q[qi++];
        const cy = Math.floor(cur / w), cx = cur % w;
        pixels.push([cx, cy]);
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (visited[ni] || bin[ni] !== 0) continue;
          visited[ni] = 1; q.push(ni);
        }
      }

      // Filter by size — ArUco black border takes ~30% of marker area
      if (pixels.length < 200 || pixels.length > w * h * 0.25) continue;

      // Find bounding box
      let minX = w, maxX = 0, minY = h, maxY = 0;
      for (const [px, py] of pixels) {
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }

      const bw = maxX - minX, bh2 = maxY - minY;
      // Must be roughly square (aspect ratio 0.7–1.3)
      if (bw < 20 || bh2 < 20) continue;
      const aspect = bw / bh2;
      if (aspect < 0.65 || aspect > 1.55) continue;

      quads.push([
        [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
      ] as [number, number][]);
    }
  }
  return quads;
}

// Sample the 4×4 inner grid from a quad region and decode marker ID
function decodeMarker(
  gray: Uint8Array, w: number,
  x0: number, y0: number, x1: number, y1: number
): number {
  const qw = x1 - x0, qh = y1 - y0;
  // Marker has 1-cell border → 6×6 grid total, inner 4×4 is the data
  const cellW = qw / 6, cellH = qh / 6;
  let bits = 0;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const cx = x0 + (col + 1.5) * cellW;
      const cy = y0 + (row + 1.5) * cellH;
      const ix = Math.round(cx), iy = Math.round(cy);
      if (ix < 0 || ix >= w || iy < 0) { bits = (bits << 1); continue; }
      const val = gray[iy * w + ix];
      bits = (bits << 1) | (val < 128 ? 1 : 0);
    }
  }

  // Check all 4 rotations against dictionary
  for (let rot = 0; rot < 4; rot++) {
    for (let id = 0; id < DICT_4X4_50.length; id++) {
      if (DICT_4X4_50[id] === bits) return id;
    }
    // Rotate bits 90° (4×4 grid rotation)
    bits = rotate4x4(bits);
  }
  return -1;
}

function rotate4x4(bits: number): number {
  // Rotate a 4×4 bit pattern 90° clockwise
  let result = 0;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const srcBit = 15 - (row * 4 + col);
      const dstBit = 15 - (col * 4 + (3 - row));
      if ((bits >> srcBit) & 1) result |= (1 << dstBit);
    }
  }
  return result;
}

export function detectAruco(
  imageData: ImageData,
  markerRealMm: number = 50
): ArucoResult {
  const { data, width, height } = imageData;

  // Downsample for speed — ArUco detectable at 25% resolution
  const scale = 0.25;
  const sw = Math.round(width * scale), sh = Math.round(height * scale);
  const tmpCanvas = document.createElement("canvas");
  tmpCanvas.width = sw; tmpCanvas.height = sh;
  const tmpCtx = tmpCanvas.getContext("2d")!;
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = width; fullCanvas.height = height;
  const fullCtx = fullCanvas.getContext("2d")!;
  fullCtx.putImageData(imageData, 0, 0);
  tmpCtx.drawImage(fullCanvas, 0, 0, sw, sh);
  const small = tmpCtx.getImageData(0, 0, sw, sh);

  const gray = grayscale(small.data, sw, sh);
  const bin = adaptiveThreshold(gray, sw, sh);
  const quads = findQuads(bin, sw, sh);

  for (const quad of quads) {
    const [tl, tr, br, bl] = quad;
    const id = decodeMarker(gray, sw, tl[0], tl[1], br[0], br[1]);
    if (id < 0) continue;

    // Scale corners back to full resolution
    const corners: [number, number][] = quad.map(
      ([x, y]) => [Math.round(x / scale), Math.round(y / scale)]
    ) as [number, number][];

    // Average side length in pixels
    const sides = [
      Math.hypot(corners[1][0]-corners[0][0], corners[1][1]-corners[0][1]),
      Math.hypot(corners[2][0]-corners[1][0], corners[2][1]-corners[1][1]),
      Math.hypot(corners[3][0]-corners[2][0], corners[3][1]-corners[2][1]),
      Math.hypot(corners[0][0]-corners[3][0], corners[0][1]-corners[3][1]),
    ];
    const sidePixels = sides.reduce((a, b) => a + b, 0) / 4;
    const pxPerMm = sidePixels / markerRealMm;

    return { found: true, markerId: id, pxPerMm, cornersPx: corners, sidePixels };
  }

  return { found: false, markerId: -1, pxPerMm: 0, cornersPx: [], sidePixels: 0 };
}
