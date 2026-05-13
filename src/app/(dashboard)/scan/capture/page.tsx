"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Upload, AlertCircle } from "lucide-react";
import { CameraView } from "@/components/camera/camera-view";
import { AngleProgress } from "@/components/camera/angle-progress";
import { useScanStore, CAPTURE_ORDER } from "@/store/scan";
import { createClient } from "@/lib/supabase/client";
import { useAuthStore } from "@/store/auth";
import { generateScanId } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { CaptureAngle } from "@/types/database";

export default function CapturePage() {
  const router = useRouter();
  const supabase = createClient();
  const { profile } = useAuthStore();
  const {
    config,
    currentAngle,
    capturedImages,
    addCapturedImage,
    isUploading,
    uploadProgress,
    setUploading,
    setScanId,
    setComplete,
    reset,
  } = useScanStore();

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Redirect if no config
  useEffect(() => {
    if (!config) {
      router.replace("/scan");
    }
  }, [config, router]);

  const allCaptured = CAPTURE_ORDER.every((a) =>
    capturedImages.some((i) => i.angle === a)
  );
  const capturedCount = capturedImages.length;
  const totalAngles = CAPTURE_ORDER.length;

  function handleCapture(blob: Blob, dataUrl: string, score: number) {
    addCapturedImage({
      angle: currentAngle,
      blob,
      dataUrl,
      alignmentScore: score,
      timestamp: Date.now(),
    });
  }

  async function handleUpload() {
    if (!config || !profile) return;
    setUploading(true, 0);
    setUploadError(null);

    try {
      // Create scan record
      const scanId = generateScanId();
      const { data: scan, error: scanError } = await supabase
        .from("scans")
        .insert({
          scan_id: scanId,
          worker_id: profile.id,
          shoe_model_id: config.shoeModelId,
          batch_id: config.batchId,
          size: config.size,
          status: "processing",
          alignment_scores: Object.fromEntries(
            capturedImages.map((i) => [i.angle, i.alignmentScore])
          ),
        })
        .select()
        .single();

      if (scanError) throw scanError;
      setScanId(scan.id);

      // Upload images
      let uploaded = 0;
      for (const img of capturedImages) {
        const filename = `${scan.id}/${img.angle}-${Date.now()}.jpg`;
        const { error: storageError } = await supabase.storage
          .from("scan-images")
          .upload(filename, img.blob, {
            contentType: "image/jpeg",
            upsert: true,
          });

        if (storageError) {
          console.error("Storage error:", storageError);
        }

        const { data: urlData } = supabase.storage
          .from("scan-images")
          .getPublicUrl(filename);

        await supabase.from("scan_images").insert({
          scan_id: scan.id,
          angle: img.angle as CaptureAngle,
          storage_path: filename,
          public_url: urlData.publicUrl,
          alignment_score: img.alignmentScore,
          is_calibrated: false,
        });

        uploaded++;
        setUploading(true, (uploaded / capturedImages.length) * 80);
      }

      // Trigger processing (placeholder)
      await supabase
        .from("scans")
        .update({ status: "processing" })
        .eq("id", scan.id);

      // Create placeholder measurements
      await supabase.from("measurements").insert({
        scan_id: scan.id,
        shoe_length_mm: 265 + Math.random() * 10,
        toe_width_mm: 95 + Math.random() * 5,
        heel_width_mm: 72 + Math.random() * 4,
        sole_length_mm: 270 + Math.random() * 10,
        sole_width_mm: 100 + Math.random() * 5,
        heel_height_mm: 28 + Math.random() * 4,
        instep_height_mm: 62 + Math.random() * 5,
        overall_accuracy: 85 + Math.random() * 12,
        processing_metadata: {
          engine: "StrideVision-v1",
          angles_used: capturedImages.length,
          avg_alignment: capturedImages.reduce((s, i) => s + i.alignmentScore, 0) / capturedImages.length,
        },
      });

      await supabase
        .from("scans")
        .update({ status: "completed" })
        .eq("id", scan.id);

      setUploading(true, 100);
      setComplete(true);

      setTimeout(() => {
        router.push(`/measurements/${scan.id}`);
      }, 500);
    } catch (err) {
      console.error(err);
      setUploadError("Upload failed. Please try again.");
      setUploading(false);
    }
  }

  if (!config) return null;

  return (
    <div className="fixed inset-0 bg-sv-black flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 bg-sv-gray-950/80 backdrop-blur-sm border-b border-sv-gray-800 z-10">
        <button
          onClick={() => router.back()}
          className="p-1.5 rounded-md text-sv-gray-400 hover:text-sv-white hover:bg-sv-gray-700 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sv-white text-sm font-medium truncate">{config.shoeModelName}</p>
          <p className="text-sv-gray-500 text-xs">
            EU {config.size} · {config.batchId} · {capturedCount}/{totalAngles} captured
          </p>
        </div>
        {allCaptured && !isUploading && (
          <Button size="sm" onClick={handleUpload} className="gap-2 flex-shrink-0">
            <Upload className="w-3.5 h-3.5" />
            Submit
          </Button>
        )}
      </div>

      {/* Angle progress */}
      <div className="px-3 py-2 bg-sv-gray-950/60 backdrop-blur-sm overflow-x-auto">
        <AngleProgress />
      </div>

      {/* Camera */}
      <div className="flex-1 relative">
        {cameraError ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="text-center max-w-sm">
              <AlertCircle className="w-12 h-12 text-sv-red mx-auto mb-4" />
              <p className="text-sv-white font-medium mb-2">Camera Error</p>
              <p className="text-sv-gray-400 text-sm mb-6">{cameraError}</p>
              <Button variant="outline" onClick={() => setCameraError(null)}>
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <CameraView
            onCapture={handleCapture}
            onError={setCameraError}
          />
        )}

        {/* Upload overlay */}
        <AnimatePresence>
          {isUploading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-sv-black/90 flex flex-col items-center justify-center gap-6"
            >
              <div className="text-center">
                <Upload className="w-10 h-10 text-sv-white mx-auto mb-3 animate-bounce" />
                <p className="text-sv-white font-semibold text-lg">
                  Uploading & Processing
                </p>
                <p className="text-sv-gray-400 text-sm mt-1">
                  Analyzing measurements...
                </p>
              </div>
              <div className="w-64">
                <Progress
                  value={uploadProgress}
                  className="h-1"
                  indicatorClassName="bg-sv-white"
                />
                <p className="text-sv-gray-500 text-xs text-center mt-2">
                  {uploadProgress.toFixed(0)}%
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Error */}
      <AnimatePresence>
        {uploadError && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-20 left-4 right-4 p-3 rounded-lg bg-sv-red/20 border border-sv-red/30 text-sv-red text-sm text-center"
          >
            {uploadError}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
