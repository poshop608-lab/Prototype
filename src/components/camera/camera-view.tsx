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

// ── Blob-based shoe detector ───────────────────────────────────────────────
// 1. Downsample to thumbnail
// 2. Compute per-pixel foreground mask vs adaptive background
// 3. Run connected-component labeling (flood fill) on fg mask
// 4. Pick top-2 largest blobs that are spatially separated
// 5. Return their bounding boxes in original resolution
function detectShoes(
  video: HTMLVideoElement,
  vw: number,
  vh: number
): { left: BBox; right: BBox } | null {

  const SCALE = 0.2; // 20% size — fast enough, enough detail
  const tw = Math.round(vw * SCALE);
  const th = Math.round(vh * SCALE);

  const thumb = document.createElement("canvas");
  thumb.width = tw; thumb.height = th;
  const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(video, 0, 0, tw, th);
  const { data } = tctx.getImageData(0, 0, tw, th);

  // ── Adaptive background: sample 4 corners (avoid shoe area) ──
  function sampleCorner(cx: number, cy: number, r = 6) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = cy; y < cy + r && y < th; y++) {
      for (let x = cx; x < cx + r && x < tw; x++) {
        const i = (y * tw + x) * 4;
        sr += data[i]; sg += data[i+1]; sb += data[i+2]; n++;
      }
    }
    return n ? [sr/n, sg/n, sb/n] : [128, 128, 128];
  }
  const corners = [
    sampleCorner(0, 0), sampleCorner(tw-7, 0),
    sampleCorner(0, th-7), sampleCorner(tw-7, th-7),
  ];
  const bgR = corners.reduce((s,c) => s+c[0], 0) / 4;
  const bgG = corners.reduce((s,c) => s+c[1], 0) / 4;
  const bgB = corners.reduce((s,c) => s+c[2], 0) / 4;

  // ── Foreground mask ──
  // A pixel is foreground if it differs enough from background
  const FG_THRESH = 28;
  const fg = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const diff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
      fg[y * tw + x] = diff > FG_THRESH ? 1 : 0;
    }
  }

  // ── Morphological close: dilate then erode to fill small holes ──
  function dilate(src: Uint8Array, r = 1): Uint8Array {
    const dst = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let v = 0;
        outer: for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const ny = y+dy, nx = x+dx;
            if (ny >= 0 && ny < th && nx >= 0 && nx < tw && src[ny*tw+nx]) { v = 1; break outer; }
          }
        }
        dst[y*tw+x] = v;
      }
    }
    return dst;
  }
  function erode(src: Uint8Array, r = 1): Uint8Array {
    const dst = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let v = 1;
        for (let dy = -r; dy <= r && v; dy++) {
          for (let dx = -r; dx <= r && v; dx++) {
            const ny = y+dy, nx = x+dx;
            if (ny < 0 || ny >= th || nx < 0 || nx >= tw || !src[ny*tw+nx]) v = 0;
          }
        }
        dst[y*tw+x] = v;
      }
    }
    return dst;
  }
  const closed = erode(dilate(fg, 2), 2);

  // ── Connected components (BFS) ──
  const label = new Int32Array(tw * th).fill(-1);
  const blobs: { pixels: number[]; minX: number; maxX: number; minY: number; maxY: number }[] = [];

  for (let start = 0; start < tw * th; start++) {
    if (!closed[start] || label[start] !== -1) continue;
    const queue = [start];
    label[start] = blobs.length;
    const blob = { pixels: [] as number[], minX: tw, maxX: 0, minY: th, maxY: 0 };
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % tw, y = Math.floor(idx / tw);
      blob.pixels.push(idx);
      if (x < blob.minX) blob.minX = x;
      if (x > blob.maxX) blob.maxX = x;
      if (y < blob.minY) blob.minY = y;
      if (y > blob.maxY) blob.maxY = y;
      const neighbors = [idx-1, idx+1, idx-tw, idx+tw];
      for (const n of neighbors) {
        const nx = n % tw, ny = Math.floor(n / tw);
        if (n >= 0 && n < tw*th && nx >= 0 && nx < tw && ny >= 0 && ny < th && closed[n] && label[n] === -1) {
          label[n] = blobs.length;
          queue.push(n);
        }
      }
    }
    blobs.push(blob);
  }

  if (blobs.length === 0) return null;

  // ── Filter blobs: min size, must be in lower 80% of frame ──
  const minArea = tw * th * 0.02; // at least 2% of frame
  const validBlobs = blobs.filter(b => {
    const area = b.pixels.length;
    const centerY = (b.minY + b.maxY) / 2;
    return area >= minArea && centerY > th * 0.2;
  });

  if (validBlobs.length < 2) {
    // Relax constraints if we can't find 2
    const relaxed = blobs
      .filter(b => b.pixels.length >= tw * th * 0.005)
      .sort((a, b) => b.pixels.length - a.pixels.length)
      .slice(0, 2);
    if (relaxed.length < 2) return null;
    relaxed.sort((a, b) => a.minX - b.minX); // left→right
    return bboxPair(relaxed[0], relaxed[1], SCALE, vw, vh);
  }

  // Sort by size, take top 4, then pick the best left+right pair
  const top = validBlobs
    .sort((a, b) => b.pixels.length - a.pixels.length)
    .slice(0, 4);

  // Find pair that maximises horizontal separation
  let bestPair: [typeof top[0], typeof top[0]] | null = null;
  let bestSep = 0;
  for (let i = 0; i < top.length; i++) {
    for (let j = i+1; j < top.length; j++) {
      const sep = Math.abs(
        (top[i].minX + top[i].maxX)/2 - (top[j].minX + top[j].maxX)/2
      );
      if (sep > bestSep) { bestSep = sep; bestPair = [top[i], top[j]]; }
    }
  }
  if (!bestPair) return null;

  // Ensure left is left
  bestPair.sort((a, b) => a.minX - b.minX);
  return bboxPair(bestPair[0], bestPair[1], SCALE, vw, vh);
}

