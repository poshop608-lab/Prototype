import type { ComparisonResult, HeelMeasurement } from "./types";

export const TOLERANCE_MM = 2.0;

export function compareHeels(left: HeelMeasurement, right: HeelMeasurement): ComparisonResult {
  const diffMm  = parseFloat(Math.abs(left.heightMm - right.heightMm).toFixed(2));
  const passed  = diffMm <= TOLERANCE_MM;
  return {
    leftMm:          left.heightMm,
    rightMm:         right.heightMm,
    diffMm,
    passed,
    rejectionReason: passed ? null : `Heel difference ${diffMm}mm exceeds ${TOLERANCE_MM}mm tolerance`,
  };
}
