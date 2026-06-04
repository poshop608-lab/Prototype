"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, RotateCcw, Camera } from "lucide-react";
import { pxToMm, compressImage } from "@/lib/utils";
import type { CaptureResult } from "@/store/scan";

const CYAN = "#06b6d4";
const GREEN = "#22c55e";
const RED  = "#ef4444";

interface Pt  { x: number; y: number; }
interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface ShoeResult { bbox: BBox; contour: Pt[]; topPt: Pt; bottomPt: Pt; }

interface Props {
  onCapture: (result: CaptureResult) => void;
  onError:   (msg: string) => void;
}

// ── Otsu optimal threshold ────────────────────────────────────────────────
function otsu(lums: Float32Array): number {
  const h = new Float64Array(256);
  for (let i = 0; i < lums.length; i++) h[Math.round(Math.min(255, lums[i]))]++;
  const N = lums.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
  let wB = 0, sB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += h[i]; if (!wB) continue;
    const wF = N - wB; if (!wF) break;
    sB += i * h[i];
    const v = wB * wF * ((sB / wB) - ((sum - sB) / wF)) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

// ── Binary morphological dilation (fills tiny gaps in shoe mask) ──────────
function dilate(mask: Uint8Array, w: number, h: number, r = 2): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { out[y * w + x] = 1; continue; }
      outer: for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w && mask[ny * w + nx]) {
            out[y * w + x] = 1; break outer;
          }
        }
    }
  return out;
}

// ── Contour smoother (3-pt moving average — keeps toe/heel curves) ────────
function smooth(pts: Pt[], r = 2): Pt[] {
  return pts.map((_, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(pts.length - 1, i + r); j++) {
      sx += pts[j].x; sy += pts[j].y; n++;
    }
    return { x: sx / n, y: sy / n };
  });
}

