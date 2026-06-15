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
  // Mask
  mask: Uint8Array;
  // Extents from mask
  bbox: BBox;
  contourPts: Pt[];
  widthPx: number;
  // Heel measurement
  heelBBox: BBox;
  heelTopPt: Pt;
  heelBotPt: Pt;
  heelHeightPx: number;
  heelValid: boolean;
  // SAM confidence
  iouScore: number;
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
  });

  // Confidence gate
  if (iouScore > 0 && iouScore < 0.6) return invalid(`Low SAM confidence (${iouScore.toFixed(2)})`);

  // Compute bounding box from mask
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

  // Reject tiny detections
  if (shoeW < (toX - fromX) * 0.1) return invalid("Shoe too narrow — move camera closer");
  if (shoeH < h * 0.05) return invalid("Shoe too short — check alignment");

  // Reject if shoe is partially outside frame
  if (minX <= fromX + 2 || maxX >= toX - 2) return invalid("Shoe partially cropped — move camera back");

  // Contour: row-by-row left/right edges
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

  // ── Heel detection ──────────────────────────────────────────────────────
  // Determine which end is the heel:
  // Count sole pixels (bottom 20% of shoe height) on left end vs right end.
  // Denser side = heel (outsole is thicker at heel).
  const soleYStart = maxY - Math.round(shoeH * 0.20);
  const heelZoneW = Math.round(shoeW * HEEL_FRAC);

  let leftSole = 0, rightSole = 0;
  for (let y = soleYStart; y <= maxY; y++) {
    for (let x = minX; x < minX + heelZoneW; x++)
      if (mask[y * w + x]) leftSole++;
    for (let x = maxX - heelZoneW; x <= maxX; x++)
      if (mask[y * w + x]) rightSole++;
  }

  const heelOnLeft = leftSole >= rightSole;
  const hzX0 = heelOnLeft ? minX : maxX - heelZoneW;
  const hzX1 = heelOnLeft ? minX + heelZoneW : maxX;
  const hzMidX = Math.round((hzX0 + hzX1) / 2);

  // Build per-row pixel count within heel column (used for gap detection)
  const heelRowCount = new Int32Array(h);
  for (let y = minY; y <= maxY; y++) {
    let cnt = 0;
    for (let x = hzX0; x <= hzX1; x++) {
      if (mask[y * w + x]) cnt++;
    }
    heelRowCount[y] = cnt;
  }

  // hMaxY = outsole bottom: last row (scanning down) with heel pixels
  let hMaxY = -1;
  for (let y = maxY; y >= minY; y--) {
    if (heelRowCount[y] > 0) { hMaxY = y; break; }
  }

  // Heel collar top (hMinY):
  // Scan upward from outsole bottom. Find the first row where heel pixel
  // density drops below 15% of heel zone width → that row is above the
  // outsole/midsole stack = the heel collar opening top.
  // Minimum heel height cap: at least 8% of shoe height (avoids noise).
  const minHeelH = Math.round(shoeH * 0.08);
  const densityThresh = (hzX1 - hzX0) * 0.15;
  let hMinY = hMaxY - minHeelH; // fallback: minimum cap

  if (hMaxY > 0) {
    for (let y = hMaxY - minHeelH; y >= minY; y--) {
      if (heelRowCount[y] < densityThresh) {
        hMinY = y + 1; // row just below the gap = collar top
        break;
      }
      hMinY = y;
    }
  }

  const heelHeightPx = hMaxY - hMinY;
  // Valid if outsole found and heel height is reasonable (5%–60% of shoe height)
  const heelValid = hMaxY > 0 && heelHeightPx > shoeH * 0.05 && heelHeightPx < shoeH * 0.60;
  const heelTopPt: Pt = { x: hzMidX, y: hMinY };
  const heelBotPt: Pt = { x: hzMidX, y: hMaxY };
  const heelBBox: BBox = { minX: hzX0, maxX: hzX1, minY: hMinY, maxY: hMaxY };

  return {
    valid: true,
    mask, bbox, contourPts,
    widthPx: shoeW,
    heelBBox, heelTopPt, heelBotPt, heelHeightPx, heelValid,
    iouScore,
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

    const hPillX = Math.min(arrowX + fs * 2.4, vw - fs * 2.5);
    if (heelValid) {
      pill(`H ${hMm}mm`, hPillX, heelMidY, "rgba(0,0,0,0.9)", YELLOW);
    } else {
      pill("HEEL?", hPillX, heelMidY, "rgba(0,0,0,0.9)", RED);
      invalidReasons.push(`${label}: Heel not detected`);
    }

    pill(`W ${wMm}mm`, midX, Math.max(minY - fs * 1.1, fs * 1.1), "rgba(0,0,0,0.9)", CYAN);
    pill(label, midX, Math.min(maxY + fs * 1.2, vh - fs * 0.9), `${GREEN}dd`, "#000");

    // Debug extras
    if (debugMode) {
      const DOT = Math.max(7, vw * 0.005);
      ctx.fillStyle = MAGENTA;
      ctx.beginPath(); ctx.arc(heelTopPt.x, topY, DOT, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = CYAN;
      ctx.beginPath(); ctx.arc(heelBotPt.x, botY, DOT, 0, Math.PI * 2); ctx.fill();
      pill(`${heelHeightPx}px`, (hz.minX + hz.maxX) / 2, heelMidY, "rgba(0,0,0,0.88)", MAGENTA);
      pill(`IoU:${sa.iouScore.toFixed(2)}`, midX, (minY + maxY) / 2, "rgba(0,0,0,0.7)", ORANGE);
    }

    return hMm;
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
    pill("No ArUco marker!", vw - fs * 7, fs * 1.6, "rgba(100,0,0,0.85)", RED);
    invalidReasons.push("ArUco marker not detected");
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
