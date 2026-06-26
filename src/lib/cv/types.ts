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

export interface HeelMeasurement {
  topY:      number;   // px: topmost foreground pixel in heel column
  bottomY:   number;   // px: bottom of shoe bbox
  heightPx:  number;   // bottomY - topY
  heightMm:  number;   // real mm via pxPerMm calibration
  heelBbox:  BBox;
  confidence: number;
}

export interface ComparisonResult {
  leftMm:          number;
  rightMm:         number;
  diffMm:          number;   // |leftMm - rightMm| — drives pass/fail
  passed:          boolean;
  rejectionReason: string | null;
}

export interface InspectionResult {
  left:          HeelMeasurement;
  right:         HeelMeasurement;
  comparison:    ComparisonResult;
  annotatedBlob: Blob | null;
}

// Stored in Supabase + localStorage. Set once by admin at installation.
export interface CalibrationData {
  pxPerMm:      number;
  calibratedAt: string;
  stationId:    string;
}

export interface ShoeDetector {
  detect(frame: ImageData): ShoeDetectionResult;
}

export type PipelineState =
  | "UNCALIBRATED"
  | "WAITING"
  | "DETECTING"
  | "STABLE"
  | "MEASURING"
  | "RESULT"
  | "COMPLETE"
  | "RESETTING";
