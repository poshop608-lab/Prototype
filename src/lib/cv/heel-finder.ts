// Determine which end of a shoe bbox is the heel.
// Method: geometric column-fill comparison — color-independent.
//
// The heel block is physically taller than the toe end on all shoe types
// (sneakers, dress shoes, boots). Dividing the bbox into vertical strips and
// counting foreground pixels per strip reliably identifies the heel end.

import type { BBox } from "./types";
import { extractForeground } from "./detector";

const STRIP_COUNT = 6;    // divide shoe width into this many strips
const HEEL_FRAC   = 0.40; // heel measurement zone = rear 40% of shoe width

export type HeelSide = "left" | "right";

export interface HeelRegion {
  side:     HeelSide;
  heelBbox: BBox;       // narrow column at the heel end (HEEL_FRAC of shoe width)
}

export function findHeelSide(
  frame: ImageData,
  shoe:  BBox,
): HeelRegion {
  const mask = extractForeground(frame, shoe);
  const bw   = shoe.w;
  const bh   = shoe.h;

  // Count foreground pixels per vertical strip
  const stripW   = Math.floor(bw / STRIP_COUNT);
  const fillPerStrip = new Float64Array(STRIP_COUNT);

  for (let s = 0; s < STRIP_COUNT; s++) {
    const sx0 = s * stripW;
    const sx1 = s === STRIP_COUNT - 1 ? bw : sx0 + stripW;
    let total = 0;
    for (let ry = 0; ry < bh; ry++) {
      for (let rx = sx0; rx < sx1; rx++) {
        total += mask[ry * bw + rx];
      }
    }
    // Normalize by strip area so different strip widths compare fairly
    fillPerStrip[s] = total / ((sx1 - sx0) * bh);
  }

  // Average fill: left 2 strips vs right 2 strips
  const leftFill  = (fillPerStrip[0] + fillPerStrip[1]) / 2;
  const rightFill = (fillPerStrip[STRIP_COUNT - 2] + fillPerStrip[STRIP_COUNT - 1]) / 2;

  const side: HeelSide = leftFill >= rightFill ? "left" : "right";

  // Build the heel measurement bbox
  const heelW = Math.max(1, Math.round(shoe.w * HEEL_FRAC));
  const heelX = side === "left"
    ? shoe.x
    : shoe.x + shoe.w - heelW;

  return {
    side,
    heelBbox: {
      x: heelX,
      y: shoe.y,
      w: heelW,
      h: shoe.h,
    },
  };
}
