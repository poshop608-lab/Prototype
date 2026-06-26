"use client";

import { useRef, useEffect, useState } from "react";

export type CameraStatus = "starting" | "ready" | "error";

export function useCamera() {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("starting");
  const [error,  setError]  = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width:  { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await new Promise<void>(res => { video.onloadedmetadata = () => res(); });
        await video.play().catch(() => {});
        if (!cancelled) setStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setError("Camera access denied — allow camera permissions and reload.");
          setStatus("error");
        }
      }
    }

    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, []);

  return { videoRef, status, error };
}
