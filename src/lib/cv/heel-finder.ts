// Determine which end of a shoe bbox is the heel, then build a heelBbox
// that is clamped to not cross splitX — the boundary between the two shoes.
//
// When shoes face inward (heels toward each other), both shoe bboxes overlap
// in X. Without clamping, both heelBboxes land in the same pixel zone and
// measure the same pixels. splitX enforces exclusive pixel ownership:
//   left shoe  → heelBbox.x + heelBbox.w <= splitX
//   right shoe → heelBbox.x              >= splitX

import type { BBox } from "./types";
import { extractForeground } from "./detector";

const STRIP_COUNT = 6;    // divide shoe width into this many strips
const HEEL_FRAC   = 0.40; // heel zone = rear 40% of shoe width (before clamping)
const MIN_HEEL_W  = 20;   // minimum heelBbox width in pixels (post-clamp)

export type HeelSide = "left" | "right";

export interface HeelRegion {
  side:     HeelSide;
  heelBbox: BBox;
}

export function findHeelSide(
  frame:   ImageData,
  shoe:    BBox,
  splitX:  number,
  owner:   "left" | "right",
): HeelRegion {
  const mask = extractForeground(frame, shoe);
  const bw   = shoe.w;
  const bh   = shoe.h;

  // Count foreground pixels per vertical strip
  const stripW       = Math.floor(bw / STRIP_COUNT);
  const fillPerStrip = new Float64Array(STRIP_COUNT);

  for (let s = 0; s < STRIP_COUNT; s++) {
    const sx0 = s * stripW;
    const sx1 = s === STRIP_COUNT - 1 ? bw : sx0 + stripW;
    let total = 0;
    for (let ry = 0; ry < bh; ry++)
      for (let rx = sx0; rx < sx1; rx++)
        total += mask[ry * bw + rx];
    fillPerStrip[s] = total / ((sx1 - sx0) * bh);
  }

  const leftFill  = (fillPerStrip[0] + fillPerStrip[1]) / 2;
  const rightFill = (fillPerStrip[STRIP_COUNT - 2] + fillPerStrip[STRIP_COUNT - 1]) / 2;
  const side: HeelSide = leftFill >= rightFill ? "left" : "right";

  // Build initial heelBbox (40% of shoe width, at the detected heel end)
  const heelW = Math.max(MIN_HEEL_W, Math.round(shoe.w * HEEL_FRAC));
  let heelX   = side === "left" ? shoe.x : shoe.x + shoe.w - heelW;

  // ── Clamp to splitX so this shoe never samples the other shoe's pixels ──
  // left shoe owns  x < splitX  → clamp right edge: heelX + heelW <= splitX
  // right shoe owns x >= splitX → clamp left edge:  heelX          >= splitX
  let clampedW = heelW;
  if (owner === "left") {
    // Right edge of heelBbox must not exceed splitX
    const rightEdge = heelX + heelW;
    if (rightEdge > splitX) {
      clampedW = Math.max(MIN_HEEL_W, splitX - heelX);
    }
  } else {
    // Left edge of heelBbox must not be below splitX
    if (heelX < splitX) {
      const overhang = splitX - heelX;
      heelX    = splitX;
      clampedW = Math.max(MIN_HEEL_W, heelW - overhang);
    }
  }

  // Clamp to shoe bbox bounds as a safety net
  heelX    = Math.max(shoe.x, Math.min(heelX, shoe.x + shoe.w - MIN_HEEL_W));
  clampedW = Math.min(clampedW, shoe.x + shoe.w - heelX);

  return {
    side,
    heelBbox: {
      x: heelX,
      y: shoe.y,
      w: Math.max(MIN_HEEL_W, clampedW),
      h: shoe.h,
    },
  };
}
