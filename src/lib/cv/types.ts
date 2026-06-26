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

export interface HeelMeasurement {
  topY:      number;  // topmost dark pixel in heel column
  bottomY:   number;  // bottom of shoe bbox
  heightPx:  number;
  heightMm:  number;
  heelBbox:  BBox;
}

export interface ScanResult {
  leftMm:          number;
  rightMm:         number;
  diffMm:          number;
  passed:          boolean;
  rejectionReason: string | null;
  annotatedDataUrl: string;  // base64 jpeg with overlay drawn
}

// Stored in Supabase + localStorage. Set once by admin.
export interface CalibrationData {
  pxPerMm:      number;
  calibratedAt: string;
  stationId:    string;
}
