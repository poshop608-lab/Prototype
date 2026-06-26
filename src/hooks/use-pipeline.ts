"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import type {
  PipelineState,
  ShoeDetectionResult,
  StabilityResult,
  InspectionResult,
  CalibrationData,
} from "@/lib/cv/types";
import { extractFrame } from "@/lib/cv/frame";
import { detectShoes } from "@/lib/cv/detector";
import { findHeelSide } from "@/lib/cv/heel-finder";
import { measureHeel } from "@/lib/cv/measure";
import { compareHeels } from "@/lib/cv/compare";
import { drawOverlay } from "@/lib/cv/overlay";

// ─── Stability configuration ──────────────────────────────────────────────────
const STABILITY_FRAMES      = 30;   // ~1s at 30fps
const STABILITY_THRESHOLD   = 10;   // max bbox center displacement in px to count as stable
const DETECTION_SCALE       = 0.5;  // downsample factor for detection loop (speed)
const RESULT_DISPLAY_MS     = 3000; // hold result screen before auto-reset check
const RESET_HOLD_MS         = 1200; // wait after shoes removed before returning to WAITING

export interface PipelineOutput {
  state:      PipelineState;
  detection:  ShoeDetectionResult | null;
  stability:  StabilityResult | null;
  result:     InspectionResult | null;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
}

