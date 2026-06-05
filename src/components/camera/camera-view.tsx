"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, RotateCcw, Camera, AlertTriangle, Info, X, Ruler } from "lucide-react";
import { pxToMm, compressImage, getCalibration, setCalibration, CALIBRATION_CARD_MM } from "@/lib/utils";
import type { CaptureResult } from "@/store/scan";

const CYAN   = "#06b6d4";
const GREEN  = "#22c55e";
const RED    = "#ef4444";
const AMBER  = "#f59e0b";
const PUB_KEY   = "rf_AvYiDjJLIMb0l0OPIgfb5ghmbyE3";
const MODEL_ID  = "shoe-segmentation-0kxvd";
const MODEL_VER = 1;

interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

type ErrorType =
  | "model_fail"
  | "no_shoes"
  | "one_shoe"
  | "too_dark"
  | "shoes_too_small"
  | "tilt"
  | "partial"
  | "network";

interface SmartError {
  type: ErrorType;
  title: string;
  fix: string;
  icon: "alert" | "info";
}

const ERROR_MAP: Record<ErrorType, SmartError> = {
  model_fail:     { type: "model_fail",    title: "AI model failed to load",       fix: "Check internet connection and reload page",               icon: "alert" },
  no_shoes:       { type: "no_shoes",      title: "No shoes detected",             fix: "Side view · both soles on surface · fill the frame",      icon: "info"  },
  one_shoe:       { type: "one_shoe",      title: "Only 1 shoe detected",          fix: "Move shoes apart · ensure both fully visible",            icon: "info"  },
  too_dark:       { type: "too_dark",      title: "Image too dark",                fix: "Move to brighter area · avoid back-lighting",             icon: "alert" },
  shoes_too_small:{ type: "shoes_too_small",title: "Shoes too small in frame",     fix: "Move camera closer — 30–50 cm above shoes",               icon: "info"  },
  tilt:           { type: "tilt",          title: "Camera tilted",                 fix: "Hold phone level — both soles should be on same line",    icon: "alert" },
  partial:        { type: "partial",       title: "Shoe partially out of frame",   fix: "Step back · centre both shoes in the green zones",        icon: "info"  },
  network:        { type: "network",       title: "Network error",                 fix: "Check internet connection and try again",                  icon: "alert" },
};

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    InferenceEngine: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CVImage: any;
    _rfEngineReady: boolean;
  }
}

function loadInferencejs(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window._rfEngineReady) { resolve(); return; }
    const existing = document.getElementById("inferencejs-cdn");
    if (existing) {
      const onLoad = () => resolve();
      const onErr  = () => reject(new Error("CDN load failed"));
      existing.addEventListener("load", onLoad, { once: true });
      existing.addEventListener("error", onErr, { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = "inferencejs-cdn";
    s.src = "https://cdn.jsdelivr.net/npm/inferencejs@1.2.3/dist/inference.js";
    s.onload  = () => { window._rfEngineReady = true; resolve(); };
    s.onerror = () => reject(new Error("CDN load failed"));
    document.head.appendChild(s);
  });
}

