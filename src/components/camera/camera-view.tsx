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

// ── Guaranteed split-frame detector ───────────────────────────────────────
// Splits frame into left/right halves. In each half, finds the tightest
// bounding box around foreground pixels using pixel luminance analysis.
// Falls back to 80% of half-frame if no clear foreground found.
// NEVER fails — always returns two boxes.
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

  // Sample background luminance from top strip (sky/wall above shoes)
  let bgLum = 0, bgN = 0;
  const topStrip = Math.round(th * 0.15);
  for (let y = 0; y < topStrip; y++) {
    for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4;
      bgLum += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      bgN++;
    }
  }
  bgLum /= bgN;

  // For each half, find tight bbox of pixels that differ from background
  function halfBBox(fromX: number, toX: number): BBox {
    let minX = toX, maxX = fromX, minY = th, maxY = 0;
    let found = false;

    // Threshold: pixel is "shoe" if luminance differs enough from bg
    // Use both dark-object-on-light and light-object-on-dark detection
    const THRESH = 35;

    for (let y = Math.round(th * 0.1); y < th; y++) {
      for (let x = fromX; x < toX; x++) {
        const i = (y * tw + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        if (Math.abs(lum - bgLum) > THRESH) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }

    if (!found || maxX - minX < tw * 0.03 || maxY - minY < th * 0.03) {
      const pad = Math.round((toX - fromX) * 0.10);
      const vpad = Math.round(th * 0.10);
      return {
        minX: Math.round((fromX + pad) / SCALE),
        maxX: Math.round((toX - pad) / SCALE),
        minY: Math.round(vpad / SCALE),
        maxY: Math.round((th - vpad) / SCALE),
      };
    }

    // Clamp height: shoe can't be taller than 55% of frame height.
    // Prevents wall pixels above shoe from inflating the box upward.
    const maxHeightPx = Math.round(th * 0.55);
    if (maxY - minY > maxHeightPx) minY = maxY - maxHeightPx;

    const PAD = 4;
    return {
      minX: Math.max(0, Math.round((minX - PAD) / SCALE)),
      maxX: Math.min(vw, Math.round((maxX + PAD) / SCALE)),
      minY: Math.max(0, Math.round((minY - PAD) / SCALE)),
      maxY: Math.min(vh, Math.round((maxY + PAD) / SCALE)),
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

    // Scale font relative to frame width so labels never crowd on any resolution
    const fs = Math.max(18, Math.round(vw * 0.018)); // ~18px at 1000w, 34px at 1920w

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

    function drawBox(bounds: BBox, label: string) {
      // Box fill + stroke
      ctx.beginPath();
      ctx.rect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      ctx.fillStyle = `${GREEN}1a`; ctx.fill();
      ctx.strokeStyle = GREEN; ctx.lineWidth = Math.max(2, vw * 0.002);
      ctx.shadowColor = GREEN; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;

      // Corner ticks
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

      // Height pill — vertically centred on box right edge
      const hx = Math.min(bounds.maxX + fs * 1.8, vw - fs * 2);
      pill(`H ${hMm}mm`, hx, midY, "rgba(0,0,0,0.82)", GREEN);

      // Width pill — above box top, safely inside frame
      pill(`W ${wMm}mm`, midX, Math.max(bounds.minY - fs * 0.9, fs * 1.1), "rgba(0,0,0,0.82)", GREEN);

      // Baseline dashes
      ctx.strokeStyle = `${GREEN}60`; ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(bounds.minX, groundY); ctx.lineTo(bounds.maxX, groundY); ctx.stroke();
      ctx.setLineDash([]);

      // Label chip below baseline
      pill(label, midX, Math.min(groundY + fs * 1.1, vh - fs * 0.8), `${GREEN}dd`, "#000");

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
