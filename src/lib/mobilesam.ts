// MobileSAM inference via onnxruntime-web
// Encoder: image → 256-dim embedding
// Decoder: embedding + prompt points → binary mask

import * as ort from "onnxruntime-web";

// WASM files are copied to /public/ by scripts/copy-ort-wasm.mjs at build time.
// Use single-threaded mode: avoids SharedArrayBuffer requirement (iOS Safari compat).
ort.env.wasm.wasmPaths = "/";
ort.env.wasm.numThreads = 1;

export interface SamMask {
  mask: Uint8Array;   // 1 = foreground, 0 = background (same size as input image)
  width: number;
  height: number;
  iouScore: number;  // model's own confidence 0–1
}

let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let loading = false;
let loadError: string | null = null;

export async function loadSAM(): Promise<void> {
  if (encoderSession && decoderSession) return;
  if (loading) {
    await new Promise<void>((res, rej) => {
      const t = setInterval(() => {
        if (encoderSession && decoderSession) { clearInterval(t); res(); }
        if (loadError) { clearInterval(t); rej(new Error(loadError)); }
      }, 100);
    });
    return;
  }
  loading = true;
  try {
    // graphOptimizationLevel "all" crashes on these Qualcomm-hub models
    // (ORT transpose_optimization bug). Use "disabled" — model runs correctly
    // without optimization, just slightly slower.
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "disabled",
    };
    [encoderSession, decoderSession] = await Promise.all([
      ort.InferenceSession.create("/models/encoder.onnx", opts),
      ort.InferenceSession.create("/models/decoder.onnx", opts),
    ]);
  } catch (e) {
    loadError = String(e);
    loading = false;
    throw e;
  }
  loading = false;
}

export function getSAMLoadError(): string | null {
  return loadError;
}

export function isSAMLoaded(): boolean {
  return !!(encoderSession && decoderSession);
}

// Preprocess image to 1024×1024 float32 tensor (SAM expects 1024×1024)
function preprocessImage(canvas: HTMLCanvasElement): ort.Tensor {
  const SAM_SIZE = 1024;
  const tmp = document.createElement("canvas");
  tmp.width = SAM_SIZE; tmp.height = SAM_SIZE;
  const ctx = tmp.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, SAM_SIZE, SAM_SIZE);
  const { data } = ctx.getImageData(0, 0, SAM_SIZE, SAM_SIZE);

  // SAM normalization: pixel_mean=[123.675,116.28,103.53], pixel_std=[58.395,57.12,57.375]
  const MEAN = [123.675, 116.28, 103.53];
  const STD  = [58.395, 57.12, 57.375];
  const N = SAM_SIZE * SAM_SIZE;
  const tensor = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    tensor[0 * N + i] = (data[i * 4 + 0] - MEAN[0]) / STD[0];
    tensor[1 * N + i] = (data[i * 4 + 1] - MEAN[1]) / STD[1];
    tensor[2 * N + i] = (data[i * 4 + 2] - MEAN[2]) / STD[2];
  }
  return new ort.Tensor("float32", tensor, [1, 3, SAM_SIZE, SAM_SIZE]);
}

// Run encoder — returns image embedding
export async function encodeImage(canvas: HTMLCanvasElement): Promise<ort.Tensor> {
  if (!encoderSession) throw new Error("SAM encoder not loaded");
  const imageTensor = preprocessImage(canvas);

  // Find the actual input name from the session
  const inputName = encoderSession.inputNames[0];
  const results = await encoderSession.run({ [inputName]: imageTensor });
  const outputName = encoderSession.outputNames[0];
  return results[outputName];
}