// Measure average luminance of frame — detect too-dark images
function frameLuminance(canvas: HTMLCanvasElement): number {
  const s = 0.1;
  const w = Math.round(canvas.width * s), h = Math.round(canvas.height * s);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
  return sum / (data.length / 4);
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef          = useRef<HTMLVideoElement>(null);
  const captureCanvasRef  = useRef<HTMLCanvasElement>(null);
  const streamRef         = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engineRef         = useRef<any>(null);
  const workerRef         = useRef<string | null>(null);

  const [isReady,      setIsReady]      = useState(false);
  const [isCapturing,  setIsCapturing]  = useState(false);
  const [isAnalyzing,  setIsAnalyzing]  = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady,   setModelReady]   = useState(false);
  const [showSuccess,  setShowSuccess]  = useState(false);
  const [isPortrait,   setIsPortrait]   = useState(false);
  const [statusMsg,    setStatusMsg]    = useState("");
  const [smartError,   setSmartError]   = useState<SmartError | null>(null);
  const [showGuide,    setShowGuide]    = useState(true);
  const [calibMode,    setCalibMode]    = useState(false);   // credit card calibration mode
  const [calibPxMm,    setCalibPxMm]    = useState<number | null>(null); // detected px/mm
  const [calibSaved,   setCalibSaved]   = useState(false);

  // portrait detection
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

  // camera start
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

  // eager model load
  useEffect(() => {
    if (!isReady || modelLoading || modelReady) return;
    async function loadModel() {
      setModelLoading(true);
      setStatusMsg("Loading AI model (~6MB)…");
      try {
        await loadInferencejs();
        const engine = new window.InferenceEngine();
        engineRef.current = engine;
        const workerId = await engine.startWorker(MODEL_ID, MODEL_VER, PUB_KEY);
        workerRef.current = workerId;
        setModelReady(true);
        setStatusMsg("");
      } catch (e) {
        console.error("[inferencejs load]", e);
        setSmartError(ERROR_MAP.model_fail);
        setStatusMsg("");
      } finally {
        setModelLoading(false);
      }
    }
    loadModel();
  }, [isReady, modelLoading, modelReady]);

  function triggerSmartError(type: ErrorType) {
    setSmartError(ERROR_MAP[type]);
    setIsCapturing(false);
    setIsAnalyzing(false);
    setStatusMsg("");
  }

  const handleCapture = useCallback(async () => {
    const video  = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setSmartError(null);
    setShowGuide(false);
    setIsCapturing(true);

    // ── Calibration mode: detect credit card width ───────────────────────
    if (calibMode) {
      const vw2 = videoRef.current!.videoWidth  || 1280;
      const vh2 = videoRef.current!.videoHeight || 720;
      captureCanvasRef.current!.width  = vw2;
      captureCanvasRef.current!.height = vh2;
      const ctx2 = captureCanvasRef.current!.getContext("2d")!;
      ctx2.drawImage(videoRef.current!, 0, 0, vw2, vh2);

      // Sample center strip for a bright rectangular object (credit card = white/light)
      // Look for widest contiguous bright region in center horizontal strip
      const s2 = 0.25;
      const tw2 = Math.round(vw2 * s2), th2 = Math.round(vh2 * s2);
      const cc = document.createElement("canvas"); cc.width = tw2; cc.height = th2;
      const tc = cc.getContext("2d", { willReadFrequently: true })!;
      tc.drawImage(captureCanvasRef.current!, 0, 0, tw2, th2);
      const { data: d2 } = tc.getImageData(0, 0, tw2, th2);

      // Scan center row for brightest object extent
      const midY = Math.round(th2 * 0.5);
      let cardL = -1, cardR = -1;
      // Find leftmost and rightmost bright pixel in center row
      for (let x = 0; x < tw2; x++) {
        const i2 = (midY * tw2 + x) * 4;
        const lum2 = 0.299 * d2[i2] + 0.587 * d2[i2+1] + 0.114 * d2[i2+2];
        if (lum2 > 160) { // bright = card (white/light-coloured)
          if (cardL === -1) cardL = x;
          cardR = x;
        }
      }

      if (cardL >= 0 && cardR > cardL && (cardR - cardL) > tw2 * 0.1) {
        const cardWidthPx = (cardR - cardL) / s2; // back to full res
        const newPxMm = cardWidthPx / CALIBRATION_CARD_MM;
        setCalibPxMm(newPxMm);
      } else {
        setCalibPxMm(null);
      }
      setIsCapturing(false);
      return;
    }

    // on-demand model load if eager load failed
    if (!workerRef.current) {
      setStatusMsg("Loading AI model…");
      try {
        await loadInferencejs();
        const engine = new window.InferenceEngine();
        engineRef.current = engine;
        workerRef.current = await engine.startWorker(MODEL_ID, MODEL_VER, PUB_KEY);
        setModelReady(true);
      } catch {
        triggerSmartError("model_fail");
        return;
      }
    }

    setIsAnalyzing(true);
    setStatusMsg("Detecting shoes…");

    const vw = video.videoWidth  || 1280;
    const vh = video.videoHeight || 720;
    canvas.width  = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, vw, vh);

    // ── Pre-detection checks ─────────────────────────────────────────────
    const lum = frameLuminance(canvas);
    if (lum < 35) { triggerSmartError("too_dark"); return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let predictions: any[] = [];
    try {
      const img    = new window.CVImage(canvas);
      const result = await engineRef.current.infer(workerRef.current, img);
      predictions  = Array.isArray(result) ? result : (result?.predictions ?? []);
      console.log("[inferencejs]", predictions.length, "predictions");
    } catch (e) {
      console.error("[infer]", e);
      const msg = e instanceof Error ? e.message : "";
      triggerSmartError(msg.toLowerCase().includes("network") ? "network" : "model_fail");
      return;
    }

    setIsAnalyzing(false);
    setStatusMsg("");

    // ── Post-detection validation ────────────────────────────────────────
    if (predictions.length === 0) { triggerSmartError("no_shoes"); return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function predToBBox(p: any): BBox {
      const x = p.bbox?.x ?? p.x ?? 0;
      const y = p.bbox?.y ?? p.y ?? 0;
      const w = p.bbox?.width  ?? p.width  ?? 0;
      const h = p.bbox?.height ?? p.height ?? 0;
      return { minX: Math.round(x - w/2), maxX: Math.round(x + w/2),
               minY: Math.round(y - h/2), maxY: Math.round(y + h/2) };
    }

    const sized = predictions.filter(p => {
      const w = p.bbox?.width ?? p.width ?? 0;
      const h = p.bbox?.height ?? p.height ?? 0;
      return w > vw * 0.04 && h > vh * 0.06;
    });

    if (sized.length === 0) { triggerSmartError("shoes_too_small"); return; }

    // IoU dedup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deduped: any[] = [];
    for (const p of sized.sort((a: any, b: any) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
      const pb = predToBBox(p);
      const dup = deduped.some(d => {
        const db = predToBBox(d);
        const ix = Math.max(0, Math.min(pb.maxX, db.maxX) - Math.max(pb.minX, db.minX));
        const iy = Math.max(0, Math.min(pb.maxY, db.maxY) - Math.max(pb.minY, db.minY));
        const inter = ix * iy;
        const union = (pb.maxX-pb.minX)*(pb.maxY-pb.minY) + (db.maxX-db.minX)*(db.maxY-db.minY) - inter;
        return union > 0 && inter/union > 0.4;
      });
      if (!dup) deduped.push(p);
    }

    if (deduped.length < 2) {
      triggerSmartError(deduped.length === 1 ? "one_shoe" : "no_shoes");
      return;
    }

    // Sort left → right
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deduped.sort((a: any, b: any) => (a.bbox?.x ?? a.x ?? 0) - (b.bbox?.x ?? b.x ?? 0));
    const leftPred  = deduped[0];
    const rightPred = deduped[deduped.length - 1];
    const lb = predToBBox(leftPred);
    const rb = predToBBox(rightPred);

    // Partial-frame check: any shoe touching frame edge?
    const PAD = 10;
    if (lb.minX < PAD || rb.maxX > vw - PAD || lb.minY < PAD || rb.minY < PAD) {
      triggerSmartError("partial");
      return;
    }

    // Tilt check: shoe baselines must be close
    const bottomDiff = Math.abs(lb.maxY - rb.maxY);
    if (bottomDiff > vh * 0.10) { triggerSmartError("tilt"); return; }

    const groundY = Math.max(lb.maxY, rb.maxY);

    // ── Draw ─────────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function drawPrediction(pred: any, bounds: BBox, label: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pts: { x: number; y: number }[] = pred.points ?? pred.segmentation_polygon ?? [];
      ctx.beginPath();
      if (pts.length >= 3) {
        pts.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
        ctx.closePath();
      } else {
        ctx.rect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      }
      ctx.fillStyle   = `${GREEN}22`;
      ctx.fill();
      ctx.strokeStyle = GREEN;
      ctx.lineWidth   = 3;
      ctx.shadowColor = GREEN;
      ctx.shadowBlur  = 14;
      ctx.stroke();
      ctx.shadowBlur  = 0;

      const hMm  = pxToMm(groundY - bounds.minY);
      const wMm  = pxToMm(bounds.maxX - bounds.minX);
      const midX = (bounds.minX + bounds.maxX) / 2;
      const midY = (bounds.minY + groundY) / 2;
      const rX   = Math.min(bounds.maxX + 8, vw - 90);

      ctx.font = "bold 16px monospace";
      const hl = `${hMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(rX - 2, midY - 12, ctx.measureText(hl).width + 10, 20);
      ctx.fillStyle = GREEN; ctx.textAlign = "left";
      ctx.fillText(hl, rX + 2, midY + 4);

      const wl = `${wMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(midX - ctx.measureText(wl).width/2 - 4, Math.max(bounds.minY - 26, 0), ctx.measureText(wl).width + 8, 18);
      ctx.fillStyle = GREEN; ctx.textAlign = "center";
      ctx.fillText(wl, midX, Math.max(bounds.minY - 10, 14));

      ctx.font = "bold 13px monospace";
      const bw = ctx.measureText(label).width + 14;
      ctx.fillStyle = `${GREEN}cc`;
      ctx.fillRect(midX - bw/2, Math.min(groundY + 6, vh - 22), bw, 18);
      ctx.fillStyle = "#000"; ctx.textAlign = "center";
      ctx.fillText(label, midX, Math.min(groundY + 19, vh - 8));

      ctx.strokeStyle = `${GREEN}80`; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(bounds.minX, groundY); ctx.lineTo(bounds.maxX, groundY); ctx.stroke();
      ctx.setLineDash([]);

      return { hMm, wMm };
    }

    const leftResult  = drawPrediction(leftPred,  lb, "LEFT");
    const rightResult = drawPrediction(rightPred, rb, "RIGHT");

    // Center divider
    ctx.strokeStyle = `${CYAN}60`; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(vw/2, 0); ctx.lineTo(vw/2, vh); ctx.stroke();
    ctx.setLineDash([]);

    const diff   = parseFloat(Math.abs(leftResult.hMm - rightResult.hMm).toFixed(1));
    const passed = diff <= 3;

    ctx.fillStyle = `${passed ? GREEN : RED}ee`;
    ctx.fillRect(0, vh - 48, vw, 48);
    ctx.font = "bold 20px monospace"; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText(passed ? `PASSED  Δ${diff}mm` : `REJECTED  Δ${diff}mm  (>3mm)`, vw/2, vh - 16);

    ctx.font = "11px monospace"; ctx.fillStyle = "rgba(0,0,0,0.7)";
    const stamp = `RF | L:${leftResult.hMm}mm R:${rightResult.hMm}mm`;
    ctx.fillRect(4, 4, ctx.measureText(stamp).width + 10, 18);
    ctx.fillStyle = GREEN; ctx.textAlign = "left";
    ctx.fillText(stamp, 9, 17);

    try {
      const blob           = await compressImage(canvas, 0.9);
      const annotatedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      if ("vibrate" in navigator) navigator.vibrate([60, 30, 60]);
      onCapture({
        blob, dataUrl: annotatedDataUrl, annotatedDataUrl,
        leftHeightMm: leftResult.hMm, rightHeightMm: rightResult.hMm,
        leftWidthMm:  leftResult.wMm, rightWidthMm:  rightResult.wMm,
        heightDiffMm: diff, passed,
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
  }, [isCapturing, isAnalyzing, onCapture, onError]);

  // ── Portrait lock ──────────────────────────────────────────────────────
  if (isPortrait) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center px-8">
          <RotateCcw className="w-14 h-14 mx-auto mb-4" style={{ color: CYAN, animation: "spin 3s linear infinite" }} />
          <p className="text-white font-bold text-lg mb-2">Rotate your phone</p>
          <p className="text-sm" style={{ color: "#888" }}>Landscape mode required to scan both shoes</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
      <canvas ref={captureCanvasRef} className="hidden" />

      {/* Camera loading */}
      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "#080810" }}>
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: CYAN }} />
        </div>
      )}

      {/* Analyzing overlay */}
      <AnimatePresence>
        {isAnalyzing && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-30"
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
          >
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold" style={{ color: CYAN }}>Detecting shoes…</p>
            <p className="text-xs mt-1" style={{ color: "#666" }}>Roboflow segmentation model</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Placement guide overlay ──────────────────────────────────────── */}
      <AnimatePresence>
        {isReady && !isCapturing && showGuide && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 pointer-events-none z-10"
          >
            {/* Left shoe zone */}
            <div className="absolute"
              style={{
                left: "4%", right: "52%", top: "28%", bottom: "18%",
                border: `2px dashed ${CYAN}70`,
                borderRadius: 8,
              }}>
              <div className="absolute inset-x-0 -top-6 flex justify-center">
                <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ color: CYAN, background: "rgba(0,0,0,0.6)" }}>
                  LEFT SHOE HERE
                </span>
              </div>
            </div>

            {/* Right shoe zone */}
            <div className="absolute"
              style={{
                left: "52%", right: "4%", top: "28%", bottom: "18%",
                border: `2px dashed ${CYAN}70`,
                borderRadius: 8,
              }}>
              <div className="absolute inset-x-0 -top-6 flex justify-center">
                <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ color: CYAN, background: "rgba(0,0,0,0.6)" }}>
                  RIGHT SHOE HERE
                </span>
              </div>
            </div>

            {/* Floor reference line */}
            <div className="absolute left-0 right-0" style={{ bottom: "18%", height: 1, background: `${CYAN}50` }}>
              <span className="absolute right-2 -top-4 text-xs" style={{ color: `${CYAN}90`, background: "rgba(0,0,0,0.5)", padding: "1px 4px", borderRadius: 3 }}>
                SOLE LINE
              </span>
            </div>

            {/* Center divider */}
            <div className="absolute top-0 bottom-0"
              style={{ left: "50%", width: 1, background: `repeating-linear-gradient(to bottom, ${CYAN}60 0px, ${CYAN}60 8px, transparent 8px, transparent 16px)` }} />

            {/* Setup instructions card */}
            <div className="absolute bottom-20 left-1/2 -translate-x-1/2 w-[88%] max-w-sm">
              <div className="rounded-xl px-4 py-3" style={{ background: "rgba(0,0,0,0.82)", border: `1px solid ${CYAN}30` }}>
                <div className="flex items-center gap-2 mb-2">
                  <Info className="w-3.5 h-3.5 flex-shrink-0" style={{ color: CYAN }} />
                  <p className="text-xs font-bold uppercase tracking-widest" style={{ color: CYAN }}>Setup guide</p>
                  <button className="ml-auto pointer-events-auto" onClick={() => setShowGuide(false)}>
                    <X className="w-3.5 h-3.5" style={{ color: "#555" }} />
                  </button>
                </div>
                <div className="space-y-1.5">
                  {[
                    { n: "1", t: "Place shoes SIDE-BY-SIDE in the dashed zones" },
                    { n: "2", t: "Both toes pointing SAME direction (left or right)" },
                    { n: "3", t: "Camera 30–50 cm above, LEVEL with the surface" },
                    { n: "4", t: "Both soles must touch the SOLE LINE" },
                  ].map(({ n, t }) => (
                    <div key={n} className="flex items-start gap-2">
                      <span className="w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold mt-0.5"
                        style={{ background: `${CYAN}30`, color: CYAN }}>
                        {n}
                      </span>
                      <p className="text-[11px] leading-tight" style={{ color: "#ccc" }}>{t}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Smart error card ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {smartError && !isAnalyzing && (
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="absolute inset-x-4 z-40"
            style={{ bottom: "88px" }}
          >
            <div className="rounded-2xl px-4 py-4" style={{
              background: "rgba(10,10,18,0.95)",
              border: `1px solid ${smartError.icon === "alert" ? RED : AMBER}50`,
              backdropFilter: "blur(8px)",
            }}>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center mt-0.5"
                  style={{ background: `${smartError.icon === "alert" ? RED : AMBER}18`, border: `1px solid ${smartError.icon === "alert" ? RED : AMBER}40` }}>
                  <AlertTriangle className="w-5 h-5" style={{ color: smartError.icon === "alert" ? RED : AMBER }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-white text-sm">{smartError.title}</p>
                  <p className="text-xs mt-0.5 leading-relaxed" style={{ color: "#aaa" }}>{smartError.fix}</p>
                </div>
                <button onClick={() => { setSmartError(null); setShowGuide(true); }}>
                  <X className="w-4 h-4 mt-1" style={{ color: "#555" }} />
                </button>
              </div>

              {/* Visual fix diagram based on error type */}
              {smartError.type === "tilt" && (
                <div className="mt-3 rounded-lg px-3 py-2 flex items-center gap-4"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div className="text-center">
                    <div className="text-[10px] mb-1" style={{ color: "#666" }}>WRONG</div>
                    <div className="text-base">📐</div>
                  </div>
                  <div className="text-xs text-center flex-1" style={{ color: "#555" }}>→</div>
                  <div className="text-center">
                    <div className="text-[10px] mb-1" style={{ color: GREEN }}>CORRECT</div>
                    <div className="text-base">📏</div>
                  </div>
                  <div className="text-[10px] flex-1" style={{ color: "#888" }}>Hold phone level — both soles on same horizontal line</div>
                </div>
              )}
              {smartError.type === "no_shoes" && (
                <div className="mt-3 rounded-lg px-3 py-2" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div className="flex gap-3 items-center">
                    <div className="text-[10px] text-center" style={{ color: "#888" }}>
                      <div className="text-lg">👟👟</div>
                      <div>SIDE VIEW</div>
                    </div>
                    <div className="text-[10px] flex-1" style={{ color: "#888" }}>
                      Shoot from the SIDE — not behind or above. Both shoe soles must be on a flat surface. Fill the frame.
                    </div>
                  </div>
                </div>
              )}
              {smartError.type === "shoes_too_small" && (
                <div className="mt-3 rounded-lg px-3 py-2" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div className="text-[10px] text-center" style={{ color: "#888" }}>Move camera to 30–50 cm above shoes · shoes should fill 70% of frame width</div>
                </div>
              )}

              <button
                onClick={() => { setSmartError(null); setShowGuide(true); }}
                className="mt-3 w-full py-2 rounded-xl text-xs font-bold"
                style={{ background: `${CYAN}18`, border: `1px solid ${CYAN}40`, color: CYAN }}
              >
                Try Again
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Corner brackets */}
      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-6 left-6 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute top-6 right-6 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-20 left-6 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-20 right-6 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
        </div>
      )}

      {/* Model status + dismiss guide hint */}
      {isReady && !isCapturing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2">
          <div className="px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-2"
            style={{ background: "rgba(0,0,0,0.8)", border: `1px solid ${CYAN}30`, color: "#ccc" }}>
            <span className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: modelReady ? GREEN : modelLoading ? AMBER : RED, boxShadow: modelReady ? `0 0 6px ${GREEN}` : "none" }} />
            {modelReady ? "AI Ready — tap capture" : modelLoading ? "Loading AI model…" : "Model failed — tap to retry"}
          </div>
          {showGuide && (
            <button onClick={() => setShowGuide(false)}
              className="px-2 py-1.5 rounded-full text-xs"
              style={{ background: "rgba(0,0,0,0.7)", border: `1px solid ${CYAN}20`, color: "#555" }}>
              Hide guide
            </button>
          )}
          {!showGuide && (
            <button onClick={() => setShowGuide(true)}
              className="px-2 py-1.5 rounded-full text-xs"
              style={{ background: "rgba(0,0,0,0.7)", border: `1px solid ${CYAN}20`, color: "#555" }}>
              Show guide
            </button>
          )}
          <button onClick={() => { setCalibMode(true); setCalibPxMm(null); setSmartError(null); }}
            className="px-2 py-1.5 rounded-full text-xs flex items-center gap-1"
            style={{ background: "rgba(0,0,0,0.7)", border: `1px solid ${AMBER}40`, color: AMBER }}>
            <Ruler className="w-3 h-3" />Calibrate
          </button>
        </div>
      )}

      {statusMsg && !isAnalyzing && (
        <div className="absolute bottom-28 left-0 right-0 flex justify-center z-10">
          <div className="px-4 py-2 rounded-full text-xs font-semibold" style={{ background: "rgba(0,0,0,0.75)", color: CYAN }}>
            {statusMsg}
          </div>
        </div>
      )}

      {/* Success flash */}
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

      {/* ── Calibration overlay ─────────────────────────────────────────── */}
      <AnimatePresence>
        {calibMode && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 flex flex-col items-center justify-center"
            style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
          >
            {calibPxMm === null ? (
              // Instruction
              <div className="px-6 py-5 rounded-2xl mx-4 max-w-sm w-full"
                style={{ background: "rgba(10,10,20,0.95)", border: `1px solid ${CYAN}40` }}>
                <div className="flex items-center gap-2 mb-3">
                  <Ruler className="w-5 h-5" style={{ color: CYAN }} />
                  <p className="font-bold text-white">Camera Calibration</p>
                  <button className="ml-auto" onClick={() => setCalibMode(false)}>
                    <X className="w-4 h-4" style={{ color: "#555" }} />
                  </button>
                </div>
                <div className="rounded-xl p-3 mb-4 text-center"
                  style={{ background: "rgba(6,182,212,0.08)", border: `1px solid ${CYAN}30` }}>
                  <div className="text-4xl mb-1">💳</div>
                  <p className="text-xs font-bold" style={{ color: CYAN }}>Credit Card = 85.6mm wide</p>
                  <p className="text-[11px] mt-1" style={{ color: "#888" }}>Place card flat, landscape, filling the WIDTH of frame</p>
                </div>
                <div className="space-y-2 mb-4">
                  {["Place card on flat surface same as shoes", "Camera same height you use for scanning", "Card should span most of the frame width", "Tap CAPTURE when card is centered"].map((t, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold mt-0.5"
                        style={{ background: `${CYAN}25`, color: CYAN }}>{i+1}</span>
                      <p className="text-[11px]" style={{ color: "#ccc" }}>{t}</p>
                    </div>
                  ))}
                </div>
                <button onClick={handleCapture}
                  className="w-full py-2.5 rounded-xl text-sm font-bold"
                  style={{ background: CYAN, color: "#000" }}>
                  Capture Card
                </button>
              </div>
            ) : (
              // Result
              <div className="px-6 py-5 rounded-2xl mx-4 max-w-sm w-full"
                style={{ background: "rgba(10,10,20,0.95)", border: `1px solid ${GREEN}40` }}>
                <div className="flex items-center gap-2 mb-3">
                  <Ruler className="w-5 h-5" style={{ color: GREEN }} />
                  <p className="font-bold text-white">Calibration Result</p>
                </div>
                <div className="rounded-xl p-3 mb-4 text-center"
                  style={{ background: "rgba(34,197,94,0.08)", border: `1px solid ${GREEN}30` }}>
                  <p className="text-2xl font-black" style={{ color: GREEN }}>{calibPxMm.toFixed(2)} px/mm</p>
                  <p className="text-xs mt-1" style={{ color: "#888" }}>Detected card width → {(CALIBRATION_CARD_MM).toFixed(1)}mm reference</p>
                  <p className="text-xs mt-0.5" style={{ color: "#666" }}>
                    Was: {getCalibration().toFixed(2)} px/mm → Now: {calibPxMm.toFixed(2)} px/mm
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setCalibPxMm(null); }}
                    className="flex-1 py-2 rounded-xl text-xs font-semibold"
                    style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#888" }}>
                    Retake
                  </button>
                  <button onClick={() => {
                    setCalibration(calibPxMm);
                    setCalibSaved(true);
                    setCalibMode(false);
                    setCalibPxMm(null);
                    setTimeout(() => setCalibSaved(false), 3000);
                  }}
                    className="flex-[2] py-2 rounded-xl text-xs font-bold"
                    style={{ background: GREEN, color: "#000" }}>
                    Save Calibration ✓
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Calibration saved toast */}
      <AnimatePresence>
        {calibSaved && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="absolute top-14 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full text-xs font-bold"
            style={{ background: GREEN, color: "#000" }}>
            ✓ Calibration saved — measurements now accurate
          </motion.div>
        )}
      </AnimatePresence>

      {/* Capture button */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1.5">
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
          {isAnalyzing ? "detecting…" : isCapturing ? "processing…" : modelReady ? "tap to capture" : "loading model…"}
        </span>
      </div>
    </div>
  );
}
