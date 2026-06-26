"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, Loader2, AlertTriangle, ArrowLeft } from "lucide-react";
import { useCamera } from "@/hooks/use-camera";
import { extractFrame } from "@/lib/cv/frame";
import { processImage } from "@/lib/cv/process";
import { getLocalCalibration, loadCalibration } from "@/lib/calibration";
import { useScanStore } from "@/store/scan";
import type { ScanResult } from "@/lib/cv/types";

const STATION_ID = "station-1";
// Fallback pxPerMm if admin hasn't calibrated (approx 3.5px/mm at ~60cm height).
// Good enough for prototype relative comparison.
const FALLBACK_PX_PER_MM = 3.5;

export default function ScanPage() {
  const router = useRouter();
  const { videoRef, status: camStatus, error: camError } = useCamera();
  const { setCaptured, setConfig } = useScanStore();

  const [processing, setProcessing] = useState(false);
  const [errMsg,     setErrMsg]     = useState<string | null>(null);
  const calibLoadedRef = useRef(false);
  const pxPerMmRef     = useRef<number>(FALLBACK_PX_PER_MM);

  // Load calibration once camera is ready
  const loadCal = useCallback(async () => {
    if (calibLoadedRef.current) return;
    calibLoadedRef.current = true;
    const local = getLocalCalibration();
    if (local) { pxPerMmRef.current = local.pxPerMm; return; }
    const remote = await loadCalibration(STATION_ID);
    if (remote) pxPerMmRef.current = remote.pxPerMm;
  }, []);

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || camStatus !== "ready" || processing) return;

    await loadCal();
    setProcessing(true);
    setErrMsg(null);

    const frame = extractFrame(video, 1);
    if (!frame) {
      setErrMsg("Could not capture frame from camera.");
      setProcessing(false);
      return;
    }

    const outcome = await processImage(frame, pxPerMmRef.current, video);

    if (!outcome.ok) {
      setErrMsg(outcome.message);
      setProcessing(false);
      return;
    }

    // Store result in Zustand, navigate to result screen
    const r: ScanResult = outcome.result;
    setConfig({ batchId: `BATCH-${Date.now()}` });
    setCaptured({
      blob:             new Blob(),          // populated on save
      dataUrl:          r.annotatedDataUrl,
      annotatedDataUrl: r.annotatedDataUrl,
      leftHeightMm:     r.leftMm,
      rightHeightMm:    r.rightMm,
      leftWidthMm:      0,
      rightWidthMm:     0,
      heightDiffMm:     r.diffMm,
      passed:           r.passed,
      rejectionReason:  r.rejectionReason,
    });

    setProcessing(false);
    router.push("/scan/result");
  }, [videoRef, camStatus, processing, loadCal, setCaptured, setConfig, router]);

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: "#080810" }}>

      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 z-10 flex-shrink-0"
        style={{ background: "rgba(8,8,16,0.95)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button
          onClick={() => router.back()}
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ color: "#666", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <p className="text-white text-sm font-semibold" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>
            Shoe Pair Inspection
          </p>
          <p className="text-xs" style={{ color: "#555" }}>
            Position both shoes, then tap Capture
          </p>
        </div>
      </div>

      {/* Camera feed — fills all space */}
      <div className="flex-1 relative overflow-hidden bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline muted autoPlay
        />

        {/* Camera starting */}
        {camStatus === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black">
            <Loader2 className="w-10 h-10 animate-spin" style={{ color: "#06b6d4" }} />
          </div>
        )}

        {/* Camera error */}
        {camStatus === "error" && (
          <div className="absolute inset-0 flex items-center justify-center p-8 bg-black">
            <div className="text-center max-w-xs">
              <AlertTriangle className="w-12 h-12 mx-auto mb-3" style={{ color: "#f59e0b" }} />
              <p className="text-white font-bold mb-2">Camera unavailable</p>
              <p className="text-sm" style={{ color: "#666" }}>{camError}</p>
            </div>
          </div>
        )}

        {/* Framing guide corners */}
        {camStatus === "ready" && !processing && (
          <div className="absolute inset-0 pointer-events-none">
            {([
              ["top-6 left-6", "border-t-2 border-l-2 rounded-tl-lg"],
              ["top-6 right-6", "border-t-2 border-r-2 rounded-tr-lg"],
              ["bottom-24 left-6", "border-b-2 border-l-2 rounded-bl-lg"],
              ["bottom-24 right-6", "border-b-2 border-r-2 rounded-br-lg"],
            ] as [string, string][]).map(([pos, border]) => (
              <div
                key={pos}
                className={`absolute w-8 h-8 ${pos} ${border}`}
                style={{ borderColor: "rgba(6,182,212,0.6)" }}
              />
            ))}
            <p
              className="absolute bottom-28 inset-x-0 text-center text-xs font-semibold"
              style={{ color: "rgba(255,255,255,0.5)" }}
            >
              Place both shoes heels facing centre
            </p>
          </div>
        )}

        {/* Processing overlay */}
        <AnimatePresence>
          {processing && (
            <motion.div
              key="proc"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center gap-4"
              style={{ background: "rgba(0,0,0,0.75)" }}
            >
              <Loader2 className="w-12 h-12 animate-spin" style={{ color: "#06b6d4" }} />
              <p className="text-white font-semibold text-sm">Analysing…</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error toast */}
        <AnimatePresence>
          {errMsg && (
            <motion.div
              key="err"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="absolute bottom-24 inset-x-4 rounded-2xl px-4 py-3 flex items-start gap-3"
              style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)" }}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: "#ef4444" }} />
              <p className="text-sm" style={{ color: "#fca5a5" }}>{errMsg}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Capture button */}
      <div
        className="flex-shrink-0 flex items-center justify-center py-6"
        style={{ background: "rgba(8,8,16,0.95)", borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button
          onClick={handleCapture}
          disabled={camStatus !== "ready" || processing}
          className="w-20 h-20 rounded-full flex items-center justify-center disabled:opacity-40 transition-transform active:scale-95"
          style={{
            background: "linear-gradient(135deg,#06b6d4,#3b82f6)",
            boxShadow: "0 0 32px rgba(6,182,212,0.4)",
          }}
        >
          <Camera className="w-8 h-8 text-black" />
        </button>
      </div>
    </div>
  );
}
