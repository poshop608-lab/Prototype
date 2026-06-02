"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, RotateCcw, Camera } from "lucide-react";
import { pxToMm, compressImage } from "@/lib/utils";
import type { CaptureResult } from "@/store/scan";

const CYAN = "#06b6d4";
const GREEN = "#22c55e";
const RED = "#ef4444";

interface DetectionBox {
  x: number; y: number; width: number; height: number;
  confidence: number;
}

interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modelRef = useRef<any>(null);

  const [isReady, setIsReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
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
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [onError]);

  // Load COCO-SSD model eagerly once camera is ready
  useEffect(() => {
    if (!isReady) return;
    async function loadModel() {
      if (modelRef.current) return;
      setIsLoadingModel(true);
      try {
        const cocoSsd = await import("@tensorflow-models/coco-ssd");
        await import("@tensorflow/tfjs");
        modelRef.current = await cocoSsd.load({ base: "lite_mobilenet_v2" });
      } catch (e) {
        console.error("[COCO-SSD load]", e);
      } finally {
        setIsLoadingModel(false);
      }
    }
    loadModel();
  }, [isReady]);

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setIsCapturing(true);
    setStatusMsg("Loading AI model...");

    // Lazy-load model if not already loaded
    if (!modelRef.current) {
      try {
        const cocoSsd = await import("@tensorflow-models/coco-ssd");
        await import("@tensorflow/tfjs");
        modelRef.current = await cocoSsd.load({ base: "lite_mobilenet_v2" });
      } catch (e) {
        onError(`Failed to load AI model: ${e instanceof Error ? e.message : "unknown error"}`);
        setIsCapturing(false);
        setStatusMsg("");
        return;
      }
    }

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d");
    if (!ctx) { setIsCapturing(false); return; }

    ctx.drawImage(video, 0, 0, vw, vh);
    setIsAnalyzing(true);
    setStatusMsg("Analyzing with AI...");

    let boxes: DetectionBox[] = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const predictions: any[] = await modelRef.current.detect(canvas);
      // COCO-SSD classes that can represent shoes/feet
      const SHOE_CLASSES = ["shoe", "sneaker", "boot", "sandal", "person", "sports ball", "handbag", "backpack", "suitcase", "cell phone", "remote", "book", "laptop", "keyboard", "mouse", "clock", "vase", "bottle", "cup"];
      // Filter for shoe-like objects; fall back to ALL objects sorted by area if none found
      let shoeDetections = predictions.filter(
        (p) => p.class === "shoe" || p.class === "sneaker" || p.class === "boot" || p.class === "sandal"
      );
      if (shoeDetections.length < 2) {
        // Fallback: take any detected objects with big bounding boxes in lower half
        shoeDetections = predictions
          .filter((p) => {
            const [, py, , ph] = p.bbox;
            return py + ph / 2 > vh * 0.25 && ph > vh * 0.08 && p.bbox[2] > vw * 0.05;
          })
          .sort((a, b) => (b.bbox[2] * b.bbox[3]) - (a.bbox[2] * a.bbox[3]));
        // If still nothing, take top 2 by area
        if (shoeDetections.length === 0) {
          shoeDetections = [...predictions].sort((a, b) => (b.bbox[2] * b.bbox[3]) - (a.bbox[2] * a.bbox[3]));
        }
      }
      console.log("[COCO-SSD]", predictions.length, "total,", shoeDetections.length, "shoe candidates");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      boxes = shoeDetections.slice(0, 4).map((p: any) => ({
        x: p.bbox[0] + p.bbox[2] / 2,
        y: p.bbox[1] + p.bbox[3] / 2,
        width: p.bbox[2],
        height: p.bbox[3],
        confidence: p.score,
      }));
    } catch (e) {
      console.error("[COCO-SSD detect]", e);
      setIsAnalyzing(false);
      setIsCapturing(false);
      setStatusMsg("");
      onError(`AI analysis failed: ${e instanceof Error ? e.message : "unknown"}. Check console.`);
      return;
    }

    setIsAnalyzing(false);

    if (boxes.length === 0) {
      setIsCapturing(false);
      setStatusMsg("");
      onError("No objects detected. Place both shoes clearly in frame and try again.");
      return;
    }

    // IoU dedup
    function iou(a: DetectionBox, b: DetectionBox): number {
      const ax1 = a.x - a.width / 2, ax2 = a.x + a.width / 2;
      const ay1 = a.y - a.height / 2, ay2 = a.y + a.height / 2;
      const bx1 = b.x - b.width / 2, bx2 = b.x + b.width / 2;
      const by1 = b.y - b.height / 2, by2 = b.y + b.height / 2;
      const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
      const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
      const inter = ix * iy;
      const union = a.width * a.height + b.width * b.height - inter;
      return union > 0 ? inter / union : 0;
    }

    const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
    const deduped: DetectionBox[] = [];
    for (const box of sorted) {
      if (!deduped.some((kept) => iou(kept, box) > 0.5)) deduped.push(box);
    }

    // Sort left → right, take 2
    deduped.sort((a, b) => a.x - b.x);
    const leftBox = deduped[0];
    const rightBox = deduped.length >= 2 ? deduped[deduped.length - 1] : deduped[0];

    function getBounds(box: DetectionBox) {
      return {
        minX: box.x - box.width / 2,
        maxX: box.x + box.width / 2,
        minY: box.y - box.height / 2,
        maxY: box.y + box.height / 2,
      };
    }

    const lb = getBounds(leftBox);
    const rb = getBounds(rightBox);

    // Tilt check
    if (deduped.length >= 2) {
      const bottomDiff = Math.abs(lb.maxY - rb.maxY);
      if (bottomDiff > vh * 0.08) {
        setIsCapturing(false);
        setStatusMsg("");
        onError(`Camera tilted — shoe baselines differ by ${Math.round(bottomDiff)}px. Level the phone and retake.`);
        return;
      }
    }

    const groundY = Math.max(lb.maxY, rb.maxY);

    function drawBox(bounds: ReturnType<typeof getBounds>, label: string) {
      ctx!.beginPath();
      ctx!.rect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      ctx!.fillStyle = `${GREEN}20`;
      ctx!.fill();
      ctx!.strokeStyle = GREEN;
      ctx!.lineWidth = 3;
      ctx!.shadowColor = GREEN;
      ctx!.shadowBlur = 12;
      ctx!.stroke();
      ctx!.shadowBlur = 0;

      const heightPx = groundY - bounds.minY;
      const widthPx = bounds.maxX - bounds.minX;
      const hMm = pxToMm(heightPx);
      const wMm = pxToMm(widthPx);
      const midX = (bounds.minX + bounds.maxX) / 2;
      const midY = (bounds.minY + groundY) / 2;
      const rX = Math.min(bounds.maxX + 8, vw - 88);

      ctx!.font = "bold 16px monospace";
      const hl = `${hMm}mm`;
      ctx!.fillStyle = "rgba(0,0,0,0.85)";
      ctx!.fillRect(rX - 2, midY - 12, ctx!.measureText(hl).width + 10, 20);
      ctx!.fillStyle = GREEN;
      ctx!.textAlign = "left";
      ctx!.fillText(hl, rX + 2, midY + 4);

      const wl = `${wMm}mm`;
      ctx!.fillStyle = "rgba(0,0,0,0.85)";
      ctx!.fillRect(midX - ctx!.measureText(wl).width / 2 - 4, Math.max(bounds.minY - 26, 0), ctx!.measureText(wl).width + 8, 18);
      ctx!.fillStyle = GREEN;
      ctx!.textAlign = "center";
      ctx!.fillText(wl, midX, Math.max(bounds.minY - 10, 14));

      const bw = ctx!.measureText(label).width + 14;
      ctx!.fillStyle = `${GREEN}cc`;
      ctx!.fillRect(midX - bw / 2, Math.min(groundY + 6, vh - 22), bw, 18);
      ctx!.font = "bold 13px monospace";
      ctx!.fillStyle = "#000";
      ctx!.textAlign = "center";
      ctx!.fillText(label, midX, Math.min(groundY + 19, vh - 8));

      ctx!.strokeStyle = `${GREEN}80`;
      ctx!.lineWidth = 1;
      ctx!.setLineDash([4, 4]);
      ctx!.beginPath();
      ctx!.moveTo(bounds.minX, groundY);
      ctx!.lineTo(bounds.maxX, groundY);
      ctx!.stroke();
      ctx!.setLineDash([]);

      return { hMm, wMm };
    }

    const leftResult = drawBox(lb, "LEFT");
    const rightResult = deduped.length >= 2 ? drawBox(rb, "RIGHT") : leftResult;

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
    const confLabel = `TF: ${deduped.length} obj | conf ${(leftBox.confidence * 100).toFixed(0)}%`;
    ctx.fillRect(4, 4, ctx.measureText(confLabel).width + 10, 18);
    ctx.fillStyle = GREEN;
    ctx.textAlign = "left";
    ctx.fillText(confLabel, 9, 17);

    try {
      const blob = await compressImage(canvas, 0.9);
      const annotatedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      if ("vibrate" in navigator) navigator.vibrate([60, 30, 60]);

      const result: CaptureResult = {
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
      };

      setShowSuccess(true);
      setStatusMsg("");
      setTimeout(() => {
        setShowSuccess(false);
        setIsCapturing(false);
      }, 1200);
      onCapture(result);
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
          <p className="text-sm" style={{ color: "#888" }}>Hold horizontally (landscape) to scan both shoes</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline muted autoPlay
      />
      <canvas ref={captureCanvasRef} className="hidden" />

      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "#080810" }}>
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: CYAN }} />
        </div>
      )}

      <AnimatePresence>
        {(isAnalyzing || isLoadingModel) && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-30"
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
          >
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold" style={{ color: CYAN }}>
              {isLoadingModel ? "Loading AI Model..." : "AI Analyzing..."}
            </p>
            <p className="text-xs mt-1" style={{ color: "#666" }}>
              {isLoadingModel ? "First load only — runs offline after" : "Detecting shoe outlines"}
            </p>
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
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
          <div
            className="px-4 py-2 rounded-full text-xs font-semibold text-center whitespace-nowrap"
            style={{ background: "rgba(0,0,0,0.7)", border: `1px solid ${CYAN}40`, color: "#ccc", backdropFilter: "blur(6px)" }}
          >
            Place both shoes side-by-side then tap capture
          </div>
        </div>
      )}

      {statusMsg && (
        <div className="absolute bottom-28 left-0 right-0 flex justify-center z-10">
          <div className="px-4 py-2 rounded-full text-xs font-semibold" style={{ background: "rgba(0,0,0,0.7)", color: CYAN }}>
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
