"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, RotateCcw, Camera } from "lucide-react";
import { pxToMm, compressImage } from "@/lib/utils";
import type { CaptureResult } from "@/store/scan";

const CYAN  = "#06b6d4";
const GREEN = "#22c55e";
const RED   = "#ef4444";

interface RoboflowPoint { x: number; y: number; }
interface RoboflowPrediction {
  x: number; y: number; width: number; height: number;
  confidence: number; class: string;
  points?: RoboflowPoint[];
}

interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef         = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef        = useRef<MediaStream | null>(null);

  const [isReady,     setIsReady]     = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isPortrait,  setIsPortrait]  = useState(false);
  const [statusMsg,   setStatusMsg]   = useState("");

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
    const video  = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setIsCapturing(true);
    setIsAnalyzing(true);
    setStatusMsg("Analyzing with AI…");

    const vw = video.videoWidth  || 1280;
    const vh = video.videoHeight || 720;
    canvas.width  = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, vw, vh);

    // Encode full frame
    const encCanvas = document.createElement("canvas");
    encCanvas.width  = 1280;
    encCanvas.height = Math.round(vh * (1280 / vw));
    encCanvas.getContext("2d")!.drawImage(canvas, 0, 0, encCanvas.width, encCanvas.height);
    const b64 = encCanvas.toDataURL("image/jpeg", 0.9).split(",")[1];

    function remap(preds: RoboflowPrediction[], scaleX: number, scaleY: number, offX = 0, offY = 0): RoboflowPrediction[] {
      return preds.map(p => ({
        ...p,
        x: offX + p.x * scaleX, y: offY + p.y * scaleY,
        width: p.width * scaleX, height: p.height * scaleY,
        points: p.points?.map(pt => ({ x: offX + pt.x * scaleX, y: offY + pt.y * scaleY })),
      }));
    }

    async function callAPI(b64img: string): Promise<RoboflowPrediction[]> {
      const res = await fetch("/api/roboflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: b64img }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`RF ${res.status}: ${JSON.stringify(data)}`);
      return data.predictions ?? [];
    }

    let predictions: RoboflowPrediction[] = [];
    try {
      const sx = vw / encCanvas.width, sy = vh / encCanvas.height;
      let preds = remap(await callAPI(b64), sx, sy);

      // If <2 detected, try split halves
      if (preds.length < 2) {
        const hw = Math.floor(vw / 2);
        const lc = document.createElement("canvas"); lc.width = 640; lc.height = Math.round(vh * 640 / hw);
        lc.getContext("2d")!.drawImage(canvas, 0, 0, hw, vh, 0, 0, lc.width, lc.height);
        const rc = document.createElement("canvas"); rc.width = 640; rc.height = Math.round(vh * 640 / hw);
        rc.getContext("2d")!.drawImage(canvas, hw, 0, hw, vh, 0, 0, rc.width, rc.height);
        const lsx = hw / lc.width, lsy = vh / lc.height;
        const [lp, rp] = await Promise.all([
          callAPI(lc.toDataURL("image/jpeg", 0.9).split(",")[1]).then(p => remap(p, lsx, lsy, 0, 0)),
          callAPI(rc.toDataURL("image/jpeg", 0.9).split(",")[1]).then(p => remap(p, lsx, lsy, hw, 0)),
        ]);
        const best = (arr: RoboflowPrediction[]) => arr.sort((a, b) => b.confidence - a.confidence)[0];
        preds = [...(lp.length ? [best(lp)] : []), ...(rp.length ? [best(rp)] : [])];
      }
      predictions = preds;
    } catch (e) {
      setIsAnalyzing(false); setIsCapturing(false); setStatusMsg("");
      onError(`AI failed: ${e instanceof Error ? e.message : "network error"}`);
      return;
    }

    setIsAnalyzing(false); setStatusMsg("");

    if (predictions.length === 0) {
      setIsCapturing(false);
      onError("No shoes detected. Ensure both shoes are clearly visible and try again.");
      return;
    }

    // Filter small, dedup, sort left→right
    const pool = predictions.filter(p => p.width > vw * 0.05 && p.height > vh * 0.08);
    const src  = pool.length ? pool : predictions;

    function iou(a: RoboflowPrediction, b: RoboflowPrediction) {
      const ax1 = a.x - a.width/2, ax2 = a.x + a.width/2, ay1 = a.y - a.height/2, ay2 = a.y + a.height/2;
      const bx1 = b.x - b.width/2, bx2 = b.x + b.width/2, by1 = b.y - b.height/2, by2 = b.y + b.height/2;
      const ix = Math.max(0, Math.min(ax2,bx2) - Math.max(ax1,bx1));
      const iy = Math.max(0, Math.min(ay2,by2) - Math.max(ay1,by1));
      const inter = ix * iy;
      const union = a.width*a.height + b.width*b.height - inter;
      return union > 0 ? inter/union : 0;
    }

    const deduped: RoboflowPrediction[] = [];
    for (const p of src.sort((a,b) => b.confidence - a.confidence)) {
      if (!deduped.some(d => iou(d,p) > 0.5)) deduped.push(p);
    }
    deduped.sort((a,b) => a.x - b.x);
    const leftPred  = deduped[0];
    const rightPred = deduped.length >= 2 ? deduped[deduped.length - 1] : deduped[0];

    function getBounds(p: RoboflowPrediction): BBox {
      const xs = p.points?.length ? p.points.map(pt => pt.x) : [p.x - p.width/2, p.x + p.width/2];
      const ys = p.points?.length ? p.points.map(pt => pt.y) : [p.y - p.height/2, p.y + p.height/2];
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }

    const lb = getBounds(leftPred);
    const rb = getBounds(rightPred);
    const groundY = Math.max(lb.maxY, rb.maxY);

    function drawPred(pred: RoboflowPrediction, bounds: BBox, label: string) {
      if (pred.points && pred.points.length >= 3) {
        ctx.beginPath();
        pred.points.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx.rect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      }
      ctx.fillStyle   = `${GREEN}20`; ctx.fill();
      ctx.strokeStyle = GREEN; ctx.lineWidth = 3;
      ctx.shadowColor = GREEN; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;

      const hMm  = pxToMm(groundY - bounds.minY);
      const wMm  = pxToMm(bounds.maxX - bounds.minX);
      const midX = (bounds.minX + bounds.maxX) / 2;
      const midY = (bounds.minY + groundY) / 2;
      const rX   = Math.min(bounds.maxX + 8, vw - 90);

      ctx.font = "bold 16px monospace";
      const hl = `${hMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(rX - 2, midY - 12, ctx.measureText(hl).width + 10, 20);
      ctx.fillStyle = GREEN; ctx.textAlign = "left"; ctx.fillText(hl, rX + 2, midY + 4);

      const wl = `${wMm}mm`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(midX - ctx.measureText(wl).width/2 - 4, Math.max(bounds.minY - 26, 0), ctx.measureText(wl).width + 8, 18);
      ctx.fillStyle = GREEN; ctx.textAlign = "center"; ctx.fillText(wl, midX, Math.max(bounds.minY - 10, 14));

      ctx.font = "bold 13px monospace";
      const bw = ctx.measureText(label).width + 14;
      ctx.fillStyle = `${GREEN}cc`;
      ctx.fillRect(midX - bw/2, Math.min(groundY + 6, vh - 22), bw, 18);
      ctx.fillStyle = "#000"; ctx.textAlign = "center";
      ctx.fillText(label, midX, Math.min(groundY + 19, vh - 8));

      ctx.strokeStyle = `${GREEN}80`; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(bounds.minX, groundY); ctx.lineTo(bounds.maxX, groundY); ctx.stroke();
      ctx.setLineDash([]);

      return { hMm, wMm };
    }

    const L = drawPred(leftPred,  lb, "LEFT");
    const R = deduped.length >= 2 ? drawPred(rightPred, rb, "RIGHT") : L;

    ctx.strokeStyle = `${CYAN}60`; ctx.lineWidth = 1; ctx.setLineDash([6,6]);
    ctx.beginPath(); ctx.moveTo(vw/2, 0); ctx.lineTo(vw/2, vh); ctx.stroke();
    ctx.setLineDash([]);

    const diff   = parseFloat(Math.abs(L.hMm - R.hMm).toFixed(1));
    const passed = diff <= 3;

    ctx.fillStyle = `${passed ? GREEN : RED}ee`;
    ctx.fillRect(0, vh - 48, vw, 48);
    ctx.font = "bold 20px monospace"; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText(passed ? `PASSED  Δ${diff}mm` : `REJECTED  Δ${diff}mm  (>3mm)`, vw/2, vh - 16);

    ctx.font = "11px monospace"; ctx.fillStyle = "rgba(0,0,0,0.7)";
    const stamp = `RF | L:${L.hMm}mm R:${R.hMm}mm | conf ${(leftPred.confidence*100).toFixed(0)}%`;
    ctx.fillRect(4, 4, ctx.measureText(stamp).width + 10, 18);
    ctx.fillStyle = GREEN; ctx.textAlign = "left"; ctx.fillText(stamp, 9, 17);

    try {
      const blob             = await compressImage(canvas, 0.9);
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
      onError("Failed to compress image");
      setIsCapturing(false);
      setStatusMsg("");
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
            <p className="text-base font-bold" style={{ color: CYAN }}>Analyzing with Roboflow…</p>
          </motion.div>
        )}
      </AnimatePresence>

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

      {isReady && !isCapturing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
          <div className="px-3 py-1.5 rounded-full text-xs font-semibold"
            style={{ background: "rgba(0,0,0,0.8)", border: `1px solid ${CYAN}30`, color: "#ccc" }}>
            Place both shoes side-by-side · tap capture
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
          {isAnalyzing ? "analyzing…" : isCapturing ? "processing…" : "tap to capture"}
        </span>
      </div>
    </div>
  );
}
