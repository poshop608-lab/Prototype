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

const STATION_ID    = "station-1";
const FALLBACK_PXMM = 3.5;

export default function ScanPage() {
  const router = useRouter();
  const { videoRef, status: camStatus, error: camError } = useCamera();
  const { setCaptured, setConfig } = useScanStore();

  const [processing, setProcessing] = useState(false);
  const [errMsg,     setErrMsg]     = useState<string | null>(null);
  const calibLoadedRef = useRef(false);
  const pxPerMmRef     = useRef<number>(FALLBACK_PXMM);

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

    const r: ScanResult = outcome.result;
    setConfig({ batchId: `BATCH-${Date.now()}` });
    setCaptured({
      blob:             new Blob(),
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
    /*
     * fixed + inset-0 escapes the dashboard layout's padding/max-width wrapper.
     * 100dvh = dynamic viewport height (accounts for Safari address bar).
     */
    <div
      className="fixed inset-0 z-50"
      style={{ background: "#000", height: "100dvh" }}
    >
      {/* ── Full-screen video ─────────────────────────────────────────────── */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full"
        style={{ objectFit: "cover" }}
        playsInline
        muted
        autoPlay
      />

      {/* ── Loading state ─────────────────────────────────────────────────── */}
      {camStatus === "starting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black">
          <Loader2 className="w-10 h-10 animate-spin" style={{ color: "#06b6d4" }} />
          <p className="text-sm font-medium" style={{ color: "#555" }}>Starting camera…</p>
        </div>
      )}

      {/* ── Camera error ──────────────────────────────────────────────────── */}
      {camStatus === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-8 bg-black">
          <div className="text-center max-w-xs">
            <AlertTriangle className="w-12 h-12 mx-auto mb-3" style={{ color: "#f59e0b" }} />
            <p className="text-white font-bold mb-2">Camera unavailable</p>
            <p className="text-sm" style={{ color: "#666" }}>{camError}</p>
          </div>
        </div>
      )}

      {/* ── Overlay UI (header + guides + button) — all on top of video ──── */}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}>

        {/* Header bar — semi-transparent, floats over video */}
        <div
          className="pointer-events-auto flex items-center gap-3 px-4"
          style={{
            paddingTop: "env(safe-area-inset-top, 12px)",
            paddingBottom: "12px",
            background: "linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)",
          }}
        >
          <button
            onClick={() => router.back()}
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{
              background: "rgba(0,0,0,0.45)",
              border: "1px solid rgba(255,255,255,0.15)",
              backdropFilter: "blur(8px)",
              color: "#fff",
            }}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1">
            <p className="text-white text-sm font-semibold leading-tight" style={{ fontFamily: "'Space Grotesk',sans-serif", textShadow: "0 1px 4px rgba(0,0,0,0.8)" }}>
              Shoe Pair Inspection
            </p>
            <p className="text-xs leading-tight" style={{ color: "rgba(255,255,255,0.55)", textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
              Position both shoes, then tap Capture
            </p>
          </div>
        </div>

        {/* Framing guides — only when camera ready and not processing */}
        {camStatus === "ready" && !processing && (
          <>
            {/* Corner brackets */}
            {([
              { pos: { top: "20%",    left:  "6%" }, t:true,  l:true,  r:false, b:false },
              { pos: { top: "20%",    right: "6%" }, t:true,  l:false, r:true,  b:false },
              { pos: { bottom: "28%", left:  "6%" }, t:false, l:true,  r:false, b:true  },
              { pos: { bottom: "28%", right: "6%" }, t:false, l:false, r:true,  b:true  },
            ]).map(({ pos, t, l, r, b }, i) => (
              <div
                key={i}
                className="absolute w-8 h-8"
                style={{
                  ...pos,
                  borderTopWidth:    t ? "2px" : 0,
                  borderLeftWidth:   l ? "2px" : 0,
                  borderRightWidth:  r ? "2px" : 0,
                  borderBottomWidth: b ? "2px" : 0,
                  borderStyle: "solid",
                  borderColor: "rgba(6,182,212,0.8)",
                  borderRadius: "2px",
                }}
              />
            ))}

            {/* Centre vertical dashed guide */}
            <div
              className="absolute"
              style={{
                left: "50%",
                top: "20%",
                bottom: "28%",
                width: "1px",
                transform: "translateX(-0.5px)",
                background: "repeating-linear-gradient(to bottom, rgba(6,182,212,0.5) 0px, rgba(6,182,212,0.5) 6px, transparent 6px, transparent 12px)",
              }}
            />

            {/* Instruction label */}
            <div
              className="absolute inset-x-0 flex justify-center"
              style={{ bottom: "calc(28% + 16px)" }}
            >
              <span
                className="px-3 py-1.5 rounded-full text-xs font-semibold"
                style={{
                  background: "rgba(0,0,0,0.55)",
                  color: "rgba(255,255,255,0.8)",
                  backdropFilter: "blur(6px)",
                  border: "1px solid rgba(255,255,255,0.1)",
                }}
              >
                Place both shoes with heels facing each other
              </span>
            </div>
          </>
        )}

        {/* Processing overlay */}
        <AnimatePresence>
          {processing && (
            <motion.div
              key="proc"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center gap-4 pointer-events-auto"
              style={{ background: "rgba(0,0,0,0.72)" }}
            >
              <Loader2 className="w-14 h-14 animate-spin" style={{ color: "#06b6d4" }} />
              <p className="text-white font-semibold">Analysing…</p>
              <p className="text-xs" style={{ color: "#555" }}>This takes 1–2 seconds</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error toast */}
        <AnimatePresence>
          {errMsg && (
            <motion.div
              key="err"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              className="absolute inset-x-4 rounded-2xl px-4 py-3 flex items-start gap-3 pointer-events-auto"
              style={{
                bottom: "calc(env(safe-area-inset-bottom, 0px) + 130px)",
                background: "rgba(239,68,68,0.15)",
                border: "1px solid rgba(239,68,68,0.4)",
                backdropFilter: "blur(8px)",
              }}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: "#ef4444" }} />
              <p className="text-sm" style={{ color: "#fca5a5" }}>{errMsg}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Capture button — floats at bottom centre like native camera */}
        <div
          className="absolute inset-x-0 flex flex-col items-center gap-3 pointer-events-auto"
          style={{
            bottom: "calc(env(safe-area-inset-bottom, 16px) + 24px)",
            background: "linear-gradient(to top, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0) 100%)",
            paddingTop: "40px",
            paddingBottom: "8px",
          }}
        >
          <button
            onClick={handleCapture}
            disabled={camStatus !== "ready" || processing}
            aria-label="Capture"
            className="disabled:opacity-40 active:scale-95 transition-transform"
            style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {/* Outer ring — mimics iOS camera button */}
            <span
              className="flex items-center justify-center rounded-full"
              style={{
                width: 80,
                height: 80,
                border: "3px solid rgba(255,255,255,0.85)",
                padding: 4,
              }}
            >
              {/* Inner filled circle */}
              <span
                className="flex items-center justify-center rounded-full"
                style={{
                  width: "100%",
                  height: "100%",
                  background: processing
                    ? "rgba(255,255,255,0.3)"
                    : "rgba(255,255,255,0.95)",
                  boxShadow: "0 0 20px rgba(255,255,255,0.3)",
                }}
              >
                {!processing && <Camera className="w-7 h-7" style={{ color: "#111" }} />}
              </span>
            </span>
          </button>
          <p className="text-xs font-medium" style={{ color: "rgba(255,255,255,0.45)" }}>
            Tap to capture
          </p>
        </div>
      </div>
    </div>
  );
}
