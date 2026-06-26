// Pull one ImageData from a live video element.
// scale < 1 downsamples for faster processing in the detection stage.
// Measurement stage always calls at scale=1 (full resolution).

let _canvas: HTMLCanvasElement | null = null;

function getCanvas(): HTMLCanvasElement {
  if (!_canvas) {
    _canvas = document.createElement("canvas");
  }
  return _canvas;
}

export function extractFrame(
  video: HTMLVideoElement,
  scale = 1,
): ImageData | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);

  const canvas = getCanvas();
  canvas.width  = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export function frameToGrayscale(frame: ImageData): Uint8Array {
  const { data, width, height } = frame;
  const N    = width * height;
  const gray = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    // BT.601 luma
    gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
  }
  return gray;
}
