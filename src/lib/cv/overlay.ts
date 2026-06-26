// Canvas overlay renderer — purely visual, zero business logic.
// Draws annotations on top of the live video canvas for each pipeline state.

import type {
  BBox,
  ShoeDetectionResult,
  StabilityResult,
  InspectionResult,
  PipelineState,
} from "./types";
import { TOLERANCE_MM } from "./compare";

const C = {
  cyan:    "#06b6d4",
  green:   "#22c55e",
  red:     "#ef4444",
  yellow:  "#f59e0b",
  white:   "#ffffff",
  black:   "#000000",
};

function pill(
  ctx:  CanvasRenderingContext2D,
  text: string,
  cx:   number,
  cy:   number,
  bg:   string,
  fg:   string,
  size: number,
): void {
  ctx.font = `bold ${size}px -apple-system,sans-serif`;
  const tw = ctx.measureText(text).width;
  const ph = size + 10, pw = tw + 20, r = ph / 2;
  const px = cx - pw / 2, py = cy - ph / 2;
  ctx.beginPath();
  ctx.moveTo(px + r, py);
  ctx.arcTo(px + pw, py,     px + pw, py + ph, r);
  ctx.arcTo(px + pw, py + ph, px,     py + ph, r);
  ctx.arcTo(px,      py + ph, px,     py,      r);
  ctx.arcTo(px,      py,      px + pw, py,     r);
  ctx.closePath();
  ctx.fillStyle = bg; ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}

function refLine(
  ctx:   CanvasRenderingContext2D,
  y:     number,
  x0:    number,
  x1:    number,
  color: string,
  lw    = 2,
): void {
  const ext = 12, tick = 10;
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.shadowColor = color; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.moveTo(x0 - ext, y); ctx.lineTo(x1 + ext, y); ctx.stroke();
  ctx.lineWidth = lw * 0.6;
  for (const tx of [x0 - ext, x1 + ext]) {
    ctx.beginPath(); ctx.moveTo(tx, y - tick / 2); ctx.lineTo(tx, y + tick / 2); ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

function drawBbox(
  ctx:   CanvasRenderingContext2D,
  bbox:  BBox,
  color: string,
  lw    = 2,
): void {
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);
  ctx.setLineDash([]);
}

function drawStabilityRing(
  ctx:      CanvasRenderingContext2D,
  cx:       number,
  cy:       number,
  r:        number,
  fraction: number,
): void {
  // Background ring
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth   = 4;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  // Progress arc
  ctx.strokeStyle = C.cyan;
  ctx.lineWidth   = 4;
  ctx.shadowColor = C.cyan; ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ─── Public draw function ─────────────────────────────────────────────────────

export function drawOverlay(
  canvas:    HTMLCanvasElement,
  state:     PipelineState,
  detection: ShoeDetectionResult | null,
  stability: StabilityResult | null,
  result:    InspectionResult  | null,
  surfaceY:  number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const fs = Math.max(13, Math.round(w * 0.014));

  // ── Surface line (always visible when calibrated) ──────────────────────────
  if (surfaceY > 0 && state !== "UNCALIBRATED") {
    ctx.strokeStyle = "rgba(6,182,212,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(0, surfaceY); ctx.lineTo(w, surfaceY); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Shoe bounding boxes ────────────────────────────────────────────────────
  if (detection?.found && (state === "DETECTING" || state === "STABLE" || state === "MEASURING")) {
    const boxColor = state === "STABLE" ? C.green : C.cyan;
    if (detection.left)  drawBbox(ctx, detection.left.bbox,  boxColor, 2);
    if (detection.right) drawBbox(ctx, detection.right.bbox, boxColor, 2);
  }

  // ── Stability ring (shown during DETECTING) ────────────────────────────────
  if (state === "DETECTING" && stability && detection?.found) {
    for (const shoe of [detection.left, detection.right]) {
      if (!shoe) continue;
      const cx = shoe.bbox.x + shoe.bbox.w / 2;
      const cy = shoe.bbox.y - 24;
      drawStabilityRing(ctx, cx, cy, 16, stability.progressFraction);
    }
  }

  // ── Result annotations ─────────────────────────────────────────────────────
  if (result && (state === "RESULT" || state === "COMPLETE")) {
    const { left, right, comparison } = result;
    const passed      = comparison.passed;
    const resultColor = passed ? C.green : C.red;

    // Left heel annotation
    if (left) {
      const hb = left.heelBbox;
      // Heel zone highlight
      ctx.fillStyle = `${C.cyan}18`;
      ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
      // Top reference line (top of heel collar)
      refLine(ctx, left.topY, hb.x, hb.x + hb.w, C.cyan, 2);
      // Bottom reference line (surface)
      refLine(ctx, left.surfaceY, hb.x, hb.x + hb.w, C.green, 2);
      // Measurement arrow
      const ax = hb.x - 20;
      ctx.strokeStyle = C.yellow; ctx.lineWidth = 2;
      ctx.shadowColor = C.yellow; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.moveTo(ax, left.topY); ctx.lineTo(ax, left.surfaceY); ctx.stroke();
      ctx.shadowBlur = 0;
      // Mm label
      const midY = (left.topY + left.surfaceY) / 2;
      pill(ctx, `L ${left.heightMm}mm`, hb.x + hb.w / 2, midY, "rgba(0,0,0,0.88)", C.yellow, fs);
    }

    // Right heel annotation
    if (right) {
      const hb = right.heelBbox;
      ctx.fillStyle = `${C.cyan}18`;
      ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
      refLine(ctx, right.topY,    hb.x, hb.x + hb.w, C.cyan,  2);
      refLine(ctx, right.surfaceY, hb.x, hb.x + hb.w, C.green, 2);
      const ax = hb.x + hb.w + 20;
      ctx.strokeStyle = C.yellow; ctx.lineWidth = 2;
      ctx.shadowColor = C.yellow; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.moveTo(ax, right.topY); ctx.lineTo(ax, right.surfaceY); ctx.stroke();
      ctx.shadowBlur = 0;
      const midY = (right.topY + right.surfaceY) / 2;
      pill(ctx, `R ${right.heightMm}mm`, hb.x + hb.w / 2, midY, "rgba(0,0,0,0.88)", C.yellow, fs);
    }

    // Result banner
    const bh2 = Math.round(h * 0.09);
    ctx.fillStyle = `${resultColor}ee`;
    ctx.fillRect(0, h - bh2, w, bh2);
    ctx.font = `bold ${Math.round(w * 0.022)}px -apple-system,sans-serif`;
    ctx.fillStyle = C.white;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const bannerText = passed
      ? `✓ PASS  Δ${comparison.diffMm}mm ≤ ${TOLERANCE_MM}mm`
      : `✗ REJECT  Δ${comparison.diffMm}mm > ${TOLERANCE_MM}mm`;
    ctx.fillText(bannerText, w / 2, h - bh2 / 2);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }

  // ── Waiting guide ──────────────────────────────────────────────────────────
  if (state === "WAITING") {
    // Framing corners
    const corner = 36, pad = 24;
    ctx.strokeStyle = `${C.cyan}70`; ctx.lineWidth = 2;
    for (const [ox, oy, sx, sy] of [
      [pad,     pad,     1,  1],
      [w - pad, pad,     -1,  1],
      [pad,     h - pad, 1, -1],
      [w - pad, h - pad, -1, -1],
    ] as [number, number, number, number][]) {
      ctx.beginPath();
      ctx.moveTo(ox + sx * corner, oy);
      ctx.lineTo(ox, oy);
      ctx.lineTo(ox, oy + sy * corner);
      ctx.stroke();
    }
  }
}
