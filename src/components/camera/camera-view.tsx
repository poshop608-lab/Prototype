"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, RotateCcw, Camera, Bug } from "lucide-react";
import { pxToMm, compressImage } from "@/lib/utils";
import type { CaptureResult } from "@/store/scan";

const CYAN = "#06b6d4";
const GREEN = "#22c55e";
const RED = "#ef4444";
const YELLOW = "#f59e0b";
const MAGENTA = "#e879f9";

interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface Pt { x: number; y: number; }
interface ShoeResult {
  bbox: BBox;
  contour: Pt[] | null;
  widthPx: number;
  // Heel measurement (primary QC metric)
  heelBBox: BBox;          // heel zone in full-res coords
  heelTopPt: Pt;           // top of heel collar (full-res)
  heelBotPt: Pt;           // bottom of outsole under heel (full-res)
  heelHeightPx: number;    // vertical distance between those two points
  heelValid: boolean;      // false → scan invalid, request retake
  // Debug
  debugMask?: Uint8Array;
  debugClean?: Uint8Array;
  thumbW?: number;
  thumbH?: number;
}

interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

function detectShoes(
  canvas: HTMLCanvasElement,
  vw: number,
  vh: number,
  debugMode: boolean
): {
  leftResult: ShoeResult; rightResult: ShoeResult;
} {
  const SCALE = 0.25;
  const tw = Math.round(vw * SCALE);
  const th = Math.round(vh * SCALE);

  const thumb = document.createElement("canvas");
  thumb.width = tw; thumb.height = th;
  const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(canvas, 0, 0, tw, th);
  const { data } = tctx.getImageData(0, 0, tw, th);

  const Rc = new Float32Array(tw * th);
  const Gc = new Float32Array(tw * th);
  const Bc = new Float32Array(tw * th);
  for (let i = 0; i < tw * th; i++) {
    Rc[i] = data[i * 4];
    Gc[i] = data[i * 4 + 1];
    Bc[i] = data[i * 4 + 2];
  }

  // BG model: top 8% rows + left/right 3% columns only.
  // Deliberately skip bottom rows — sole pixels contaminate BG average
  // and produce a threshold too low to separate dark shoe from floor.
  const TOP_ROWS  = Math.max(3, Math.round(th * 0.08));
  const SIDE_COLS = Math.max(2, Math.round(tw * 0.03));

  let bgR = 0, bgG = 0, bgBl = 0, bgN = 0;
  // top strip
  for (let y = 0; y < TOP_ROWS; y++)
    for (let x = 0; x < tw; x++) {
      const i = y * tw + x;
      bgR += Rc[i]; bgG += Gc[i]; bgBl += Bc[i]; bgN++;
    }
  // left/right columns (middle half of frame height only)
  for (let y = TOP_ROWS; y < th - TOP_ROWS; y++) {
    for (let x = 0; x < SIDE_COLS; x++) {
      const i = y * tw + x;
      bgR += Rc[i]; bgG += Gc[i]; bgBl += Bc[i]; bgN++;
    }
    for (let x = tw - SIDE_COLS; x < tw; x++) {
      const i = y * tw + x;
      bgR += Rc[i]; bgG += Gc[i]; bgBl += Bc[i]; bgN++;
    }
  }
  bgR /= bgN; bgG /= bgN; bgBl /= bgN;

  // BG variance → adaptive threshold
  let varAcc = 0, varN = 0;
  for (let y = 0; y < TOP_ROWS; y++)
    for (let x = 0; x < tw; x++) {
      const i = y * tw + x;
      const dr = Rc[i] - bgR, dg = Gc[i] - bgG, db = Bc[i] - bgBl;
      varAcc += dr * dr + dg * dg + db * db; varN++;
    }
  const bgStd = Math.sqrt((varAcc / varN) / 3);
  // Clamp 22–60. Bright/uniform wall → low std → tighter thresh. Noisy BG → higher.
  const THRESH = Math.max(22, Math.min(60, bgStd * 2.5 + 18));

  function colorDist(idx: number): number {
    const dr = Rc[idx] - bgR, dg = Gc[idx] - bgG, db = Bc[idx] - bgBl;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // BFS connected-component labeler
  function bfsLabel(mask: Uint8Array, fromX: number, toX: number) {
    const labels = new Int32Array(tw * th).fill(-1);
    let label = 0;
    const q: number[] = [];
    for (let y = 0; y < th; y++) {
      for (let x = fromX; x < toX; x++) {
        const idx = y * tw + x;
        if (mask[idx] !== 1 || labels[idx] !== -1) continue;
        labels[idx] = label;
        q.length = 0; q.push(idx); let qi = 0;
        while (qi < q.length) {
          const cur = q[qi++];
          const cy = Math.floor(cur / tw), cx = cur % tw;
          const nb = [
            cy > 0 ? cur - tw : -1,
            cy < th - 1 ? cur + tw : -1,
            cx > fromX ? cur - 1 : -1,
            cx < toX - 1 ? cur + 1 : -1,
          ];
          for (const n of nb) {
            if (n < 0 || mask[n] !== 1 || labels[n] !== -1) continue;
            labels[n] = label; q.push(n);
          }
        }
        label++;
      }
    }
    return { labels, count: label };
  }

  function processHalf(fromX: number, toX: number): ShoeResult {
    const halfW = toX - fromX;

    // ── Step 1: initial foreground mask ──────────────────────────────────
    const mask = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        const idx = y * tw + x;
        mask[idx] = colorDist(idx) > THRESH ? 1 : 0;
      }

    // ── Step 2: dilation R=4 — large enough to bridge collar opening ──────
    // Collar opening is a gap of ~3–6 thumbnail pixels between shoe upper
    // and the background behind it. R=4 bridges that gap before BG flood-fill
    // can sneak through.
    const DR = 4;
    const dil = new Uint8Array(tw * th);
    for (let y = DR; y < th - DR; y++)
      for (let x = fromX + DR; x < toX - DR; x++) {
        outer: for (let dy = -DR; dy <= DR; dy++)
          for (let dx = -DR; dx <= DR; dx++)
            if (mask[(y + dy) * tw + (x + dx)]) { dil[y * tw + x] = 1; break outer; }
      }

    // ── Step 3: erosion R=3 — remove thin noise, restore shape ───────────
    const ER = 3;
    const closed = new Uint8Array(tw * th);
    for (let y = ER; y < th - ER; y++)
      for (let x = fromX + ER; x < toX - ER; x++) {
        let all = true;
        outer2: for (let dy = -ER; dy <= ER; dy++)
          for (let dx = -ER; dx <= ER; dx++)
            if (!dil[(y + dy) * tw + (x + dx)]) { all = false; break outer2; }
        closed[y * tw + x] = all ? 1 : 0;
      }

    // ── Step 4: BFS from top rows + side column borders ──────────────────
    // Seed: full top 8% (wall), left col, right col.
    // NOT bottom row — shoe sole is at the bottom center; seeding from
    // the full bottom row causes flood-fill to enter through the sole.
    const bgFill = new Uint8Array(tw * th);
    const bgQ: number[] = [];

    function seedBg(x: number, y: number) {
      if (x < fromX || x >= toX || y < 0 || y >= th) return;
      const idx = y * tw + x;
      if (bgFill[idx] || closed[idx]) return;
      bgFill[idx] = 1; bgQ.push(idx);
    }

    // Full top 8%
    for (let y = 0; y < TOP_ROWS; y++)
      for (let x = fromX; x < toX; x++) seedBg(x, y);
    // Side columns full height
    for (let y = 0; y < th; y++) { seedBg(fromX, y); seedBg(toX - 1, y); }
    // Bottom corners only (20% each side), not centre where sole is
    const bcw = Math.round(halfW * 0.20);
    for (let y = Math.round(th * 0.75); y < th; y++) {
      for (let x = fromX; x < fromX + bcw; x++) seedBg(x, y);
      for (let x = toX - bcw; x < toX; x++) seedBg(x, y);
    }

    let bqi = 0;
    while (bqi < bgQ.length) {
      const idx = bgQ[bqi++];
      const y = Math.floor(idx / tw), x = idx % tw;
      if (y > 0)       seedBg(x, y - 1);
      if (y < th - 1)  seedBg(x, y + 1);
      if (x > fromX)   seedBg(x - 1, y);
      if (x < toX - 1) seedBg(x + 1, y);
    }

    // ── Step 5: candidate = closed AND NOT bgFill ─────────────────────────
    const cand = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        const i = y * tw + x;
        cand[i] = (closed[i] && !bgFill[i]) ? 1 : 0;
      }

    // ── Step 6: largest blob = the shoe ──────────────────────────────────
    const { labels, count } = bfsLabel(cand, fromX, toX);
    if (count === 0) return makeFallback(fromX, toX, halfW);

    const sizes = new Int32Array(count);
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        const l = labels[y * tw + x];
        if (l >= 0) sizes[l]++;
      }
    let best = 0;
    for (let i = 1; i < count; i++) if (sizes[i] > sizes[best]) best = i;

    if (sizes[best] < halfW * th * 0.015) return makeFallback(fromX, toX, halfW);

    // ── Step 7: extract blob into shoe mask ───────────────────────────────
    let minY = th, maxY = 0, minXs = toX, maxXs = fromX;
    const shoe = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        if (labels[y * tw + x] !== best) continue;
        shoe[y * tw + x] = 1;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x < minXs) minXs = x; if (x > maxXs) maxXs = x;
      }

    if (maxY - minY < th * 0.04 || maxXs - minXs < halfW * 0.05)
      return makeFallback(fromX, toX, halfW);

    // ── Step 8: topological hole fill ────────────────────────────────────
    // Flood-fill from a 1-pixel border around the shoe bbox through NON-shoe
    // pixels, marking them as "exterior". Any non-shoe pixel NOT reachable
    // from exterior = interior hole (collar cavity) → fill it.
    const bx0 = Math.max(fromX, minXs - 2);
    const bx1 = Math.min(toX - 1, maxXs + 2);
    const by0 = Math.max(0, minY - 2);
    const by1 = Math.min(th - 1, maxY + 2);

    const exterior = new Uint8Array(tw * th);
    const hoQ: number[] = [];
    function seedExt(x: number, y: number) {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) return;
      const idx = y * tw + x;
      if (shoe[idx] || exterior[idx]) return;
      exterior[idx] = 1; hoQ.push(idx);
    }
    // Border of bbox
    for (let x = bx0; x <= bx1; x++) { seedExt(x, by0); seedExt(x, by1); }
    for (let y = by0; y <= by1; y++) { seedExt(bx0, y); seedExt(bx1, y); }
    let hqi = 0;
    while (hqi < hoQ.length) {
      const idx = hoQ[hqi++];
      const y = Math.floor(idx / tw), x = idx % tw;
      seedExt(x, y - 1); seedExt(x, y + 1); seedExt(x - 1, y); seedExt(x + 1, y);
    }
    // Fill interior holes
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const i = y * tw + x;
        if (!shoe[i] && !exterior[i]) { shoe[i] = 1; }
      }

    // Recompute extents after hole fill
    minY = th; maxY = 0; minXs = toX; maxXs = fromX;
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        if (!shoe[y * tw + x]) continue;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x < minXs) minXs = x; if (x > maxXs) maxXs = x;
      }

    // ── Step 9: contour smoothing — sliding window on edges ──────────────
    const WIN = 3;
    const leftEdge: Pt[] = [];
    const rightEdge: Pt[] = [];
    for (let y = minY; y <= maxY; y++) {
      let lx = toX, rx = fromX - 1;
      for (let x = fromX; x < toX; x++)
        if (shoe[y * tw + x]) { if (x < lx) lx = x; if (x > rx) rx = x; }
      if (rx >= lx) { leftEdge.push({ x: lx, y }); rightEdge.push({ x: rx, y }); }
    }
    if (leftEdge.length < 4) return makeFallback(fromX, toX, halfW);

    // Smooth edges: replace each x with average of WIN neighbours
    function smooth(pts: Pt[]): Pt[] {
      return pts.map((p, i) => {
        let sum = 0, n = 0;
        for (let k = Math.max(0, i - WIN); k <= Math.min(pts.length - 1, i + WIN); k++) {
          sum += pts[k].x; n++;
        }
        return { x: Math.round(sum / n), y: p.y };
      });
    }
    const sLeft = smooth(leftEdge);
    const sRight = smooth(rightEdge);

    const pts: Pt[] = [
      ...sLeft,
      ...[...sRight].reverse(),
    ].map(p => ({ x: Math.round(p.x / SCALE), y: Math.round(p.y / SCALE) }));

    const bbox: BBox = {
      minX: Math.max(0, Math.round(minXs / SCALE)),
      maxX: Math.min(vw, Math.round(maxXs / SCALE)),
      minY: Math.max(0, Math.round(minY / SCALE)),
      maxY: Math.min(vh, Math.round(maxY / SCALE)),
    };

    const widthPx = Math.round((maxXs - minXs) / SCALE);

    // ── Step 10: Heel detection ───────────────────────────────────────────
    // Heel = the END of the shoe that has more sole mass (thicker outsole).
    // Strategy: compare shoe pixel density in the bottom 20% of shoe height
    // between the left 28% and right 28% of shoe width. Denser side = heel.
    const shoeW = maxXs - minXs;
    const shoeH = maxY - minY;
    const HEEL_ZONE_FRAC = 0.28; // 28% of shoe length = heel zone
    const SOLE_ZONE_FRAC = 0.20; // bottom 20% of shoe height = sole band
    const heelZoneW = Math.round(shoeW * HEEL_ZONE_FRAC);
    const soleYStart = maxY - Math.round(shoeH * SOLE_ZONE_FRAC);

    // Count sole pixels in left end vs right end
    let leftSoleCount = 0, rightSoleCount = 0;
    for (let y = soleYStart; y <= maxY; y++) {
      for (let x = minXs; x < minXs + heelZoneW; x++)
        if (shoe[y * tw + x]) leftSoleCount++;
      for (let x = maxXs - heelZoneW; x <= maxXs; x++)
        if (shoe[y * tw + x]) rightSoleCount++;
    }

    // heelIsLeft = true means heel is on the minX side of this shoe half
    const heelIsLeft = leftSoleCount >= rightSoleCount;
    const hzX0 = heelIsLeft ? minXs : maxXs - heelZoneW;
    const hzX1 = heelIsLeft ? minXs + heelZoneW : maxXs;

    // Scan heel zone for topmost and bottommost shoe pixels
    let hMinY = th, hMaxY = 0, heelRowsFilled = 0;
    for (let y = minY; y <= maxY; y++) {
      let hasPixel = false;
      for (let x = hzX0; x <= hzX1; x++) {
        if (shoe[y * tw + x]) {
          if (y < hMinY) hMinY = y;
          if (y > hMaxY) hMaxY = y;
          hasPixel = true;
        }
      }
      if (hasPixel) heelRowsFilled++;
    }

    // Validity: heel span must cover at least 40% of total shoe rows
    // and the heel zone itself must have non-trivial height
    const heelValid = heelRowsFilled > (shoeH * 0.40) && (hMaxY - hMinY) > (shoeH * 0.30);

    // Full-res coords
    const hzMidX = Math.round((hzX0 + hzX1) / 2 / SCALE);
    const heelTopPt: Pt = { x: hzMidX, y: Math.round(hMinY / SCALE) };
    const heelBotPt: Pt = { x: hzMidX, y: Math.round(hMaxY / SCALE) };
    const heelHeightPx = Math.round((hMaxY - hMinY) / SCALE);

    const heelBBox: BBox = {
      minX: Math.max(0, Math.round(hzX0 / SCALE)),
      maxX: Math.min(vw, Math.round(hzX1 / SCALE)),
      minY: heelTopPt.y,
      maxY: heelBotPt.y,
    };

    return {
      bbox, contour: pts,
      widthPx,
      heelBBox, heelTopPt, heelBotPt, heelHeightPx, heelValid,
      ...(debugMode ? { debugMask: mask, debugClean: shoe, thumbW: tw, thumbH: th } : {}),
    };
  }

  function makeFallback(fromX: number, toX: number, halfW: number): ShoeResult {
    const pad = Math.round(halfW * 0.08);
    const b: BBox = {
      minX: Math.round((fromX + pad) / SCALE),
      maxX: Math.round((toX - pad) / SCALE),
      minY: Math.round(th * 0.15 / SCALE),
      maxY: Math.round(th * 0.85 / SCALE),
    };
    const midX = (b.minX + b.maxX) / 2;
    const midY = (b.minY + b.maxY) / 2;
    return {
      bbox: b, contour: null,
      widthPx: b.maxX - b.minX,
      heelBBox: b,
      heelTopPt: { x: midX, y: b.minY },
      heelBotPt: { x: midX, y: b.maxY },
      heelHeightPx: b.maxY - b.minY,
      heelValid: false,
    };
  }

  const mid = Math.round(tw / 2);
  const L  = processHalf(0, mid);
  const Rh = processHalf(mid, tw);
  return { leftResult: L, rightResult: Rh };
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug canvas — 4 mask panels + measurement callout
// ─────────────────────────────────────────────────────────────────────────────
function renderDebug(
  dbgCanvas: HTMLCanvasElement,
  L: ShoeResult, Rh: ShoeResult,
  pxPerMm: number
) {
  if (!L.debugMask || !L.thumbW) return;
  const tw = L.thumbW!, th = L.thumbH!;
  const panelW = Math.round(tw / 2);

  dbgCanvas.width = panelW * 4;
  dbgCanvas.height = th + 22;
  const ctx = dbgCanvas.getContext("2d")!;
  ctx.fillStyle = "#06060f";
  ctx.fillRect(0, 0, dbgCanvas.width, dbgCanvas.height);

  const panels = [
    { label: "RAW L",  mask: L.debugMask,   half: [0, panelW]            as [number,number], col: [0,200,255] },
    { label: "SHOE L", mask: L.debugClean,  half: [0, panelW]            as [number,number], col: [0,255,120] },
    { label: "RAW R",  mask: Rh.debugMask,  half: [panelW, tw]           as [number,number], col: [0,200,255] },
    { label: "SHOE R", mask: Rh.debugClean, half: [panelW, tw]           as [number,number], col: [0,255,120] },
  ];

  panels.forEach(({ label, mask, half, col }, pi) => {
    if (!mask) return;
    const [fx, tx2] = half;
    const imgd = ctx.createImageData(panelW, th);
    for (let y = 0; y < th; y++) {
      for (let x = fx; x < tx2; x++) {
        const src = y * tw + x;
        const dst = (y * panelW + (x - fx)) * 4;
        if (mask[src]) {
          imgd.data[dst] = col[0]; imgd.data[dst+1] = col[1];
          imgd.data[dst+2] = col[2]; imgd.data[dst+3] = 255;
        } else {
          imgd.data[dst] = 18; imgd.data[dst+1] = 18; imgd.data[dst+2] = 28; imgd.data[dst+3] = 255;
        }
      }
    }
    ctx.putImageData(imgd, pi * panelW, 0);
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(pi * panelW, 0, panelW, 12);
    ctx.fillStyle = "#aaa"; ctx.font = "9px monospace"; ctx.textAlign = "left";
    ctx.fillText(label, pi * panelW + 2, 10);
  });

  // Bottom info bar — shows heel height values specifically
  const P = pxPerMm;
  ctx.fillStyle = "#0a0a18";
  ctx.fillRect(0, th, dbgCanvas.width, 22);
  ctx.fillStyle = L.heelValid ? "#0cf" : "#f55"; ctx.font = "9px monospace"; ctx.textAlign = "left";
  ctx.fillText(
    `L heel: ${L.heelHeightPx}px=${(L.heelHeightPx/P).toFixed(1)}mm [${L.heelValid?"OK":"INVALID"}]  |  R heel: ${Rh.heelHeightPx}px=${(Rh.heelHeightPx/P).toFixed(1)}mm [${Rh.heelValid?"OK":"INVALID"}]  |  W L=${L.widthPx}px  R=${Rh.widthPx}px  |  px/mm=${P}`,
    4, th + 14
  );
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isPortrait, setIsPortrait] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => {
    function check() { setIsPortrait(window.innerHeight > window.innerWidth); }
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  useEffect(() => {
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await new Promise<void>((res) => { video.onloadedmetadata = () => res(); });
        await video.play().catch(() => {});
        setIsReady(true);
      } catch {
        onError("Camera access denied. Allow camera permissions and reload.");
      }
    }
    startCamera();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [onError]);

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setIsCapturing(true);
    setIsAnalyzing(true);

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    canvas.width = vw; canvas.height = vh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, vw, vh);

    await new Promise(r => setTimeout(r, 20));

    const det = detectShoes(canvas, vw, vh, debugMode);
    const LR = det.leftResult, RR = det.rightResult;
    const PX_PER_MM = 3.5;

    if (debugMode && debugCanvasRef.current) {
      renderDebug(debugCanvasRef.current, LR, RR, PX_PER_MM);
      setShowDebug(true);
    }
    setIsAnalyzing(false);

    // Invalid scan check — if either heel not detected, request retake
    const scanInvalid = !LR.heelValid || !RR.heelValid;

    const fs = Math.max(18, Math.round(vw * 0.018));

    function pill(text: string, cx: number, cy: number, bg: string, fg: string) {
      ctx.font = `bold ${fs}px -apple-system,sans-serif`;
      const tw2 = ctx.measureText(text).width;
      const ph = fs + 10, pw = tw2 + 20, r2 = ph / 2;
      const px = cx - pw / 2, py = cy - ph / 2;
      ctx.beginPath();
      ctx.moveTo(px + r2, py);
      ctx.arcTo(px + pw, py, px + pw, py + ph, r2);
      ctx.arcTo(px + pw, py + ph, px, py + ph, r2);
      ctx.arcTo(px, py + ph, px, py, r2);
      ctx.arcTo(px, py, px + pw, py, r2);
      ctx.closePath();
      ctx.fillStyle = bg; ctx.fill();
      ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(text, cx, cy);
      ctx.textBaseline = "alphabetic";
    }

    function drawShoe(sr: ShoeResult, label: string) {
      const { bbox, contour, heelBBox, heelTopPt, heelBotPt, heelHeightPx, widthPx, heelValid } = sr;
      const { minX, minY, maxX, maxY } = bbox;
      const midX = (minX + maxX) / 2;
      const lw = Math.max(2, vw * 0.002);
      const refLW = Math.max(3, vw * 0.003);
      const lineExt = Math.round(vw * 0.012);
      const tickH = Math.round(vw * 0.014);

      // ── Faint shoe silhouette ─────────────────────────────────────────
      ctx.beginPath();
      if (contour && contour.length > 2) {
        contour.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.closePath();
      } else {
        ctx.rect(minX, minY, maxX - minX, maxY - minY);
      }
      ctx.fillStyle = `${GREEN}10`; ctx.fill();
      ctx.strokeStyle = `${GREEN}45`; ctx.lineWidth = lw;
      ctx.stroke();

      // ── Heel zone highlight ───────────────────────────────────────────
      // Shaded band over heel region so user can see what was measured
      const hz = heelBBox;
      ctx.fillStyle = heelValid ? `${YELLOW}22` : `${RED}22`;
      ctx.fillRect(hz.minX, hz.minY, hz.maxX - hz.minX, hz.maxY - hz.minY);
      ctx.strokeStyle = heelValid ? `${YELLOW}80` : `${RED}80`;
      ctx.lineWidth = lw; ctx.setLineDash([4, 4]);
      ctx.strokeRect(hz.minX, hz.minY, hz.maxX - hz.minX, hz.maxY - hz.minY);
      ctx.setLineDash([]);

      // ── Horizontal reference lines spanning heel zone ─────────────────
      // TOP line: highest heel collar pixel (cyan)
      // BOTTOM line: lowest outsole pixel under heel (green)
      const topY = heelTopPt.y;
      const botY = heelBotPt.y;
      const refX0 = hz.minX - lineExt;
      const refX1 = hz.maxX + lineExt;

      function drawRefLine(y: number, color: string) {
        ctx.strokeStyle = color; ctx.lineWidth = refLW;
        ctx.shadowColor = color; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.moveTo(refX0, y); ctx.lineTo(refX1, y); ctx.stroke();
        ctx.lineWidth = refLW * 0.7;
        ctx.beginPath(); ctx.moveTo(refX0, y - tickH / 2); ctx.lineTo(refX0, y + tickH / 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(refX1, y - tickH / 2); ctx.lineTo(refX1, y + tickH / 2); ctx.stroke();
        ctx.shadowBlur = 0;
      }

      drawRefLine(topY, CYAN);    // top of heel collar
      drawRefLine(botY, GREEN);   // bottom of outsole

      // ── Vertical measurement arrow (right of heel zone) ───────────────
      const arrowX = refX1 + Math.round(vw * 0.006);
      const arrowH2 = Math.round(vw * 0.008);
      ctx.strokeStyle = YELLOW; ctx.lineWidth = lw;
      ctx.shadowColor = YELLOW; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.moveTo(arrowX, topY); ctx.lineTo(arrowX, botY); ctx.stroke();
      // top arrowhead
      ctx.beginPath();
      ctx.moveTo(arrowX - arrowH2 * 0.6, topY + arrowH2);
      ctx.lineTo(arrowX, topY);
      ctx.lineTo(arrowX + arrowH2 * 0.6, topY + arrowH2);
      ctx.stroke();
      // bottom arrowhead
      ctx.beginPath();
      ctx.moveTo(arrowX - arrowH2 * 0.6, botY - arrowH2);
      ctx.lineTo(arrowX, botY);
      ctx.lineTo(arrowX + arrowH2 * 0.6, botY - arrowH2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // ── Measurements ─────────────────────────────────────────────────
      const hMm = parseFloat((heelHeightPx / PX_PER_MM).toFixed(1));
      const wMm = parseFloat((widthPx / PX_PER_MM).toFixed(1));
      const heelMidY = (topY + botY) / 2;

      // Heel height pill next to arrow
      const hPillX = Math.min(arrowX + fs * 2.4, vw - fs * 2.5);
      if (heelValid) {
        pill(`H ${hMm}mm`, hPillX, heelMidY, "rgba(0,0,0,0.88)", YELLOW);
      } else {
        pill("HEEL?", hPillX, heelMidY, "rgba(0,0,0,0.88)", RED);
      }

      // Width pill above full shoe
      pill(`W ${wMm}mm`, midX, Math.max(minY - fs * 1.1, fs * 1.1), "rgba(0,0,0,0.88)", CYAN);

      // Label chip below shoe
      pill(label, midX, Math.min(maxY + fs * 1.2, vh - fs * 0.8), `${GREEN}dd`, "#000");

      // Debug dot: heel top (magenta) and bottom (cyan)
      if (debugMode) {
        const DOT = Math.max(7, vw * 0.005);
        ctx.fillStyle = MAGENTA;
        ctx.beginPath(); ctx.arc(heelTopPt.x, topY, DOT, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = CYAN;
        ctx.beginPath(); ctx.arc(heelBotPt.x, botY, DOT, 0, Math.PI * 2); ctx.fill();
        pill(`${heelHeightPx}px`, (hz.minX + hz.maxX) / 2, heelMidY, "rgba(0,0,0,0.85)", MAGENTA);
      }

      return { hMm, wMm };
    }

    const leftM  = drawShoe(LR, "LEFT");
    const rightM = drawShoe(RR, "RIGHT");

    // Centre divider
    ctx.strokeStyle = `${CYAN}55`; ctx.lineWidth = 1; ctx.setLineDash([6,6]);
    ctx.beginPath(); ctx.moveTo(vw/2,0); ctx.lineTo(vw/2,vh); ctx.stroke();
    ctx.setLineDash([]);

    const diff = parseFloat(Math.abs(leftM.hMm - rightM.hMm).toFixed(1));
    const passed = !scanInvalid && diff <= 2;

    // Result banner
    const bh = Math.round(vh * 0.07);
    ctx.fillStyle = scanInvalid ? `${YELLOW}ee` : passed ? `${GREEN}ee` : `${RED}ee`;
    ctx.fillRect(0, vh - bh, vw, bh);
    ctx.font = `bold ${Math.round(vw * 0.022)}px -apple-system,sans-serif`;
    ctx.fillStyle = scanInvalid ? "#000" : "#fff";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(
      scanInvalid
        ? "⚠  INVALID — Heel not detected · Retake"
        : passed
          ? `✓  PASSED   Δ${diff} mm`
          : `✗  REJECTED   Δ${diff} mm  (limit 2 mm)`,
      vw / 2, vh - bh / 2
    );
    ctx.textBaseline = "alphabetic";

    // Debug / info stamp
    if (debugMode) {
      ctx.font = "10px monospace"; ctx.textAlign = "left";
      const stamp = `DBG HEEL | L:${LR.heelHeightPx}px=${leftM.hMm}mm[${LR.heelValid?"OK":"!"}]  R:${RR.heelHeightPx}px=${rightM.hMm}mm[${RR.heelValid?"OK":"!"}]  px/mm=${PX_PER_MM}`;
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(4, 4, ctx.measureText(stamp).width + 10, 18);
      ctx.fillStyle = YELLOW; ctx.fillText(stamp, 9, 17);
    } else {
      ctx.font = "11px monospace"; ctx.textAlign = "left";
      const stamp = `HEEL | L:${leftM.hMm}mm R:${rightM.hMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(4, 4, ctx.measureText(stamp).width + 10, 18);
      ctx.fillStyle = GREEN; ctx.fillText(stamp, 9, 17);
    }

    try {
      const blob = await compressImage(canvas, 0.9);
      const annotatedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      if ("vibrate" in navigator) navigator.vibrate(scanInvalid ? [100, 50, 100, 50, 100] : [60, 30, 60]);

      onCapture({
        blob, dataUrl: annotatedDataUrl, annotatedDataUrl,
        leftHeightMm:  leftM.hMm,
        rightHeightMm: rightM.hMm,
        leftWidthMm:   leftM.wMm,
        rightWidthMm:  rightM.wMm,
        heightDiffMm:  scanInvalid ? 0 : diff,
        passed: passed && !scanInvalid,
        rejectionReason: scanInvalid
          ? "Heel region not detected — please retake"
          : passed ? null : `Heel height difference ${diff}mm exceeds 2mm tolerance`,
      });

      setShowSuccess(true);
      setTimeout(() => { setShowSuccess(false); setIsCapturing(false); setShowDebug(false); }, 1400);
    } catch {
      onError("Failed to process image");
      setIsCapturing(false);
    }
  }, [isCapturing, isAnalyzing, debugMode, onCapture, onError]);

  if (isPortrait) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center px-8">
          <RotateCcw className="w-14 h-14 mx-auto mb-4" style={{ color: CYAN, animation: "spin 3s linear infinite" }} />
          <p className="text-white font-bold text-lg mb-2">Rotate your phone</p>
          <p className="text-sm" style={{ color: "#888" }}>Hold horizontally (landscape) to scan both shoes</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
      <canvas ref={captureCanvasRef} className="hidden" />

      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "#080810" }}>
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: CYAN }} />
        </div>
      )}

      <AnimatePresence>
        {isAnalyzing && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-30"
            style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
          >
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold" style={{ color: CYAN }}>Segmenting shoes…</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Guide overlay */}
      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 bottom-0 left-1/2 w-px opacity-40"
            style={{ background: `repeating-linear-gradient(to bottom,${CYAN} 0,${CYAN} 8px,transparent 8px,transparent 16px)` }} />
          <div className="absolute left-4 top-1/2 -translate-y-1/2">
            <div className="px-3 py-1 rounded-full text-xs font-bold"
              style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>LEFT SHOE</div>
          </div>
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="px-3 py-1 rounded-full text-xs font-bold"
              style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>RIGHT SHOE</div>
          </div>
          <div className="absolute top-8 left-8 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute top-8 right-8 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 left-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 right-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
        </div>
      )}

      {isReady && !isCapturing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap"
            style={{ background: "rgba(0,0,0,0.75)", border: `1px solid ${CYAN}40`, color: "#ccc" }}>
            One shoe each side · landscape · tap capture
          </div>
        </div>
      )}

      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center z-20"
            style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }}
          >
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 1.2, opacity: 0 }}
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{ background: "rgba(34,197,94,0.2)", border: `2px solid ${GREEN}`, boxShadow: `0 0 32px ${GREEN}80` }}
            >
              <CheckCircle2 className="w-10 h-10" style={{ color: GREEN }} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Debug overlay panel */}
      <AnimatePresence>
        {showDebug && debugMode && (
          <motion.div
            initial={{ opacity: 0, y: 60 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 60 }}
            className="absolute left-0 right-0 bottom-28 z-20 mx-2 rounded-2xl overflow-hidden"
            style={{ background: "rgba(8,8,18,0.96)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(8px)" }}
          >
            <div className="px-2 py-2">
              <p className="text-[10px] font-bold mb-1.5" style={{ color: YELLOW }}>DEBUG: Segmentation + Measurements</p>
              <canvas ref={debugCanvasRef} className="w-full rounded"
                style={{ imageRendering: "pixelated", border: `1px solid rgba(255,255,255,0.07)` }} />
              <div className="flex gap-3 mt-1 text-[9px]" style={{ color: "#555" }}>
                <span style={{ color: "#00c8ff" }}>■ Raw FG mask</span>
                <span style={{ color: "#00ff78" }}>■ Shoe blob (hole-filled)</span>
                <span style={{ color: MAGENTA }}>● Top point</span>
                <span style={{ color: CYAN }}>● Bottom point</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-between px-6 pb-6 pt-3"
        style={{ background: "linear-gradient(to top,rgba(0,0,0,0.75) 0%,transparent 100%)" }}>
        <button
          onClick={() => { setDebugMode(d => !d); setShowDebug(false); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
          style={{
            background: debugMode ? `${YELLOW}30` : "rgba(0,0,0,0.5)",
            border: `1px solid ${debugMode ? YELLOW : "rgba(255,255,255,0.15)"}`,
            color: debugMode ? YELLOW : "rgba(255,255,255,0.4)",
          }}
        >
          <Bug className="w-3.5 h-3.5" />
          {debugMode ? "Debug ON" : "Debug"}
        </button>

        <div className="flex flex-col items-center gap-1">
          <button
            onClick={handleCapture}
            disabled={!isReady || isCapturing || isAnalyzing}
            className="relative w-20 h-20 rounded-full flex items-center justify-center transition-transform active:scale-90 disabled:opacity-40"
            style={{ border: "4px solid rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.15)", backdropFilter: "blur(4px)" }}
          >
            <Camera className="w-8 h-8 text-white" />
            {(isCapturing || isAnalyzing) && (
              <div className="absolute inset-0 rounded-full border-4 border-cyan-400 animate-ping" />
            )}
          </button>
          <span className="text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.45)" }}>
            {isAnalyzing ? "segmenting…" : isCapturing ? "processing…" : "tap to capture"}
          </span>
        </div>

        <div className="w-16" />
      </div>
    </div>
  );
}
