import { create } from "zustand";

export interface ScanConfig {
  batchId: string;
}

export interface CaptureResult {
  blob: Blob;
  dataUrl: string;
  annotatedDataUrl: string;
  leftHeightMm: number;
  rightHeightMm: number;
  leftWidthMm: number;
  rightWidthMm: number;
  heightDiffMm: number;
  passed: boolean;
  rejectionReason: string | null;
}

interface ScanState {
  config: ScanConfig | null;
  captured: CaptureResult | null;
  scanId: string | null;
  isUploading: boolean;

  setConfig: (config: ScanConfig) => void;
  setCaptured: (result: CaptureResult) => void;
  setScanId: (id: string) => void;
  setUploading: (v: boolean) => void;
  reset: () => void;
}

export const useScanStore = create<ScanState>((set) => ({
  config: null,
  captured: null,
  scanId: null,
  isUploading: false,

  setConfig: (config) => set({ config }),
  setCaptured: (captured) => set({ captured }),
  setScanId: (scanId) => set({ scanId }),
  setUploading: (isUploading) => set({ isUploading }),
  reset: () => set({ config: null, captured: null, scanId: null, isUploading: false }),
}));
