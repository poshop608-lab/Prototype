// ─── Shared CV types ─────────────────────────────────────────────────────────

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedShoe {
  bbox:       BBox;
  confidence: number;
}

export interface ShoeDetectionResult {
  found: boolean;
  left:  DetectedShoe | null;
  right: DetectedShoe | null;
}

export interface StabilityResult {
  stable:             boolean;
  framesRecorded:     number;
  maxDisplacementPx:  number;
  progressFraction:   number;
}

export interface ForegroundMask {
  data:   Uint8Array;
  width:  number;
  height: number;
}

export interface HeelMeasurement {
  topY:       number;   // px: topmost foreground pixel in heel column
  bottomY:    number;   // px: bottom of shoe bbox (outsole baseline)
  heightPx:   number;   // bottomY - topY
  heightMm:   number;   // approximate mm (from frame-width heuristic, ±10mm)
  heelBbox:   BBox;
  confidence: number;
}

export interface ComparisonResult {
  leftMm:          number;
  rightMm:         number;
  diffPercent:     number;   // |left - right| / avg × 100 — drives pass/fail
  passed:          boolean;
  rejectionReason: string | null;
}

export interface InspectionResult {
  left:          HeelMeasurement;
  right:         HeelMeasurement;
  comparison:    ComparisonResult;
  annotatedBlob: Blob | null;
}

// ─── Detector interface (abstract — YOLO drops in here later) ─────────────────
export interface ShoeDetector {
  detect(frame: ImageData): ShoeDetectionResult;
}

// ─── Pipeline state machine ───────────────────────────────────────────────────
export type PipelineState =
  | "WAITING"      // no shoes present
  | "DETECTING"    // shoes found, stability accumulating
  | "STABLE"       // stability threshold met
  | "MEASURING"    // measurement in progress
  | "RESULT"       // PASS/REJECT displayed
  | "COMPLETE"     // save done
  | "RESETTING";   // shoes removed, animating out
