import { create } from "zustand";
import type { CaptureAngle } from "@/types/database";

export interface CapturedImage {
  angle: CaptureAngle;
  blob: Blob;
  dataUrl: string;
  alignmentScore: number;
  timestamp: number;
}

export interface ScanConfig {
  shoeModelId: string;
  shoeModelName: string;
  category: string;
  size: string;
  batchId: string;
}

interface ScanState {
  config: ScanConfig | null;
  capturedImages: CapturedImage[];
  currentAngle: CaptureAngle;
  scanId: string | null;
  isUploading: boolean;
  uploadProgress: number;
  isComplete: boolean;

  setConfig: (config: ScanConfig) => void;
  addCapturedImage: (image: CapturedImage) => void;
  removeImage: (angle: CaptureAngle) => void;
  setCurrentAngle: (angle: CaptureAngle) => void;
  setScanId: (id: string) => void;
  setUploading: (uploading: boolean, progress?: number) => void;
  setComplete: (complete: boolean) => void;
  reset: () => void;
}

const CAPTURE_ORDER: CaptureAngle[] = [
  "top",
  "left",
  "right",
  "front",
  "back",
  "sole",
];

export const useScanStore = create<ScanState>((set, get) => ({
  config: null,
  capturedImages: [],
  currentAngle: "top",
  scanId: null,
  isUploading: false,
  uploadProgress: 0,
  isComplete: false,

  setConfig: (config) => set({ config }),

  addCapturedImage: (image) => {
    const { capturedImages } = get();
    const updated = capturedImages.filter((i) => i.angle !== image.angle);
    updated.push(image);
    const nextIndex = CAPTURE_ORDER.indexOf(image.angle) + 1;
    const nextAngle =
      nextIndex < CAPTURE_ORDER.length
        ? CAPTURE_ORDER[nextIndex]
        : CAPTURE_ORDER[CAPTURE_ORDER.length - 1];
    set({ capturedImages: updated, currentAngle: nextAngle });
  },

  removeImage: (angle) => {
    const updated = get().capturedImages.filter((i) => i.angle !== angle);
    set({ capturedImages: updated, currentAngle: angle });
  },

  setCurrentAngle: (angle) => set({ currentAngle: angle }),
  setScanId: (scanId) => set({ scanId }),
  setUploading: (isUploading, uploadProgress = 0) =>
    set({ isUploading, uploadProgress }),
  setComplete: (isComplete) => set({ isComplete }),
  reset: () =>
    set({
      config: null,
      capturedImages: [],
      currentAngle: "top",
      scanId: null,
      isUploading: false,
      uploadProgress: 0,
      isComplete: false,
    }),
}));

export { CAPTURE_ORDER };
