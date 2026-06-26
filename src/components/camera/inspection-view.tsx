"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Loader2, CheckCircle2, XCircle, RotateCcw, AlertTriangle } from "lucide-react";
import { useCamera } from "@/hooks/use-camera";
import { usePipeline } from "@/hooks/use-pipeline";
import type { CalibrationData, InspectionResult } from "@/lib/cv/types";

interface Props {
  calibration:       CalibrationData | null;
  onResult:          (result: InspectionResult) => void;
  onNeedCalibration: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  WAITING:   "Place both shoes on the surface",
  DETECTING: "Hold steady…",
  STABLE:    "Measuring…",
  MEASURING: "Measuring…",
  RESULT:    "",
  COMPLETE:  "Saved ✓",
  RESETTING: "Ready for next pair",
};

export function InspectionView({ calibration, onResult, onNeedCalibration }: Props) {
  const { videoRef, status: camStatus, error: camError } = useCamera();
  const { state, detection, stability, result, overlayRef } = usePipeline(videoRef, calibration, onResult);

  const isResult    = state === "RESULT" || state === "COMPLETE";
  const passed      = result?.comparison.passed;
  const resultColor = passed ? "#22c55e" : "#ef4444";

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">

      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline muted autoPlay
      />

      <canvas
        ref={overlayRef}
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />

      {camStatus === "starting" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <Loader2 className="w-10 h-10 animate-spin" style={{ color: "#06b6d4" }} />
        </div>
      )}

      {camStatus === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-8 bg-black">
          <div className="text-center max-w-xs">
            <XCircle className="w-12 h-12 mx-auto mb-3" style={{ color: "#ef4444" }} />
            <p className="font-bold text-white text-base mb-2">Camera unavailable</p>
            <p className="text-sm" style={{ color: "#666" }}>{camError}</p>
          </div>
        </div>
      )}

      {/* Status bar */}
      {camStatus === "ready" && !isResult && (
        <div
          className="absolute bottom-0 inset-x-0 flex items-center justify-center gap-3 px-4 py-3"
          style={{ background: "linear-gradient(to top, rgba(0,0,0,0.85), transparent)" }}
        >
          {(state === "DETECTING" || state === "MEASURING" || state === "STABLE") && stability && (
            <div className="relative w-8 h-8 mr-1">
              <svg className="w-8 h-8 -rotate-90" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
                <circle
                  cx="18" cy="18" r="14"
                  fill="none"
                  stroke="#06b6d4"
                  strokeWidth="3"
                  strokeDasharray={`${stability.progressFraction * 87.96} 87.96`}
                  strokeLinecap="round"
                />
              </svg>
            </div>
          )}
          <p className="text-sm font-semibold text-white text-center">
            {STATUS_LABELS[state] ?? ""}
          </p>
          {detection?.found && stability && !stability.stable && state === "DETECTING" && (
            <span className="text-xs" style={{ color: "#555" }}>
              {Math.round(stability.progressFraction * 100)}%
            </span>
          )}
        </div>
      )}

      {/* Result panel */}
      <AnimatePresence>
        {isResult && result && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ type: "spring", stiffness: 280, damping: 24 }}
            className="absolute bottom-0 inset-x-0 px-4 pb-5 pt-4"
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.96) 60%, transparent)" }}
          >
            <div
              className="rounded-2xl p-4 flex items-center gap-4"
              style={{ background: `${resultColor}18`, border: `1px solid ${resultColor}40` }}
            >
              {passed
                ? <CheckCircle2 className="w-10 h-10 flex-shrink-0" style={{ color: resultColor }} />
                : <XCircle      className="w-10 h-10 flex-shrink-0" style={{ color: resultColor }} />
              }
              <div className="flex-1 min-w-0">
                <p className="text-xl font-black" style={{ color: resultColor, fontFamily: "'Space Grotesk',sans-serif" }}>
                  {passed ? "PASS" : "REJECT"}
                </p>
                <p className="text-xs mt-0.5" style={{ color: "#888" }}>
                  L {result.comparison.leftMm}mm · R {result.comparison.rightMm}mm · Δ {result.comparison.diffMm}mm
                </p>
              </div>
              {state === "COMPLETE" && (
                <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: "#22c55e" }}>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Saved
                </div>
              )}
            </div>
            <p className="text-center text-xs mt-3" style={{ color: "#555" }}>
              {state === "COMPLETE" ? "Remove shoes to scan next pair" : "Saving…"}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Resetting flash */}
      <AnimatePresence>
        {state === "RESETTING" && (
          <motion.div
            key="resetting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.5)" }}
          >
            <div className="flex flex-col items-center gap-3">
              <RotateCcw className="w-10 h-10 animate-spin" style={{ color: "#06b6d4" }} />
              <p className="text-white font-semibold text-sm">Resetting…</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Uncalibrated gate — admin must calibrate first */}
      {state === "UNCALIBRATED" && (
        <div className="absolute inset-0 flex items-center justify-center p-8 bg-black">
          <div className="text-center max-w-xs">
            <AlertTriangle className="w-12 h-12 mx-auto mb-3" style={{ color: "#f59e0b" }} />
            <p className="font-bold text-white text-base mb-2">Station not calibrated</p>
            <p className="text-sm mb-5" style={{ color: "#666" }}>
              An admin must perform one-time calibration before workers can use this station.
            </p>
            <button
              onClick={onNeedCalibration}
              className="px-5 py-2.5 rounded-xl text-sm font-bold text-black"
              style={{ background: "linear-gradient(135deg,#06b6d4,#3b82f6)" }}
            >
              Go to Calibration
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