export function usePipeline(
  videoRef:    React.RefObject<HTMLVideoElement | null>,
  calibration: CalibrationData | null,
  onResult:    (result: InspectionResult) => void,
): PipelineOutput {
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const [state,     setState]     = useState<PipelineState>(
    calibration ? "WAITING" : "UNCALIBRATED"
  );
  const [detection, setDetection] = useState<ShoeDetectionResult | null>(null);
  const [stability, setStability] = useState<StabilityResult | null>(null);
  const [result,    setResult]    = useState<InspectionResult | null>(null);

  // Mutable refs for values used inside rAF (avoids stale closures)
  const stateRef      = useRef<PipelineState>(state);
  const detectionRef  = useRef<ShoeDetectionResult | null>(null);
  const stabilityRef  = useRef<StabilityResult | null>(null);
  const resultRef     = useRef<InspectionResult | null>(null);
  const calibRef      = useRef<CalibrationData | null>(calibration);
  const onResultRef   = useRef(onResult);

  // History ring buffer for stability: [left_cx, left_cy, right_cx, right_cy]
  const historyRef = useRef<Array<[number, number, number, number]>>([]);

  // RAF handle
  const rafRef        = useRef<number>(0);
  const resultTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>);

  // Sync refs
  useEffect(() => { calibRef.current  = calibration;  }, [calibration]);
  useEffect(() => { onResultRef.current = onResult;   }, [onResult]);
  useEffect(() => { stateRef.current  = state;        }, [state]);

  // ── State transition helper ──────────────────────────────────────────────────
  const transition = useCallback((next: PipelineState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // ── Reset stability buffer ───────────────────────────────────────────────────
  const resetStability = useCallback(() => {
    historyRef.current = [];
    const s: StabilityResult = { stable: false, framesRecorded: 0, maxDisplacementPx: 0, progressFraction: 0 };
    stabilityRef.current = s;
    setStability(s);
  }, []);

  // ── Stability update ──────────────────────────────────────────────────────────
  function updateStability(det: ShoeDetectionResult): StabilityResult {
    if (!det.found || !det.left || !det.right) {
      const s: StabilityResult = { stable: false, framesRecorded: 0, maxDisplacementPx: 0, progressFraction: 0 };
      historyRef.current = [];
      return s;
    }
    const lcx = det.left.bbox.x  + det.left.bbox.w  / 2;
    const lcy = det.left.bbox.y  + det.left.bbox.h  / 2;
    const rcx = det.right.bbox.x + det.right.bbox.w / 2;
    const rcy = det.right.bbox.y + det.right.bbox.h / 2;

    historyRef.current.push([lcx, lcy, rcx, rcy]);
    if (historyRef.current.length > STABILITY_FRAMES) historyRef.current.shift();

    const n = historyRef.current.length;
    let maxDisp = 0;
    for (let i = 1; i < n; i++) {
      const [plcx, plcy, prcx, prcy] = historyRef.current[i - 1];
      const [clcx, clcy, crcx, crcy] = historyRef.current[i];
      const dl = Math.hypot(clcx - plcx, clcy - plcy);
      const dr = Math.hypot(crcx - prcx, crcy - prcy);
      if (dl > maxDisp) maxDisp = dl;
      if (dr > maxDisp) maxDisp = dr;
    }

    const stable = n >= STABILITY_FRAMES && maxDisp < STABILITY_THRESHOLD;
    return {
      stable,
      framesRecorded:    n,
      maxDisplacementPx: maxDisp,
      progressFraction:  Math.min(n / STABILITY_FRAMES, 1),
    };
  }

  // ── Measurement ────────────────────────────────────────────────────────────
  async function runMeasurement(): Promise<void> {
    const video = videoRef.current;
    const cal   = calibRef.current;
    const det   = detectionRef.current;
    if (!video || !cal || !det?.found || !det.left || !det.right) {
      transition("WAITING");
      return;
    }

    // Full-resolution frame for measurement accuracy
    const frame = extractFrame(video, 1);
    if (!frame) { transition("WAITING"); return; }

    try {
      const leftRegion  = findHeelSide(frame, det.left.bbox);
      const rightRegion = findHeelSide(frame, det.right.bbox);

      const leftMeasure  = measureHeel(frame, leftRegion.heelBbox,  cal.surfaceY, cal.pxPerMm);
      const rightMeasure = measureHeel(frame, rightRegion.heelBbox, cal.surfaceY, cal.pxPerMm);

      if (!leftMeasure || !rightMeasure) {
        transition("WAITING");
        return;
      }

      const comparison = compareHeels(leftMeasure, rightMeasure);

      // Capture annotated frame as Blob
      let annotatedBlob: Blob | null = null;
      const overlay = overlayRef.current;
      if (overlay) {
        // Draw result annotations before capturing blob
        const insp: InspectionResult = { left: leftMeasure, right: rightMeasure, comparison, annotatedBlob: null };
        drawOverlay(overlay, "RESULT", det, null, insp, cal.surfaceY);
        // Composite video + overlay into a single canvas
        const comp = document.createElement("canvas");
        comp.width  = overlay.width;
        comp.height = overlay.height;
        const ctx = comp.getContext("2d")!;
        ctx.drawImage(video, 0, 0, comp.width, comp.height);
        ctx.drawImage(overlay, 0, 0);
        await new Promise<void>(res => comp.toBlob(blob => { annotatedBlob = blob; res(); }, "image/jpeg", 0.88));
      }

      const inspection: InspectionResult = {
        left:  leftMeasure,
        right: rightMeasure,
        comparison,
        annotatedBlob,
      };

      resultRef.current = inspection;
      setResult(inspection);
      transition("RESULT");

      onResultRef.current(inspection);

      // After display time, move to COMPLETE then check for shoe removal
      clearTimeout(resultTimerRef.current);
      resultTimerRef.current = setTimeout(() => {
        transition("COMPLETE");
        // Start polling for shoe removal (500ms interval, not rAF)
        startRemovalCheck();
      }, RESULT_DISPLAY_MS);

    } catch {
      transition("WAITING");
    }
  }

  // ── Post-result: detect shoe removal ─────────────────────────────────────
  const removalCheckRef = useRef<ReturnType<typeof setInterval>>(0 as unknown as ReturnType<typeof setInterval>);

  function startRemovalCheck(): void {
    clearInterval(removalCheckRef.current);
    removalCheckRef.current = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const frame = extractFrame(video, DETECTION_SCALE);
      if (!frame) return;

      const det = detectShoes(frame);
      if (!det.found) {
        clearInterval(removalCheckRef.current);
        transition("RESETTING");
        setTimeout(() => {
          resultRef.current  = null;
          detectionRef.current = null;
          setResult(null);
          setDetection(null);
          resetStability();
          transition("WAITING");
          restartRaf();
        }, RESET_HOLD_MS);
      }
    }, 500);
  }

  // ── rAF detection loop ────────────────────────────────────────────────────
  function rafLoop(): void {
    const video = videoRef.current;
    const cal   = calibRef.current;
    const s     = stateRef.current;

    if (!video || !cal || s === "RESULT" || s === "COMPLETE" || s === "RESETTING" || s === "UNCALIBRATED") {
      rafRef.current = requestAnimationFrame(rafLoop);
      return;
    }

    const frame = extractFrame(video, DETECTION_SCALE);
    if (!frame) {
      rafRef.current = requestAnimationFrame(rafLoop);
      return;
    }

    // Scale bboxes back to full-resolution coords
    const invScale = 1 / DETECTION_SCALE;
    const rawDet   = detectShoes(frame);
    const det: ShoeDetectionResult = rawDet.found && rawDet.left && rawDet.right
      ? {
          found: true,
          left:  { ...rawDet.left,  bbox: { x: rawDet.left.bbox.x  * invScale, y: rawDet.left.bbox.y  * invScale, w: rawDet.left.bbox.w  * invScale, h: rawDet.left.bbox.h  * invScale } },
          right: { ...rawDet.right, bbox: { x: rawDet.right.bbox.x * invScale, y: rawDet.right.bbox.y * invScale, w: rawDet.right.bbox.w * invScale, h: rawDet.right.bbox.h * invScale } },
        }
      : rawDet;

    detectionRef.current = det;
    setDetection(det);

    const stab = updateStability(det);
    stabilityRef.current = stab;
    setStability(stab);

    // State transitions
    if (!det.found) {
      if (s === "DETECTING") { resetStability(); transition("WAITING"); }
    } else if (s === "WAITING") {
      transition("DETECTING");
    } else if (s === "DETECTING" && stab.stable) {
      transition("MEASURING");
      cancelAnimationFrame(rafRef.current);
      runMeasurement();
      return; // don't restart rAF — runMeasurement will handle transitions
    }

    // Draw overlay
    const overlay = overlayRef.current;
    if (overlay) {
      const fullFrame = extractFrame(video, 1);
      if (fullFrame) {
        overlay.width  = fullFrame.width;
        overlay.height = fullFrame.height;
      }
      drawOverlay(overlay, stateRef.current, det, stab, resultRef.current, cal.surfaceY);
    }

    rafRef.current = requestAnimationFrame(rafLoop);
  }

  function restartRaf(): void {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(rafLoop);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!calibration) {
      transition("UNCALIBRATED");
      return;
    }
    transition("WAITING");
    rafRef.current = requestAnimationFrame(rafLoop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(resultTimerRef.current);
      clearInterval(removalCheckRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calibration?.stationId]); // only restart when calibration identity changes

  return { state, detection, stability, result, overlayRef };
}
