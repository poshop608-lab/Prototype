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

// Wait for OpenCV.js WASM to be ready (loaded via <script> in layout.tsx)
function waitForOpenCV(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("OpenCV.js timed out")), 20000);
    function check() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cv = (window as any).cv;
      if (cv && cv.Mat) { clearTimeout(timeout); resolve(); return; }
      // cv may exist but still loading (has onRuntimeInitialized)
      if (cv && cv.onRuntimeInitialized !== undefined) {
        cv.onRuntimeInitialized = () => { clearTimeout(timeout); resolve(); };
        return;
      }
      setTimeout(check, 200);
    }
    check();
  });
}

// ── OpenCV.js shoe detector ────────────────────────────────────────────────
// Multi-strategy: tries several Canny thresholds + OTSU threshold fallback
// Picks top-2 largest spatially separated contours
function detectWithOpenCV(canvas: HTMLCanvasElement): { left: BBox; right: BBox } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cv = (window as any).cv;
  if (!cv || !cv.Mat) return null;

  const vw = canvas.width;
  const vh = canvas.height;

  const SCALE = 0.4;
  const sw = Math.round(vw * SCALE);
  const sh = Math.round(vh * SCALE);

  const small = document.createElement("canvas");
  small.width = sw; small.height = sh;
  small.getContext("2d")!.drawImage(canvas, 0, 0, sw, sh);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mats: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mat<T>(v: T): T { mats.push(v); return v; }

  try {
    const src     = mat(cv.imread(small));
    const gray    = mat(new cv.Mat());
    const blurred = mat(new cv.Mat());

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    type Rect = { x: number; y: number; width: number; height: number };
    type Candidate = { rect: Rect; area: number };

    // Try multiple detection strategies, return first that finds 2 candidates
    function tryStrategy(edgeMat: unknown): Candidate[] {
      const dilated   = mat(new cv.Mat());
      const closed    = mat(new cv.Mat());
      const contours  = mat(new cv.MatVector());
      const hierarchy = mat(new cv.Mat());

      const k1 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
      const k2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11, 11));
      mats.push(k1, k2);
      cv.dilate(edgeMat, dilated, k1);
      cv.morphologyEx(dilated, closed, cv.MORPH_CLOSE, k2);
      cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const minArea = sw * sh * 0.008; // 0.8% of frame — very permissive
      const found: Candidate[] = [];

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        cnt.delete();
        if (area < minArea) continue;
        const rect = cv.boundingRect(contours.get(i));
        contours.get(i).delete();
        const centerY = rect.y + rect.height / 2;
        // Very relaxed: any object in lower 90% of frame with reasonable size
        if (centerY > sh * 0.10 && rect.width > sw * 0.04 && rect.height > sh * 0.04) {
          found.push({ rect, area });
        }
      }
      return found;
    }

    let candidates: Candidate[] = [];

    // Strategy 1: loose Canny (works for most lighting)
    if (candidates.length < 2) {
      const e = mat(new cv.Mat());
      cv.Canny(blurred, e, 20, 60);
      candidates = tryStrategy(e);
    }
    // Strategy 2: medium Canny
    if (candidates.length < 2) {
      const e = mat(new cv.Mat());
      cv.Canny(blurred, e, 40, 120);
      candidates = tryStrategy(e);
    }
    // Strategy 3: tight Canny
    if (candidates.length < 2) {
      const e = mat(new cv.Mat());
      cv.Canny(blurred, e, 10, 40);
      candidates = tryStrategy(e);
    }
    // Strategy 4: OTSU binary threshold (works when background and shoe contrast)
    if (candidates.length < 2) {
      const binary = mat(new cv.Mat());
      cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      candidates = tryStrategy(binary);
    }
    // Strategy 5: adaptive threshold (works in uneven lighting)
    if (candidates.length < 2) {
      const adaptive = mat(new cv.Mat());
      cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);
      candidates = tryStrategy(adaptive);
    }

    if (candidates.length < 2) return null;

    // Sort by area desc, pick top 8
    candidates.sort((a, b) => b.area - a.area);
    const top = candidates.slice(0, 8);

    // Merge overlapping rects (IoU > 0.3) — keep larger
    const merged: Candidate[] = [];
    for (const c of top) {
      const overlap = merged.find(m => {
        const ix = Math.max(0, Math.min(m.rect.x+m.rect.width, c.rect.x+c.rect.width) - Math.max(m.rect.x, c.rect.x));
        const iy = Math.max(0, Math.min(m.rect.y+m.rect.height, c.rect.y+c.rect.height) - Math.max(m.rect.y, c.rect.y));
        const inter = ix * iy;
        const uni = m.rect.width*m.rect.height + c.rect.width*c.rect.height - inter;
        return inter / uni > 0.3;
      });
      if (!overlap) merged.push(c);
      if (merged.length >= 6) break;
    }

    if (merged.length < 2) return null;

    // Find pair with max horizontal separation
    let bestA = merged[0], bestB = merged[1], bestSep = 0;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const ca = merged[i].rect.x + merged[i].rect.width / 2;
        const cb = merged[j].rect.x + merged[j].rect.width / 2;
        const sep = Math.abs(ca - cb);
        if (sep > bestSep) { bestSep = sep; bestA = merged[i]; bestB = merged[j]; }
      }
    }

    // Require at least 3% width separation (very relaxed)
    if (bestSep < sw * 0.03) return null;

    // Sort left → right
    const pair = [bestA, bestB].sort((a, b) => a.rect.x - b.rect.x);

    const PAD = Math.round(8 / SCALE);
    function toFull(r: { x: number; y: number; width: number; height: number }): BBox {
      return {
        minX: Math.max(0, Math.round(r.x / SCALE) - PAD),
        maxX: Math.min(vw, Math.round((r.x + r.width) / SCALE) + PAD),
        minY: Math.max(0, Math.round(r.y / SCALE) - PAD),
        maxY: Math.min(vh, Math.round((r.y + r.height) / SCALE) + PAD),
      };
    }

    return { left: toFull(pair[0].rect), right: toFull(pair[1].rect) };
  } catch (e) {
    console.error("[OpenCV detect]", e);
    return null;
  } finally {
    for (const m of mats) {
      try { if (m && m.delete) m.delete(); } catch {}
    }
  }
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [cvReady, setCvReady] = useState(false);
  const [cvLoading, setCvLoading] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isPortrait, setIsPortrait] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

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

  // Wait for OpenCV.js to finish loading (async script in layout)
  useEffect(() => {
    if (!isReady || cvReady || cvLoading) return;
    setCvLoading(true);
    waitForOpenCV()
      .then(() => { setCvReady(true); setCvLoading(false); })
      .catch((e) => { console.error("[OpenCV load]", e); setCvLoading(false); });
  }, [isReady, cvReady, cvLoading]);

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setIsCapturing(true);

    // Wait for OpenCV if still loading
    if (!cvReady) {
      setStatusMsg("Waiting for OpenCV...");
      try {
        await waitForOpenCV();
        setCvReady(true);
      } catch {
        onError("OpenCV.js failed to load. Check internet connection and reload.");
        setIsCapturing(false);
        setStatusMsg("");
        return;
      }
    }

    setIsAnalyzing(true);
    setStatusMsg("Detecting shoes...");

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, vw, vh);

    // Yield to let UI update before heavy computation
    await new Promise(r => setTimeout(r, 30));

    const result = detectWithOpenCV(canvas);

    setIsAnalyzing(false);
    setStatusMsg("");

    if (!result) {
      setIsCapturing(false);
      onError(
        "Could not detect two shoes. Tips: ensure good lighting, shoes on contrasting surface, clear gap between them, camera level."
      );
      return;
    }

    const { left: lb, right: rb } = result;

    // Tilt check
    const bottomDiff = Math.abs(lb.maxY - rb.maxY);
    if (bottomDiff > vh * 0.12) {
      setIsCapturing(false);
      onError(`Camera tilted — shoe baselines differ by ${Math.round(bottomDiff)}px. Level the camera and retake.`);
      return;
    }

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
    const stamp = `OpenCV | L:${leftResult.hMm}mm R:${rightResult.hMm}mm`;
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
      setStatusMsg("");
      setTimeout(() => { setShowSuccess(false); setIsCapturing(false); }, 1200);
    } catch {
      onError("Failed to compress image");
      setIsCapturing(false);
      setStatusMsg("");
    }
  }, [isCapturing, isAnalyzing, cvReady, onCapture, onError]);

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

      {/* OpenCV status bar */}
      {isReady && cvLoading && (
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center gap-2 py-1.5"
          style={{ background: "rgba(0,0,0,0.75)" }}>
          <Loader2 className="w-3 h-3 animate-spin" style={{ color: CYAN }} />
          <span className="text-xs font-medium" style={{ color: CYAN }}>Loading OpenCV.js...</span>
        </div>
      )}
      {isReady && cvReady && !cvLoading && !isCapturing && (
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center gap-2 py-1.5"
          style={{ background: "rgba(34,197,94,0.12)" }}>
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN }} />
          <span className="text-[10px] font-semibold" style={{ color: GREEN }}>OpenCV Ready</span>
        </div>
      )}

      <AnimatePresence>
        {isAnalyzing && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-30"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          >
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold" style={{ color: CYAN }}>Detecting shoes...</p>
            <p className="text-xs mt-1" style={{ color: "#666" }}>OpenCV Canny + findContours</p>
          </motion.div>
        )}
      </AnimatePresence>

      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-8 left-8 w-12 h-12" style={{ borderTop: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute top-8 right-8 w-12 h-12" style={{ borderTop: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 left-8 w-12 h-12" style={{ borderBottom: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 right-8 w-12 h-12" style={{ borderBottom: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
        </div>
      )}

      {isReady && !isCapturing && (
        <div className="absolute top-10 left-1/2 -translate-x-1/2 z-10">
          <div className="px-4 py-2 rounded-full text-xs font-semibold text-center whitespace-nowrap"
            style={{ background: "rgba(0,0,0,0.7)", border: `1px solid ${CYAN}40`, color: "#ccc", backdropFilter: "blur(6px)" }}>
            Shoes side-by-side · contrasting surface · landscape
          </div>
        </div>
      )}

      {statusMsg && (
        <div className="absolute bottom-28 left-0 right-0 flex justify-center z-10">
          <div className="px-4 py-2 rounded-full text-xs font-semibold"
            style={{ background: "rgba(0,0,0,0.7)", color: CYAN }}>
            {statusMsg}
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
          {isAnalyzing ? "analyzing..." : isCapturing ? "processing..." : "tap to capture"}
        </span>
      </div>
    </div>
  );
}
