"use client";

// One-time admin calibration.
// Admin places any flat object of known width on the inspection surface.
// System detects its left/right edges using vertical Sobel gradients.
// pxPerMm = detected pixel width / known mm width.
// Result stored in Supabase + localStorage. Never needs repeating unless camera moves.

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertTriangle, Loader2, ArrowLeft } from "lucide-react";
import { useCamera } from "@/hooks/use-camera";
import { extractFrame, frameToGrayscale } from "@/lib/cv/frame";
import { saveCalibration } from "@/lib/calibration";
import type { CalibrationData } from "@/lib/cv/types";

const STATION_ID = "station-1";

// Detect left and right edge of the widest flat object placed horizontally
// in the middle of the frame using vertical Sobel column gradient sums.
function detectObjectEdges(frame: ImageData): { leftX: number; rightX: number; widthPx: number } | null {
  const { width: w, height: h } = frame;
  const gray = frameToGrayscale(frame);

  // Search only the middle vertical band (avoid table edge / wall)
  const yStart = Math.floor(h * 0.25);
  const yEnd   = Math.floor(h * 0.75);

  // Per-column: sum of |horizontal gradient| across middle rows
  const colGrad = new Float64Array(w);
  for (let x = 1; x < w - 1; x++) {
    let s = 0;
    for (let y = yStart; y < yEnd; y++) {
      s += Math.abs(gray[y * w + x + 1] - gray[y * w + x - 1]);
    }
    colGrad[x] = s;
  }

  // Find strongest edge from left (in left 50%)
  let leftX = -1, maxL = 0;
  for (let x = 5; x < Math.floor(w * 0.5); x++) {
    if (colGrad[x] > maxL) { maxL = colGrad[x]; leftX = x; }
  }

  // Find strongest edge from right (in right 50%)
  let rightX = -1, maxR = 0;
  for (let x = w - 5; x >= Math.floor(w * 0.5); x--) {
    if (colGrad[x] > maxR) { maxR = colGrad[x]; rightX = x; }
  }

  if (leftX < 0 || rightX < 0 || rightX <= leftX + 20) return null;
  return { leftX, rightX, widthPx: rightX - leftX };
}

// Common reference objects with their widths
const PRESETS = [
  { label: "Credit card", mm: 85.6 },
  { label: "A4 short side", mm: 210 },
  { label: "A4 long side", mm: 297 },
  { label: "Ruler (30cm)", mm: 300 },
];

type Phase = "idle" | "busy" | "done" | "error";

