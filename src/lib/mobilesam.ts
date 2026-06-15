// MobileSAM inference via onnxruntime-web
// Encoder: 1×3×1024×1024 → image_embeddings [1,256,64,64]
// Decoder: image_embeddings + point_coords[1,9,2] + point_labels[1,9]
//          → masks[1,3,256,256] + iou_predictions[1,3]
//
// IMPORTANT: Decoder is exported with FIXED N=9 prompt points (3×3 grid).
// Always call decodeMask with exactly 9 points and 9 labels.

import * as ort from "onnxruntime-web";

// WASM files in /public (copied by scripts/copy-ort-wasm.mjs at build time)
ort.env.wasm.wasmPaths = "/";
ort.env.wasm.numThreads = 1;  // single-threaded: avoids SharedArrayBuffer (iOS safe)

export const DECODER_N_POINTS = 9;  // fixed — must match exported model

export interface SamMask {
  mask: Uint8Array;   // 1=foreground, 0=background, same size as input canvas
  width: number;
  height: number;
  iouScore: number;
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
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "basic",
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

export function getSAMLoadError(): string | null { return loadError; }
export function isSAMLoaded(): boolean { return !!(encoderSession && decoderSession); }

// Preprocess canvas → SAM float32 tensor [1,3,1024,1024]
function preprocessImage(canvas: HTMLCanvasElement): ort.Tensor {
  const SAM_SIZE = 1024;
  const tmp = document.createElement("canvas");
  tmp.width = SAM_SIZE; tmp.height = SAM_SIZE;
  tmp.getContext("2d")!.drawImage(canvas, 0, 0, SAM_SIZE, SAM_SIZE);
  const { data } = tmp.getContext("2d")!.getImageData(0, 0, SAM_SIZE, SAM_SIZE);
  const MEAN = [123.675, 116.28,  103.53];
  const STD  = [58.395,  57.12,   57.375];
  const N = SAM_SIZE * SAM_SIZE;
  const tensor = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    tensor[0 * N + i] = (data[i * 4 + 0] - MEAN[0]) / STD[0];
    tensor[1 * N + i] = (data[i * 4 + 1] - MEAN[1]) / STD[1];
    tensor[2 * N + i] = (data[i * 4 + 2] - MEAN[2]) / STD[2];
  }
  return new ort.Tensor("float32", tensor, [1, 3, SAM_SIZE, SAM_SIZE]);
}

// Encode canvas → image embedding
export async function encodeImage(canvas: HTMLCanvasElement): Promise<ort.Tensor> {
  if (!encoderSession) throw new Error("SAM encoder not loaded");
  const img = preprocessImage(canvas);
  const results = await encoderSession.run({ [encoderSession.inputNames[0]]: img });
  return results[encoderSession.outputNames[0]];
}

// Decode embedding + EXACTLY 9 prompt points → binary mask
// promptPoints: exactly 9 [x,y] pairs, normalized 0-1 relative to canvas
// labels: exactly 9 values (1=foreground, 0=background)
export async function decodeMask(
  embedding: ort.Tensor,
  promptPoints: [number, number][],  // must be length 9
  labels: number[],                  // must be length 9
  origWidth: number,
  origHeight: number,
): Promise<SamMask> {
  if (!decoderSession) throw new Error("SAM decoder not loaded");
  if (promptPoints.length !== DECODER_N_POINTS) {
    throw new Error(`decodeMask requires exactly ${DECODER_N_POINTS} points, got ${promptPoints.length}`);
  }

  const SAM_SIZE = 1024;
  const coords = new Float32Array(DECODER_N_POINTS * 2);
  for (let i = 0; i < DECODER_N_POINTS; i++) {
    coords[i * 2]     = promptPoints[i][0] * SAM_SIZE;
    coords[i * 2 + 1] = promptPoints[i][1] * SAM_SIZE;
  }

  const results = await decoderSession.run({
    "image_embeddings": embedding,
    "point_coords":     new ort.Tensor("float32", coords,                             [1, DECODER_N_POINTS, 2]),
    "point_labels":     new ort.Tensor("float32", new Float32Array(labels),           [1, DECODER_N_POINTS]),
  });

  // Output: masks [1, 3, 256, 256], iou_predictions [1, 3]
  const masksOut = results["masks"] ?? results[decoderSession.outputNames[0]];
  const iouOut   = results["iou_predictions"] ?? results[decoderSession.outputNames[1]];

  const iouData = iouOut.data as Float32Array;
  let bestIdx = 0, bestIou = -Infinity;
  for (let i = 0; i < iouData.length; i++) {
    if (iouData[i] > bestIou) { bestIou = iouData[i]; bestIdx = i; }
  }

  const maskH = masksOut.dims[masksOut.dims.length - 2];
  const maskW = masksOut.dims[masksOut.dims.length - 1];
  const maskData = masksOut.data as Float32Array;
  const offset = bestIdx * maskH * maskW;
  const binary = new Uint8Array(maskH * maskW);
  for (let i = 0; i < maskH * maskW; i++) {
    binary[i] = maskData[offset + i] > 0 ? 1 : 0;
  }

  return {
    mask: resizeMask(binary, maskW, maskH, origWidth, origHeight),
    width: origWidth,
    height: origHeight,
    iouScore: bestIou > -Infinity ? bestIou : 0,
  };
}

function resizeMask(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const dst = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(Math.round((y / dh) * sh), sh - 1);
    for (let x = 0; x < dw; x++) {
      dst[y * dw + x] = src[sy * sw + Math.min(Math.round((x / dw) * sw), sw - 1)];
    }
  }
  return dst;
}

// Generate exactly N prompt points in a grid over a region.
// Returns normalized [0-1] coords relative to full image.
// gridSize=3 → 9 points (matches DECODER_N_POINTS).
export function gridPrompts(
  regionX: number, regionW: number,
  regionY: number, regionH: number,
  imageW: number,  imageH: number,
  gridSize = 3,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      pts.push([
        (regionX + (col + 0.5) * (regionW / gridSize)) / imageW,
        (regionY + (row + 0.5) * (regionH / gridSize)) / imageH,
      ]);
    }
  }
  return pts;
}
