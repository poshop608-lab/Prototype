"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, RotateCcw, Camera, Bug, AlertTriangle } from "lucide-react";
import { compressImage } from "@/lib/utils";
import { loadSAM, isSAMLoaded, encodeImage, decodeMask, gridPrompts } from "@/lib/mobilesam";
import { detectAruco } from "@/lib/aruco";
import type { CaptureResult } from "@/store/scan";

// ── ArUco config ─────────────────────────────────────────────────────────────
// Print Marker ID 0 (DICT_4X4_50) at exactly this size and place in frame.
const ARUCO_REAL_MM = 50;

// Tolerance
const TOLERANCE_MM = 2;

// Heel zone = rear 20% of shoe horizontal span
const HEEL_FRAC = 0.20;

const CYAN    = "#06b6d4";
const GREEN   = "#22c55e";
const RED     = "#ef4444";
const YELLOW  = "#f59e0b";
const MAGENTA = "#e879f9";
const ORANGE  = "#f97316";

interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface Pt { x: number; y: number; }

interface ShoeAnalysis {
  valid: boolean;
  invalidReason?: string;
  mask: Uint8Array;
  bbox: BBox;
  contourPts: Pt[];
  widthPx: number;
  heelBBox: BBox;
  heelTopPt: Pt;
  heelBotPt: Pt;
  heelHeightPx: number;
  heelValid: boolean;
  iouScore: number;
  // Debug: rear-face profile (row Y → outermost X in heel zone)
  rearFaceProfile: { y: number; x: number }[];
  // Debug: was inflection found or did we use fallback?
  inflectionFound: boolean;
}

