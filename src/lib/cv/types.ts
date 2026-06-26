// ─── Shared CV types ─────────────────────────────────────────────────────────
// All modules in lib/cv/* depend only on these types.
// The detector interface is abstract so YOLO can replace the deterministic
// implementation without changing any downstream module.

export interface BBox {
  x: number;   // left edge in pixels (full-resolution frame coords)
  y: number;   // top edge in pixels
  w: number;   // width in pixels
  h: number;   // height in pixels
}

export interface DetectedShoe {
  bbox: BBox;
  confidence: number;   // 0–1; deterministic detector always returns 1.0
}

// Two shoes, sorted left-to-right by x-center.
export interface ShoeDetectionResult {
  found: boolean;
  left:  DetectedShoe | null;
  right: DetectedShoe | null;
}

// Stability tracker output
export interface StabilityResult {
  stable:              boolean;
  framesRecorded:      number;   // 0 – STABILITY_FRAMES
  maxDisplacementPx:   number;
  progressFraction:    number;   // 0.0–1.0 for UI ring
}

// Foreground mask for a single shoe region
export interface ForegroundMask {
  data:   Uint8Array;   // 1 = foreground, 0 = background; same size as input frame
  width:  number;
  height: number;
}

export interface HeelMeasurement {
  topY:        number;   // px: topmost foreground pixel in heel column (heel collar top)
  surfaceY:    number;   // px: calibrated surface line (constant per installation)
  heightPx:    number;   // surfaceY - topY
  heightMm:    number;   // heightPx / pxPerMm
  heelBbox:    BBox;     // the narrow column that was actually measured
  confidence:  number;   // 0–1: consistency of column heights (low spread = high)
}

export interface ComparisonResult {
  leftMm:          number;
  rightMm:         number;
  diffMm:          number;
  passed:          boolean;
  rejectionReason: string | null;
}

export interface InspectionResult {
  left:           HeelMeasurement;
  right:          HeelMeasurement;
  comparison:     ComparisonResult;
  annotatedBlob:  Blob | null;
}

// Calibration stored in Supabase + mirrored to localStorage as a fast cache
export interface CalibrationData {
  pxPerMm:       number;
  surfaceY:      number;   // calibrated surface line Y in frame pixels
  frameWidth:    number;   // camera resolution at calibration time
  frameHeight:   number;
  calibratedAt:  string;   // ISO timestamp
  stationId:     string;   // e.g. "station-1"
}

// ─── Detector interface (abstract — swap implementation without changing callers) ─
export interface ShoeDetector {
  detect(frame: ImageData): ShoeDetectionResult;
}

// ─── Pipeline state machine ───────────────────────────────────────────────────
export type PipelineState =
  | "UNCALIBRATED"   // no calibration found
  | "WAITING"        // calibrated, no shoes present
  | "DETECTING"      // shoes found, stability accumulating
  | "STABLE"         // stability threshold met → trigger measurement
  | "MEASURING"      // heel measurement in progress (<10ms)
  | "RESULT"         // PASS/REJECT displayed, auto-save running
  | "COMPLETE"       // save done, brief confirmation
  | "RESETTING";     // shoes removed, animating out
