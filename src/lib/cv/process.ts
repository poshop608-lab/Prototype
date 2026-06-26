// Single-image processing pipeline.
// Takes one captured ImageData, returns ScanResult or an error string.
// No rAF, no state machine, no stability tracking.

import type { ScanResult } from "./types";
import { detectShoes } from "./detector";
import { findHeelSide } from "./heel-finder";
import { measureHeel } from "./measure";
import { compareHeels } from "./compare";
import { drawResultOverlay } from "./overlay";

export type ProcessError =
  | "NO_SHOES"        // detector found 0 or 1 shoe
  | "MEASURE_FAILED"  // heel measurement returned null
  | "UNKNOWN";

export interface ProcessSuccess {
  ok: true;
  result: ScanResult;
}

export interface ProcessFailure {
  ok: false;
  error: ProcessError;
  message: string;
}

export type ProcessOutcome = ProcessSuccess | ProcessFailure;

export async function processImage(
  frame:    ImageData,
  pxPerMm:  number,
  videoEl:  HTMLVideoElement | null,  // used only for annotation canvas composite
): Promise<ProcessOutcome> {
  // 1. Detect shoes
  const detection = detectShoes(frame);
  if (!detection.found || !detection.left || !detection.right) {
    return {
      ok: false,
      error: "NO_SHOES",
      message: "Could not detect two shoes in the image. Ensure both shoes are fully visible with clear contrast against the background.",
    };
  }

  // 2. Find heel side for each shoe
  const leftRegion  = findHeelSide(frame, detection.left.bbox);
  const rightRegion = findHeelSide(frame, detection.right.bbox);

  // 3. Measure heel height
  const leftM  = measureHeel(frame, leftRegion.heelBbox,  detection.left.bbox,  pxPerMm);
  const rightM = measureHeel(frame, rightRegion.heelBbox, detection.right.bbox, pxPerMm);

  if (!leftM || !rightM) {
    return {
      ok: false,
      error: "MEASURE_FAILED",
      message: "Could not measure heel height. Try repositioning so the heel ends are clearly visible.",
    };
  }

  // 4. Draw annotated result onto an offscreen canvas
  const annotCanvas = document.createElement("canvas");
  annotCanvas.width  = frame.width;
  annotCanvas.height = frame.height;

  // Draw original frame pixels first
  const ctx = annotCanvas.getContext("2d")!;
  ctx.putImageData(frame, 0, 0);

  // Build a preliminary result (annotatedDataUrl filled after)
  const comparison = compareHeels(leftM, rightM, "");

  // Draw overlay on top (pixels already written via putImageData — skip drawImage)
  drawResultOverlay(annotCanvas, null, detection, leftM, rightM, comparison, true);

  const annotatedDataUrl = annotCanvas.toDataURL("image/jpeg", 0.88);

  return {
    ok: true,
    result: { ...comparison, annotatedDataUrl },
  };
}
