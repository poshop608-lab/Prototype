"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, RotateCcw, Camera } from "lucide-react";
import { pxToMm, compressImage } from "@/lib/utils";
import type { CaptureResult } from "@/store/scan";

const CYAN = "#06b6d4";
const GREEN = "#22c55e";
const RED = "#ef4444";

interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface Pt { x: number; y: number; }
interface ShoeResult { bbox: BBox; polygon: Pt[]; }

interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

// ── Silhouette-polygon shoe detector ─────────────────────────────────────
// Per half-frame:
//  1. Build fg mask (lum diff from wall background)
//  2. Refine vertical extent bottom-up (no wall above shoe)
//  3. Trace left-edge + right-edge at every row → exact shoe silhouette polygon
//  4. Subsample polygon to ~60 points for smooth drawing
function detectShoes(
  canvas: HTMLCanvasElement,
  vw: number,
  vh: number
): { left: ShoeResult; right: ShoeResult } {
  const SCALE = 0.25;
  const tw = Math.round(vw * SCALE);
  const th = Math.round(vh * SCALE);

  const thumb = document.createElement("canvas");
  thumb.width = tw; thumb.height = th;
  const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(canvas, 0, 0, tw, th);
  const { data } = tctx.getImageData(0, 0, tw, th);

  // Background: top strip average
  let bgLum = 0, bgN = 0;
  for (let y = 0; y < Math.round(th * 0.15); y++) {
    for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4;
      bgLum += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      bgN++;
    }
  }
  bgLum /= bgN;

  const THRESH = 35;

  function pixLum(x: number, y: number): number {
    const i = (y * tw + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
  }
  function isFg(x: number, y: number): boolean {
    return Math.abs(pixLum(x, y) - bgLum) > THRESH;
  }

  function halfDetect(fromX: number, toX: number): ShoeResult {
    const halfW = toX - fromX;

    // Pass 1: raw bbox
    let minX = toX, maxX = fromX, minY = th, maxY = 0;
    let found = false;
    for (let y = Math.round(th * 0.1); y < th; y++) {
      for (let x = fromX; x < toX; x++) {
        if (isFg(x, y)) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          found = true;
        }
      }
    }

    if (!found || maxX - minX < halfW * 0.03 || maxY - minY < th * 0.03) {
      const pad = Math.round(halfW * 0.10);
      const vpad = Math.round(th * 0.10);
      const fb: BBox = {
        minX: Math.round((fromX + pad) / SCALE),
        maxX: Math.round((toX - pad) / SCALE),
        minY: Math.round(vpad / SCALE),
        maxY: Math.round((th - vpad) / SCALE),
      };
      return { bbox: fb, polygon: bboxToPolygon(fb) };
    }

    // Pass 2: refine minY bottom-up within detected x-range.
    // Threshold 0.20: actual shoe rows >0.35 density; wall marks <0.06.
    // emptyStreak 2: 2 consecutive sub-threshold rows = above shoe, stop.
    // Max-height clamp: shoe height cannot exceed 55% of frame.
    let refinedMinY = maxY;
    let emptyStreak = 0;
    for (let y = maxY - 1; y >= minY; y--) {
      let rowFg = 0;
      for (let x = minX; x <= maxX; x++) if (isFg(x, y)) rowFg++;
      if (rowFg / (maxX - minX + 1) > 0.20) {
        refinedMinY = y; emptyStreak = 0;
      } else if (++emptyStreak >= 2) break;
    }
    // Hard clamp: never let the box be taller than 55% of frame height
    const maxBoxHeight = Math.round(th * 0.55);
    if (maxY - refinedMinY > maxBoxHeight) refinedMinY = maxY - maxBoxHeight;
    minY = refinedMinY;

    // Pass 3: trace left + right edges row by row within shoe band
    const leftEdge: Pt[] = [];   // top → bottom
    const rightEdge: Pt[] = [];  // top → bottom (reversed for polygon winding)

    for (let y = minY; y <= maxY; y++) {
      let lx = -1, rx = -1;
      for (let x = fromX; x < toX; x++) {
        if (isFg(x, y)) { if (lx === -1) lx = x; rx = x; }
      }
      if (lx !== -1) {
        leftEdge.push({ x: Math.round(lx / SCALE), y: Math.round(y / SCALE) });
        rightEdge.push({ x: Math.round(rx / SCALE), y: Math.round(y / SCALE) });
      }
    }

    // Polygon = left edge top→bottom + right edge bottom→top
    const rawPolygon: Pt[] = [...leftEdge, ...rightEdge.reverse()];

    // Subsample to ~80 points for smooth rendering
    const polygon = subsample(rawPolygon, 80);

    const PAD = 4;
    const bbox: BBox = {
      minX: Math.max(0, Math.round((minX - PAD) / SCALE)),
      maxX: Math.min(vw, Math.round((maxX + PAD) / SCALE)),
      minY: Math.max(0, Math.round((minY - PAD) / SCALE)),
      maxY: Math.min(vh, Math.round((maxY + PAD) / SCALE)),
    };

    return { bbox, polygon };
  }

  const mid = Math.round(tw / 2);
  return {
    left: halfDetect(0, mid),
    right: halfDetect(mid, tw),
  };
}