interface Props {
  onCapture: (result: CaptureResult) => void;
  onError: (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract measurement data from a SAM binary mask
// mask: Uint8Array (1=shoe, 0=bg), w×h = full image dimensions
// halfRange: [fromX, toX] pixel range this shoe occupies
// ─────────────────────────────────────────────────────────────────────────────
function analyzeShoe(
  mask: Uint8Array,
  iouScore: number,
  w: number, h: number,
  fromX: number, toX: number,
): ShoeAnalysis {
  const invalid = (reason: string): ShoeAnalysis => ({
    valid: false, invalidReason: reason,
    mask, bbox: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, contourPts: [],
    widthPx: 0, heelBBox: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    heelTopPt: { x: 0, y: 0 }, heelBotPt: { x: 0, y: 0 },
    heelHeightPx: 0, heelValid: false, iouScore,
    rearFaceProfile: [], inflectionFound: false,
  });

  // Confidence gate
  if (iouScore > 0 && iouScore < 0.6) return invalid(`Low SAM confidence (${iouScore.toFixed(2)})`);

  // ── Step 1: Bounding box from mask pixels only ──────────────────────────
  let minX = toX, maxX = fromX, minY = h, maxY = 0;
  let pixelCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = fromX; x < toX; x++) {
      if (!mask[y * w + x]) continue;
      pixelCount++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (pixelCount === 0) return invalid("No shoe pixels detected");

  const shoeW = maxX - minX, shoeH = maxY - minY;

  if (shoeW < (toX - fromX) * 0.1) return invalid("Shoe too narrow — move camera closer");
  if (shoeH < h * 0.05) return invalid("Shoe too short — check alignment");
  if (minX <= fromX + 2 || maxX >= toX - 2) return invalid("Shoe partially cropped — move camera back");

  // ── Step 2: Per-column contour profiles ────────────────────────────────
  // For each X column, find:
  //   topEdge[x]  = Y of topmost mask pixel  (top silhouette)
  //   botEdge[x]  = Y of bottommost mask pixel (bottom silhouette)
  // These are indexed by absolute x (0..w).
  // Only mask pixels count — background cannot enter these arrays.
  const topEdge = new Int32Array(w).fill(-1);
  const botEdge = new Int32Array(w).fill(-1);

  for (let y = minY; y <= maxY; y++) {
    for (let x = fromX; x < toX; x++) {
      if (!mask[y * w + x]) continue;
      if (topEdge[x] < 0 || y < topEdge[x]) topEdge[x] = y;
      if (botEdge[x] < 0 || y > botEdge[x]) botEdge[x] = y;
    }
  }

  // Row-by-row left/right edges for contour drawing
  const leftEdge: Pt[] = [], rightEdge: Pt[] = [];
  for (let y = minY; y <= maxY; y++) {
    let lx = toX, rx = fromX - 1;
    for (let x = fromX; x < toX; x++) {
      if (mask[y * w + x]) { if (x < lx) lx = x; if (x > rx) rx = x; }
    }
    if (rx >= lx) { leftEdge.push({ x: lx, y }); rightEdge.push({ x: rx, y }); }
  }
  const contourPts: Pt[] = [...leftEdge, ...[...rightEdge].reverse()];
  const bbox: BBox = { minX, maxX, minY, maxY };

  // ── Step 3: Identify heel end ───────────────────────────────────────────
  // The heel has a more vertical rear wall than the toe.
  // Measure how many mask pixels are in the bottom 20% of shoe height
  // at each end (rear 20% of width). Denser side = heel.
  const heelZoneW = Math.round(shoeW * HEEL_FRAC);
  const soleCheckTop = maxY - Math.round(shoeH * 0.20);

  let leftSole = 0, rightSole = 0;
  for (let y = soleCheckTop; y <= maxY; y++) {
    for (let x = minX; x < minX + heelZoneW; x++)
      if (mask[y * w + x]) leftSole++;
    for (let x = maxX - heelZoneW + 1; x <= maxX; x++)
      if (mask[y * w + x]) rightSole++;
  }

  const heelOnLeft = leftSole >= rightSole;
  const hzX0 = heelOnLeft ? minX : maxX - heelZoneW;
  const hzX1 = heelOnLeft ? minX + heelZoneW : maxX;
  const hzMidX = Math.round((hzX0 + hzX1) / 2);

  // ── Step 4: hMaxY — outsole contact line ───────────────────────────────
  // The bottommost mask pixel in the heel X zone, restricted to mask only.
  // botEdge[] already holds bottommost Y per column from mask pixels.
  let hMaxY = -1;
  for (let x = hzX0; x <= hzX1; x++) {
    if (botEdge[x] > hMaxY) hMaxY = botEdge[x];
  }
  if (hMaxY < 0) return invalid("Cannot find outsole in heel zone");

  // ── Step 5: hMinY — heel block top (welt line / insole junction) ────────
  //
  // FUNDAMENTAL INSIGHT: We are NOT measuring the heel collar of the upper.
  // We are measuring the HEEL BLOCK HEIGHT = the outsole + heel stack thickness.
  //
  // On a side-view shoe photo the heel block is visible as a rectangular
  // block at the bottom-rear. Its top edge = where the heel block meets the
  // shoe upper (welt line). This is NOT at the top of the shoe — it is
  // roughly 10–20% of shoe height from the bottom.
  //
  // Detection method: use the REAR-FACE contour of the heel zone.
  // The rear face is the outermost X edge at the heel end:
  //   heelOnLeft  → the LEFT contour edge (leftEdge array, x ≈ minX)
  //   heelOnRight → the RIGHT contour edge (rightEdge array, x ≈ maxX)
  //
  // Scan this rear-face edge from hMaxY UPWARD. The heel block sidewall
  // is nearly vertical (constant X). When the edge X position moves inward
  // by more than INSET_THRESHOLD pixels over a short window, that is the
  // welt/insole junction — the top of the heel block.
  //
  // If the rear edge never inflects (very upright heel), fall back to
  // botEdge-based approach using the bottom-most N% of the shoe height.

  // Build rear-face edge: for each row y in [minY..hMaxY],
  // the outermost X in the heel zone.
  const rearEdgeX: Map<number, number> = new Map();
  for (let y = minY; y <= hMaxY; y++) {
    if (heelOnLeft) {
      // Leftmost mask pixel in heel zone = rear face
      for (let x = hzX0; x <= hzX1; x++) {
        if (mask[y * w + x]) { rearEdgeX.set(y, x); break; }
      }
    } else {
      // Rightmost mask pixel in heel zone = rear face
      for (let x = hzX1; x >= hzX0; x--) {
        if (mask[y * w + x]) { rearEdgeX.set(y, x); break; }
      }
    }
  }

  // Scan upward from hMaxY. Use a sliding window to detect inward inflection.
  // Only search within the bottom 40% of shoe height (heel block can't be
  // taller than 40% of the full shoe).
  const INSET_THRESHOLD = Math.round(shoeW * 0.020); // 2% of shoe width
  const WINDOW = 8;
  const maxSearchY = hMaxY - Math.round(shoeH * 0.40); // don't go above 40% from bottom
  let hMinY = -1;
  let inflectionFound = false;

  // Collect rows with rear edge, bottom-up, limited to search range
  const rows: number[] = [];
  for (let y = hMaxY; y >= Math.max(minY, maxSearchY); y--) {
    if (rearEdgeX.has(y)) rows.push(y);
  }

  // Smooth: rolling average of edge X over WINDOW rows
  function avgEdgeX(rowIdx: number): number {
    let sum = 0, cnt = 0;
    for (let di = -Math.floor(WINDOW / 2); di <= Math.floor(WINDOW / 2); di++) {
      const ri = rowIdx + di;
      if (ri < 0 || ri >= rows.length) continue;
      sum += rearEdgeX.get(rows[ri])!; cnt++;
    }
    return cnt > 0 ? sum / cnt : -1;
  }

  // Scan upward (i increases = moving up from sole)
  for (let i = WINDOW; i < rows.length - WINDOW; i++) {
    const xNear = avgEdgeX(i - WINDOW); // closer to sole (lower)
    const xFar  = avgEdgeX(i);          // higher up
    if (xNear < 0 || xFar < 0) continue;

    // Inward move: heel-on-left → x increases going inward; heel-on-right → x decreases
    const inwardMove = heelOnLeft ? (xFar - xNear) : (xNear - xFar);
    if (inwardMove > INSET_THRESHOLD) {
      hMinY = rows[i];
      inflectionFound = true;
      break;
    }
  }

  // Fallback: 18% of shoe height from bottom (≈50px for 280px-tall shoe at this distance)
  if (hMinY < 0) {
    hMinY = hMaxY - Math.round(shoeH * 0.18);
  }

  // Hard clamp: heel block max 35% of shoe height, min 3%
  hMinY = Math.max(hMinY, hMaxY - Math.round(shoeH * 0.35));
  hMinY = Math.min(hMinY, hMaxY - Math.round(shoeH * 0.03));

  // ── Step 6: Validate ────────────────────────────────────────────────────
  const heelHeightPx = hMaxY - hMinY;

  // Physical validation: 10mm–80mm for formal shoes
  // Without ArUco we use px range: at ~3.5px/mm → 35–280px
  // With ArUco these will be converted to mm and checked later
  const heelValid = heelHeightPx > 20 && heelHeightPx < 500; // px sanity only here

  const heelTopPt: Pt = { x: hzMidX, y: hMinY };
  const heelBotPt: Pt = { x: hzMidX, y: hMaxY };
  const heelBBox:  BBox = { minX: hzX0, maxX: hzX1, minY: hMinY, maxY: hMaxY };

  // Build rear-face profile for debug drawing (every 3rd row to reduce points)
  const rearFaceProfile: { y: number; x: number }[] = [];
  for (let y = hMaxY; y >= Math.max(minY, maxSearchY); y -= 3) {
    const x = rearEdgeX.get(y);
    if (x !== undefined) rearFaceProfile.push({ y, x });
  }

  return {
    valid: true,
    mask, bbox, contourPts,
    widthPx: shoeW,
    heelBBox, heelTopPt, heelBotPt, heelHeightPx, heelValid,
    iouScore, rearFaceProfile, inflectionFound,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Draw annotated overlay onto the capture canvas
// ─────────────────────────────────────────────────────────────────────────────
function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  vw: number, vh: number,
  left: ShoeAnalysis, right: ShoeAnalysis,
  arucoPxPerMm: number | null,
  debugMode: boolean,
): { leftHMm: number; rightHMm: number; leftWMm: number; rightWMm: number; diff: number; passed: boolean; scanInvalid: boolean; invalidReason: string } {
  const pxPerMm = arucoPxPerMm ?? 3.5; // fallback only — not recommended
  const fs = Math.max(16, Math.round(vw * 0.016));

  function pill(text: string, cx: number, cy: number, bg: string, fg: string) {
    ctx.font = `bold ${fs}px -apple-system,sans-serif`;
    const tw = ctx.measureText(text).width;
    const ph = fs + 10, pw = tw + 20, r = ph / 2;
    const px = cx - pw / 2, py = cy - ph / 2;
    ctx.beginPath();
    ctx.moveTo(px + r, py); ctx.arcTo(px + pw, py, px + pw, py + ph, r);
    ctx.arcTo(px + pw, py + ph, px, py + ph, r); ctx.arcTo(px, py + ph, px, py, r);
    ctx.arcTo(px, py, px + pw, py, r); ctx.closePath();
    ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy); ctx.textBaseline = "alphabetic";
  }

  function refLine(y: number, x0: number, x1: number, color: string) {
    const ext = Math.round(vw * 0.010);
    const tickH = Math.round(vw * 0.012);
    const lw = Math.max(3, vw * 0.0028);
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(x0 - ext, y); ctx.lineTo(x1 + ext, y); ctx.stroke();
    ctx.lineWidth = lw * 0.7;
    ctx.beginPath(); ctx.moveTo(x0 - ext, y - tickH/2); ctx.lineTo(x0 - ext, y + tickH/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1 + ext, y - tickH/2); ctx.lineTo(x1 + ext, y + tickH/2); ctx.stroke();
    ctx.shadowBlur = 0;
  }

  let leftHMm = 0, rightHMm = 0, leftWMm = 0, rightWMm = 0;
  const invalidReasons: string[] = [];

  function drawShoe(sa: ShoeAnalysis, label: string) {
    if (!sa.valid) {
      invalidReasons.push(`${label}: ${sa.invalidReason}`);
      return 0;
    }

    const { bbox, contourPts, heelBBox, heelTopPt, heelBotPt, heelHeightPx, widthPx, heelValid } = sa;
    const { minX, minY, maxX, maxY } = bbox;
    const midX = (minX + maxX) / 2;
    const lw = Math.max(2, vw * 0.0018);

    // ── SAM mask tint (green pixels only where mask=1) ────────────────────
    // Draw a semi-transparent green overlay exactly on shoe pixels
    const offscreen = document.createElement("canvas");
    offscreen.width = vw; offscreen.height = vh;
    const oCtx = offscreen.getContext("2d")!;
    const imgD = oCtx.createImageData(vw, vh);
    const maskColor = [34, 197, 94]; // green
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!sa.mask[y * vw + x]) continue;
        const di = (y * vw + x) * 4;
        imgD.data[di]   = maskColor[0];
        imgD.data[di+1] = maskColor[1];
        imgD.data[di+2] = maskColor[2];
        imgD.data[di+3] = 45; // ~18% opacity tint
      }
    }
    oCtx.putImageData(imgD, 0, 0);
    ctx.drawImage(offscreen, 0, 0);

