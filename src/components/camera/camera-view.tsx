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

interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface Pt { x: number; y: number; }
interface ShoeResult {
  bbox: BBox;
  contour: Pt[] | null;
  // debug masks in thumbnail coordinates
  debugMask?: Uint8Array;
  debugClean?: Uint8Array;
  thumbW?: number;
  thumbH?: number;
}

interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOE SEGMENTATION PIPELINE
//
// Goal: isolate ONLY the shoe pixels, nothing else.
//
// Pipeline:
//   1. Downsample to 25% for speed
//   2. Build per-pixel background model from all 4 frame edges
//   3. Threshold: pixel is "foreground" if color distance > adaptive thresh
//   4. Morphological close (dilate then erode) to fill holes inside shoe
//   5. Flood-fill from CORNER seeds only (not full borders) to label BG
//   6. Keep only the largest connected foreground blob per half = the shoe
//   7. Row-by-row contour tracing on that blob
//   8. Measurements from contour extents only
// ─────────────────────────────────────────────────────────────────────────────
function detectShoes(
  canvas: HTMLCanvasElement,
  vw: number,
  vh: number,
  debugMode: boolean
): { left: BBox; right: BBox; leftContour: Pt[] | null; rightContour: Pt[] | null; leftDebug?: ShoeResult; rightDebug?: ShoeResult } {
  const SCALE = 0.25;
  const tw = Math.round(vw * SCALE);
  const th = Math.round(vh * SCALE);

  const thumb = document.createElement("canvas");
  thumb.width = tw; thumb.height = th;
  const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(canvas, 0, 0, tw, th);
  const imgData = tctx.getImageData(0, 0, tw, th);
  const data = imgData.data;

  // ── Per-pixel RGB arrays ──────────────────────────────────────────────────
  const R = new Float32Array(tw * th);
  const G = new Float32Array(tw * th);
  const B = new Float32Array(tw * th);
  for (let i = 0; i < tw * th; i++) {
    R[i] = data[i * 4];
    G[i] = data[i * 4 + 1];
    B[i] = data[i * 4 + 2];
  }

  // ── Background model: sample all 4 edges (outer 3% ring) ────────────────
  // Store as avg RGB so we can compute per-pixel color distance to BG
  const BG_RING = Math.max(2, Math.round(th * 0.03));

  let bgR = 0, bgG = 0, bgBl = 0, bgN = 0;
  for (let y = 0; y < BG_RING; y++)
    for (let x = 0; x < tw; x++) {
      const i = y * tw + x;
      bgR += R[i]; bgG += G[i]; bgBl += B[i]; bgN++;
    }
  for (let y = th - BG_RING; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const i = y * tw + x;
      bgR += R[i]; bgG += G[i]; bgBl += B[i]; bgN++;
    }
  for (let x = 0; x < BG_RING; x++)
    for (let y = BG_RING; y < th - BG_RING; y++) {
      const i = y * tw + x;
      bgR += R[i]; bgG += G[i]; bgBl += B[i]; bgN++;
    }
  for (let x = tw - BG_RING; x < tw; x++)
    for (let y = BG_RING; y < th - BG_RING; y++) {
      const i = y * tw + x;
      bgR += R[i]; bgG += G[i]; bgBl += B[i]; bgN++;
    }
  bgR /= bgN; bgG /= bgN; bgBl /= bgN;

  // Also compute BG variance to set adaptive threshold
  let variance = 0;
  for (let y = 0; y < BG_RING; y++)
    for (let x = 0; x < tw; x++) {
      const i = y * tw + x;
      const dr = R[i] - bgR, dg = G[i] - bgG, db = B[i] - bgBl;
      variance += dr * dr + dg * dg + db * db;
    }
  variance /= (BG_RING * tw);
  const bgStd = Math.sqrt(variance / 3);
  // Adaptive: at least 25, at most 55. Tight backgrounds need smaller thresh.
  const THRESH = Math.max(25, Math.min(55, bgStd * 2.5 + 20));

  function colorDistToBg(idx: number): number {
    const dr = R[idx] - bgR, dg = G[idx] - bgG, db = B[idx] - bgBl;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // ── BFS: label connected components ─────────────────────────────────────
  function bfsLabel(mask: Uint8Array, fromX: number, toX: number): { labels: Int32Array; count: number } {
    const labels = new Int32Array(tw * th).fill(-1);
    let label = 0;
    const queue: number[] = [];

    for (let y = 0; y < th; y++) {
      for (let x = fromX; x < toX; x++) {
        const idx = y * tw + x;
        if (mask[idx] !== 1 || labels[idx] !== -1) continue;
        labels[idx] = label;
        queue.length = 0;
        queue.push(idx);
        let qi = 0;
        while (qi < queue.length) {
          const cur = queue[qi++];
          const cy = Math.floor(cur / tw), cx = cur % tw;
          const neighbors = [
            cy > 0 ? cur - tw : -1,
            cy < th - 1 ? cur + tw : -1,
            cx > fromX ? cur - 1 : -1,
            cx < toX - 1 ? cur + 1 : -1,
          ];
          for (const nb of neighbors) {
            if (nb < 0 || mask[nb] !== 1 || labels[nb] !== -1) continue;
            labels[nb] = label;
            queue.push(nb);
          }
        }
        label++;
      }
    }
    return { labels, count: label };
  }

  function processHalf(fromX: number, toX: number): ShoeResult {
    const halfW = toX - fromX;

    // ── Step 1: foreground mask via color distance to BG ──────────────────
    const mask = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        const idx = y * tw + x;
        mask[idx] = colorDistToBg(idx) > THRESH ? 1 : 0;
      }

    // ── Step 2: morphological close — dilate R=2 then erode R=2 ──────────
    // Dilation: fills holes inside shoe body
    const DR = 2;
    const dil = new Uint8Array(tw * th);
    for (let y = DR; y < th - DR; y++)
      for (let x = fromX + DR; x < toX - DR; x++) {
        outer: for (let dy = -DR; dy <= DR; dy++)
          for (let dx = -DR; dx <= DR; dx++)
            if (mask[(y + dy) * tw + (x + dx)]) { dil[y * tw + x] = 1; break outer; }
      }

    // Erosion: removes thin noise/wisps that survived dilation
    const ER = 1;
    const eroded = new Uint8Array(tw * th);
    for (let y = ER; y < th - ER; y++)
      for (let x = fromX + ER; x < toX - ER; x++) {
        let allSet = true;
        outer2: for (let dy = -ER; dy <= ER; dy++)
          for (let dx = -ER; dx <= ER; dx++)
            if (!dil[(y + dy) * tw + (x + dx)]) { allSet = false; break outer2; }
        eroded[y * tw + x] = allSet ? 1 : 0;
      }

    // ── Step 3: BFS flood from CORNER seeds only ──────────────────────────
    // Corners = 5% of frame width/height from each corner.
    // This avoids seeding into the shoe bottom (shoe often sits at center-bottom).
    const bgFill = new Uint8Array(tw * th);
    const bfsBg: number[] = [];

    function seedBg(x: number, y: number) {
      if (x < fromX || x >= toX || y < 0 || y >= th) return;
      const idx = y * tw + x;
      if (bgFill[idx] || eroded[idx]) return;
      bgFill[idx] = 1; bfsBg.push(idx);
    }

    const cx5 = Math.round(halfW * 0.12); // corner zone width
    const cy5 = Math.round(th * 0.12);    // corner zone height

    // Top-left corner zone
    for (let y = 0; y < cy5; y++)
      for (let x = fromX; x < fromX + cx5; x++) seedBg(x, y);
    // Top-right corner zone
    for (let y = 0; y < cy5; y++)
      for (let x = toX - cx5; x < toX; x++) seedBg(x, y);
    // Bottom-left corner zone
    for (let y = th - cy5; y < th; y++)
      for (let x = fromX; x < fromX + cx5; x++) seedBg(x, y);
    // Bottom-right corner zone
    for (let y = th - cy5; y < th; y++)
      for (let x = toX - cx5; x < toX; x++) seedBg(x, y);
    // Full top row (sky/wall above shoe is always BG)
    for (let x = fromX; x < toX; x++) seedBg(x, 0);
    for (let x = fromX; x < toX; x++) seedBg(x, 1);

    let bqi = 0;
    while (bqi < bfsBg.length) {
      const idx = bfsBg[bqi++];
      const y = Math.floor(idx / tw), x = idx % tw;
      if (y > 0)       seedBg(x, y - 1);
      if (y < th - 1)  seedBg(x, y + 1);
      if (x > fromX)   seedBg(x - 1, y);
      if (x < toX - 1) seedBg(x + 1, y);
    }

    // ── Step 4: candidate mask = eroded AND NOT bgFill ────────────────────
    const candidate = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        const idx = y * tw + x;
        candidate[idx] = (eroded[idx] && !bgFill[idx]) ? 1 : 0;
      }

    // ── Step 5: largest connected component = the shoe ───────────────────
    const { labels, count } = bfsLabel(candidate, fromX, toX);

    if (count === 0) {
      return fallback(fromX, toX, halfW);
    }

    const sizes = new Int32Array(count);
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        const l = labels[y * tw + x];
        if (l >= 0) sizes[l]++;
      }

    let bestLabel = 0, bestSize = 0;
    for (let i = 0; i < count; i++)
      if (sizes[i] > bestSize) { bestSize = sizes[i]; bestLabel = i; }

    // Reject if shoe blob is too small (< 1.5% of half area) — probably noise
    const minArea = halfW * th * 0.015;
    if (bestSize < minArea) {
      return fallback(fromX, toX, halfW);
    }

    // ── Step 6: clean shoe mask ───────────────────────────────────────────
    const shoe = new Uint8Array(tw * th);
    let minY = th, maxY = 0, minXs = toX, maxXs = fromX;
    for (let y = 0; y < th; y++)
      for (let x = fromX; x < toX; x++) {
        if (labels[y * tw + x] === bestLabel) {
          shoe[y * tw + x] = 1;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (x < minXs) minXs = x;
          if (x > maxXs) maxXs = x;
        }
      }

    const shoeH = maxY - minY;
    const shoeW = maxXs - minXs;
    if (shoeH < th * 0.04 || shoeW < halfW * 0.05) {
      return fallback(fromX, toX, halfW);
    }

    // ── Step 7: row-by-row silhouette contour ────────────────────────────
    const leftEdge: Pt[] = [];
    const rightEdge: Pt[] = [];
    for (let y = minY; y <= maxY; y++) {
      let lx = toX, rx = fromX - 1;
      for (let x = fromX; x < toX; x++)
        if (shoe[y * tw + x]) { if (x < lx) lx = x; if (x > rx) rx = x; }
      if (rx >= lx) {
        leftEdge.push({ x: lx, y });
        rightEdge.push({ x: rx, y });
      }
    }

    if (leftEdge.length < 4) return fallback(fromX, toX, halfW);

    const pts: Pt[] = [
      ...leftEdge,
      ...[...rightEdge].reverse(),
    ].map(p => ({ x: Math.round(p.x / SCALE), y: Math.round(p.y / SCALE) }));

    const bbox: BBox = {
      minX: Math.max(0, Math.round(minXs / SCALE)),
      maxX: Math.min(vw, Math.round(maxXs / SCALE)),
      minY: Math.max(0, Math.round(minY / SCALE)),
      maxY: Math.min(vh, Math.round(maxY / SCALE)),
    };

    return {
      bbox,
      contour: pts,
      ...(debugMode ? { debugMask: mask, debugClean: shoe, thumbW: tw, thumbH: th } : {}),
    };
  }

  function fallback(fromX: number, toX: number, halfW: number): ShoeResult {
    const pad = Math.round(halfW * 0.08);
    return {
      bbox: {
        minX: Math.round((fromX + pad) / SCALE),
        maxX: Math.round((toX - pad) / SCALE),
        minY: Math.round(th * 0.15 / SCALE),
        maxY: Math.round(th * 0.85 / SCALE),
      },
      contour: null,
    };
  }

  const mid = Math.round(tw / 2);
  const L = processHalf(0, mid);
  const Rh = processHalf(mid, tw);
  return {
    left: L.bbox, right: Rh.bbox,
    leftContour: L.contour, rightContour: Rh.contour,
    leftDebug: debugMode ? L : undefined,
    rightDebug: debugMode ? Rh : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug overlay: draws mask stages onto a secondary canvas shown below camera
// ─────────────────────────────────────────────────────────────────────────────
function renderDebug(
  dbgCanvas: HTMLCanvasElement,
  leftDebug: ShoeResult | undefined,
  rightDebug: ShoeResult | undefined,
  vw: number, vh: number
) {
  if (!leftDebug?.debugMask || !leftDebug.thumbW) return;
  const tw = leftDebug.thumbW;
  const th = leftDebug.thumbH!;

  // 4 panels: raw mask L, clean L, raw mask R, clean R
  const panelW = tw, panelH = th;
  dbgCanvas.width = panelW * 4;
  dbgCanvas.height = panelH;
  const ctx = dbgCanvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, dbgCanvas.width, panelH);

  const panels = [
    { label: "RAW MASK L", mask: leftDebug.debugMask, half: [0, Math.round(tw / 2)] as [number, number], color: [0, 200, 255] },
    { label: "SHOE ONLY L", mask: leftDebug.debugClean, half: [0, Math.round(tw / 2)] as [number, number], color: [0, 255, 120] },
    { label: "RAW MASK R", mask: rightDebug?.debugMask, half: [Math.round(tw / 2), tw] as [number, number], color: [0, 200, 255] },
    { label: "SHOE ONLY R", mask: rightDebug?.debugClean, half: [Math.round(tw / 2), tw] as [number, number], color: [0, 255, 120] },
  ];

  panels.forEach(({ label, mask, half, color }, pi) => {
    if (!mask) return;
    const [fx, tx] = half;
    const imgd = ctx.createImageData(panelW, panelH);
    for (let y = 0; y < th; y++) {
      for (let x = fx; x < tx; x++) {
        const src = y * tw + x;
        const dst = (y * panelW + (x - fx)) * 4;
        if (mask[src]) {
          imgd.data[dst] = color[0];
          imgd.data[dst + 1] = color[1];
          imgd.data[dst + 2] = color[2];
          imgd.data[dst + 3] = 255;
        } else {
          imgd.data[dst] = 20; imgd.data[dst + 1] = 20; imgd.data[dst + 2] = 30;
          imgd.data[dst + 3] = 255;
        }
      }
    }
    ctx.putImageData(imgd, pi * panelW, 0);
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(pi * panelW, 0, ctx.measureText(label).width + 8, 14);
    ctx.fillStyle = "#fff";
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.fillText(label, pi * panelW + 4, 11);
  });
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
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, vw, vh);

    await new Promise(r => setTimeout(r, 20));

    const result = detectShoes(canvas, vw, vh, debugMode);
    const { left: lb, right: rb, leftContour: lc, rightContour: rc } = result;

    if (debugMode && debugCanvasRef.current) {
      renderDebug(debugCanvasRef.current, result.leftDebug, result.rightDebug, vw, vh);
      setShowDebug(true);
    }

    setIsAnalyzing(false);

    const groundY = Math.max(lb.maxY, rb.maxY);
    const fs = Math.max(18, Math.round(vw * 0.018));

    function pill(text: string, cx: number, cy: number, bg: string, fg: string) {
      ctx.font = `bold ${fs}px -apple-system,sans-serif`;
      const tw2 = ctx.measureText(text).width;
      const ph = fs + 10, pw = tw2 + 20, r = ph / 2;
      const px = cx - pw / 2, py = cy - ph / 2;
      ctx.beginPath();
      ctx.moveTo(px + r, py);
      ctx.arcTo(px + pw, py, px + pw, py + ph, r);
      ctx.arcTo(px + pw, py + ph, px, py + ph, r);
      ctx.arcTo(px, py + ph, px, py, r);
      ctx.arcTo(px, py, px + pw, py, r);
      ctx.closePath();
      ctx.fillStyle = bg; ctx.fill();
      ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(text, cx, cy);
      ctx.textBaseline = "alphabetic";
    }

    function drawBox(bounds: BBox, contour: Pt[] | null, label: string) {
      ctx.beginPath();
      if (contour && contour.length > 2) {
        contour.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.closePath();
      } else {
        ctx.rect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      }
      ctx.fillStyle = `${GREEN}1a`; ctx.fill();
      ctx.strokeStyle = GREEN; ctx.lineWidth = Math.max(2, vw * 0.002);
      ctx.shadowColor = GREEN; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;

      const tk = Math.round(vw * 0.025);
      const { minX, minY, maxX } = bounds;
      const bY = groundY;
      ctx.strokeStyle = GREEN; ctx.lineWidth = Math.max(3, vw * 0.003);
      ctx.shadowColor = GREEN; ctx.shadowBlur = 8;
      [[minX, minY, 1, 1],[maxX, minY,-1, 1],[minX, bY, 1,-1],[maxX, bY,-1,-1]].forEach(([cx,cy,dx,dy]) => {
        ctx.beginPath(); ctx.moveTo(cx as number,(cy as number)+(dy as number)*tk);
        ctx.lineTo(cx as number,cy as number); ctx.lineTo((cx as number)+(dx as number)*tk,cy as number); ctx.stroke();
      });
      ctx.shadowBlur = 0;

      const hMm = pxToMm(groundY - bounds.minY);
      const wMm = pxToMm(bounds.maxX - bounds.minX);
      const midX = (bounds.minX + bounds.maxX) / 2;
      const midY = (bounds.minY + groundY) / 2;

      const hx = Math.min(bounds.maxX + fs * 1.8, vw - fs * 2);
      pill(`H ${hMm}mm`, hx, midY, "rgba(0,0,0,0.82)", GREEN);
      pill(`W ${wMm}mm`, midX, Math.max(bounds.minY - fs * 0.9, fs * 1.1), "rgba(0,0,0,0.82)", GREEN);

      ctx.strokeStyle = `${GREEN}60`; ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(bounds.minX, groundY); ctx.lineTo(bounds.maxX, groundY); ctx.stroke();
      ctx.setLineDash([]);

      pill(label, midX, Math.min(groundY + fs * 1.1, vh - fs * 0.8), `${GREEN}dd`, "#000");

      return { hMm, wMm };
    }

    const leftResult  = drawBox(lb, lc, "LEFT");
    const rightResult = drawBox(rb, rc, "RIGHT");

    ctx.strokeStyle = `${CYAN}60`;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(vw / 2, 0);
    ctx.lineTo(vw / 2, vh);
    ctx.stroke();
    ctx.setLineDash([]);

    const diff = parseFloat(Math.abs(leftResult.hMm - rightResult.hMm).toFixed(1));
    const passed = diff <= 3;

    ctx.fillStyle = `${passed ? GREEN : RED}ee`;
    const bh = Math.round(vh * 0.07);
    ctx.fillRect(0, vh - bh, vw, bh);
    ctx.font = `bold ${Math.round(vw * 0.022)}px -apple-system,sans-serif`;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      passed ? `✓  PASSED   Δ${diff} mm` : `✗  REJECTED   Δ${diff} mm  (limit 3mm)`,
      vw / 2, vh - bh / 2
    );
    ctx.textBaseline = "alphabetic";

    ctx.font = "11px monospace";
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    const stamp = `CV | L:${leftResult.hMm}mm R:${rightResult.hMm}mm`;
    ctx.fillRect(4, 4, ctx.measureText(stamp).width + 10, 18);
    ctx.fillStyle = GREEN;
    ctx.textAlign = "left";
    ctx.fillText(stamp, 9, 17);

    try {
      const blob = await compressImage(canvas, 0.9);
      const annotatedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      if ("vibrate" in navigator) navigator.vibrate([60, 30, 60]);

      onCapture({
        blob,
        dataUrl: annotatedDataUrl,
        annotatedDataUrl,
        leftHeightMm: leftResult.hMm,
        rightHeightMm: rightResult.hMm,
        leftWidthMm: leftResult.wMm,
        rightWidthMm: rightResult.wMm,
        heightDiffMm: diff,
        passed,
        rejectionReason: passed ? null : `Height difference ${diff}mm exceeds 3mm tolerance`,
      });

      setShowSuccess(true);
      setTimeout(() => { setShowSuccess(false); setIsCapturing(false); setShowDebug(false); }, 1200);
    } catch {
      onError("Failed to compress image");
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
    <div className="relative w-full bg-black overflow-hidden flex flex-col">
      {/* Camera viewport */}
      <div className="relative w-full" style={{ aspectRatio: "16/9" }}>
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
              <p className="text-base font-bold" style={{ color: CYAN }}>Segmenting shoes...</p>
            </motion.div>
          )}
        </AnimatePresence>

        {isReady && !isCapturing && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-0 bottom-0 left-1/2 w-px opacity-40"
              style={{ background: `repeating-linear-gradient(to bottom, ${CYAN} 0px, ${CYAN} 8px, transparent 8px, transparent 16px)` }} />
            <div className="absolute left-4 top-1/2 -translate-y-1/2">
              <div className="px-3 py-1 rounded-full text-xs font-bold"
                style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>
                LEFT SHOE
              </div>
            </div>
            <div className="absolute right-4 top-1/2 -translate-y-1/2">
              <div className="px-3 py-1 rounded-full text-xs font-bold"
                style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>
                RIGHT SHOE
              </div>
            </div>
            <div className="absolute top-8 left-8 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
            <div className="absolute top-8 right-8 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
            <div className="absolute bottom-8 left-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
            <div className="absolute bottom-8 right-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
          </div>
        )}

        {isReady && !isCapturing && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
            <div className="px-4 py-1.5 rounded-full text-xs font-semibold text-center whitespace-nowrap"
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
      </div>

      {/* Debug panel — shown when debugMode ON and capture taken */}
      <AnimatePresence>
        {showDebug && debugMode && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
            style={{ background: "#0a0a12", borderTop: "1px solid rgba(255,255,255,0.08)" }}
          >
            <div className="px-3 py-2">
              <p className="text-xs font-bold mb-2" style={{ color: YELLOW }}>DEBUG: Segmentation Masks</p>
              <canvas
                ref={debugCanvasRef}
                className="w-full rounded"
                style={{ imageRendering: "pixelated", border: `1px solid rgba(255,255,255,0.1)` }}
              />
              <div className="flex gap-4 mt-1.5 text-xs" style={{ color: "#555" }}>
                <span style={{ color: "#00c8ff" }}>■ Raw foreground mask</span>
                <span style={{ color: "#00ff78" }}>■ Shoe-only (largest blob)</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Controls */}
      <div className="flex items-center justify-between px-6 py-4" style={{ background: "#080810" }}>
        {/* Debug toggle */}
        <button
          onClick={() => { setDebugMode(d => !d); setShowDebug(false); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-colors"
          style={{
            background: debugMode ? `${YELLOW}22` : "rgba(255,255,255,0.04)",
            border: `1px solid ${debugMode ? YELLOW : "rgba(255,255,255,0.1)"}`,
            color: debugMode ? YELLOW : "#555",
          }}
        >
          <Bug className="w-3.5 h-3.5" />
          {debugMode ? "Debug ON" : "Debug"}
        </button>

        {/* Capture button */}
        <button
          onClick={handleCapture}
          disabled={!isReady || isCapturing || isAnalyzing}
          className="relative w-20 h-20 rounded-full flex items-center justify-center transition-transform active:scale-90 disabled:opacity-40"
          style={{ border: "4px solid rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.12)", backdropFilter: "blur(4px)" }}
        >
          <Camera className="w-8 h-8 text-white" />
          {(isCapturing || isAnalyzing) && (
            <div className="absolute inset-0 rounded-full border-4 border-cyan-400 animate-ping" />
          )}
        </button>

        {/* Spacer to balance layout */}
        <div className="w-16" />
      </div>

      <div className="text-center pb-3">
        <span className="text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.3)" }}>
          {isAnalyzing ? "segmenting..." : isCapturing ? "processing..." : "tap to capture"}
        </span>
      </div>
    </div>
  );
}
