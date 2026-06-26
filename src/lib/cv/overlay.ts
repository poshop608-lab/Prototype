// Draws result annotations on a canvas over a captured image.
// Called once after measurement — not in a rAF loop.

import type { BBox, HeelMeasurement, ScanResult, ShoeDetectionResult } from "./types";
import { TOLERANCE_MM } from "./compare";

const C = { cyan:"#06b6d4", green:"#22c55e", red:"#ef4444", yellow:"#f59e0b", white:"#ffffff" };

function pill(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, bg: string, fg: string, size: number) {
  ctx.font = `bold ${size}px -apple-system,sans-serif`;
  const tw = ctx.measureText(text).width;
  const ph = size+10, pw = tw+20, r = ph/2;
  const px = cx-pw/2, py = cy-ph/2;
  ctx.beginPath();
  ctx.moveTo(px+r,py); ctx.arcTo(px+pw,py,px+pw,py+ph,r); ctx.arcTo(px+pw,py+ph,px,py+ph,r);
  ctx.arcTo(px,py+ph,px,py,r); ctx.arcTo(px,py,px+pw,py,r); ctx.closePath();
  ctx.fillStyle=bg; ctx.fill();
  ctx.fillStyle=fg; ctx.textAlign="center"; ctx.textBaseline="middle";
  ctx.fillText(text,cx,cy);
  ctx.textAlign="left"; ctx.textBaseline="alphabetic";
}

function hLine(ctx: CanvasRenderingContext2D, y: number, x0: number, x1: number, color: string) {
  ctx.strokeStyle=color; ctx.lineWidth=2;
  ctx.shadowColor=color; ctx.shadowBlur=6;
  ctx.setLineDash([8,4]);
  ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x1,y); ctx.stroke();
  ctx.setLineDash([]); ctx.shadowBlur=0;
}

function drawBbox(ctx: CanvasRenderingContext2D, bbox: BBox, color: string) {
  ctx.strokeStyle=color; ctx.lineWidth=2; ctx.setLineDash([6,4]);
  ctx.strokeRect(bbox.x,bbox.y,bbox.w,bbox.h); ctx.setLineDash([]);
}

// Draw heel annotation for one shoe
function drawHeel(ctx: CanvasRenderingContext2D, m: HeelMeasurement, side: "left"|"right", passed: boolean) {
  const hb  = m.heelBbox;
  const col = passed ? C.green : C.red;
  const fs  = Math.max(12, Math.round(hb.w * 0.18));

  // Heel zone highlight
  ctx.fillStyle = `${C.cyan}22`;
  ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
  drawBbox(ctx, hb, C.cyan);

  // Top line (heel collar) and bottom line (outsole)
  hLine(ctx, m.topY,    hb.x, hb.x+hb.w, C.cyan);
  hLine(ctx, m.bottomY, hb.x, hb.x+hb.w, C.green);

  // Arrow
  const ax = side === "left" ? hb.x - 18 : hb.x + hb.w + 18;
  ctx.strokeStyle=C.yellow; ctx.lineWidth=2;
  ctx.shadowColor=C.yellow; ctx.shadowBlur=5;
  ctx.beginPath(); ctx.moveTo(ax, m.topY); ctx.lineTo(ax, m.bottomY); ctx.stroke();
  ctx.shadowBlur=0;

  // Arrowheads
  for (const [y, dir] of [[m.topY, -1], [m.bottomY, 1]] as [number, number][]) {
    ctx.beginPath();
    ctx.moveTo(ax, y);
    ctx.lineTo(ax-5, y+dir*8);
    ctx.lineTo(ax+5, y+dir*8);
    ctx.closePath(); ctx.fillStyle=C.yellow; ctx.fill();
  }

  // Label
  const midY = (m.topY + m.bottomY) / 2;
  const label = `${side === "left" ? "L" : "R"} ${m.heightMm}mm`;
  pill(ctx, label, hb.x+hb.w/2, midY, "rgba(0,0,0,0.85)", col, fs);
}

// When skipDraw=true the caller has already written pixels; skip resize+drawImage.
export function drawResultOverlay(
  canvas:    HTMLCanvasElement,
  image:     HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | null,
  detection: ShoeDetectionResult,
  left:      HeelMeasurement,
  right:     HeelMeasurement,
  result:    ScanResult,
  skipDraw = false,
): void {
  if (!skipDraw && image) {
    canvas.width  = (image as HTMLVideoElement).videoWidth  || (image as HTMLImageElement).naturalWidth  || (image as HTMLCanvasElement).width;
    canvas.height = (image as HTMLVideoElement).videoHeight || (image as HTMLImageElement).naturalHeight || (image as HTMLCanvasElement).height;
    const ctx2 = canvas.getContext("2d");
    if (!ctx2) return;
    ctx2.clearRect(0, 0, canvas.width, canvas.height);
    ctx2.drawImage(image, 0, 0, canvas.width, canvas.height);
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width, h = canvas.height;

  // Shoe bboxes
  if (detection.left)  drawBbox(ctx, detection.left.bbox,  C.cyan);
  if (detection.right) drawBbox(ctx, detection.right.bbox, C.cyan);

  // Heel annotations
  drawHeel(ctx, left,  "left",  result.passed);
  drawHeel(ctx, right, "right", result.passed);

  // Result banner at top
  const resultColor = result.passed ? C.green : C.red;
  const bh = Math.round(h * 0.10);
  ctx.fillStyle = `${resultColor}dd`;
  ctx.fillRect(0, 0, w, bh);
  ctx.font = `bold ${Math.round(w * 0.038)}px 'Space Grotesk',-apple-system,sans-serif`;
  ctx.fillStyle = C.white;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const label = result.passed
    ? `✓ PASS  L${result.leftMm}mm  R${result.rightMm}mm  Δ${result.diffMm}mm`
    : `✗ FAIL  L${result.leftMm}mm  R${result.rightMm}mm  Δ${result.diffMm}mm > ${TOLERANCE_MM}mm`;
  ctx.fillText(label, w/2, bh/2);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}