// ── Full-precision shoe silhouette detector ───────────────────────────────
// Scale 0.40 (vs 0.25 before) → 60% more resolution → sharper curves
// Pipeline: Otsu mask → dilate (fill gaps) → row-by-row edge trace (ALL pts)
//           → smooth → bottom-anchored extent
function detectShoes(canvas: HTMLCanvasElement, vw: number, vh: number)
  : { left: ShoeResult; right: ShoeResult } {

  const SCALE = 0.40;
  const tw = Math.round(vw * SCALE);
  const th = Math.round(vh * SCALE);

  const thumb = document.createElement("canvas");
  thumb.width = tw; thumb.height = th;
  thumb.getContext("2d", { willReadFrequently: true })!.drawImage(canvas, 0, 0, tw, th);
  const { data } = thumb.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, tw, th);

  const gray = new Float32Array(tw * th);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4;
      gray[y * tw + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }

  function halfDetect(fromX: number, toX: number): ShoeResult {
    const halfW = toX - fromX;

    // Otsu on this half only
    const hg = new Float32Array(halfW * th);
    for (let y = 0; y < th; y++)
      for (let x = 0; x < halfW; x++) hg[y * halfW + x] = gray[y * tw + (fromX + x)];
    const thresh = otsu(hg);

    // Binary mask: dark pixels = shoe
    const rawMask = new Uint8Array(halfW * th);
    for (let y = 0; y < th; y++)
      for (let x = 0; x < halfW; x++)
        rawMask[y * halfW + x] = gray[y * tw + (fromX + x)] < thresh ? 1 : 0;

    // Dilate 2px to fill stitching/sole gaps
    const mask = dilate(rawMask, halfW, th, 2);

    // Per-row shoe density
    const den = new Float32Array(th);
    for (let y = 0; y < th; y++) {
      let c = 0;
      for (let x = 0; x < halfW; x++) c += mask[y * halfW + x];
      den[y] = c / halfW;
    }

    // Bottom-anchored extent: shoe bottom → scan up → stop at 2 sub-threshold rows
    let shoeBottom = Math.round(th * 0.80);
    for (let y = Math.round(th * 0.90); y >= Math.round(th * 0.20); y--)
      if (den[y] > 0.15) { shoeBottom = y; break; }

    let shoeTop = shoeBottom, empty = 0;
    for (let y = shoeBottom - 1; y >= 0; y--) {
      if (den[y] > 0.18) { shoeTop = y; empty = 0; }
      else if (++empty >= 2) break;
    }
    // Hard-clamp height to 55% of frame
    if (shoeBottom - shoeTop > Math.round(th * 0.55))
      shoeTop = shoeBottom - Math.round(th * 0.55);

    // Trace left + right edges row-by-row — ALL points, no downsampling
    const leftEdge: Pt[] = [], rightEdge: Pt[] = [];
    let bboxMinX = halfW, bboxMaxX = 0;

    for (let y = shoeTop; y <= shoeBottom; y++) {
      let lx = -1, rx = -1;
      for (let x = 0; x < halfW; x++)
        if (mask[y * halfW + x]) { if (lx === -1) lx = x; rx = x; }
      if (lx === -1) continue;
      if (lx < bboxMinX) bboxMinX = lx;
      if (rx > bboxMaxX) bboxMaxX = rx;
      leftEdge.push ({ x: (fromX + lx) / SCALE, y: y / SCALE });
      rightEdge.push({ x: (fromX + rx) / SCALE, y: y / SCALE });
    }

    // Closed contour: left-edge top→bottom + right-edge bottom→top
    const raw: Pt[] = [...leftEdge, ...rightEdge.reverse()];
    // Smooth with radius 3 (preserves toe/heel curvature, removes pixel jitter)
    const contour = smooth(raw, 3);

    const PAD = 3;
    const bbox: BBox = {
      minX: Math.max(0,  Math.round((bboxMinX + fromX - PAD) / SCALE)),
      maxX: Math.min(vw, Math.round((bboxMaxX + fromX + PAD) / SCALE)),
      minY: Math.max(0,  Math.round((shoeTop   - PAD) / SCALE)),
      maxY: Math.min(vh, Math.round((shoeBottom + PAD) / SCALE)),
    };

    // Midpoints for debug dots
    const midCX = (bboxMinX + bboxMaxX) / 2;
    const topPt:    Pt = { x: (fromX + midCX) / SCALE, y: shoeTop    / SCALE };
    const bottomPt: Pt = { x: (fromX + midCX) / SCALE, y: shoeBottom / SCALE };

    // Fallback
    if (contour.length < 4) {
      const p = Math.round(halfW * 0.08);
      return {
        bbox: { minX: Math.round((fromX + p) / SCALE), maxX: Math.round((toX - p) / SCALE),
                minY: Math.round(th * 0.15 / SCALE),   maxY: Math.round(th * 0.85 / SCALE) },
        contour: [], topPt, bottomPt,
      };
    }

    return { bbox, contour, topPt, bottomPt };
  }

  const mid = Math.round(tw / 2);
  return { left: halfDetect(0, mid), right: halfDetect(mid, tw) };
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [isReady,    setIsReady]    = useState(false);
  const [isCapturing,setIsCapturing]= useState(false);
  const [isAnalyzing,setIsAnalyzing]= useState(false);
  const [showSuccess,setShowSuccess]= useState(false);
  const [isPortrait, setIsPortrait] = useState(false);

  useEffect(() => {
    const check = () => setIsPortrait(window.innerHeight > window.innerWidth);
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => { window.removeEventListener("resize", check); window.removeEventListener("orientationchange", check); };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream; v.setAttribute("playsinline","true");
        await new Promise<void>(r => { v.onloadedmetadata = () => r(); });
        await v.play().catch(()=>{});
        setIsReady(true);
      } catch { onError("Camera access denied. Allow camera permissions and reload."); }
    })();
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, [onError]);

  const handleCapture = useCallback(async () => {
    const video  = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setIsCapturing(true); setIsAnalyzing(true);

    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    canvas.width = vw; canvas.height = vh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, vw, vh);
    await new Promise(r => setTimeout(r, 20));

    const { left: ls, right: rs } = detectShoes(canvas, vw, vh);
    setIsAnalyzing(false);

    const groundY = Math.max(ls.bbox.maxY, rs.bbox.maxY);

    function drawShoe(res: ShoeResult, label: string) {
      const { bbox, contour, topPt, bottomPt } = res;

      if (contour.length >= 3) {
        // Filled silhouette
        ctx.beginPath();
        ctx.moveTo(contour[0].x, contour[0].y);
        for (let i = 1; i < contour.length; i++) ctx.lineTo(contour[i].x, contour[i].y);
        ctx.closePath();
        ctx.fillStyle = `${GREEN}1a`;
        ctx.fill();
        // Glowing stroke
        ctx.strokeStyle = GREEN;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = GREEN;
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = GREEN; ctx.lineWidth = 2.5;
        ctx.strokeRect(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
      }

      const heightPx = groundY - bbox.minY;
      const hMm = pxToMm(heightPx);
      const wMm = pxToMm(bbox.maxX - bbox.minX);
      const midX = (bbox.minX + bbox.maxX) / 2;
      const midY = (bbox.minY + groundY) / 2;
      const rX   = Math.min(bbox.maxX + 8, vw - 90);

      // Height label
      ctx.font = "bold 16px monospace";
      const hl = `${hMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(rX - 2, midY - 12, ctx.measureText(hl).width + 10, 20);
      ctx.fillStyle = GREEN; ctx.textAlign = "left";
      ctx.fillText(hl, rX + 2, midY + 4);

      // Width label
      const wl = `${wMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(midX - ctx.measureText(wl).width / 2 - 4, Math.max(bbox.minY - 26, 0), ctx.measureText(wl).width + 8, 18);
      ctx.fillStyle = GREEN; ctx.textAlign = "center";
      ctx.fillText(wl, midX, Math.max(bbox.minY - 10, 14));

      // LEFT/RIGHT badge
      ctx.font = "bold 13px monospace";
      const bw = ctx.measureText(label).width + 14;
      ctx.fillStyle = `${GREEN}cc`;
      ctx.fillRect(midX - bw / 2, Math.min(groundY + 6, vh - 22), bw, 18);
      ctx.fillStyle = "#000"; ctx.textAlign = "center";
      ctx.fillText(label, midX, Math.min(groundY + 19, vh - 8));

      // Ground baseline
      ctx.strokeStyle = `${GREEN}80`; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(bbox.minX, groundY); ctx.lineTo(bbox.maxX, groundY);
      ctx.stroke(); ctx.setLineDash([]);

      // Debug dots: TOP (cyan) + BOTTOM (cyan)
      for (const pt of [topPt, bottomPt]) {
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = CYAN; ctx.fill();
        ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.stroke();
      }

      return { hMm, wMm };
    }

    const L = drawShoe(ls, "LEFT");
    const R = drawShoe(rs, "RIGHT");

    // Center divider
    ctx.strokeStyle = `${CYAN}40`; ctx.lineWidth = 1; ctx.setLineDash([6,6]);
    ctx.beginPath(); ctx.moveTo(vw/2, 0); ctx.lineTo(vw/2, vh);
    ctx.stroke(); ctx.setLineDash([]);

    const diff   = parseFloat(Math.abs(L.hMm - R.hMm).toFixed(1));
    const passed = diff <= 3;

    ctx.fillStyle = `${passed ? GREEN : RED}ee`;
    ctx.fillRect(0, vh - 48, vw, 48);
    ctx.font = "bold 20px monospace"; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText(passed ? `PASSED  Δ${diff}mm` : `REJECTED  Δ${diff}mm  (>3mm)`, vw/2, vh-16);

    ctx.font = "11px monospace"; ctx.fillStyle = "rgba(0,0,0,0.7)";
    const s = `OTSU | L:${L.hMm}mm R:${R.hMm}mm`;
    ctx.fillRect(4, 4, ctx.measureText(s).width + 10, 18);
    ctx.fillStyle = GREEN; ctx.textAlign = "left"; ctx.fillText(s, 9, 17);

    try {
      const blob = await compressImage(canvas, 0.9);
      const annotatedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      if ("vibrate" in navigator) navigator.vibrate([60, 30, 60]);
      onCapture({
        blob, dataUrl: annotatedDataUrl, annotatedDataUrl,
        leftHeightMm: L.hMm, rightHeightMm: R.hMm,
        leftWidthMm: L.wMm, rightWidthMm: R.wMm,
        heightDiffMm: diff, passed,
        rejectionReason: passed ? null : `Height difference ${diff}mm exceeds 3mm tolerance`,
      });
      setShowSuccess(true);
      setTimeout(() => { setShowSuccess(false); setIsCapturing(false); }, 1200);
    } catch {
      onError("Failed to compress image"); setIsCapturing(false);
    }
  }, [isCapturing, isAnalyzing, onCapture, onError]);

  if (isPortrait) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center px-8">
          <RotateCcw className="w-14 h-14 mx-auto mb-4" style={{ color: CYAN, animation: "spin 3s linear infinite" }} />
          <p className="text-white font-bold text-lg mb-2">Rotate your phone</p>
          <p className="text-sm" style={{ color: "#888" }}>Hold horizontally to scan both shoes</p>
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
          <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-30"
            style={{ background:"rgba(0,0,0,0.6)", backdropFilter:"blur(4px)" }}>
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold" style={{ color: CYAN }}>Extracting silhouette...</p>
            <p className="text-xs mt-1" style={{ color:"#666" }}>Otsu segmentation</p>
          </motion.div>
        )}
      </AnimatePresence>

      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 bottom-0 left-1/2 w-px opacity-30"
            style={{ background:`repeating-linear-gradient(to bottom,${CYAN} 0,${CYAN} 8px,transparent 8px,transparent 16px)` }} />
          <div className="absolute left-4 top-1/2 -translate-y-1/2">
            <div className="px-3 py-1 rounded-full text-xs font-bold"
              style={{ background:"rgba(0,0,0,0.6)", border:`1px solid ${CYAN}50`, color:CYAN }}>LEFT SHOE</div>
          </div>
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="px-3 py-1 rounded-full text-xs font-bold"
              style={{ background:"rgba(0,0,0,0.6)", border:`1px solid ${CYAN}50`, color:CYAN }}>RIGHT SHOE</div>
          </div>
          {[["top-8","left-8","borderTop","borderLeft"],["top-8","right-8","borderTop","borderRight"],
            ["bottom-24","left-8","borderBottom","borderLeft"],["bottom-24","right-8","borderBottom","borderRight"]]
            .map(([t,lr,b1,b2],i) => (
              <div key={i} className={`absolute ${t} ${lr} w-10 h-10`}
                style={{ [b1]:`2px solid ${CYAN}`, [b2]:`2px solid ${CYAN}` }} />
            ))}
        </div>
      )}

      {isReady && !isCapturing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap"
            style={{ background:"rgba(0,0,0,0.75)", border:`1px solid ${CYAN}40`, color:"#ccc" }}>
            Side view · one shoe each side · landscape
          </div>
        </div>
      )}

      <AnimatePresence>
        {showSuccess && (
          <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
            className="absolute inset-0 flex items-center justify-center z-20"
            style={{ background:"rgba(0,0,0,0.4)", backdropFilter:"blur(2px)" }}>
            <motion.div initial={{ scale:0.5, opacity:0 }} animate={{ scale:1, opacity:1 }} exit={{ scale:1.2, opacity:0 }}
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{ background:"rgba(34,197,94,0.2)", border:`2px solid ${GREEN}`, boxShadow:`0 0 32px ${GREEN}80` }}>
              <CheckCircle2 className="w-10 h-10" style={{ color: GREEN }} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2">
        <button onClick={handleCapture} disabled={!isReady || isCapturing || isAnalyzing}
          className="relative w-20 h-20 rounded-full flex items-center justify-center transition-transform active:scale-90 disabled:opacity-40"
          style={{ border:"4px solid rgba(255,255,255,0.85)", background:"rgba(255,255,255,0.12)", backdropFilter:"blur(4px)" }}>
          <Camera className="w-8 h-8 text-white" />
          {(isCapturing || isAnalyzing) && <div className="absolute inset-0 rounded-full border-4 border-cyan-400 animate-ping" />}
        </button>
        <span className="text-[10px] font-medium" style={{ color:"rgba(255,255,255,0.5)" }}>
          {isAnalyzing ? "segmenting..." : isCapturing ? "processing..." : "tap to capture"}
        </span>
      </div>
    </div>
  );
}