// Run decoder with prompt points → mask
// promptPoints: array of [x, y] in 0–1 normalized coordinates (relative to canvas)
// labels: 1 = foreground point, 0 = background point
export async function decodeMask(
  embedding: ort.Tensor,
  promptPoints: [number, number][],
  labels: number[],
  origWidth: number,
  origHeight: number,
): Promise<SamMask> {
  if (!decoderSession) throw new Error("SAM decoder not loaded");

  const SAM_SIZE = 1024;
  const numPoints = promptPoints.length;

  // Scale points to SAM coordinate space (1024×1024)
  const coords = new Float32Array(numPoints * 2);
  for (let i = 0; i < numPoints; i++) {
    coords[i * 2]     = promptPoints[i][0] * SAM_SIZE;
    coords[i * 2 + 1] = promptPoints[i][1] * SAM_SIZE;
  }

  const labelsArr = new Float32Array(labels);

  // Check actual input names from the session
  const inputNames = decoderSession.inputNames;

  // Build inputs matching model's expected names
  const feeds: Record<string, ort.Tensor> = {};

  // Map common SAM decoder input names
  const nameMap: Record<string, ort.Tensor> = {
    "image_embeddings": embedding,
    "point_coords": new ort.Tensor("float32", coords, [1, numPoints, 2]),
    "point_labels": new ort.Tensor("float32", labelsArr, [1, numPoints]),
    "mask_input": new ort.Tensor("float32", new Float32Array(1 * 1 * 256 * 256), [1, 1, 256, 256]),
    "has_mask_input": new ort.Tensor("float32", new Float32Array([0]), [1]),
    "orig_im_size": new ort.Tensor("float32", new Float32Array([origHeight, origWidth]), [2]),
    // Qualcomm hub variant may use these names instead:
    "val_0": new ort.Tensor("float32", coords, [1, numPoints, 2]),
    "val_4": new ort.Tensor("float32", labelsArr, [1, numPoints]),
  };

  for (const name of inputNames) {
    if (nameMap[name]) feeds[name] = nameMap[name];
  }

  const results = await decoderSession.run(feeds);

  // Output: masks [1, 4, H, W], iou_predictions [1, 4]
  const outputNames = decoderSession.outputNames;
  let masksOutput: ort.Tensor | undefined;
  let iouOutput: ort.Tensor | undefined;

  for (const name of outputNames) {
    if (name.includes("mask") || name.includes("Sigmoid") || results[name].dims.length === 4) {
      masksOutput = results[name];
    }
    if (name.includes("iou") || (results[name].dims.length <= 2)) {
      iouOutput = results[name];
    }
  }

  if (!masksOutput) {
    // Fallback: first output is masks
    masksOutput = results[outputNames[0]];
  }

  const maskData = masksOutput.data as Float32Array;
  const maskDims = masksOutput.dims;

  // SAM outputs 4 candidate masks — pick the best (highest IoU score)
  let bestIdx = 0;
  let bestIou = -1;
  if (iouOutput) {
    const iouData = iouOutput.data as Float32Array;
    for (let i = 0; i < 4 && i < iouData.length; i++) {
      if (iouData[i] > bestIou) { bestIou = iouData[i]; bestIdx = i; }
    }
  }

  // Extract best mask and threshold at 0
  const maskH = maskDims[maskDims.length - 2];
  const maskW = maskDims[maskDims.length - 1];
  const maskOffset = bestIdx * maskH * maskW;
  const binaryMask = new Uint8Array(maskH * maskW);
  for (let i = 0; i < maskH * maskW; i++) {
    binaryMask[i] = maskData[maskOffset + i] > 0 ? 1 : 0;
  }

  // Resize mask back to original image dimensions
  const finalMask = resizeMask(binaryMask, maskW, maskH, origWidth, origHeight);

  return {
    mask: finalMask,
    width: origWidth,
    height: origHeight,
    iouScore: bestIou,
  };
}

// Nearest-neighbour resize of binary mask
function resizeMask(
  src: Uint8Array, sw: number, sh: number,
  dw: number, dh: number
): Uint8Array {
  const dst = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.round((y / dh) * sh);
    for (let x = 0; x < dw; x++) {
      const sx = Math.round((x / dw) * sw);
      dst[y * dw + x] = src[Math.min(sy, sh-1) * sw + Math.min(sx, sw-1)];
    }
  }
  return dst;
}

// Generate a grid of prompt points covering a region
// Returns normalized [0–1] coords relative to the full image
export function gridPrompts(
  regionX: number, regionW: number,
  regionY: number, regionH: number,
  imageW: number, imageH: number,
  gridSize: number = 3,
): [number, number][] {
  const points: [number, number][] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const px = regionX + (col + 0.5) * (regionW / gridSize);
      const py = regionY + (row + 0.5) * (regionH / gridSize);
      points.push([px / imageW, py / imageH]);
    }
  }
  return points;
}
