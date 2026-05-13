"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, RotateCcw, CheckCircle2, Loader2 } from "lucide-react";
import { AlignmentOverlay } from "./alignment-overlay";
import { useScanStore } from "@/store/scan";
import { compressImage, getAlignmentColor } from "@/lib/utils";
import type { CaptureAngle } from "@/types/database";

const AUTO_CAPTURE_THRESHOLD = 88;
const AUTO_CAPTURE_HOLD_MS = 1200;

interface Props {
  onCapture: (blob: Blob, dataUrl: string, score: number) => void;
  onError: (msg: string) => void;
}

export function CameraView({ onCapture, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { currentAngle } = useScanStore();
  const [isReady, setIsReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [alignmentScore, setAlignmentScore] = useState(0);
  const [tiltX, setTiltX] = useState(0);
  const [tiltY, setTiltY] = useState(0);
  const [gyroAvailable, setGyroAvailable] = useState(false);
  const [autoCountdown, setAutoCountdown] = useState<number | null>(null);

  // Start camera
  useEffect(() => {
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setIsReady(true);
        }
      } catch {
        onError("Camera access denied. Please allow camera permissions.");
      }
    }

    startCamera();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [onError]);

  // Gyroscope / accelerometer
  useEffect(() => {
    function handleOrientation(e: DeviceOrientationEvent) {
      if (e.gamma !== null && e.beta !== null) {
        setGyroAvailable(true);
        setTiltX(e.gamma || 0);
        setTiltY((e.beta || 0) - 45);
      }
    }

    window.addEventListener("deviceorientation", handleOrientation, true);
    return () => window.removeEventListener("deviceorientation", handleOrientation, true);
  }, []);

  // Simulate alignment score based on tilt (real implementation uses CV)
  useEffect(() => {
    const tiltMagnitude = Math.sqrt(tiltX ** 2 + tiltY ** 2);
    const base = Math.max(30, 95 - tiltMagnitude * 1.5);
    // Add some jitter for realism
    const jitter = (Math.random() - 0.5) * 4;
    const score = Math.min(99, Math.max(0, base + jitter));
    setAlignmentScore(parseFloat(score.toFixed(1)));
  }, [tiltX, tiltY]);

  // Auto-capture logic
  useEffect(() => {
    if (alignmentScore >= AUTO_CAPTURE_THRESHOLD && isReady && !isCapturing) {
      if (!autoTimerRef.current) {
        setAutoCountdown(AUTO_CAPTURE_HOLD_MS);
        const startTime = Date.now();
        const interval = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const remaining = AUTO_CAPTURE_HOLD_MS - elapsed;
          if (remaining <= 0) {
            clearInterval(interval);
            setAutoCountdown(null);
            handleCapture();
          } else {
            setAutoCountdown(remaining);
          }
        }, 50);
        autoTimerRef.current = interval as unknown as ReturnType<typeof setTimeout>;
      }
    } else {
      if (autoTimerRef.current) {
        clearInterval(autoTimerRef.current as unknown as ReturnType<typeof setInterval>);
        autoTimerRef.current = null;
        setAutoCountdown(null);
      }
    }
  }, [alignmentScore, isReady, isCapturing]);

  const handleCapture = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || isCapturing) return;

    setIsCapturing(true);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);

    try {
      const blob = await compressImage(canvas, 0.88);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.88);

      // Haptic feedback
      if ("vibrate" in navigator) {
        navigator.vibrate([50, 30, 50]);
      }

      setShowSuccess(true);
      setTimeout(() => {
        setShowSuccess(false);
        setIsCapturing(false);
      }, 1200);

      onCapture(blob, dataUrl, alignmentScore);
    } catch {
      onError("Failed to capture image");
      setIsCapturing(false);
    }
  }, [isCapturing, alignmentScore, onCapture, onError]);

  const scoreColor = getAlignmentColor(alignmentScore);

  return (
    <div className="relative w-full h-full bg-black rounded-xl overflow-hidden">
      {/* Video feed */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        muted
      />
      <canvas ref={canvasRef} className="hidden" />

      {/* Loading state */}
      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-sv-gray-950">
          <div className="text-center">
            <Loader2 className="w-8 h-8 text-sv-gray-400 animate-spin mx-auto mb-3" />
            <p className="text-sv-gray-400 text-sm">Initializing camera...</p>
          </div>
        </div>
      )}

      {/* Alignment overlay */}
      {isReady && (
        <AlignmentOverlay
          angle={currentAngle}
          alignmentScore={alignmentScore}
          tiltX={tiltX}
          tiltY={tiltY}
        />
      )}

      {/* Auto-capture countdown ring */}
      {autoCountdown !== null && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="rgba(255,255,255,0.1)"
              strokeWidth="4"
            />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke={scoreColor}
              strokeWidth="4"
              strokeDasharray={`${2 * Math.PI * 42}`}
              strokeDashoffset={`${2 * Math.PI * 42 * (autoCountdown / AUTO_CAPTURE_HOLD_MS)}`}
              style={{ transition: "stroke-dashoffset 0.05s linear" }}
            />
          </svg>
          <div className="absolute text-white text-xs font-medium">AUTO</div>
        </div>
      )}

      {/* Success flash */}
      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center bg-white/10 backdrop-blur-[1px]"
          >
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 1.2, opacity: 0 }}
              className="w-20 h-20 rounded-full bg-sv-green/30 border-2 border-sv-green flex items-center justify-center"
            >
              <CheckCircle2 className="w-10 h-10 text-sv-green" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Manual capture button */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
        <button
          onClick={handleCapture}
          disabled={!isReady || isCapturing}
          className="relative w-16 h-16 rounded-full border-4 border-white/80 bg-white/20 backdrop-blur-sm flex items-center justify-center transition-transform active:scale-90 disabled:opacity-40"
        >
          <div className="w-10 h-10 rounded-full bg-white" />
          {isCapturing && (
            <div className="absolute inset-0 rounded-full border-4 border-sv-green animate-ping" />
          )}
        </button>
      </div>

      {/* Gyro badge */}
      {!gyroAvailable && (
        <div className="absolute top-4 right-4">
          <div className="px-2 py-1 rounded-md bg-black/40 backdrop-blur-sm text-[10px] text-white/50">
            No gyroscope
          </div>
        </div>
      )}
    </div>
  );
}
