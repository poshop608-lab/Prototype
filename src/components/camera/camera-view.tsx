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

interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

// ── Bottom-anchored shoe detector ─────────────────────────────────────────
// Key insight: shoes sit ON a surface. The shoe occupies the region just
// ABOVE the surface/table line. We scan from bottom up to find:
//   1. The surface line (first row of uniform horizontal color = table)
//   2. The shoe mass above it (darkest / most different from bg wall)
// This ignores wall/background above the shoe entirely.
function detectShoes(
  canvas: HTMLCanvasElement,
  vw: number,
  vh: number
): { left: BBox; right: BBox } {
  const SCALE = 0.25;
  const tw = Math.round(vw * SCALE);
  const th = Math.round(vh * SCALE);

  const thumb = document.createElement("canvas");
  thumb.width = tw; thumb.height = th;
  const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(canvas, 0, 0, tw, th);
  const { data } = tctx.getImageData(0, 0, tw, th);

  function lum(x: number, y: number) {
    const i = (y * tw + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
  }

  // Sample wall/background: top 20% of frame (above shoe area)
  let wallLum = 0, wallN = 0;
  for (let y = 0; y < Math.round(th * 0.20); y++) {
    for (let x = 0; x < tw; x++) {
      wallLum += lum(x, y); wallN++;
    }
  }
  wallLum /= wallN;

  // Find surface/table line by scanning bottom-up:
  // The surface row is the first row (from bottom) where the entire row
  // has uniform-ish luminance (low stddev = flat surface, not shoe texture)
  function findSurfaceY(fromX: number, toX: number): number {
    for (let y = th - 1; y > th * 0.5; y--) {
      const lums: number[] = [];
      for (let x = fromX; x < toX; x++) lums.push(lum(x, y));
      const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
      const variance = lums.reduce((s, v) => s + (v - mean) ** 2, 0) / lums.length;
      const stddev = Math.sqrt(variance);
      // Uniform row = surface (stddev < 18 means it's a flat table/floor)
      if (stddev < 18) return y;
    }
    // Fallback: bottom 15% of frame
    return Math.round(th * 0.85);
  }

  // Within each half, find the shoe bbox:
  // Scan from surfaceY upward, mark pixels that differ from wall background
  // Stop scanning upward when we hit 3+ consecutive rows with NO shoe pixels
  // (= we've exited the shoe and hit background wall)
  function halfBBox(fromX: number, toX: number): BBox {
    const surfaceY = findSurfaceY(fromX, toX);
    const THRESH = 28; // differs from wall bg by this much = shoe pixel
    const halfW = toX - fromX;

    let shoeTop = surfaceY;
    let consecutiveEmpty = 0;

    for (let y = surfaceY - 1; y >= Math.round(th * 0.05); y--) {
      let rowShoePixels = 0;
      for (let x = fromX; x < toX; x++) {
        if (Math.abs(lum(x, y) - wallLum) > THRESH) rowShoePixels++;
      }
      const density = rowShoePixels / halfW;
      if (density > 0.08) {
        // This row has shoe content
        shoeTop = y;
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
        // 4 consecutive empty rows above shoe = we've cleared the shoe top
        if (consecutiveEmpty >= 4) break;
      }
    }

    // Now find left/right extent within shoeTop..surfaceY
    let minX = toX, maxX = fromX;
    for (let y = shoeTop; y <= surfaceY; y++) {
      for (let x = fromX; x < toX; x++) {
        if (Math.abs(lum(x, y) - wallLum) > THRESH) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }

    // Sanity check — fallback to reasonable default if result is tiny
    const boxW = maxX - minX;
    const boxH = surfaceY - shoeTop;
    if (boxW < halfW * 0.15 || boxH < th * 0.05) {
      // Use middle 70% of half, top 30%–bottom 85%
      const pad = Math.round(halfW * 0.15);
      return {
        minX: Math.round((fromX + pad) / SCALE),
        maxX: Math.round((toX - pad) / SCALE),
        minY: Math.round(th * 0.30 / SCALE),
        maxY: Math.round(surfaceY / SCALE),
      };
    }

    const PAD = 3;
    return {
      minX: Math.max(0, Math.round((minX - PAD) / SCALE)),
      maxX: Math.min(vw, Math.round((maxX + PAD) / SCALE)),
      minY: Math.max(0, Math.round((shoeTop - PAD) / SCALE)),
      maxY: Math.min(vh, Math.round((surfaceY + PAD) / SCALE)),
    };
  }

  const mid = Math.round(tw / 2);
  return {
    left: halfBBox(0, mid),
    right: halfBBox(mid, tw),
  };
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

    const { left: lb, right: rb } = detectShoes(canvas, vw, vh);
    setIsAnalyzing(false);

    const groundY = Math.max(lb.maxY, rb.maxY);

    function drawBox(bounds: BBox, label: string) {
      ctx.beginPath();
      ctx.rect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      ctx.fillStyle = `${GREEN}22`;
      ctx.fill();
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 3;
      ctx.shadowColor = GREEN;
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.shadowBlur = 0;

      const heightPx = groundY - bounds.minY;
      const widthPx = bounds.maxX - bounds.minX;
      const hMm = pxToMm(heightPx);
      const wMm = pxToMm(widthPx);
      const midX = (bounds.minX + bounds.maxX) / 2;
      const midY = (bounds.minY + groundY) / 2;
      const rX = Math.min(bounds.maxX + 8, vw - 90);

      ctx.font = "bold 16px monospace";
      const hl = `${hMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(rX - 2, midY - 12, ctx.measureText(hl).width + 10, 20);
      ctx.fillStyle = GREEN;
      ctx.textAlign = "left";
      ctx.fillText(hl, rX + 2, midY + 4);

      const wl = `${wMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(midX - ctx.measureText(wl).width / 2 - 4, Math.max(bounds.minY - 26, 0), ctx.measureText(wl).width + 8, 18);
      ctx.fillStyle = GREEN;
      ctx.textAlign = "center";
      ctx.fillText(wl, midX, Math.max(bounds.minY - 10, 14));

      ctx.font = "bold 13px monospace";
      const bw = ctx.measureText(label).width + 14;
      ctx.fillStyle = `${GREEN}cc`;
      ctx.fillRect(midX - bw / 2, Math.min(groundY + 6, vh - 22), bw, 18);
      ctx.fillStyle = "#000";
      ctx.textAlign = "center";
      ctx.fillText(label, midX, Math.min(groundY + 19, vh - 8));

      ctx.strokeStyle = `${GREEN}80`;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(bounds.minX, groundY);
      ctx.lineTo(bounds.maxX, groundY);
      ctx.stroke();
      ctx.setLineDash([]);

      return { hMm, wMm };
    }

    const leftResult = drawBox(lb, "LEFT");
    const rightResult = drawBox(rb, "RIGHT");

    // Draw center divider line so user can see the split
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
            <p className="text-base font-bold" style={{ color: CYAN }}>Measuring shoes...</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Guide overlay — shows split line and shoe zones */}
      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          {/* Center divider */}
          <div className="absolute top-0 bottom-0 left-1/2 w-px opacity-40"
            style={{ background: `repeating-linear-gradient(to bottom, ${CYAN} 0px, ${CYAN} 8px, transparent 8px, transparent 16px)` }} />
          {/* Left zone label */}
          <div className="absolute left-4 top-1/2 -translate-y-1/2">
            <div className="px-3 py-1 rounded-full text-xs font-bold"
              style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>
              LEFT SHOE
            </div>
          </div>
          {/* Right zone label */}
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="px-3 py-1 rounded-full text-xs font-bold"
              style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>
              RIGHT SHOE
            </div>
          </div>
          {/* Corner guides */}
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
            One shoe each side of the line · landscape · tap capture
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
          {isAnalyzing ? "measuring..." : isCapturing ? "processing..." : "tap to capture"}
        </span>
      </div>
    </div>
  );
}
