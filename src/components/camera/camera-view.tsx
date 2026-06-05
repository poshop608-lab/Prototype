"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, RotateCcw, Camera, XCircle } from "lucide-react";
import { pxToMm, compressImage } from "@/lib/utils";
import type { CaptureResult } from "@/store/scan";

const CYAN  = "#06b6d4";
const GREEN = "#22c55e";
const RED   = "#ef4444";

const PUB_KEY   = "rf_AvYiDjJLIMb0l0OPIgfb5ghmbyE3";
const MODEL_ID  = "shoe-segmentation-0kxvd";
const MODEL_VER = 1;

interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _mod: any = null;
async function loadRF() {
  if (_mod) return _mod;
  _mod = await import("inferencejs");
  return _mod;
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef         = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef        = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engineRef        = useRef<any>(null);
  const workerRef        = useRef<string | null>(null);

  const [isReady,      setIsReady]      = useState(false);
  const [isCapturing,  setIsCapturing]  = useState(false);
  const [isAnalyzing,  setIsAnalyzing]  = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady,   setModelReady]   = useState(false);
  const [showSuccess,  setShowSuccess]  = useState(false);
  const [isPortrait,   setIsPortrait]   = useState(false);
  const [statusMsg,    setStatusMsg]    = useState("");

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

  // Eager model load
  useEffect(() => {
    if (!isReady || modelLoading || modelReady) return;
    async function load() {
      setModelLoading(true);
      setStatusMsg("Loading AI model…");
      try {
        const mod = await loadRF();
        const engine = new mod.InferenceEngine();
        engineRef.current = engine;
        workerRef.current = await engine.startWorker(MODEL_ID, MODEL_VER, PUB_KEY);
        setModelReady(true);
        setStatusMsg("");
      } catch (e) {
        console.error("[RF load]", e);
        setStatusMsg("Model failed — tap capture to retry");
      } finally {
        setModelLoading(false);
      }
    }
    load();
  }, [isReady, modelLoading, modelReady]);

  const handleCapture = useCallback(async () => {
    const video  = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setIsCapturing(true);

    if (!workerRef.current) {
      setStatusMsg("Loading AI model…");
      try {
        const mod = await loadRF();
        const engine = new mod.InferenceEngine();
        engineRef.current = engine;
        workerRef.current = await engine.startWorker(MODEL_ID, MODEL_VER, PUB_KEY);
        setModelReady(true);
      } catch (e) {
        onError(`Model failed to load: ${e instanceof Error ? e.message : "network error"}`);
        setIsCapturing(false);
        setStatusMsg("");
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let predictions: any[] = [];
    try {
      const mod    = await loadRF();
      const img    = new mod.CVImage(canvas);
      const result = await engineRef.current.infer(workerRef.current, img);
      predictions  = Array.isArray(result) ? result : (result?.predictions ?? []);
      console.log("[RF]", predictions.length, "predictions");
    } catch (e) {
      console.error("[RF infer]", e);
      setIsAnalyzing(false);
      setIsCapturing(false);
      setStatusMsg("");
      onError(`Detection failed: ${e instanceof Error ? e.message : "unknown"}`);
      return;
    }

    setIsAnalyzing(false);
    setStatusMsg("");

    if (predictions.length === 0) {
      setIsCapturing(false);
      onError("No shoes detected. Ensure both shoes are clearly visible in side view.");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function predToBBox(p: any): BBox {
      const x = p.bbox?.x ?? p.x ?? 0;
      const y = p.bbox?.y ?? p.y ?? 0;
      const w = p.bbox?.width  ?? p.width  ?? 0;
      const h = p.bbox?.height ?? p.height ?? 0;
      return { minX: Math.round(x - w/2), maxX: Math.round(x + w/2),
               minY: Math.round(y - h/2), maxY: Math.round(y + h/2) };
    }

    // Filter tiny detections, dedup, sort left→right
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sized = predictions.filter((p: any) => {
      const w = p.bbox?.width ?? p.width ?? 0;
      const h = p.bbox?.height ?? p.height ?? 0;
      return w > vw * 0.04 && h > vh * 0.05;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deduped: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      setIsCapturing(false);
      onError(`Only ${deduped.length} shoe detected. Ensure both shoes are fully visible.`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deduped.sort((a: any, b: any) => (a.bbox?.x ?? a.x ?? 0) - (b.bbox?.x ?? b.x ?? 0));
    const lb = predToBBox(deduped[0]);
    const rb = predToBBox(deduped[deduped.length - 1]);
    const groundY = Math.max(lb.maxY, rb.maxY);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function drawPred(pred: any, bounds: BBox, label: string) {
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

    const L = drawPred(deduped[0],                   lb, "LEFT");
    const R = drawPred(deduped[deduped.length - 1],  rb, "RIGHT");

    ctx.strokeStyle = `${CYAN}60`; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(vw/2, 0); ctx.lineTo(vw/2, vh); ctx.stroke();
    ctx.setLineDash([]);

    const diff   = parseFloat(Math.abs(L.hMm - R.hMm).toFixed(1));
    const passed = diff <= 3;

    ctx.fillStyle = `${passed ? GREEN : RED}ee`;
    ctx.fillRect(0, vh - 48, vw, 48);
    ctx.font = "bold 20px monospace"; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText(passed ? `PASSED  Δ${diff}mm` : `REJECTED  Δ${diff}mm  (>3mm)`, vw/2, vh - 16);

    ctx.font = "11px monospace"; ctx.fillStyle = "rgba(0,0,0,0.7)";
    const stamp = `RF | L:${L.hMm}mm R:${R.hMm}mm`;
    ctx.fillRect(4, 4, ctx.measureText(stamp).width + 10, 18);
    ctx.fillStyle = GREEN; ctx.textAlign = "left";
    ctx.fillText(stamp, 9, 17);

    try {
      const blob             = await compressImage(canvas, 0.9);
      const annotatedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      if ("vibrate" in navigator) navigator.vibrate([60, 30, 60]);
      onCapture({
        blob, dataUrl: annotatedDataUrl, annotatedDataUrl,
        leftHeightMm: L.hMm, rightHeightMm: R.hMm,
        leftWidthMm:  L.wMm, rightWidthMm:  R.wMm,
        heightDiffMm: diff, passed,
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
          <p className="text-sm" style={{ color: "#888" }}>Landscape mode required</p>
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
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
          >
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold" style={{ color: CYAN }}>Detecting shoes…</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Corner brackets */}
      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 bottom-0 left-1/2 w-px opacity-30"
            style={{ background: `repeating-linear-gradient(to bottom, ${CYAN} 0px, ${CYAN} 8px, transparent 8px, transparent 16px)` }} />
          <div className="absolute left-4 top-1/2 -translate-y-1/2 px-2 py-1 rounded text-xs font-bold"
            style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>LEFT</div>
          <div className="absolute right-4 top-1/2 -translate-y-1/2 px-2 py-1 rounded text-xs font-bold"
            style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>RIGHT</div>
          <div className="absolute top-6 left-6 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute top-6 right-6 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-20 left-6 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-20 right-6 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
        </div>
      )}

      {/* Status bar */}
      {isReady && !isCapturing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-2"
            style={{ background: "rgba(0,0,0,0.8)", border: `1px solid ${CYAN}30`, color: "#ccc" }}>
            <span className="w-2 h-2 rounded-full"
              style={{ background: modelReady ? GREEN : modelLoading ? "#f59e0b" : RED, boxShadow: modelReady ? `0 0 6px ${GREEN}` : "none" }} />
            {modelReady ? "AI Ready" : modelLoading ? "Loading model…" : "Model failed"}
          </div>
        </div>
      )}

      {statusMsg && !isAnalyzing && (
        <div className="absolute bottom-28 left-0 right-0 flex justify-center z-10">
          <div className="px-4 py-2 rounded-full text-xs font-semibold" style={{ background: "rgba(0,0,0,0.75)", color: CYAN }}>
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

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1.5">
        <button
          onClick={handleCapture}
          disabled={!isReady || isCapturing || isAnalyzing}
          className="relative w-20 h-20 rounded-full flex items-center justify-center transition-transform active:scale-90 disabled:opacity-40"
          style={{ border: "4px solid rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.12)", backdropFilter: "blur(4px)" }}
        >
          {isCapturing || isAnalyzing
            ? <Loader2 className="w-8 h-8 text-white animate-spin" />
            : <Camera className="w-8 h-8 text-white" />
          }
          {(isCapturing || isAnalyzing) && (
            <div className="absolute inset-0 rounded-full border-4 border-cyan-400 animate-ping" />
          )}
        </button>
        <span className="text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.5)" }}>
          {isAnalyzing ? "detecting…" : isCapturing ? "processing…" : modelReady ? "tap to capture" : "loading…"}
        </span>
      </div>

      {/* Unused import suppressor */}
      <span className="hidden"><XCircle /></span>
    </div>
  );
}
