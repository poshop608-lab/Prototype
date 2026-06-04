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

// MediaPipe model URL — EfficientDet-Lite0, ~4MB, works offline after first load
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

// Classes that could represent a shoe on a factory floor
const SHOE_CLASSES = new Set([
  "shoe", "sneaker", "boot", "sandal", "slipper",
  // fallback: anything that can sit on a floor
  "sports ball", "bottle", "cup", "vase", "bowl",
  "handbag", "backpack", "suitcase", "clock", "book",
  "laptop", "keyboard", "remote", "mouse", "cell phone",
  "teddy bear", "potted plant", "chair",
]);

export function CameraView({ onCapture, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const detectorRef = useRef<any>(null);

  const [isReady, setIsReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady, setModelReady] = useState(false);
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
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
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

  // Load MediaPipe model eagerly once camera is ready
  useEffect(() => {
    if (!isReady || detectorRef.current || modelLoading) return;
    async function loadModel() {
      setModelLoading(true);
      try {
        const { ObjectDetector, FilesetResolver } =
          await import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
        );
        detectorRef.current = await ObjectDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          scoreThreshold: 0.2,
          maxResults: 10,
          runningMode: "IMAGE",
        });
        setModelReady(true);
      } catch (e) {
        console.error("[MediaPipe load]", e);
        // Try CPU fallback
        try {
          const { ObjectDetector, FilesetResolver } =
            await import("@mediapipe/tasks-vision");
          const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
          );
          detectorRef.current = await ObjectDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
            scoreThreshold: 0.2,
            maxResults: 10,
            runningMode: "IMAGE",
          });
          setModelReady(true);
        } catch (e2) {
          console.error("[MediaPipe CPU fallback failed]", e2);
        }
      } finally {
        setModelLoading(false);
      }
    }
    loadModel();
  }, [isReady, modelLoading]);

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setIsCapturing(true);

    // Load model on-demand if eager load hasn't finished
    if (!detectorRef.current) {
      setStatusMsg("Loading AI model (~4MB)...");
      try {
        const { ObjectDetector, FilesetResolver } =
          await import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
        );
        detectorRef.current = await ObjectDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          scoreThreshold: 0.2,
          maxResults: 10,
          runningMode: "IMAGE",
        });
        setModelReady(true);
      } catch (e) {
        onError(`AI model failed to load: ${e instanceof Error ? e.message : "network error"}`);
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

    let detections: { bbox: BBox; score: number; label: string }[] = [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = detectorRef.current.detect(canvas) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any[] = result.detections ?? [];

      detections = raw.map((d) => {
        const bb = d.boundingBox;
        return {
          label: d.categories?.[0]?.categoryName ?? "object",
          score: d.categories?.[0]?.score ?? 0,
          bbox: {
            minX: Math.round(bb.originX),
            minY: Math.round(bb.originY),
            maxX: Math.round(bb.originX + bb.width),
            maxY: Math.round(bb.originY + bb.height),
          },
        };
      });

      console.log("[MediaPipe]", detections.length, "detections:", detections.map(d => `${d.label}(${(d.score*100).toFixed(0)}%)`));
    } catch (e) {
      setIsAnalyzing(false);
      setIsCapturing(false);
      setStatusMsg("");
      onError(`Detection failed: ${e instanceof Error ? e.message : "unknown"}`);
      return;
    }

    setIsAnalyzing(false);
    setStatusMsg("");

    if (detections.length === 0) {
      setIsCapturing(false);
      onError("No objects detected. Make sure shoes are well-lit and clearly visible.");
      return;
    }

    // Prefer shoe-class detections; fallback to all detections by area
    let shoes = detections.filter(d => SHOE_CLASSES.has(d.label.toLowerCase()));
    if (shoes.length < 2) shoes = detections;

    // Remove duplicates (IoU > 0.5)
    function iou(a: BBox, b: BBox) {
      const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
      const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      const inter = ix * iy;
      const aA = (a.maxX - a.minX) * (a.maxY - a.minY);
      const bA = (b.maxX - b.minX) * (b.maxY - b.minY);
      return inter / (aA + bA - inter + 1e-6);
    }
    const sorted = [...shoes].sort((a, b) => b.score - a.score);
    const deduped: typeof sorted = [];
    for (const d of sorted) {
      if (!deduped.some(k => iou(k.bbox, d.bbox) > 0.5)) deduped.push(d);
    }

    if (deduped.length < 2) {
      setIsCapturing(false);
      onError(
        `Only found ${deduped.length} object(s). Both shoes must be fully visible, side-by-side with a gap between them.`
      );
      return;
    }

    // Pick best pair: max horizontal separation among top-4
    const top4 = deduped.slice(0, 4);
    let bestA = top4[0], bestB = top4[1], bestSep = 0;
    for (let i = 0; i < top4.length; i++) {
      for (let j = i + 1; j < top4.length; j++) {
        const ca = (top4[i].bbox.minX + top4[i].bbox.maxX) / 2;
        const cb = (top4[j].bbox.minX + top4[j].bbox.maxX) / 2;
        const sep = Math.abs(ca - cb);
        if (sep > bestSep) { bestSep = sep; bestA = top4[i]; bestB = top4[j]; }
      }
    }

    // Sort left → right
    const [leftDet, rightDet] = [bestA, bestB].sort((a, b) => a.bbox.minX - b.bbox.minX);
    const lb = leftDet.bbox;
    const rb = rightDet.bbox;

    // Tilt check
    const bottomDiff = Math.abs(lb.maxY - rb.maxY);
    if (bottomDiff > vh * 0.12) {
      setIsCapturing(false);
      onError(`Camera tilted — shoe baselines differ by ${Math.round(bottomDiff)}px. Level the camera.`);
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
    const stamp = `MP | L:${leftResult.hMm}mm R:${rightResult.hMm}mm | ${leftDet.label}/${rightDet.label}`;
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

      {/* Model loading indicator (subtle, top bar) */}
      {isReady && modelLoading && (
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center gap-2 py-2"
          style={{ background: "rgba(0,0,0,0.7)" }}>
          <Loader2 className="w-3 h-3 animate-spin" style={{ color: CYAN }} />
          <span className="text-xs font-medium" style={{ color: CYAN }}>Loading AI model...</span>
        </div>
      )}
      {isReady && modelReady && !modelLoading && !isCapturing && (
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center gap-2 py-1.5"
          style={{ background: "rgba(34,197,94,0.15)" }}>
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN }} />
          <span className="text-[10px] font-semibold" style={{ color: GREEN }}>AI Ready</span>
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
            <p className="text-xs mt-1" style={{ color: "#666" }}>MediaPipe EfficientDet</p>
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
            Shoes side-by-side · landscape · well-lit
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
