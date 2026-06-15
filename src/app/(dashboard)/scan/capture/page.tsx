"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, CheckCircle2, XCircle, RotateCcw, Save, Loader2 } from "lucide-react";
import { CameraView } from "@/components/camera/camera-view";
import { useScanStore } from "@/store/scan";
import { createClient } from "@/lib/supabase/client";
import { useAuthStore } from "@/store/auth";
import { generateScanId } from "@/lib/utils";
import type { CaptureResult } from "@/store/scan";

export default function CapturePage() {
  const router = useRouter();
  const supabase = createClient();
  const { profile } = useAuthStore();
  const { config, captured, setCaptured, setUploading, isUploading, reset } = useScanStore();

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStep, setSaveStep] = useState<"uploading" | "saving">("uploading");

  useEffect(() => {
    if (!config) router.replace("/scan");
  }, [config, router]);

  function handleCapture(result: CaptureResult) {
    setCaptured(result);
  }

  function handleRetake() {
    setCaptured(null as unknown as CaptureResult);
    setCameraError(null);
    setSaveError(null);
  }

  async function handleSave() {
    if (!config || !captured || !profile) return;
    setUploading(true);
    setSaveError(null);
    setSaveStep("uploading");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any;

    try {
      const scanId = generateScanId();

      // 1. Create scan record
      const { data: scan, error: scanError } = await db
        .from("scans")
        .insert({
          scan_id: scanId,
          worker_id: profile.id,
          batch_id: config.batchId,
          size: "N/A",
          status: captured.passed ? "passed" : "rejected",
          left_height_mm: captured.leftHeightMm,
          right_height_mm: captured.rightHeightMm,
          left_width_mm: captured.leftWidthMm,
          right_width_mm: captured.rightWidthMm,
          height_diff_mm: captured.heightDiffMm,
          passed: captured.passed,
          rejection_reason: captured.rejectionReason,
        })
        .select()
        .single();

      if (scanError) throw new Error(scanError.message ?? JSON.stringify(scanError));
      if (!scan) throw new Error("No scan returned");

      // 2. Upload annotated image
      const filename = `${scan.id}/pair-${Date.now()}.jpg`;
      const { error: storageErr } = await supabase.storage
        .from("scan-images")
        .upload(filename, captured.blob, { contentType: "image/jpeg", upsert: true });
      if (storageErr) console.warn("Storage upload:", storageErr.message);

      const { data: urlData } = supabase.storage.from("scan-images").getPublicUrl(filename);

      setSaveStep("saving");

      // 3. Insert scan_image row
      await db.from("scan_images").insert({
        scan_id: scan.id,
        side: "pair",
        storage_path: filename,
        public_url: urlData.publicUrl,
      });

      setUploading(false);
      reset();
      router.push("/scans");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      setSaveError(`Save failed: ${msg}`);
      setUploading(false);
    }
  }

  if (!config) return null;

  // ── STATE 2: Result screen ────────────────────────────────────────────
  if (captured) {
    const passed = captured.passed;
    const accentColor = passed ? "#22c55e" : "#ef4444";

    return (
      <div className="fixed inset-0 flex flex-col" style={{ background: "#080810" }}>
        {/* Header */}
        <div
          className="flex items-center gap-3 px-4 py-3 z-10"
          style={{ background: "rgba(8,8,16,0.9)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          <button
            onClick={handleRetake}
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ color: "#666", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <p className="text-white text-sm font-semibold flex-1" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            Scan Result
          </p>
          <span className="text-xs font-medium px-2 py-1 rounded-full"
            style={{ background: `${accentColor}20`, color: accentColor, border: `1px solid ${accentColor}40` }}>
            {config.batchId}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-lg mx-auto px-4 py-6 space-y-5">

            {/* PASS / REJECT banner */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 20 }}
              className="rounded-2xl p-6 text-center"
              style={{ background: `${accentColor}12`, border: `1px solid ${accentColor}30` }}
            >
              <div className="flex items-center justify-center gap-3 mb-2">
                {passed
                  ? <CheckCircle2 className="w-10 h-10" style={{ color: accentColor }} />
                  : <XCircle className="w-10 h-10" style={{ color: accentColor }} />
                }
                <span className="text-3xl font-black tracking-wide" style={{ color: accentColor, fontFamily: "'Space Grotesk', sans-serif" }}>
                  {passed ? "PASSED" : "REJECTED"}
                </span>
              </div>
              {!passed && captured.rejectionReason && (
                <p className="text-sm mt-1" style={{ color: "#888" }}>{captured.rejectionReason}</p>
              )}
              {passed && (
                <p className="text-sm mt-1" style={{ color: "#888" }}>
                  Height difference within tolerance
                </p>
              )}
            </motion.div>

            {/* Measurements */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="rounded-2xl overflow-hidden"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <div className="px-4 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#555" }}>Measurements</p>
                <p className="text-xs mt-0.5" style={{ color: "#444" }}>Heel profile = full shoe height at heel end (side view). Difference is the QC metric.</p>
              </div>
              <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
                {[
                  { label: "Left Heel Profile", value: `${captured.leftHeightMm} mm`, accent: false },
                  { label: "Right Heel Profile", value: `${captured.rightHeightMm} mm`, accent: false },
                  { label: "Left Shoe Width", value: `${captured.leftWidthMm} mm`, accent: false },
                  { label: "Right Shoe Width", value: `${captured.rightWidthMm} mm`, accent: false },
                  { label: "Profile Difference", value: `${captured.heightDiffMm} mm`, accent: true },
                ].map(({ label, value, accent }) => (
                  <div key={label} className="flex items-center justify-between px-4 py-3">
                    <span className="text-sm" style={{ color: "#666" }}>{label}</span>
                    <span
                      className="text-sm font-bold tabular-nums"
                      style={{ color: accent ? accentColor : "white" }}
                    >
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Annotated image */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="rounded-2xl overflow-hidden"
              style={{ border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <img
                src={captured.annotatedDataUrl}
                alt="Captured shoes with measurements"
                className="w-full object-cover"
              />
            </motion.div>

            {/* Save error */}
            <AnimatePresence>
              {saveError && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="rounded-xl px-4 py-3 text-sm"
                  style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "#ef4444" }}
                >
                  {saveError}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Actions */}
            <div className="flex gap-3 pb-4">
              <button
                onClick={handleRetake}
                disabled={isUploading}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold disabled:opacity-40"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#888" }}
              >
                <RotateCcw className="w-4 h-4" />
                Retake
              </button>
              <motion.button
                onClick={handleSave}
                disabled={isUploading}
                whileHover={!isUploading ? { scale: 1.02 } : {}}
                whileTap={!isUploading ? { scale: 0.98 } : {}}
                className="flex-[2] flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold text-black disabled:opacity-60"
                style={{ background: `linear-gradient(135deg, ${accentColor}, ${passed ? "#16a34a" : "#dc2626"})`, cursor: isUploading ? "not-allowed" : "pointer", fontFamily: "'Space Grotesk', sans-serif" }}
              >
                {isUploading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {saveStep === "uploading" ? "Uploading..." : "Saving..."}
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save to History
                  </>
                )}
              </motion.button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── STATE 1: Camera ───────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: "#080810" }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 z-10 backdrop-blur-sm"
        style={{ background: "rgba(8,8,16,0.85)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button
          onClick={() => router.back()}
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ color: "#666", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <p className="text-white text-sm font-semibold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            Shoe Pair Inspection
          </p>
          <p className="text-xs" style={{ color: "#555" }}>
            {config.batchId} · Place both shoes side-by-side
          </p>
        </div>
      </div>

      {/* Camera */}
      <div className="flex-1 relative">
        {cameraError ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div
              className="text-center max-w-sm p-8 rounded-2xl"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(239,68,68,0.2)" }}
            >
              <XCircle className="w-10 h-10 mx-auto mb-3" style={{ color: "#ef4444" }} />
              <p className="font-bold text-white mb-2">Camera Error</p>
              <p className="text-sm mb-5" style={{ color: "#666" }}>{cameraError}</p>
              <button
                onClick={() => setCameraError(null)}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white"
                style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}
              >
                Try again
              </button>
            </div>
          </div>
        ) : (
          <CameraView onCapture={handleCapture} onError={setCameraError} />
        )}
      </div>
    </div>
  );
}
