// Single-image processing pipeline.
// Detect on downsampled frame (fast), measure + annotate on full-res frame.

import type { BBox, ScanResult } from "./types";
import { detectShoes } from "./detector";
import { findHeelSide } from "./heel-finder";
import { measureHeel } from "./measure";
import { compareHeels } from "./compare";
import { drawResultOverlay } from "./overlay";

export type ProcessError =
  | "NO_SHOES"
  | "MEASURE_FAILED"
  | "UNKNOWN";

export interface ProcessSuccess { ok: true;  result: ScanResult; }
export interface ProcessFailure { ok: false; error: ProcessError; message: string; }
export type ProcessOutcome = ProcessSuccess | ProcessFailure;

// Scale factor for detection: full frame → 640px wide
const DETECT_SCALE = 640;

function scaleBbox(bbox: BBox, sx: number, sy: number): BBox {
  return {
    x: Math.round(bbox.x * sx),
    y: Math.round(bbox.y * sy),
    w: Math.round(bbox.w * sx),
    h: Math.round(bbox.h * sy),
  };
}

export async function processImage(
  fullFrame: ImageData,
  pxPerMm:   number,
  _videoEl:  HTMLVideoElement | null,
): Promise<ProcessOutcome> {
  const fw = fullFrame.width;
  const fh = fullFrame.height;

  // ── 1. Downsample for detection ──────────────────────────────────────────
  const dsScale = Math.min(1, DETECT_SCALE / fw);
  const dsW     = Math.round(fw * dsScale);
  const dsH     = Math.round(fh * dsScale);

  // Draw into offscreen canvas at reduced size
  const dsCanvas = document.createElement("canvas");
  dsCanvas.width  = dsW;
  dsCanvas.height = dsH;
  const dsCtx = dsCanvas.getContext("2d", { willReadFrequently: true })!;

  // Reconstruct ImageBitmap from full-res ImageData to draw scaled
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width  = fw;
  fullCanvas.height = fh;
  fullCanvas.getContext("2d")!.putImageData(fullFrame, 0, 0);
  dsCtx.drawImage(fullCanvas, 0, 0, dsW, dsH);
  const dsFrame = dsCtx.getImageData(0, 0, dsW, dsH);

  // ── 2. Detect on small frame ─────────────────────────────────────────────
  const detection = detectShoes(dsFrame);
  if (!detection.found || !detection.left || !detection.right) {
    return {
      ok: false,
      error: "NO_SHOES",
      message: "Could not detect two shoes. Ensure both shoes are fully visible with clear contrast against the background.",
    };
  }

  // ── 3. Scale bboxes back to full resolution ──────────────────────────────
  const scaleX = fw / dsW;
  const scaleY = fh / dsH;

  const leftDetection  = { ...detection.left,  bbox: scaleBbox(detection.left.bbox,  scaleX, scaleY) };
  const rightDetection = { ...detection.right, bbox: scaleBbox(detection.right.bbox, scaleX, scaleY) };
  // Scale splitX to full resolution — this is the hard boundary between shoes
  const splitX = Math.round(detection.splitX * scaleX);
  const fullDetection  = { found: true, left: leftDetection, right: rightDetection, splitX };

  console.info("[process] frame", fw, "×", fh,
    "| splitX:", splitX,
    "| L bbox x:", leftDetection.bbox.x,  "w:", leftDetection.bbox.w,
    "| R bbox x:", rightDetection.bbox.x, "w:", rightDetection.bbox.w);

  // ── 4. Find heel side + measure on full-res ──────────────────────────────
  // Pass splitX so each shoe's heelBbox is clamped to its own side.
  // This prevents the heelBbox of an inward-facing heel from crossing into
  // the opposite shoe's pixel space.
  const leftRegion  = findHeelSide(fullFrame, leftDetection.bbox,  splitX, "left");
  const rightRegion = findHeelSide(fullFrame, rightDetection.bbox, splitX, "right");

  console.info("[process] L heel side:", leftRegion.side,
    "heelBbox x:", leftRegion.heelBbox.x, "w:", leftRegion.heelBbox.w,
    "| R heel side:", rightRegion.side,
    "heelBbox x:", rightRegion.heelBbox.x, "w:", rightRegion.heelBbox.w);

  const leftM  = measureHeel(fullFrame, leftRegion.heelBbox,  leftDetection.bbox,  pxPerMm);
  const rightM = measureHeel(fullFrame, rightRegion.heelBbox, rightDetection.bbox, pxPerMm);

  if (!leftM || !rightM) {
    return {
      ok: false,
      error: "MEASURE_FAILED",
      message: "Could not measure heel height. Try repositioning so heel ends are clearly visible.",
    };
  }

  // ── 5. Annotate ──────────────────────────────────────────────────────────
  const comparison = compareHeels(leftM, rightM, "");

  // Reuse fullCanvas (already has full-res pixels)
  const annotCtx = fullCanvas.getContext("2d")!;
  annotCtx.putImageData(fullFrame, 0, 0);
  drawResultOverlay(fullCanvas, null, fullDetection, leftM, rightM, comparison, true);

  const annotatedDataUrl = fullCanvas.toDataURL("image/jpeg", 0.85);

  return {
    ok: true,
    result: { ...comparison, annotatedDataUrl },
  };
}
