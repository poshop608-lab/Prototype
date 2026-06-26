"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { InspectionView } from "@/components/camera/inspection-view";
import { useScanStore } from "@/store/scan";
import { useAuthStore } from "@/store/auth";
import { createClient } from "@/lib/supabase/client";
import { getLocalCalibration, loadCalibration } from "@/lib/calibration";
import { generateScanId } from "@/lib/utils";
import type { InspectionResult, CalibrationData } from "@/lib/cv/types";

const STATION_ID = "station-1"; // could come from env or URL param in future

export default function CapturePage() {
  const router  = useRouter();
  const supabase = createClient();
  const { profile }  = useAuthStore();
  const { config }   = useScanStore();

  const [calibration, setCalibration] = useState<CalibrationData | null>(null);
  const [saveStatus,  setSaveStatus]  = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError,   setSaveError]   = useState<string | null>(null);

  // Load calibration on mount
  useEffect(() => {
    const local = getLocalCalibration();
    if (local) setCalibration(local);
    // Also fetch from Supabase (refreshes cache)
    loadCalibration(STATION_ID).then(cal => { if (cal) setCalibration(cal); });
  }, []);

  // If no batch config, redirect to scan setup
  useEffect(() => {
    if (!config) router.replace("/scan");
  }, [config, router]);

  // Auto-save fires immediately when the pipeline emits a result
  const handleResult = useCallback(async (result: InspectionResult) => {
    if (!config || !profile) return;
    setSaveStatus("saving");
    setSaveError(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any;

    try {
      const scanId = generateScanId();
      const { comparison: cmp, left, right } = result;

      // 1. Insert scan record
      const { data: scan, error: scanErr } = await db
        .from("scans")
        .insert({
          scan_id:          scanId,
          worker_id:        profile.id,
          batch_id:         config.batchId,
          size:             "N/A",
          status:           cmp.passed ? "passed" : "rejected",
          left_height_mm:   left.heightMm,
          right_height_mm:  right.heightMm,
          left_width_mm:    null,
          right_width_mm:   null,
          height_diff_mm:   cmp.diffMm,
          passed:           cmp.passed,
          rejection_reason: cmp.rejectionReason,
        })
        .select()
        .single();

      if (scanErr) throw new Error(scanErr.message ?? JSON.stringify(scanErr));
      if (!scan)   throw new Error("No scan record returned");

      // 2. Upload annotated image (non-blocking — failure doesn't abort save)
      if (result.annotatedBlob) {
        const filename = `${scan.id}/pair-${Date.now()}.jpg`;
        const { error: storageErr } = await supabase.storage
          .from("scan-images")
          .upload(filename, result.annotatedBlob, { contentType: "image/jpeg", upsert: true });
        if (!storageErr) {
          const { data: urlData } = supabase.storage.from("scan-images").getPublicUrl(filename);
          await db.from("scan_images").insert({
            scan_id:      scan.id,
            side:         "pair",
            storage_path: filename,
            public_url:   urlData.publicUrl,
          });
        }
      }

      setSaveStatus("saved");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      setSaveError(`Save failed: ${msg}`);
      setSaveStatus("error");
    }
  }, [config, profile, supabase]);

  const handleNeedCalibration = useCallback(() => {
    router.push("/admin/calibrate");
  }, [router]);

  if (!config) return null;

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: "#080810" }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 z-10 flex-shrink-0"
        style={{ background: "rgba(8,8,16,0.9)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
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
            {config.batchId} · Fully automatic
          </p>
        </div>
        {/* Save status chip */}
        {saveStatus === "saving" && (
          <span className="text-xs font-medium px-2 py-1 rounded-full" style={{ background: "rgba(6,182,212,0.15)", color: "#06b6d4" }}>
            Saving…
          </span>
        )}
        {saveStatus === "saved" && (
          <span className="text-xs font-medium px-2 py-1 rounded-full" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>
            Saved ✓
          </span>
        )}
        {saveStatus === "error" && (
          <span className="text-xs font-medium px-2 py-1 rounded-full" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }} title={saveError ?? ""}>
            Save failed
          </span>
        )}
      </div>

      {/* Camera fills remaining space */}
      <div className="flex-1 relative">
        <InspectionView
          calibration={calibration}
          onResult={handleResult}
          onNeedCalibration={handleNeedCalibration}
        />
      </div>
    </div>
  );
}
