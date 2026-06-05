import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export function formatRelativeTime(date: string | Date) {
  const now = new Date();
  const then = new Date(date);
  const diff = now.getTime() - then.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatDate(date);
}

export function formatMeasurement(value: number, unit: "mm" | "cm" = "mm") {
  if (unit === "cm") return `${(value / 10).toFixed(1)} cm`;
  return `${value.toFixed(1)} mm`;
}

export function getAlignmentColor(score: number): string {
  if (score >= 85) return "#22C55E";
  if (score >= 60) return "#F59E0B";
  return "#EF4444";
}

export function compressImage(
  canvas: HTMLCanvasElement,
  quality = 0.85
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas to blob failed"));
      },
      "image/jpeg",
      quality
    );
  });
}

export function generateScanId(): string {
  return `SCAN-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}

export const PX_PER_MM = 3.5;

export function pxToMm(px: number): number {
  return parseFloat((px / PX_PER_MM).toFixed(1));
}
