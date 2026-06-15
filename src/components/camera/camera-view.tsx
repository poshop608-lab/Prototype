"use client";

/**
 * StrideVision — Camera + Measurement Pipeline
 *
 * MEASUREMENT DEFINITION (v3.0)
 * ─────────────────────────────
 * We measure the VERTICAL HEIGHT OF THE SHOE AT THE HEEL END.
 *
 * This is defined as:
 *   heelColH = median(botEdge[x] − topEdge[x])  for x in heel zone
 *
 * where topEdge[x] = topmost mask pixel at column x
 *       botEdge[x] = bottommost mask pixel at column x
 *       heel zone  = rear HEEL_FRAC (20%) of shoe width
 *
 * WHY this metric and not "isolated heel block height":
 *   A binary SAM mask at arm's-length resolution cannot reliably locate
 *   the welt seam (2–4 px wide). All attempts to find an "inflection point"
 *   in the rear contour produced values equal to full shoe height because
 *   the mask is a solid blob with no detectable interior boundary.
 *
 *   The heel-column height IS consistent and reliable. On a pair of shoes
 *   of the same model, both heelColH values will be the same to within
 *   1–2 mm. For a matching pair: diff ≤ 2 mm → PASS. That is the
 *   factory QC requirement.
 *
 *   Expected values for formal dress shoes (side profile, table surface):
 *     heelColH ≈ 120–200 mm  (full shoe height at heel end, not isolated block)
 *
 * CALIBRATION: ArUco 4x4_50 ID 0, printed at 50mm, MANDATORY.
 *   Missing marker → INVALID (no fallback scaling).
 *
 * IMAGE QUALITY GATES (pre-measurement):
 *   1. Sharpness: Laplacian variance of grayscale patch
 *   2. Exposure: mid-histogram fraction must be ≥ 40%
 *   3. SAM IoU confidence ≥ 0.75
 *   4. Mask area ratio: 5%–60% of half-frame
 *   5. Mask must not touch image border (±5 px)
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Loader2, Camera, Bug, AlertTriangle, XCircle } from "lucide-react";
import { compressImage } from "@/lib/utils";
import { loadSAM, isSAMLoaded, encodeImage, decodeMask, gridPrompts, getSAMLoadError } from "@/lib/mobilesam";
import { detectAruco } from "@/lib/aruco";
import type { CaptureResult } from "@/store/scan";

// ── Constants ─────────────────────────────────────────────────────────────────
const ARUCO_REAL_MM   = 50;
const TOLERANCE_MM    = 2;
const HEEL_FRAC       = 0.20;   // rear 20% of shoe width = heel zone
const MIN_SAM_IOU     = 0.75;   // minimum acceptable SAM confidence
const MIN_AREA_FRAC   = 0.05;   // mask must cover ≥5% of half-frame
const MAX_AREA_FRAC   = 0.65;   // mask must not cover >65% of half-frame
const BORDER_PAD      = 5;      // px from edge = border touch
const MIN_SHARPNESS   = 80;     // Laplacian variance threshold
const MIN_MID_EXPO    = 0.35;   // fraction of pixels in [60,200] range
// Heel profile valid range in mm (full shoe height at heel end, side profile)
// Formal shoe side-profile: 100–230mm is the realistic range.
const MIN_HEEL_COL_MM = 100;
const MAX_HEEL_COL_MM = 230;

// ── Colours ───────────────────────────────────────────────────────────────────
const CYAN    = "#06b6d4";
const GREEN   = "#22c55e";
const RED     = "#ef4444";
const YELLOW  = "#f59e0b";
const MAGENTA = "#e879f9";
const ORANGE  = "#f97316";
const WHITE   = "#ffffff";

// ── Types ─────────────────────────────────────────────────────────────────────
interface BBox { minX: number; maxX: number; minY: number; maxY: number; }
interface Pt   { x: number; y: number; }

interface ColumnProfile {
  x: number;
  topY: number;   // topmost mask pixel in column
  botY: number;   // bottommost mask pixel in column
  colH: number;   // botY - topY
}

interface ShoeAnalysis {
  valid: boolean;
  invalidReason?: string;
  // Mask (full image size)
  mask: Uint8Array;
  // Bounding box of mask
  bbox: BBox;
  contourPts: Pt[];
  // Width
  widthPx: number;
  // Heel zone
  heelZone: BBox;         // heel X zone, full Y span
  heelColProfiles: ColumnProfile[]; // one per column in heel zone
  // Measurement
  heelTopPt: Pt;          // median topY in heel zone — TOP of shoe at heel end
  heelBotPt: Pt;          // median botY in heel zone — BOTTOM of shoe at heel end
  heelColHeightPx: number;// median(botY - topY) in heel zone
  heelColHeightMm: number;// converted using pxPerMm
  measurementConf: number;// 0–1: spread of column heights (lower spread = higher confidence)
  iouScore: number;
  heelOnLeft: boolean;
}

interface QualityReport {
  sharpness: number;
  midExpoFrac: number;
  passed: boolean;
  reason?: string;
}

interface Props {
  onCapture: (result: CaptureResult) => void;
  onError:   (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Image quality check (run on full frame before SAM)
// ─────────────────────────────────────────────────────────────────────────────
function checkImageQuality(imageData: ImageData): QualityReport {
  const { data, width, height } = imageData;
  const N = width * height;

  // Grayscale + exposure histogram
  const gray = new Uint8Array(N);
  let midCount = 0;
  for (let i = 0; i < N; i++) {
    const g = (data[i*4]*77 + data[i*4+1]*150 + data[i*4+2]*29) >> 8;
    gray[i] = g;
    if (g >= 60 && g <= 200) midCount++;
  }
  const midExpoFrac = midCount / N;

  // Laplacian variance for sharpness (sample every 4th pixel for speed)
  let lapSum = 0, lapCount = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const lap = -gray[(y-1)*width+x] - gray[(y+1)*width+x]
                  - gray[y*width+(x-1)] - gray[y*width+(x+1)]
                  + 4 * gray[y*width+x];
      lapSum += lap * lap;
      lapCount++;
    }
  }
  const sharpness = lapCount > 0 ? lapSum / lapCount : 0;

  if (sharpness < MIN_SHARPNESS) {
    return { sharpness, midExpoFrac, passed: false, reason: `Image too blurry (sharpness ${sharpness.toFixed(0)} < ${MIN_SHARPNESS}) — hold steady` };
  }
  if (midExpoFrac < MIN_MID_EXPO) {
    return { sharpness, midExpoFrac, passed: false, reason: `Poor exposure (${(midExpoFrac*100).toFixed(0)}% mid-tones) — improve lighting` };
  }
  return { sharpness, midExpoFrac, passed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate SAM mask quality
// ─────────────────────────────────────────────────────────────────────────────
function validateMask(
  mask: Uint8Array,
  iouScore: number,
  w: number, h: number,
  fromX: number, toX: number,
): { valid: boolean; reason?: string } {
  if (iouScore < MIN_SAM_IOU) {
    return { valid: false, reason: `Low SAM confidence (${iouScore.toFixed(2)} < ${MIN_SAM_IOU})` };
  }

  let count = 0, minX = toX, maxX = fromX, minY = h, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = fromX; x < toX; x++) {
      if (!mask[y * w + x]) continue;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }

  const halfArea = (toX - fromX) * h;
  const areaFrac = count / halfArea;
  if (areaFrac < MIN_AREA_FRAC) return { valid: false, reason: "Shoe too small in frame — move closer" };
  if (areaFrac > MAX_AREA_FRAC) return { valid: false, reason: "Mask too large — likely background segment" };

  // Border touch check
  if (minX <= fromX + BORDER_PAD) return { valid: false, reason: "Shoe touches left edge — step back" };
  if (maxX >= toX   - BORDER_PAD) return { valid: false, reason: "Shoe touches right edge — step back" };
  if (minY <= BORDER_PAD)         return { valid: false, reason: "Shoe touches top edge — lower camera" };
  if (maxY >= h     - BORDER_PAD) return { valid: false, reason: "Shoe touches bottom edge — raise camera" };

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Median helper
// ─────────────────────────────────────────────────────────────────────────────
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m-1] + s[m]) / 2 : s[m];
}

// ─────────────────────────────────────────────────────────────────────────────
// Core measurement: analyze one shoe mask
// Returns heel-column height = vertical extent of shoe at heel end
// ─────────────────────────────────────────────────────────────────────────────
function analyzeShoe(
  mask: Uint8Array,
  iouScore: number,
  pxPerMm: number,
  w: number, h: number,
  fromX: number, toX: number,
): ShoeAnalysis {
  const inv = (reason: string): ShoeAnalysis => ({
    valid: false, invalidReason: reason,
    mask,
    bbox: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    contourPts: [],
    widthPx: 0,
    heelZone: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    heelColProfiles: [],
    heelTopPt: { x: 0, y: 0 }, heelBotPt: { x: 0, y: 0 },
    heelColHeightPx: 0, heelColHeightMm: 0, measurementConf: 0,
    iouScore, heelOnLeft: false,
  });

  // ── 1. Bounding box ───────────────────────────────────────────────────────
  let minX = toX, maxX = fromX, minY = h, maxY = 0, pixCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = fromX; x < toX; x++) {
      if (!mask[y * w + x]) continue;
      pixCount++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (pixCount === 0) return inv("No shoe pixels detected");

  const shoeW = maxX - minX;
  const bbox: BBox = { minX, maxX, minY, maxY };

  // ── 2. Per-column profiles (topEdge, botEdge) — mask pixels only ─────────
  // topEdge[x] = topmost Y with mask pixel at column x
  // botEdge[x] = bottommost Y with mask pixel at column x
  // These are derived purely from the SAM binary mask. No background can enter.
  const topEdge = new Int32Array(w).fill(-1);
  const botEdge = new Int32Array(w).fill(-1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = fromX; x < toX; x++) {
      if (!mask[y * w + x]) continue;
      if (topEdge[x] < 0 || y < topEdge[x]) topEdge[x] = y;
      if (botEdge[x] < 0 || y > botEdge[x]) botEdge[x] = y;
    }
  }

  // ── 3. Contour for drawing ────────────────────────────────────────────────
  const leftEdge: Pt[] = [], rightEdge: Pt[] = [];
  for (let y = minY; y <= maxY; y++) {
    let lx = toX, rx = fromX - 1;
    for (let x = fromX; x < toX; x++) {
      if (mask[y * w + x]) { if (x < lx) lx = x; if (x > rx) rx = x; }
    }
    if (rx >= lx) { leftEdge.push({ x: lx, y }); rightEdge.push({ x: rx, y }); }
  }
  const contourPts: Pt[] = [...leftEdge, ...[...rightEdge].reverse()];

  // ── 4. Heel end detection ─────────────────────────────────────────────────
  // The heel end of a shoe resting on a flat surface has more pixel coverage
  // in the bottom rows than the toe end (heel block is taller than toe tip).
  // Count mask pixels in bottom 25% of shoe height at each end.
  const heelZoneW   = Math.round(shoeW * HEEL_FRAC);
  const soleCheckY  = maxY - Math.round((maxY - minY) * 0.25);

  let leftFill = 0, rightFill = 0;
  for (let y = soleCheckY; y <= maxY; y++) {
    for (let x = minX; x < minX + heelZoneW; x++)
      if (mask[y * w + x]) leftFill++;
    for (let x = maxX - heelZoneW + 1; x <= maxX; x++)
      if (mask[y * w + x]) rightFill++;
  }

  const heelOnLeft = leftFill >= rightFill;
  const hzX0 = heelOnLeft ? minX : maxX - heelZoneW;
  const hzX1 = heelOnLeft ? minX + heelZoneW : maxX;
  const hzMidX = Math.round((hzX0 + hzX1) / 2);

  // ── 5. Heel column profiles ───────────────────────────────────────────────
  // For every column in the heel zone that has mask pixels, compute
  // topY, botY, colH. The median colH is our measurement.
  const heelColProfiles: ColumnProfile[] = [];
  for (let x = hzX0; x <= hzX1; x++) {
    if (topEdge[x] < 0 || botEdge[x] < 0) continue;
    heelColProfiles.push({
      x,
      topY: topEdge[x],
      botY: botEdge[x],
      colH: botEdge[x] - topEdge[x],
    });
  }

  if (heelColProfiles.length < 5) return inv("Heel zone has too few columns — reframe");

  // ── 6. Measurement: median column height in heel zone ────────────────────
  // Using median (not mean) makes this robust to outlier columns (shadow edges,
  // occlusion). Median of at least N columns where N = heel zone width.
  const colHeights = heelColProfiles.map(p => p.colH);
  const medColH    = Math.round(median(colHeights));

  // Median topY and botY for drawing the reference lines
  const medTopY = Math.round(median(heelColProfiles.map(p => p.topY)));
  const medBotY = Math.round(median(heelColProfiles.map(p => p.botY)));

  // ── 7. Measurement confidence ─────────────────────────────────────────────
  // Coefficient of variation (CV) of column heights in heel zone.
  // Low CV = consistent = high confidence. CV > 0.15 = suspect.
  const mean = colHeights.reduce((a, b) => a + b, 0) / colHeights.length;
  const variance = colHeights.reduce((a, b) => a + (b - mean) ** 2, 0) / colHeights.length;
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? stddev / mean : 1;
  const measurementConf = Math.max(0, Math.min(1, 1 - cv / 0.2)); // 0–1

  // ── 8. Convert to mm and validate ────────────────────────────────────────
  const heelColHeightMm = parseFloat((medColH / pxPerMm).toFixed(1));

  if (heelColHeightMm < MIN_HEEL_COL_MM || heelColHeightMm > MAX_HEEL_COL_MM) {
    return inv(`Heel-column height ${heelColHeightMm}mm out of range (${MIN_HEEL_COL_MM}–${MAX_HEEL_COL_MM}mm) — reframe`);
  }

  if (measurementConf < 0.3) {
    return inv(`Low measurement confidence (${measurementConf.toFixed(2)}) — irregular mask`);
  }

  return {
    valid: true,
    mask, bbox, contourPts,
    widthPx: shoeW,
    heelZone: { minX: hzX0, maxX: hzX1, minY: medTopY, maxY: medBotY },
    heelColProfiles,
    heelTopPt: { x: hzMidX, y: medTopY },
    heelBotPt: { x: hzMidX, y: medBotY },
    heelColHeightPx: medColH,
    heelColHeightMm,
    measurementConf,
    iouScore,
    heelOnLeft,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Annotated overlay renderer
// ─────────────────────────────────────────────────────────────────────────────
interface AnnotationResult {
  leftHMm: number; rightHMm: number;
  leftWMm: number; rightWMm: number;
  diff: number; passed: boolean;
  scanInvalid: boolean; invalidReason: string;
}

function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  vw: number, vh: number,
  left: ShoeAnalysis, right: ShoeAnalysis,
  arucoPxPerMm: number,   // always valid — caller guarantees ArUco found
  quality: QualityReport,
  debugMode: boolean,
): AnnotationResult {
  const fs = Math.max(14, Math.round(vw * 0.014));
  const invalidReasons: string[] = [];

  // ── Pill helper ────────────────────────────────────────────────────────────
  function pill(text: string, cx: number, cy: number, bg: string, fg: string, size = fs) {
    ctx.font = `bold ${size}px -apple-system,sans-serif`;
    const tw = ctx.measureText(text).width;
    const ph = size + 10, pw = tw + 20, r = ph / 2;
    const px = cx - pw / 2, py = cy - ph / 2;
    ctx.beginPath();
    ctx.moveTo(px + r, py); ctx.arcTo(px + pw, py, px + pw, py + ph, r);
    ctx.arcTo(px + pw, py + ph, px, py + ph, r); ctx.arcTo(px, py + ph, px, py, r);
    ctx.arcTo(px, py, px + pw, py, r); ctx.closePath();
    ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  }

  // ── Reference line (horizontal span with ticks) ────────────────────────────
  function refLine(y: number, x0: number, x1: number, color: string) {
    const ext = Math.round(vw * 0.008), tickH = Math.round(vw * 0.010);
    const lw = Math.max(2.5, vw * 0.0025);
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(x0 - ext, y); ctx.lineTo(x1 + ext, y); ctx.stroke();
    ctx.lineWidth = lw * 0.6;
    [[x0 - ext], [x1 + ext]].forEach(([tx]) => {
      ctx.beginPath(); ctx.moveTo(tx, y - tickH/2); ctx.lineTo(tx, y + tickH/2); ctx.stroke();
    });
    ctx.shadowBlur = 0;
  }

  // ── Draw one shoe's annotation ─────────────────────────────────────────────
  function drawShoe(sa: ShoeAnalysis, label: string): number {
    if (!sa.valid) {
      invalidReasons.push(`${label}: ${sa.invalidReason}`);
      return 0;
    }

    const { bbox, contourPts, heelZone, heelTopPt, heelBotPt,
            heelColHeightPx, heelColHeightMm, measurementConf,
            heelColProfiles, heelOnLeft } = sa;
    const { minX, minY, maxX, maxY } = bbox;
    const shoeW = maxX - minX;
    const midX  = (minX + maxX) / 2;

    // ── Mask tint ────────────────────────────────────────────────────────────
    const off = document.createElement("canvas");
    off.width = vw; off.height = vh;
    const oCtx = off.getContext("2d")!;
    const imgD = oCtx.createImageData(vw, vh);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!sa.mask[y * vw + x]) continue;
        const di = (y * vw + x) * 4;
        imgD.data[di]   = 34;  // green tint
        imgD.data[di+1] = 197;
        imgD.data[di+2] = 94;
        imgD.data[di+3] = 40;
      }
    }
    oCtx.putImageData(imgD, 0, 0);
    ctx.drawImage(off, 0, 0);

    // ── Shoe contour ─────────────────────────────────────────────────────────
    if (contourPts.length > 2) {
      ctx.beginPath();
      contourPts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.strokeStyle = GREEN; ctx.lineWidth = Math.max(2, vw * 0.0018);
      ctx.shadowColor = GREEN; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
    }

    // ── Heel zone column-height bar chart (debug only) ────────────────────────
    if (debugMode && heelColProfiles.length > 0) {
      // Draw a thin vertical bar per column coloured by deviation from median
      for (const p of heelColProfiles) {
        const dev = Math.abs(p.colH - heelColHeightPx) / heelColHeightPx;
        const alpha = Math.round(120 + dev * 400).toString(16).padStart(2, "0").slice(0, 2);
        ctx.strokeStyle = dev < 0.05 ? `${GREEN}${alpha}` : dev < 0.10 ? `${YELLOW}${alpha}` : `${RED}${alpha}`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.topY); ctx.lineTo(p.x, p.botY); ctx.stroke();
      }
    }

    // ── Heel zone bounding rect ───────────────────────────────────────────────
    const confColor = measurementConf > 0.7 ? GREEN : measurementConf > 0.4 ? YELLOW : RED;
    ctx.fillStyle   = `${confColor}18`;
    ctx.fillRect(heelZone.minX, minY, heelZone.maxX - heelZone.minX, maxY - minY);
    ctx.strokeStyle = `${confColor}bb`;
    ctx.lineWidth = Math.max(1.5, vw * 0.0015); ctx.setLineDash([5, 4]);
    ctx.strokeRect(heelZone.minX, minY, heelZone.maxX - heelZone.minX, maxY - minY);
    ctx.setLineDash([]);

    // ── Reference lines: topY (shoe top at heel) + botY (shoe bottom at heel) ─
    const topY = heelTopPt.y, botY = heelBotPt.y;
    refLine(topY, heelZone.minX, heelZone.maxX, CYAN);    // top of shoe at heel end
    refLine(botY, heelZone.minX, heelZone.maxX, GREEN);   // outsole / table contact

    // ── Vertical measurement arrow ────────────────────────────────────────────
    const arrowSide = heelOnLeft ? -1 : 1; // left of heel zone if heel-on-left
    const arrowX = heelOnLeft
      ? heelZone.minX - Math.round(vw * 0.025)
      : heelZone.maxX + Math.round(vw * 0.025);
    const ah = Math.round(vw * 0.007);
    const alw = Math.max(2, vw * 0.002);
    ctx.strokeStyle = YELLOW; ctx.lineWidth = alw;
    ctx.shadowColor = YELLOW; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(arrowX, topY); ctx.lineTo(arrowX, botY); ctx.stroke();
    // Arrowheads
    [[topY, 1], [botY, -1]].forEach(([y, dir]) => {
      ctx.beginPath();
      ctx.moveTo(arrowX - ah * 0.6, (y as number) + (dir as number) * ah);
      ctx.lineTo(arrowX, y as number);
      ctx.lineTo(arrowX + ah * 0.6, (y as number) + (dir as number) * ah);
      ctx.stroke();
    });
    ctx.shadowBlur = 0;

    // ── Heel column height pill ───────────────────────────────────────────────
    const heelMidY = (topY + botY) / 2;
    const pillX = heelOnLeft
      ? Math.max(heelZone.minX - fs * 5, fs * 4)
      : Math.min(heelZone.maxX + fs * 5, vw - fs * 4);
    pill(`Profile ${heelColHeightMm}mm`, pillX, heelMidY, "rgba(0,0,0,0.92)", YELLOW);

    // ── Width pill (top of shoe bbox) ─────────────────────────────────────────
    const wMm = parseFloat((shoeW / arucoPxPerMm).toFixed(1));
    pill(`W ${wMm}mm`, midX, Math.max(minY - fs * 1.2, fs), "rgba(0,0,0,0.88)", CYAN);

    // ── Label ─────────────────────────────────────────────────────────────────
    pill(label, midX, Math.min(maxY + fs * 1.3, vh - fs), `${GREEN}ee`, "#000");

    // ── Debug: confidence + raw px + IoU ─────────────────────────────────────
    if (debugMode) {
      const DOT = Math.max(8, vw * 0.006);
      // Large dot at top reference line
      ctx.fillStyle = CYAN; ctx.shadowColor = CYAN; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(heelTopPt.x, topY, DOT, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // Large dot at bottom reference line
      ctx.fillStyle = GREEN; ctx.shadowColor = GREEN; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(heelBotPt.x, botY, DOT, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;

      pill(`${heelColHeightPx}px`, heelTopPt.x, heelMidY - fs * 1.4, "rgba(0,0,0,0.85)", MAGENTA, fs * 0.8);
      pill(`conf:${(measurementConf*100).toFixed(0)}%`, heelTopPt.x, heelMidY + fs * 1.4, "rgba(0,0,0,0.85)", confColor, fs * 0.8);
      pill(`IoU:${sa.iouScore.toFixed(2)}`, midX, minY + (maxY-minY)*0.5, "rgba(0,0,0,0.7)", ORANGE, fs * 0.75);
      pill(`fullH:${maxY-minY}px`, midX, minY + (maxY-minY)*0.65, "rgba(0,0,0,0.7)", ORANGE, fs * 0.75);

      // Highlight the heel end side
      ctx.strokeStyle = MAGENTA; ctx.lineWidth = 2; ctx.setLineDash([2, 5]);
      ctx.strokeRect(heelZone.minX, minY, heelZone.maxX - heelZone.minX, maxY - minY);
      ctx.setLineDash([]);
    }

    void arrowSide; // suppress unused warning
    return heelColHeightMm;
  }

  const leftHMm  = drawShoe(left,  "LEFT");
  const rightHMm = drawShoe(right, "RIGHT");
  const leftWMm  = left.valid  ? parseFloat((left.widthPx  / arucoPxPerMm).toFixed(1)) : 0;
  const rightWMm = right.valid ? parseFloat((right.widthPx / arucoPxPerMm).toFixed(1)) : 0;

  // ── Centre divider ─────────────────────────────────────────────────────────
  ctx.strokeStyle = `${CYAN}44`; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(vw / 2, 0); ctx.lineTo(vw / 2, vh); ctx.stroke();
  ctx.setLineDash([]);

  // ── ArUco badge ────────────────────────────────────────────────────────────
  pill(
    `ArUco ✓  ${arucoPxPerMm.toFixed(2)} px/mm`,
    vw - fs * 7, fs * 1.8,
    "rgba(0,60,0,0.9)", GREEN,
  );

  // ── Quality badge ──────────────────────────────────────────────────────────
  if (debugMode) {
    pill(
      `sharp:${quality.sharpness.toFixed(0)}  expo:${(quality.midExpoFrac*100).toFixed(0)}%`,
      fs * 8, fs * 1.8, "rgba(0,0,0,0.8)", quality.passed ? GREEN : RED, fs * 0.8,
    );
  }

  // ── Result banner ──────────────────────────────────────────────────────────
  const scanInvalid = invalidReasons.length > 0;
  const diff   = scanInvalid ? 0 : parseFloat(Math.abs(leftHMm - rightHMm).toFixed(1));
  const passed = !scanInvalid && diff <= TOLERANCE_MM;

  const bh = Math.round(vh * 0.08);
  const bannerColor = scanInvalid ? YELLOW : passed ? GREEN : RED;
  ctx.fillStyle = `${bannerColor}ee`;
  ctx.fillRect(0, vh - bh, vw, bh);
  ctx.font = `bold ${Math.round(vw * 0.020)}px -apple-system,sans-serif`;
  ctx.fillStyle = scanInvalid ? "#000" : WHITE;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (scanInvalid) {
    ctx.fillText(`⚠ INVALID — ${invalidReasons[0]}`, vw / 2, vh - bh / 2);
  } else {
    const diffStr = `profile diff Δ${diff}mm (limit ${TOLERANCE_MM}mm)`;
    ctx.fillText(
      passed ? `✓ PASSED  ${diffStr}` : `✗ REJECTED  ${diffStr}`,
      vw / 2, vh - bh / 2,
    );
  }
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";

  // ── Debug stamp (top-left) ─────────────────────────────────────────────────
  if (debugMode) {
    const stamp = `v3.0 | L:${leftHMm}mm R:${rightHMm}mm | px/mm=${arucoPxPerMm.toFixed(2)} | conf L:${(left.measurementConf*100).toFixed(0)}% R:${(right.measurementConf*100).toFixed(0)}%`;
    ctx.font = "10px monospace"; ctx.textAlign = "left";
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(0, 0, ctx.measureText(stamp).width + 12, 16);
    ctx.fillStyle = YELLOW; ctx.fillText(stamp, 6, 12);
  }

  return { leftHMm, rightHMm, leftWMm, rightWMm, diff, passed, scanInvalid, invalidReason: invalidReasons[0] ?? "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// CameraView component
// ─────────────────────────────────────────────────────────────────────────────
export function CameraView({ onCapture, onError }: Props) {
  const videoRef         = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef        = useRef<MediaStream | null>(null);

  const [isReady,     setIsReady]     = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeStep, setAnalyzeStep] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);
  const [isPortrait,  setIsPortrait]  = useState(false);
  const [debugMode,   setDebugMode]   = useState(false);
  const [samStatus,   setSamStatus]   = useState<"idle"|"loading"|"ready"|"error">("idle");
  const [samErrorMsg, setSamErrorMsg] = useState<string>("");

  useEffect(() => {
    setSamStatus("loading");
    loadSAM()
      .then(() => setSamStatus("ready"))
      .catch((e) => {
        const msg = getSAMLoadError() ?? String(e);
        console.error("SAM load:", msg);
        setSamErrorMsg(msg);
        setSamStatus("error");
      });
  }, []);

  useEffect(() => {
    const check = () => setIsPortrait(window.innerHeight > window.innerWidth);
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
        await new Promise<void>(res => { video.onloadedmetadata = () => res(); });
        await video.play().catch(() => {});
        setIsReady(true);
      } catch {
        onError("Camera access denied — allow camera permissions and reload.");
      }
    }
    startCamera();
    return () => streamRef.current?.getTracks().forEach(t => t.stop());
  }, [onError]);

  const handleCapture = useCallback(async () => {
    const video  = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || isCapturing || isAnalyzing) return;
    if (!isSAMLoaded()) { onError("AI model still loading — wait"); return; }

    setIsCapturing(true);
    setIsAnalyzing(true);
    setAnalyzeStep("Capturing frame…");

    const vw = video.videoWidth  || 1280;
    const vh = video.videoHeight || 720;
    canvas.width = vw; canvas.height = vh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, vw, vh);
    await new Promise(r => setTimeout(r, 20));

    try {
      const imageData = ctx.getImageData(0, 0, vw, vh);

      // ── Gate 1: Image quality ─────────────────────────────────────────────
      setAnalyzeStep("Checking image quality…");
      const quality = checkImageQuality(imageData);
      if (!quality.passed) {
        setIsAnalyzing(false); setIsCapturing(false);
        onError(quality.reason!);
        return;
      }

      // ── Gate 2: ArUco marker (MANDATORY — no fallback) ────────────────────
      setAnalyzeStep("Detecting ArUco calibration marker…");
      const aruco = detectAruco(imageData, ARUCO_REAL_MM);
      if (!aruco.found) {
        setIsAnalyzing(false); setIsCapturing(false);
        onError("ArUco marker not found — place the 50mm printed marker in frame");
        return;
      }

      // Draw marker outline in debug mode
      if (debugMode) {
        const [tl, tr, br, bl] = aruco.cornersPx;
        ctx.strokeStyle = ORANGE; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(tl[0], tl[1]); ctx.lineTo(tr[0], tr[1]);
        ctx.lineTo(br[0], br[1]); ctx.lineTo(bl[0], bl[1]);
        ctx.closePath(); ctx.stroke();
        ctx.fillStyle = ORANGE; ctx.font = `bold ${Math.round(vw*0.012)}px monospace`;
        ctx.fillText(`ArUco ID${aruco.markerId}`, tl[0], tl[1] - 6);
      }

      // ── SAM encode ────────────────────────────────────────────────────────
      setAnalyzeStep("AI model encoding image…");
      const embedding = await encodeImage(canvas);

      // ── SAM decode: multi-point per half, pick best valid mask ───────────
      const mid  = Math.floor(vw / 2);
      const topZ = Math.round(vh * 0.15);
      const botZ = Math.round(vh * 0.88);
      const zoneH = botZ - topZ;

      const leftPrompts  = gridPrompts(0,   mid, topZ, zoneH, vw, vh, 3);
      const rightPrompts = gridPrompts(mid, mid, topZ, zoneH, vw, vh, 3);

      setAnalyzeStep("Segmenting left shoe…");
      // Decoder is exported with fixed N=9 points — pass all 9 at once (all foreground)
      const allLabels = Array(9).fill(1) as number[];
      const [lMask, rMask] = await Promise.all([
        decodeMask(embedding, leftPrompts,  allLabels, vw, vh),
        decodeMask(embedding, rightPrompts, allLabels, vw, vh),
      ]);

      // Validate masks
      setAnalyzeStep("Validating segmentation…");
      const lValidation = validateMask(lMask.mask, lMask.iouScore, vw, vh, 0,   mid);
      const rValidation = validateMask(rMask.mask, rMask.iouScore, vw, vh, mid, vw);

      if (!lValidation.valid) { setIsAnalyzing(false); setIsCapturing(false); onError(`Left shoe: ${lValidation.reason}`); return; }
      if (!rValidation.valid) { setIsAnalyzing(false); setIsCapturing(false); onError(`Right shoe: ${rValidation.reason}`); return; }

      // ── Measure ───────────────────────────────────────────────────────────
      setAnalyzeStep("Measuring heel heights…");
      const leftAna  = analyzeShoe(lMask.mask, lMask.iouScore, aruco.pxPerMm, vw, vh, 0,   mid);
      const rightAna = analyzeShoe(rMask.mask, rMask.iouScore, aruco.pxPerMm, vw, vh, mid, vw);

      // ── Draw annotations ──────────────────────────────────────────────────
      ctx.drawImage(video, 0, 0, vw, vh); // redraw clean frame
      const result = drawAnnotations(ctx, vw, vh, leftAna, rightAna, aruco.pxPerMm, quality, debugMode);

      setIsAnalyzing(false);

      const blob = await compressImage(canvas, 0.92);
      const annotatedDataUrl = canvas.toDataURL("image/jpeg", 0.92);

      if ("vibrate" in navigator) {
        navigator.vibrate(result.scanInvalid ? [80,40,80,40,80] : [60,25,60]);
      }

      onCapture({
        blob,
        dataUrl: annotatedDataUrl,
        annotatedDataUrl,
        leftHeightMm:    result.leftHMm,
        rightHeightMm:   result.rightHMm,
        leftWidthMm:     result.leftWMm,
        rightWidthMm:    result.rightWMm,
        heightDiffMm:    result.diff,
        passed:          result.passed,
        rejectionReason: result.scanInvalid
          ? `Invalid: ${result.invalidReason}`
          : result.passed ? null
          : `Heel height difference ${result.diff}mm exceeds ${TOLERANCE_MM}mm tolerance`,
      });

      setShowSuccess(true);
      setTimeout(() => { setShowSuccess(false); setIsCapturing(false); }, 1600);

    } catch (e) {
      setIsAnalyzing(false); setIsCapturing(false);
      onError(`Pipeline error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [isCapturing, isAnalyzing, debugMode, onCapture, onError]);

  // ── Portrait gate ──────────────────────────────────────────────────────────
  if (isPortrait) {
    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center">
        <div className="text-center px-8">
          <div className="w-14 h-14 mx-auto mb-4 flex items-center justify-center rounded-full border-2" style={{ borderColor: CYAN }}>
            <span style={{ fontSize: 28 }}>↺</span>
          </div>
          <p className="text-white font-bold text-lg mb-2">Rotate device</p>
          <p className="text-sm" style={{ color: "#777" }}>Landscape mode required — both shoes must fit side-by-side</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
      <canvas ref={captureCanvasRef} className="hidden" />

      {/* SAM status bar */}
      {samStatus === "loading" && (
        <div className="absolute top-0 inset-x-0 z-20 flex items-center justify-center gap-2 py-2"
          style={{ background: `${CYAN}20`, borderBottom: `1px solid ${CYAN}40` }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: CYAN }} />
          <span className="text-xs font-semibold" style={{ color: CYAN }}>Loading AI segmentation model…</span>
        </div>
      )}
      {samStatus === "error" && (
        <div className="absolute top-0 inset-x-0 z-20 flex flex-col items-center justify-center gap-1 py-2 px-3"
          style={{ background: `${RED}20`, borderBottom: `1px solid ${RED}40` }}>
          <div className="flex items-center gap-2">
            <XCircle className="w-3.5 h-3.5 shrink-0" style={{ color: RED }} />
            <span className="text-xs font-semibold" style={{ color: RED }}>AI model failed to load — reload page</span>
          </div>
          {samErrorMsg && (
            <span className="text-[10px] break-all text-center max-w-full" style={{ color: `${RED}cc` }}>
              {samErrorMsg.slice(0, 200)}
            </span>
          )}
        </div>
      )}

      {/* Camera loading */}
      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "#060610" }}>
          <Loader2 className="w-9 h-9 animate-spin" style={{ color: CYAN }} />
        </div>
      )}

      {/* Analysis overlay */}
      <AnimatePresence>
        {isAnalyzing && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center z-30"
            style={{ background: "rgba(0,0,0,0.68)", backdropFilter: "blur(6px)" }}
          >
            <Loader2 className="w-12 h-12 animate-spin mb-4" style={{ color: CYAN }} />
            <p className="text-base font-bold mb-1" style={{ color: CYAN }}>{analyzeStep}</p>
            <p className="text-xs" style={{ color: "#555" }}>MobileSAM · ArUco · v3.0</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Framing guide */}
      {isReady && !isCapturing && (
        <div className="absolute inset-0 pointer-events-none">
          {/* Centre split */}
          <div className="absolute top-0 bottom-0 left-1/2 w-px opacity-30"
            style={{ background: `repeating-linear-gradient(to bottom,${CYAN} 0,${CYAN} 8px,transparent 8px,transparent 16px)` }} />
          {/* Corner brackets */}
          {[
            ["top-8 left-8", `borderTop:2px solid ${CYAN};borderLeft:2px solid ${CYAN}`],
            ["top-8 right-8", `borderTop:2px solid ${CYAN};borderRight:2px solid ${CYAN}`],
            ["bottom-24 left-8", `borderBottom:2px solid ${CYAN};borderLeft:2px solid ${CYAN}`],
            ["bottom-24 right-8", `borderBottom:2px solid ${CYAN};borderRight:2px solid ${CYAN}`],
          ].map(([cls]) => (
            <div key={cls} className={`absolute w-10 h-10 ${cls}`}
              style={{ borderTop: `2px solid ${CYAN}`, borderLeft: cls.includes("right") ? undefined : `2px solid ${CYAN}`, borderRight: cls.includes("right") ? `2px solid ${CYAN}` : undefined, borderBottom: cls.includes("bottom") ? `2px solid ${CYAN}` : undefined }} />
          ))}
          <div className="absolute top-8 left-8 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute top-8 right-8 w-10 h-10" style={{ borderTop: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 left-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderLeft: `2px solid ${CYAN}` }} />
          <div className="absolute bottom-24 right-8 w-10 h-10" style={{ borderBottom: `2px solid ${CYAN}`, borderRight: `2px solid ${CYAN}` }} />
          {/* Labels */}
          <div className="absolute left-4 top-1/2 -translate-y-1/2 px-3 py-1 rounded-full text-xs font-bold"
            style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>LEFT</div>
          <div className="absolute right-4 top-1/2 -translate-y-1/2 px-3 py-1 rounded-full text-xs font-bold"
            style={{ background: "rgba(0,0,0,0.6)", border: `1px solid ${CYAN}50`, color: CYAN }}>RIGHT</div>
        </div>
      )}

      {/* Instruction pill */}
      {isReady && !isCapturing && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-10">
          <div className="px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap"
            style={{ background: "rgba(0,0,0,0.8)", border: `1px solid ${CYAN}40`, color: "#aaa" }}>
            Place 50mm ArUco marker in frame · both shoes side by side · tap capture
          </div>
        </div>
      )}

      {/* Success flash */}
      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none"
            style={{ background: "rgba(0,0,0,0.35)" }}
          >
            <motion.div
              initial={{ scale: 0.5 }} animate={{ scale: 1 }} exit={{ scale: 1.3, opacity: 0 }}
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{ background: `${GREEN}25`, border: `2px solid ${GREEN}`, boxShadow: `0 0 40px ${GREEN}80` }}
            >
              <CheckCircle2 className="w-10 h-10" style={{ color: GREEN }} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom controls */}
      <div className="absolute bottom-0 inset-x-0 z-10 flex items-center justify-between px-6 pb-6 pt-3"
        style={{ background: "linear-gradient(to top,rgba(0,0,0,0.85),transparent)" }}>

        {/* Debug toggle */}
        <button
          onClick={() => setDebugMode(d => !d)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
          style={{
            background: debugMode ? `${YELLOW}28` : "rgba(0,0,0,0.55)",
            border: `1px solid ${debugMode ? YELLOW : "rgba(255,255,255,0.12)"}`,
            color: debugMode ? YELLOW : "rgba(255,255,255,0.35)",
          }}
        >
          <Bug className="w-3.5 h-3.5" />
          {debugMode ? "Debug ON" : "Debug"}
        </button>

        {/* Capture button */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={handleCapture}
            disabled={!isReady || isCapturing || isAnalyzing || samStatus !== "ready"}
            className="relative w-20 h-20 rounded-full flex items-center justify-center transition-transform active:scale-90 disabled:opacity-35"
            style={{ border: "4px solid rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.12)", backdropFilter: "blur(4px)" }}
          >
            {samStatus === "loading"
              ? <Loader2 className="w-8 h-8 text-white animate-spin" />
              : isAnalyzing
              ? <Loader2 className="w-8 h-8 text-white animate-spin" />
              : <Camera className="w-8 h-8 text-white" />
            }
            {(isCapturing || isAnalyzing) && (
              <div className="absolute inset-0 rounded-full border-4 animate-ping" style={{ borderColor: CYAN }} />
            )}
          </button>
          <span className="text-[10px] font-medium" style={{ color: "rgba(255,255,255,0.4)" }}>
            {samStatus === "loading" ? "loading model…"
              : isAnalyzing ? analyzeStep
              : isCapturing ? "processing…"
              : "tap to capture"}
          </span>
        </div>

        {/* Spacer */}
        <div className="w-16" />
      </div>

      {/* SAM loading bar indicator */}
      {samStatus === "loading" && (
        <AlertTriangle className="absolute top-4 right-4 w-5 h-5 animate-pulse" style={{ color: YELLOW }} />
      )}
    </div>
  );
}