function bboxPair(
  a: { minX: number; maxX: number; minY: number; maxY: number },
  b: { minX: number; maxX: number; minY: number; maxY: number },
  scale: number,
  vw: number,
  vh: number
): { left: BBox; right: BBox } {
  const PAD = 10;
  function toFull(bbox: typeof a): BBox {
    return {
      minX: Math.max(0, Math.round(bbox.minX / scale) - PAD),
      maxX: Math.min(vw, Math.round(bbox.maxX / scale) + PAD),
      minY: Math.max(0, Math.round(bbox.minY / scale) - PAD),
      maxY: Math.min(vh, Math.round(bbox.maxY / scale) + PAD),
    };
  }
  return { left: toFull(a), right: toFull(b) };
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

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;

    setIsCapturing(true);
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

    const result = detectShoes(video, vw, vh);

    setIsAnalyzing(false);

    if (!result) {
      setIsCapturing(false);
      setStatusMsg("");
      onError("Could not find two distinct shoes. Place both shoes on a contrasting surface with clear separation, then retry.");
      return;
    }

    const { left: lb, right: rb } = result;

    // Tilt check
    const bottomDiff = Math.abs(lb.maxY - rb.maxY);
    if (bottomDiff > vh * 0.10) {
      setIsCapturing(false);
      setStatusMsg("");
      onError(`Camera tilted — shoe baselines differ by ${Math.round(bottomDiff)}px. Level the camera and retake.`);
      return;
    }

    // Shared ground baseline = lower of the two box bottoms
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

      // Height = from top of shoe bbox to shared ground
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
      ctx.fillRect(midX - ctx.measureText(wl).width/2 - 4, Math.max(bounds.minY - 26, 0), ctx.measureText(wl).width + 8, 18);
      ctx.fillStyle = GREEN;
      ctx.textAlign = "center";
      ctx.fillText(wl, midX, Math.max(bounds.minY - 10, 14));

      ctx.font = "bold 13px monospace";
      const bw = ctx.measureText(label).width + 14;
      ctx.fillStyle = `${GREEN}cc`;
      ctx.fillRect(midX - bw/2, Math.min(groundY + 6, vh - 22), bw, 18);
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

      <AnimatePresence>
        {isAnalyzing && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-30"
            style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
          >
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold" style={{ color: CYAN }}>Detecting shoes...</p>
            <p className="text-xs mt-1" style={{ color: "#666" }}>Blob detection — instant</p>
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
            Shoes side-by-side · contrasting surface · landscape
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