    // ── Contour outline ──────────────────────────────────────────────────
    if (contourPts.length > 2) {
      ctx.beginPath();
      contourPts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.strokeStyle = GREEN; ctx.lineWidth = Math.max(2, vw * 0.002);
      ctx.shadowColor = GREEN; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
    }

    // ── Heel zone highlight ──────────────────────────────────────────────
    const hz = heelBBox;
    ctx.fillStyle = heelValid ? `${YELLOW}25` : `${RED}25`;
    ctx.fillRect(hz.minX, hz.minY, hz.maxX - hz.minX, hz.maxY - hz.minY);
    ctx.strokeStyle = heelValid ? `${YELLOW}90` : `${RED}90`;
    ctx.lineWidth = lw; ctx.setLineDash([4, 4]);
    ctx.strokeRect(hz.minX, hz.minY, hz.maxX - hz.minX, hz.maxY - hz.minY);
    ctx.setLineDash([]);

    // ── Reference lines (heel collar top + outsole bottom) ───────────────
    const topY = heelTopPt.y, botY = heelBotPt.y;
    refLine(topY, hz.minX, hz.maxX, CYAN);
    refLine(botY, hz.minX, hz.maxX, GREEN);

    // ── Vertical arrow (right of heel zone) ──────────────────────────────
    const arrowX = hz.maxX + Math.round(vw * 0.015);
    const ah = Math.round(vw * 0.008);
    const alw = Math.max(2, vw * 0.002);
    ctx.strokeStyle = YELLOW; ctx.lineWidth = alw;
    ctx.shadowColor = YELLOW; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(arrowX, topY); ctx.lineTo(arrowX, botY); ctx.stroke();
    [[topY, 1], [botY, -1]].forEach(([y, dir]) => {
      ctx.beginPath();
      ctx.moveTo(arrowX - ah * 0.6, (y as number) + (dir as number) * ah);
      ctx.lineTo(arrowX, y as number);
      ctx.lineTo(arrowX + ah * 0.6, (y as number) + (dir as number) * ah);
      ctx.stroke();
    });
    ctx.shadowBlur = 0;

