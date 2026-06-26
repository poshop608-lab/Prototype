"use client";

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Camera, ArrowLeft, CheckCircle2, AlertTriangle, Ruler } from "lucide-react";
import { useCamera } from "@/hooks/use-camera";
import { extractFrame, frameToGrayscale } from "@/lib/cv/frame";
import { saveCalibration } from "@/lib/calibration";
import type { CalibrationData } from "@/lib/cv/types";

// ─── Surface line detection ────────────────────────────────────────────────────
// Finds the brightest horizontal band in the lower 50% of the frame.
// The inspection table surface reflects more light than the wall background.
function detectSurfaceLine(frame: ImageData): number {
  const { width: w, height: h } = frame;
  const gray = frameToGrayscale(frame);
  const startY = Math.floor(h * 0.4); // search lower 60%

  // Row brightness: average luminance per row
  let maxBrightness = 0, surfaceY = Math.floor(h * 0.85);
  for (let y = startY; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) rowSum += gray[y * w + x];
    const rowBrightness = rowSum / w;
    if (rowBrightness > maxBrightness) {
      maxBrightness = rowBrightness;
      surfaceY = y;
    }
  }
  return surfaceY;
}

// ─── Reference object edge detection (px/mm calibration) ──────────────────────
// Finds the leftmost and rightmost dark vertical edges in the middle 60% of height.
function detectObjectEdges(frame: ImageData): { leftX: number; rightX: number } | null {
  const { width: w, height: h } = frame;
  const gray = frameToGrayscale(frame);
  const yStart = Math.floor(h * 0.2), yEnd = Math.floor(h * 0.8);

  // Vertical Sobel per column (sum of absolute horizontal gradient across middle rows)
  const colGrad = new Float64Array(w);
  for (let x = 1; x < w - 1; x++) {
    let s = 0;
    for (let y = yStart; y < yEnd; y++) {
      s += Math.abs(gray[y * w + x + 1] - gray[y * w + x - 1]);
    }
    colGrad[x] = s;
  }

  // Find left edge (first strong gradient from left, in left 50%)
  const THRESH = 300;
  let leftX = -1, rightX = -1;
  for (let x = 5; x < w / 2; x++) {
    if (colGrad[x] > THRESH) { leftX = x; break; }
  }
  for (let x = w - 5; x > w / 2; x--) {
    if (colGrad[x] > THRESH) { rightX = x; break; }
  }

  if (leftX < 0 || rightX < 0 || rightX <= leftX) return null;
  return { leftX, rightX };
}

const STATION_ID = "station-1";

type Step = "surface" | "scale" | "done";

