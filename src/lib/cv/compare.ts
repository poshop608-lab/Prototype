import type { ComparisonResult, HeelMeasurement } from "./types";

// Tolerance: heel heights must be within this % of each other to PASS.
// 5% on a 100px heel = 5px difference allowed.
export const TOLERANCE_PERCENT = 5.0;

export function compareHeels(
  left:  HeelMeasurement,
  right: HeelMeasurement,
): ComparisonResult {
  const avg         = (left.heightPx + right.heightPx) / 2;
  const diffPx      = Math.abs(left.heightPx - right.heightPx);
  const diffPercent = parseFloat(((diffPx / avg) * 100).toFixed(1));
  const passed      = diffPercent <= TOLERANCE_PERCENT;

  return {
    leftMm:          left.heightMm,
    rightMm:         right.heightMm,
    diffPercent,
    passed,
    rejectionReason: passed
      ? null
      : `Heel height difference ${diffPercent}% exceeds ${TOLERANCE_PERCENT}% tolerance`,
  };
}