function subsample(pts: Pt[], target: number): Pt[] {
  if (pts.length <= target) return pts;
  const step = pts.length / target;
  const out: Pt[] = [];
  for (let i = 0; i < target; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

function bboxToPolygon(b: BBox): Pt[] {
  return [
    { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY },
  ];
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isPortrait, setIsPortrait] = useState(false);

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

    const { left: ls, right: rs } = detectShoes(canvas, vw, vh);
    setIsAnalyzing(false);

    const groundY = Math.max(ls.bbox.maxY, rs.bbox.maxY);

    function drawShoe(result: ShoeResult, label: string) {
      const { bbox, polygon } = result;

      // Draw silhouette polygon
      if (polygon.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(polygon[0].x, polygon[0].y);
        for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
        ctx.closePath();
        ctx.fillStyle = `${GREEN}20`;
        ctx.fill();
        ctx.strokeStyle = GREEN;
        ctx.lineWidth = 3;
        ctx.shadowColor = GREEN;
        ctx.shadowBlur = 16;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        // Fallback rect
        ctx.beginPath();
        ctx.rect(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
        ctx.fillStyle = `${GREEN}20`;
        ctx.fill();
        ctx.strokeStyle = GREEN;
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      const heightPx = groundY - bbox.minY;
      const widthPx = bbox.maxX - bbox.minX;
      const hMm = pxToMm(heightPx);
      const wMm = pxToMm(widthPx);
      const midX = (bbox.minX + bbox.maxX) / 2;
      const midY = (bbox.minY + groundY) / 2;
      const rX = Math.min(bbox.maxX + 8, vw - 90);

      // Height label
      ctx.font = "bold 16px monospace";
      const hl = `${hMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(rX - 2, midY - 12, ctx.measureText(hl).width + 10, 20);
      ctx.fillStyle = GREEN;
      ctx.textAlign = "left";
      ctx.fillText(hl, rX + 2, midY + 4);

      // Width label
      const wl = `${wMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(midX - ctx.measureText(wl).width / 2 - 4, Math.max(bbox.minY - 26, 0), ctx.measureText(wl).width + 8, 18);
      ctx.fillStyle = GREEN;
      ctx.textAlign = "center";
      ctx.fillText(wl, midX, Math.max(bbox.minY - 10, 14));

      // LEFT/RIGHT badge
      ctx.font = "bold 13px monospace";
      const bw = ctx.measureText(label).width + 14;
      ctx.fillStyle = `${GREEN}cc`;
      ctx.fillRect(midX - bw / 2, Math.min(groundY + 6, vh - 22), bw, 18);
      ctx.fillStyle = "#000";
      ctx.textAlign = "center";
      ctx.fillText(label, midX, Math.min(groundY + 19, vh - 8));

      // Ground baseline
      ctx.strokeStyle = `${GREEN}80`;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(bbox.minX, groundY);
      ctx.lineTo(bbox.maxX, groundY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Debug: TOP point (cyan dot)
      ctx.beginPath();
      ctx.arc(midX, bbox.minY, 6, 0, Math.PI * 2);
      ctx.fillStyle = CYAN;
      ctx.fill();
      // Debug: BOTTOM point (cyan dot)
      ctx.beginPath();
      ctx.arc(midX, bbox.maxY, 6, 0, Math.PI * 2);
      ctx.fillStyle = CYAN;
      ctx.fill();

      return { hMm, wMm };
    }

    const leftResult = drawShoe(ls, "LEFT");
    const rightResult = drawShoe(rs, "RIGHT");

    // Center divider
    ctx.strokeStyle = `${CYAN}50`;
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
    ctx.fillRect(0, vh - 48, vw, 48);
    ctx.font = "bold 20px monospace";
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(
      passed ? `PASSED  Δ${diff}mm` : `REJECTED  Δ${diff}mm  (>3mm)`,
      vw / 2, vh - 16
    );

    ctx.font = "11px monospace";
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    const stamp = `CV-SEG | L:${leftResult.hMm}mm R:${rightResult.hMm}mm`;
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
      setTimeout(() => { setShowSuccess(false); setIsCapturing(false); }, 1200);
    } catch {
      onError("Failed to compress image");
      setIsCapturing(false);
    }
  }, [isCapturing, isAnalyzing, onCapture, onError]);

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
            <p className="text-base font-bold" style={{ color: CYAN }}>Tracing shoe silhouette...</p>
          </motion.div>
        )}
      </AnimatePresence>

      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 bottom-0 left-1/2 w-px opacity-30"
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
          <div className="absolute bottom-24 left-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 right-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
        </div>
      )}

      {isReady && !isCapturing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="px-4 py-1.5 rounded-full text-xs font-semibold text-center whitespace-nowrap"
            style={{ background: "rgba(0,0,0,0.75)", border: `1px solid ${CYAN}40`, color: "#ccc" }}>
            Side view · one shoe each side · landscape
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

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2">
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
        <span className="text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.5)" }}>
          {isAnalyzing ? "tracing..." : isCapturing ? "processing..." : "tap to capture"}
        </span>
      </div>
    </div>
  );
}