    // ── Measurements ─────────────────────────────────────────────────────
    const hMm = parseFloat((heelHeightPx / pxPerMm).toFixed(1));
    const wMm = parseFloat((widthPx / pxPerMm).toFixed(1));
    const heelMidY = (topY + botY) / 2;

    // Physical mm validation (10–80mm for formal shoe heel block)
    const hMmValid = heelValid && hMm >= 10 && hMm <= 80;

    const hPillX = Math.min(arrowX + fs * 2.4, vw - fs * 2.5);
    if (hMmValid) {
      pill(`H ${hMm}mm`, hPillX, heelMidY, "rgba(0,0,0,0.9)", YELLOW);
    } else {
      pill(`H ${hMm}mm ✗`, hPillX, heelMidY, "rgba(0,0,0,0.9)", RED);
      invalidReasons.push(`${label}: Heel ${hMm}mm out of range (10–80mm)`);
    }

    pill(`W ${wMm}mm`, midX, Math.max(minY - fs * 1.1, fs * 1.1), "rgba(0,0,0,0.9)", CYAN);
    pill(label, midX, Math.min(maxY + fs * 1.2, vh - fs * 0.9), `${GREEN}dd`, "#000");

    // ── Debug extras ──────────────────────────────────────────────────────
    if (debugMode) {
      const DOT = Math.max(9, vw * 0.007);

      // Draw rear-face profile polyline (orange) — the contour we actually scanned
      if (sa.rearFaceProfile.length > 1) {
        ctx.strokeStyle = ORANGE; ctx.lineWidth = 3; ctx.shadowColor = ORANGE; ctx.shadowBlur = 6;
        ctx.beginPath();
        sa.rearFaceProfile.forEach((pt, i) => {
          if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke(); ctx.shadowBlur = 0;
      }

      // MAGENTA dot = heel block top (welt line / inflection point)
      ctx.fillStyle = MAGENTA; ctx.shadowColor = MAGENTA; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(heelTopPt.x, topY, DOT, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // Label the magenta dot
      ctx.font = `bold ${fs * 0.75}px monospace`; ctx.fillStyle = MAGENTA; ctx.textAlign = "left";
      ctx.fillText(sa.inflectionFound ? "▲ WELT (detected)" : "▲ WELT (fallback)", heelTopPt.x + DOT + 4, topY + 4);

      // CYAN dot = outsole contact (hMaxY) — ground contact point
      ctx.fillStyle = CYAN; ctx.shadowColor = CYAN; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(heelBotPt.x, botY, DOT, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = CYAN;
      ctx.fillText("▼ OUTSOLE", heelBotPt.x + DOT + 4, botY + 4);

      // Raw pixel pill
      pill(`${heelHeightPx}px | ${hMm}mm`, (hz.minX + hz.maxX) / 2, heelMidY, "rgba(0,0,0,0.92)", MAGENTA);

      // Shoe full height for reference
      pill(`fullH:${maxY - minY}px=${((maxY - minY) / pxPerMm).toFixed(0)}mm`, midX, minY + (maxY - minY) * 0.5, "rgba(0,0,0,0.7)", ORANGE);

      // IoU score
      pill(`IoU:${sa.iouScore.toFixed(2)}`, midX, minY - fs * 1.5, "rgba(0,0,0,0.7)", ORANGE);

      // Heel zone vertical span (dashed magenta rectangle)
      ctx.strokeStyle = MAGENTA; ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]);
      ctx.strokeRect(hz.minX, minY, hz.maxX - hz.minX, maxY - minY);
      ctx.setLineDash([]);
    }

    return hMmValid ? hMm : 0;
  }

  leftHMm  = drawShoe(left, "LEFT");
  rightHMm = drawShoe(right, "RIGHT");
  leftWMm  = left.valid  ? parseFloat((left.widthPx  / pxPerMm).toFixed(1)) : 0;
  rightWMm = right.valid ? parseFloat((right.widthPx / pxPerMm).toFixed(1)) : 0;

  // ── Centre divider ────────────────────────────────────────────────────
  ctx.strokeStyle = `${CYAN}55`; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(vw / 2, 0); ctx.lineTo(vw / 2, vh); ctx.stroke();
  ctx.setLineDash([]);

  // ── ArUco marker indicator ────────────────────────────────────────────
  if (arucoPxPerMm) {
    pill(`ArUco ✓ ${arucoPxPerMm.toFixed(2)}px/mm`, vw - fs * 7, fs * 1.6, "rgba(0,80,0,0.85)", GREEN);
  } else {
    // Warning only — allow scan with fallback px/mm so dev can verify heel geometry
    pill(`px/mm≈3.5 (no ArUco)`, vw - fs * 7, fs * 1.6, "rgba(100,60,0,0.85)", YELLOW);
  }

  const scanInvalid = invalidReasons.length > 0;
  const diff = scanInvalid ? 0 : parseFloat(Math.abs(leftHMm - rightHMm).toFixed(1));
  const passed = !scanInvalid && diff <= TOLERANCE_MM;

  // ── Result banner ─────────────────────────────────────────────────────
  const bh = Math.round(vh * 0.075);
  ctx.fillStyle = scanInvalid ? `${YELLOW}ee` : passed ? `${GREEN}ee` : `${RED}ee`;
  ctx.fillRect(0, vh - bh, vw, bh);
  ctx.font = `bold ${Math.round(vw * 0.02)}px -apple-system,sans-serif`;
  ctx.fillStyle = scanInvalid ? "#000" : "#fff";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (scanInvalid) {
    ctx.fillText(`⚠ INVALID — ${invalidReasons[0]} · Retake`, vw / 2, vh - bh / 2);
  } else {
    ctx.fillText(
      passed ? `✓ PASSED  Δ${diff}mm` : `✗ REJECTED  Δ${diff}mm  (limit ${TOLERANCE_MM}mm)`,
      vw / 2, vh - bh / 2
    );
  }
  ctx.textBaseline = "alphabetic";

  // ── Debug stamp ───────────────────────────────────────────────────────
  const stamp = debugMode
    ? `SAM HEEL | L:${left.heelHeightPx}px=${leftHMm}mm IoU=${left.iouScore.toFixed(2)} | R:${right.heelHeightPx}px=${rightHMm}mm IoU=${right.iouScore.toFixed(2)} | px/mm=${pxPerMm.toFixed(2)}`
    : `SAM | L:${leftHMm}mm R:${rightHMm}mm`;
  ctx.font = "11px monospace"; ctx.textAlign = "left";
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(4, 4, ctx.measureText(stamp).width + 10, 18);
  ctx.fillStyle = debugMode ? YELLOW : GREEN;
  ctx.fillText(stamp, 9, 17);

  return { leftHMm, rightHMm, leftWMm, rightWMm, diff, passed, scanInvalid, invalidReason: invalidReasons[0] ?? "" };
}

// ─────────────────────────────────────────────────────────────────────────────
export function CameraView({ onCapture, onError }: Props) {
  const videoRef       = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef      = useRef<MediaStream | null>(null);

  const [isReady,     setIsReady]     = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeStep, setAnalyzeStep] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);
  const [isPortrait,  setIsPortrait]  = useState(false);
  const [debugMode,   setDebugMode]   = useState(false);
  const [samStatus,   setSamStatus]   = useState<"idle"|"loading"|"ready"|"error">("idle");

  // Load SAM on mount
  useEffect(() => {
    setSamStatus("loading");
    loadSAM()
      .then(() => setSamStatus("ready"))
      .catch((e) => { console.error("SAM load failed:", e); setSamStatus("error"); });
  }, []);

  useEffect(() => {
    function check() { setIsPortrait(window.innerHeight > window.innerWidth); }
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => { window.removeEventListener("resize", check); window.removeEventListener("orientationchange", check); };
  }, []);

  useEffect(() => {
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await new Promise<void>((res) => { video.onloadedmetadata = () => res(); });
        await video.play().catch(() => {});
        setIsReady(true);
      } catch {
        onError("Camera access denied. Allow camera permissions and reload.");
      }
    }
    startCamera();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [onError]);

  const handleCapture = useCallback(async () => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;
    if (!isSAMLoaded()) { onError("AI model still loading — please wait"); return; }

    setIsCapturing(true);
    setIsAnalyzing(true);
    setAnalyzeStep("Capturing frame…");

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    canvas.width = vw; canvas.height = vh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, vw, vh);

    await new Promise(r => setTimeout(r, 20));

    try {
      // ── Step 1: ArUco marker detection ────────────────────────────────
      setAnalyzeStep("Detecting calibration marker…");
      const imageData = ctx.getImageData(0, 0, vw, vh);
      const aruco = detectAruco(imageData, ARUCO_REAL_MM);

      if (debugMode && aruco.found) {
        // Draw marker corners
        const [tl, tr, br, bl] = aruco.cornersPx;
        ctx.strokeStyle = ORANGE; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(tl[0], tl[1]); ctx.lineTo(tr[0], tr[1]);
        ctx.lineTo(br[0], br[1]); ctx.lineTo(bl[0], bl[1]);
        ctx.closePath(); ctx.stroke();
      }

      // ── Step 2: Encode image with SAM ────────────────────────────────
      setAnalyzeStep("AI encoding image…");
      const embedding = await encodeImage(canvas);

      // ── Step 3: Decode masks for each shoe half ───────────────────────
      const mid = Math.floor(vw / 2);

      // Generate grid prompts for each half
      // Focus on middle 60% of height where shoe body is
      const topY  = Math.round(vh * 0.20);
      const botY  = Math.round(vh * 0.85);
      const zoneH = botY - topY;

      setAnalyzeStep("Segmenting left shoe…");
      const leftPrompts  = gridPrompts(0,   mid,  topY, zoneH, vw, vh, 3);
      const rightPrompts = gridPrompts(mid, mid,  topY, zoneH, vw, vh, 3);

      // Run SAM for each half — try all prompt points, pick best mask
      async function bestMask(prompts: [number, number][]) {
        let bestScore = -1;
        let bestMaskResult = await decodeMask(embedding, [prompts[0]], [1], vw, vh);
        for (let i = 1; i < prompts.length; i++) {
          const result = await decodeMask(embedding, [prompts[i]], [1], vw, vh);
          if (result.iouScore > bestScore) {
            bestScore = result.iouScore;
            bestMaskResult = result;
          }
        }
        return bestMaskResult;
      }

      const [leftMask, rightMask] = await Promise.all([
        bestMask(leftPrompts),
        bestMask(rightPrompts),
      ]);

      // ── Step 4: Analyze each shoe mask ───────────────────────────────
      setAnalyzeStep("Measuring heel heights…");
      const leftAnalysis  = analyzeShoe(leftMask.mask,  leftMask.iouScore,  vw, vh, 0,   mid);
      const rightAnalysis = analyzeShoe(rightMask.mask, rightMask.iouScore, vw, vh, mid, vw);

      // ── Step 5: Draw annotations ──────────────────────────────────────
      // Redraw original frame first (annotations go on top)
      ctx.drawImage(video, 0, 0, vw, vh);
      const measurements = drawAnnotations(
        ctx, vw, vh,
        leftAnalysis, rightAnalysis,
        aruco.found ? aruco.pxPerMm : null,
        debugMode,
      );

      setIsAnalyzing(false);

      const blob = await compressImage(canvas, 0.9);
      const annotatedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      if ("vibrate" in navigator) {
        navigator.vibrate(measurements.scanInvalid ? [100,50,100,50,100] : [60, 30, 60]);
      }

      onCapture({
        blob, dataUrl: annotatedDataUrl, annotatedDataUrl,
        leftHeightMm:  measurements.leftHMm,
        rightHeightMm: measurements.rightHMm,
        leftWidthMm:   measurements.leftWMm,
        rightWidthMm:  measurements.rightWMm,
        heightDiffMm:  measurements.diff,
        passed:        measurements.passed,
        rejectionReason: measurements.scanInvalid
          ? `Invalid scan: ${measurements.invalidReason}`
          : measurements.passed ? null
          : `Heel height difference ${measurements.diff}mm exceeds ${TOLERANCE_MM}mm tolerance`,
      });

      setShowSuccess(true);
      setTimeout(() => { setShowSuccess(false); setIsCapturing(false); }, 1500);
    } catch (e) {
      setIsAnalyzing(false);
      setIsCapturing(false);
      onError(`Analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [isCapturing, isAnalyzing, debugMode, onCapture, onError]);

  if (isPortrait) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center px-8">
          <RotateCcw className="w-14 h-14 mx-auto mb-4" style={{ color: CYAN, animation: "spin 3s linear infinite" }} />
          <p className="text-white font-bold text-lg mb-2">Rotate your phone</p>
          <p className="text-sm" style={{ color: "#888" }}>Hold horizontally to scan both shoes</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
      <canvas ref={captureCanvasRef} className="hidden" />

      {/* SAM loading banner */}
      {samStatus === "loading" && (
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center gap-2 py-2"
          style={{ background: "rgba(6,182,212,0.15)", borderBottom: `1px solid ${CYAN}40` }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: CYAN }} />
          <span className="text-xs font-semibold" style={{ color: CYAN }}>Loading AI model…</span>
        </div>
      )}
      {samStatus === "error" && (
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center gap-2 py-2"
          style={{ background: "rgba(239,68,68,0.15)", borderBottom: `1px solid ${RED}40` }}>
          <AlertTriangle className="w-3.5 h-3.5" style={{ color: RED }} />
          <span className="text-xs font-semibold" style={{ color: RED }}>AI model failed to load</span>
        </div>
      )}

      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "#080810" }}>
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: CYAN }} />
        </div>
      )}

      <AnimatePresence>
        {isAnalyzing && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-30"
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
          >
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold mb-1" style={{ color: CYAN }}>{analyzeStep}</p>
            <p className="text-xs" style={{ color: "#666" }}>MobileSAM · ArUco calibration</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Guide overlay */}
      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 bottom-0 left-1/2 w-px opacity-40"
            style={{ background: `repeating-linear-gradient(to bottom,${CYAN} 0,${CYAN} 8px,transparent 8px,transparent 16px)` }} />
          <div className="absolute left-4 top-1/2 -translate-y-1/2">
            <div className="px-3 py-1 rounded-full text-xs font-bold"
              style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>LEFT SHOE</div>
          </div>
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="px-3 py-1 rounded-full text-xs font-bold"
              style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>RIGHT SHOE</div>
          </div>
          <div className="absolute top-8 left-8 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute top-8 right-8 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 left-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 right-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
        </div>
      )}

      {isReady && !isCapturing && (
        <div className="absolute top-10 left-1/2 -translate-x-1/2 z-10">
          <div className="px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap"
            style={{ background: "rgba(0,0,0,0.75)", border: `1px solid ${CYAN}40`, color: "#ccc" }}>
            Place ArUco marker in frame · one shoe each side · tap capture
          </div>
        </div>
      )}

      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center z-20"
            style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }}
          >
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 1.2, opacity: 0 }}
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{ background: "rgba(34,197,94,0.2)", border: `2px solid ${GREEN}`, boxShadow: `0 0 32px ${GREEN}80` }}
            >
              <CheckCircle2 className="w-10 h-10" style={{ color: GREEN }} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-between px-6 pb-6 pt-3"
        style={{ background: "linear-gradient(to top,rgba(0,0,0,0.8) 0%,transparent 100%)" }}>
        <button
          onClick={() => setDebugMode(d => !d)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
          style={{
            background: debugMode ? `${YELLOW}30` : "rgba(0,0,0,0.5)",
            border: `1px solid ${debugMode ? YELLOW : "rgba(255,255,255,0.15)"}`,
            color: debugMode ? YELLOW : "rgba(255,255,255,0.4)",
          }}
        >
          <Bug className="w-3.5 h-3.5" />
          {debugMode ? "Debug ON" : "Debug"}
        </button>

        <div className="flex flex-col items-center gap-1">
          <button
            onClick={handleCapture}
            disabled={!isReady || isCapturing || isAnalyzing || samStatus !== "ready"}
            className="relative w-20 h-20 rounded-full flex items-center justify-center transition-transform active:scale-90 disabled:opacity-40"
            style={{ border: "4px solid rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.15)", backdropFilter: "blur(4px)" }}
          >
            {samStatus === "loading"
              ? <Loader2 className="w-8 h-8 text-white animate-spin" />
              : <Camera className="w-8 h-8 text-white" />
            }
            {(isCapturing || isAnalyzing) && (
              <div className="absolute inset-0 rounded-full border-4 border-cyan-400 animate-ping" />
            )}
          </button>
          <span className="text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.45)" }}>
            {samStatus === "loading" ? "loading AI…"
              : isAnalyzing ? analyzeStep
              : isCapturing ? "processing…"
              : "tap to capture"}
          </span>
        </div>

        <div className="w-16" />
      </div>
    </div>
  );
}