export default function CalibratePage() {
  const router = useRouter();
  const { videoRef, status: camStatus } = useCamera();
  const captureRef = useRef<HTMLCanvasElement>(null);

  const [step,       setStep]       = useState<Step>("surface");
  const [surfaceY,   setSurfaceY]   = useState<number>(0);
  const [refWidthMm, setRefWidthMm] = useState("297"); // default: A4 width
  const [pxPerMm,    setPxPerMm]    = useState<number>(0);
  const [message,    setMessage]    = useState<string>("");
  const [busy,       setBusy]       = useState(false);

  // ── Step 1: capture surface line ──────────────────────────────────────────
  const captureSurface = useCallback(async () => {
    const video = videoRef.current;
    if (!video || camStatus !== "ready") return;
    setBusy(true);
    setMessage("");

    // Average 5 frames
    const frames: ImageData[] = [];
    for (let i = 0; i < 5; i++) {
      const f = extractFrame(video, 1);
      if (f) frames.push(f);
      await new Promise(r => setTimeout(r, 80));
    }
    if (!frames.length) { setMessage("Could not capture frame. Try again."); setBusy(false); return; }

    // Use first frame (averaging across frames is overkill for static surface)
    const sY = detectSurfaceLine(frames[0]);
    setSurfaceY(sY);
    setMessage(`Surface line detected at Y=${sY}px`);
    setStep("scale");
    setBusy(false);
  }, [videoRef, camStatus]);

  // ── Step 2: measure reference object ─────────────────────────────────────
  const captureScale = useCallback(async () => {
    const video = videoRef.current;
    if (!video || camStatus !== "ready") return;
    const mmVal = parseFloat(refWidthMm);
    if (!mmVal || mmVal <= 0) { setMessage("Enter a valid width in mm."); return; }
    setBusy(true);
    setMessage("");

    const frame = extractFrame(video, 1);
    if (!frame) { setMessage("Could not capture frame."); setBusy(false); return; }

    const edges = detectObjectEdges(frame);
    if (!edges) { setMessage("Could not detect object edges. Ensure the reference object fills the frame against a clear background."); setBusy(false); return; }

    const widthPx = edges.rightX - edges.leftX;
    const computed = widthPx / mmVal;
    setPxPerMm(computed);
    setMessage(`Detected ${widthPx}px = ${mmVal}mm → ${computed.toFixed(3)} px/mm`);
    setBusy(false);
  }, [videoRef, camStatus, refWidthMm]);

  // ── Save calibration ──────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !surfaceY || !pxPerMm) return;
    setBusy(true);

    const cal: CalibrationData = {
      pxPerMm,
      surfaceY,
      frameWidth:   video.videoWidth,
      frameHeight:  video.videoHeight,
      calibratedAt: new Date().toISOString(),
      stationId:    STATION_ID,
    };

    await saveCalibration(cal);
    setStep("done");
    setBusy(false);
  }, [videoRef, surfaceY, pxPerMm]);

  return (
    <div className="max-w-lg mx-auto space-y-6 pb-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ color: "#666", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>
            Station Calibration
          </h1>
          <p className="text-xs mt-0.5" style={{ color: "#555" }}>
            Admin only · Performed once at installation
          </p>
        </div>
      </div>

      {/* Live preview */}
      <div className="relative rounded-2xl overflow-hidden bg-black" style={{ aspectRatio: "16/9" }}>
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
        <canvas ref={captureRef} className="hidden" />
        {camStatus === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black">
            <p className="text-sm text-white">Starting camera…</p>
          </div>
        )}
      </div>

      {/* Steps */}
      {step === "surface" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl p-5 space-y-4"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <div className="flex items-center gap-2">
            <Ruler className="w-4 h-4" style={{ color: "#06b6d4" }} />
            <p className="text-sm font-semibold text-white">Step 1 — Surface Line</p>
          </div>
          <p className="text-xs" style={{ color: "#666" }}>
            Clear the inspection surface. Remove all shoes and objects.
            Point the camera at the empty table surface and tap Capture.
          </p>
          <button
            onClick={captureSurface}
            disabled={busy || camStatus !== "ready"}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold text-black disabled:opacity-40"
            style={{ background: "linear-gradient(135deg,#06b6d4,#3b82f6)" }}
          >
            <Camera className="w-4 h-4" />
            {busy ? "Capturing…" : "Capture Surface"}
          </button>
        </motion.div>
      )}

      {step === "scale" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl p-5 space-y-4"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <div className="flex items-center gap-2">
            <Ruler className="w-4 h-4" style={{ color: "#06b6d4" }} />
            <p className="text-sm font-semibold text-white">Step 2 — Scale Calibration</p>
          </div>
          <p className="text-xs" style={{ color: "#666" }}>
            Place a reference object of known width flat on the surface (e.g. an A4 sheet, 297 mm wide).
            Centre it in frame so both left and right edges are visible.
            Enter the known width and tap Measure.
          </p>
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#555" }}>
              Known width (mm)
            </label>
            <input
              type="number"
              value={refWidthMm}
              onChange={e => setRefWidthMm(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-white text-sm"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
              placeholder="e.g. 297"
            />
          </div>
          <button
            onClick={captureScale}
            disabled={busy || camStatus !== "ready"}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold text-black disabled:opacity-40"
            style={{ background: "linear-gradient(135deg,#06b6d4,#3b82f6)" }}
          >
            <Ruler className="w-4 h-4" />
            {busy ? "Measuring…" : "Measure Reference"}
          </button>
          {pxPerMm > 0 && (
            <button
              onClick={handleSave}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold text-black disabled:opacity-40"
              style={{ background: "linear-gradient(135deg,#22c55e,#16a34a)" }}
            >
              <CheckCircle2 className="w-4 h-4" />
              Save Calibration
            </button>
          )}
        </motion.div>
      )}

      {step === "done" && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="rounded-2xl p-6 text-center space-y-3"
          style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)" }}
        >
          <CheckCircle2 className="w-12 h-12 mx-auto" style={{ color: "#22c55e" }} />
          <p className="font-bold text-white text-lg" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>
            Calibration Saved
          </p>
          <p className="text-xs" style={{ color: "#666" }}>
            Surface Y: {surfaceY}px · Scale: {pxPerMm.toFixed(3)} px/mm
          </p>
          <button
            onClick={() => router.push("/scan")}
            className="px-6 py-2.5 rounded-xl text-sm font-bold text-black mt-2"
            style={{ background: "linear-gradient(135deg,#22c55e,#16a34a)" }}
          >
            Start Inspecting
          </button>
        </motion.div>
      )}

      {/* Status message */}
      {message && (
        <div
          className="rounded-xl px-4 py-3 text-xs font-medium flex items-start gap-2"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#aaa" }}
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: "#f59e0b" }} />
          {message}
        </div>
      )}
    </div>
  );
}
