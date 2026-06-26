"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { useCamera } from "@/hooks/use-camera";
import { extractFrame, frameToGrayscale } from "@/lib/cv/frame";
import { saveCalibration } from "@/lib/calibration";
import type { CalibrationData } from "@/lib/cv/types";

const STATION_ID = "station-1";
// Horizontal FOV for typical factory inspection phone (iPhone ~65°, Samsung S-series ~67°)
const DEFAULT_H_FOV_DEG = 65;

// Finds the brightest horizontal band in the lower 60% — the lit table surface.
function detectSurfaceLine(frame: ImageData): number {
  const { width: w, height: h } = frame;
  const gray = frameToGrayscale(frame);
  const startY = Math.floor(h * 0.4);
  let maxBrightness = 0, surfaceY = Math.floor(h * 0.85);
  for (let y = startY; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) rowSum += gray[y * w + x];
    const avg = rowSum / w;
    if (avg > maxBrightness) { maxBrightness = avg; surfaceY = y; }
  }
  return surfaceY;
}

// pxPerMm from camera geometry: frameWidth / (2 * heightMm * tan(hFOV/2))
function computePxPerMm(frameWidth: number, heightCm: number, hFovDeg: number): number {
  const heightMm = heightCm * 10;
  const halfFovRad = (hFovDeg / 2) * (Math.PI / 180);
  const fovWidthMm = 2 * heightMm * Math.tan(halfFovRad);
  return frameWidth / fovWidthMm;
}

type Phase = "input" | "running" | "done" | "error";