export default function CalibratePage() {
  const router = useRouter();
  const { videoRef, status: camStatus } = useCamera();

  const [refMm,    setRefMm]    = useState("85.6");
  const [phase,    setPhase]    = useState<Phase>("idle");
  const [errMsg,   setErrMsg]   = useState("");
  const [result,   setResult]   = useState<{ pxPerMm: number; widthPx: number } | null>(null);

  const handleCalibrate = useCallback(async () => {
    const video = videoRef.current;
    if (!video || camStatus !== "ready") return;
    const mm = parseFloat(refMm);
    if (!mm || mm <= 0) { setErrMsg("Enter a valid width in mm."); return; }

    setPhase("busy"); setErrMsg("");

    // Average 5 frames for stability
    const frames: ImageData[] = [];
    for (let i = 0; i < 5; i++) {
      const f = extractFrame(video, 1);
      if (f) frames.push(f);
      await new Promise(r => setTimeout(r, 80));
    }

    if (!frames.length) {
      setErrMsg("Could not read camera frame. Allow camera access and try again.");
      setPhase("error"); return;
    }

    const edges = detectObjectEdges(frames[0]);
    if (!edges) {
      setErrMsg("Could not detect object edges. Make sure the reference object is centred in frame with clear contrast against the surface.");
      setPhase("error"); return;
    }

    const pxPerMm = edges.widthPx / mm;
    const cal: CalibrationData = {
      pxPerMm,
      calibratedAt: new Date().toISOString(),
      stationId:    STATION_ID,
    };

    try {
      await saveCalibration(cal);
      setResult({ pxPerMm, widthPx: edges.widthPx });
      setPhase("done");
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Save failed.");
      setPhase("error");
    }
  }, [videoRef, camStatus, refMm]);

  return (
    <div className="max-w-lg mx-auto space-y-5 pb-10">

      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()}
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ color:"#666", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)" }}>
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-white" style={{ fontFamily:"'Space Grotesk',sans-serif" }}>
            Station Calibration
          </h1>
          <p className="text-xs mt-0.5" style={{ color:"#555" }}>
            Admin only · Performed once at installation
          </p>
        </div>
      </div>

      {/* Live preview */}
      <div className="relative rounded-2xl overflow-hidden bg-black" style={{ aspectRatio:"16/9" }}>
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
        {camStatus === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color:"#06b6d4" }} />
          </div>
        )}
      </div>

      <AnimatePresence mode="wait">
        {(phase === "idle" || phase === "busy" || phase === "error") && (
          <motion.div
            key="input"
            initial={{ opacity:0, y:10 }}
            animate={{ opacity:1, y:0 }}
            exit={{ opacity:0, y:-6 }}
            className="rounded-2xl p-5 space-y-5"
            style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.08)" }}
          >
            {/* Instructions */}
            <div className="space-y-1">
              <p className="text-sm font-semibold text-white">Place a flat reference object on the surface</p>
              <p className="text-xs leading-relaxed" style={{ color:"#555" }}>
                Any object with a known width works — credit card, ruler, paper.
                Lay it flat, centred in frame, with both edges clearly visible.
                Enter its width below, then tap Calibrate.
              </p>
            </div>

            {/* Presets */}
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color:"#444" }}>Quick select</p>
              <div className="grid grid-cols-2 gap-2">
                {PRESETS.map(p => (
                  <button key={p.label}
                    onClick={() => setRefMm(String(p.mm))}
                    className="py-2 px-3 rounded-xl text-xs font-semibold text-left transition-all"
                    style={{
                      background: refMm === String(p.mm) ? "rgba(6,182,212,0.15)" : "rgba(255,255,255,0.04)",
                      border:     refMm === String(p.mm) ? "1px solid rgba(6,182,212,0.4)" : "1px solid rgba(255,255,255,0.07)",
                      color:      refMm === String(p.mm) ? "#06b6d4" : "#666",
                    }}
                  >
                    <span className="block text-white" style={{ fontWeight: 600 }}>{p.label}</span>
                    <span>{p.mm} mm</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Manual input */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color:"#444" }}>
                Reference width (mm)
              </label>
              <input
                type="number"
                inputMode="decimal"
                value={refMm}
                onChange={e => setRefMm(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl text-white text-sm"
                style={{ background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.1)" }}
                placeholder="e.g. 85.6"
              />
            </div>

            {errMsg && (
              <div className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs"
                style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", color:"#ef4444" }}>
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                {errMsg}
              </div>
            )}

            <button
              onClick={handleCalibrate}
              disabled={camStatus !== "ready" || phase === "busy"}
              className="w-full py-3.5 rounded-xl text-sm font-bold text-black disabled:opacity-40 flex items-center justify-center gap-2"
              style={{ background:"linear-gradient(135deg,#06b6d4,#3b82f6)" }}
            >
              {phase === "busy" && <Loader2 className="w-4 h-4 animate-spin" />}
              {phase === "busy" ? "Detecting…" : "Calibrate Station"}
            </button>
          </motion.div>
        )}

        {phase === "done" && result && (
          <motion.div
            key="done"
            initial={{ opacity:0, scale:0.96 }}
            animate={{ opacity:1, scale:1 }}
            className="rounded-2xl p-6 text-center space-y-3"
            style={{ background:"rgba(34,197,94,0.07)", border:"1px solid rgba(34,197,94,0.2)" }}
          >
            <CheckCircle2 className="w-12 h-12 mx-auto" style={{ color:"#22c55e" }} />
            <p className="font-bold text-white text-lg" style={{ fontFamily:"'Space Grotesk',sans-serif" }}>
              Station Ready
            </p>
            <p className="text-xs" style={{ color:"#666" }}>
              {result.widthPx}px = {refMm}mm → {result.pxPerMm.toFixed(3)} px/mm
            </p>
            <p className="text-xs" style={{ color:"#444" }}>
              Workers can now scan. Calibration is saved permanently.
            </p>
            <button
              onClick={() => router.push("/scan")}
              className="px-6 py-2.5 rounded-xl text-sm font-bold text-black"
              style={{ background:"linear-gradient(135deg,#22c55e,#16a34a)" }}
            >
              Start Inspecting
            </button>
            <button
              onClick={() => { setPhase("idle"); setResult(null); }}
              className="block w-full text-xs py-1" style={{ color:"#444" }}
            >
              Recalibrate
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
