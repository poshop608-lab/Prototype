import type { HeelMeasurement, ScanResult } from "./types";

export const TOLERANCE_MM = 2.0;

export function compareHeels(
  left:  HeelMeasurement,
  right: HeelMeasurement,
  annotatedDataUrl: string,
): ScanResult {
  const diffMm = parseFloat(Math.abs(left.heightMm - right.heightMm).toFixed(2));
  const passed = diffMm <= TOLERANCE_MM;
  return {
    leftMm:           left.heightMm,
    rightMm:          right.heightMm,
    diffMm,
    passed,
    rejectionReason:  passed ? null : `Difference ${diffMm}mm exceeds ${TOLERANCE_MM}mm tolerance`,
    annotatedDataUrl,
  };
}