export default function CalibratePage() {
  const router = useRouter();
  const { videoRef, status: camStatus } = useCamera();
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const [heightCm, setHeightCm] = useState("60");
  const [phase,    setPhase]    = useState<Phase>("input");
  const [errMsg,   setErrMsg]   = useState("");
  const [result,   setResult]   = useState<{ surfaceY: number; pxPerMm: number } | null>(null);

  // Draw a horizontal guide line on overlay at surfaceY when done
  useEffect(() => {
    const canvas = overlayRef.current;
    const video  = videoRef.current;
    if (!canvas || !video || !result) return;
    canvas.width  = video.videoWidth  || canvas.offsetWidth;
    canvas.height = video.videoHeight || canvas.offsetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Scale surfaceY from video coords to canvas display coords
    const scaleY = canvas.height / (video.videoHeight || canvas.height);
    const displayY = result.surfaceY * scaleY;

    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth   = 2;
    ctx.setLineDash([12, 6]);
    ctx.beginPath();
    ctx.moveTo(0, displayY);
    ctx.lineTo(canvas.width, displayY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#22c55e";
    ctx.font = "bold 13px 'Space Grotesk', sans-serif";
    ctx.fillText("Surface line", 12, displayY - 6);
  }, [result, videoRef]);

  const handleCalibrate = useCallback(async () => {
    const video = videoRef.current;
    if (!video || camStatus !== "ready") return;

    const cm = parseFloat(heightCm);
    if (!cm || cm < 10 || cm > 300) {
      setErrMsg("Enter a valid height between 10 and 300 cm.");
      return;
    }

    setPhase("running");
    setErrMsg("");

    // Average 5 frames ~400ms apart for stable surface detection
    const frames: ImageData[] = [];
    for (let i = 0; i < 5; i++) {
      const f = extractFrame(video, 1);
      if (f) frames.push(f);
      await new Promise(r => setTimeout(r, 80));
    }

    if (!frames.length) {
      setErrMsg("Could not read camera frame. Allow camera access and try again.");
      setPhase("error");
      return;
    }

    const surfaceY = detectSurfaceLine(frames[0]);
    const frameW   = frames[0].width;
    const pxPerMm  = computePxPerMm(frameW, cm, DEFAULT_H_FOV_DEG);

    const cal: CalibrationData = {
      pxPerMm,
      surfaceY,
      frameWidth:   video.videoWidth,
      frameHeight:  video.videoHeight,
      calibratedAt: new Date().toISOString(),
      stationId:    STATION_ID,
    };

    try {
      await saveCalibration(cal);
      setResult({ surfaceY, pxPerMm });
      setPhase("done");
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Save failed.");
      setPhase("error");
    }
  }, [videoRef, camStatus, heightCm]);

  return (
    <div className="max-w-lg mx-auto space-y-5 pb-10">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>
          Station Setup
        </h1>
        <p className="text-xs mt-0.5" style={{ color: "#555" }}>
          Admin only · Done once at installation
        </p>
      </div>

      {/* Camera preview */}
      <div className="relative rounded-2xl overflow-hidden bg-black" style={{ aspectRatio: "16/9" }}>
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
        <canvas ref={overlayRef} className="absolute inset-0 w-full h-full object-cover pointer-events-none" />

        {camStatus === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: "#06b6d4" }} />
          </div>
        )}

        {/* Running overlay */}
        <AnimatePresence>
          {phase === "running" && (
            <motion.div
              key="scanning"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center gap-3"
              style={{ background: "rgba(0,0,0,0.65)" }}
            >
              <Loader2 className="w-10 h-10 animate-spin" style={{ color: "#06b6d4" }} />
              <p className="text-white text-sm font-semibold">Detecting surface…</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Input card */}
      <AnimatePresence mode="wait">
        {(phase === "input" || phase === "error") && (
          <motion.div
            key="input"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="rounded-2xl p-5 space-y-5"
            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <div className="space-y-1">
              <p className="text-sm font-semibold text-white">
                How high is the camera above the table?
              </p>
              <p className="text-xs" style={{ color: "#555" }}>
                Measure from the table surface up to the phone lens.
                No tools or reference sheets needed.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 relative">
                <input
                  type="number"
                  inputMode="decimal"
                  value={heightCm}
                  onChange={e => setHeightCm(e.target.value)}
                  min={10}
                  max={300}
                  className="w-full px-3 py-3 rounded-xl text-white text-lg font-semibold text-center"
                  style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}
                />
              </div>
              <span className="text-sm font-semibold" style={{ color: "#555", minWidth: "2rem" }}>cm</span>
            </div>

            {/* Quick presets */}
            <div className="flex gap-2">
              {[40, 50, 60, 70, 80].map(v => (
                <button
                  key={v}
                  onClick={() => setHeightCm(String(v))}
                  className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all"
                  style={{
                    background: heightCm === String(v) ? "rgba(6,182,212,0.2)" : "rgba(255,255,255,0.04)",
                    border: heightCm === String(v) ? "1px solid rgba(6,182,212,0.5)" : "1px solid rgba(255,255,255,0.06)",
                    color: heightCm === String(v) ? "#06b6d4" : "#555",
                  }}
                >
                  {v}
                </button>
              ))}
            </div>

            {errMsg && (
              <div
                className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs"
                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444" }}
              >
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                {errMsg}
              </div>
            )}

            <button
              onClick={handleCalibrate}
              disabled={camStatus !== "ready"}
              className="w-full py-3.5 rounded-xl text-sm font-bold text-black disabled:opacity-40"
              style={{ background: "linear-gradient(135deg,#06b6d4,#3b82f6)" }}
            >
              Calibrate Station
            </button>
          </motion.div>
        )}

        {phase === "done" && result && (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-2xl p-6 text-center space-y-3"
            style={{ background: "rgba(34,197,94,0.07)", border: "1px solid rgba(34,197,94,0.2)" }}
          >
            <CheckCircle2 className="w-12 h-12 mx-auto" style={{ color: "#22c55e" }} />
            <p className="font-bold text-white text-lg" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>
              Station Ready
            </p>
            <p className="text-xs" style={{ color: "#666" }}>
              Scale: {result.pxPerMm.toFixed(3)} px/mm · Surface Y: {result.surfaceY}px
            </p>
            <p className="text-xs" style={{ color: "#444" }}>
              Workers can now start scanning. No further setup needed.
            </p>
            <button
              onClick={() => router.push("/scan")}
              className="px-6 py-2.5 rounded-xl text-sm font-bold text-black mt-2"
              style={{ background: "linear-gradient(135deg,#22c55e,#16a34a)" }}
            >
              Start Inspecting
            </button>
            <button
              onClick={() => { setPhase("input"); setResult(null); }}
              className="block w-full text-xs mt-1 py-1"
              style={{ color: "#444" }}
            >
              Recalibrate
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
