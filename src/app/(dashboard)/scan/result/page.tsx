"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { CheckCircle2, XCircle, RotateCcw, Save, Loader2 } from "lucide-react";
import { useScanStore } from "@/store/scan";
import { createClient } from "@/lib/supabase/client";

const STATION_ID = "station-1";

export default function ResultPage() {
  const router = useRouter();
  const { captured, config, reset } = useScanStore();
  const [saving, setSaving]   = useState(false);
  const [saved,  setSaved]    = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Guard — if navigated here directly with no result, go back
  useEffect(() => {
    if (!captured) router.replace("/scan");
  }, [captured, router]);

  const handleRetake = useCallback(() => {
    reset();
    router.replace("/scan");
  }, [reset, router]);

  const handleSave = useCallback(async () => {
    if (!captured || saving || saved) return;
    setSaving(true);
    setSaveErr(null);

    try {
      const sb = createClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = sb as any;
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const batchId = config?.batchId ?? `BATCH-${Date.now()}`;
      const scanId  = `SCAN-${Date.now()}`;
      const status  = captured.passed ? "passed" : "rejected";

      // Upload annotated image to Storage
      const blob = await (await fetch(captured.annotatedDataUrl)).blob();
      const storagePath = `scans/${user.id}/${scanId}.jpg`;
      const { error: uploadErr } = await sb.storage
        .from("scan-images")
        .upload(storagePath, blob, { contentType: "image/jpeg", upsert: true });
      if (uploadErr) throw uploadErr;

      const { data: urlData } = sb.storage
        .from("scan-images")
        .getPublicUrl(storagePath);

      // Insert scan row
      const { data: scanRow, error: scanErr } = await db
        .from("scans")
        .insert({
          scan_id:          scanId,
          worker_id:        user.id,
          batch_id:         batchId,
          size:             "N/A",
          status,
          left_height_mm:   captured.leftHeightMm,
          right_height_mm:  captured.rightHeightMm,
          left_width_mm:    null,
          right_width_mm:   null,
          height_diff_mm:   captured.heightDiffMm,
          passed:           captured.passed,
          rejection_reason: captured.rejectionReason,
          notes:            null,
        })
        .select()
        .single();
      if (scanErr) throw scanErr;

      // Insert scan_image row
      await db.from("scan_images").insert({
        scan_id:      scanRow.id,
        side:         "pair",
        storage_path: storagePath,
        public_url:   urlData?.publicUrl ?? null,
      });

      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [captured, config, saving, saved]);

  if (!captured) return null;

  const passed = captured.passed;
  const accentColor = passed ? "#22c55e" : "#ef4444";
  const bgAccent    = passed ? "rgba(34,197,94,0.08)"  : "rgba(239,68,68,0.08)";
  const borderAccent = passed ? "rgba(34,197,94,0.2)"  : "rgba(239,68,68,0.2)";

  return (
    <div
      className="min-h-dvh flex flex-col"
      style={{ background: "#080810", color: "#fff" }}
    >
      {/* Result banner */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-center gap-3 py-6 px-4"
        style={{ background: bgAccent, borderBottom: `1px solid ${borderAccent}` }}
      >
        {passed
          ? <CheckCircle2 className="w-10 h-10" style={{ color: accentColor }} />
          : <XCircle      className="w-10 h-10" style={{ color: accentColor }} />
        }
        <div>
          <p
            className="text-3xl font-black tracking-wide"
            style={{ color: accentColor, fontFamily: "'Space Grotesk',sans-serif" }}
          >
            {passed ? "PASS" : "FAIL"}
          </p>
          {!passed && captured.rejectionReason && (
            <p className="text-xs mt-0.5" style={{ color: "#f87171" }}>
              {captured.rejectionReason}
            </p>
          )}
        </div>
      </motion.div>

      {/* Annotated image */}
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.1 }}
        className="mx-4 mt-4 rounded-2xl overflow-hidden"
        style={{ border: "1px solid rgba(255,255,255,0.06)" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={captured.annotatedDataUrl}
          alt="Annotated shoe scan"
          className="w-full object-contain"
          style={{ maxHeight: "45vh", background: "#000" }}
        />
      </motion.div>

      {/* Measurements table */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18 }}
        className="mx-4 mt-4 rounded-2xl p-4 grid grid-cols-3 gap-3"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        {[
          { label: "Left Heel",  value: `${captured.leftHeightMm} mm`,  sub: "Left shoe" },
          { label: "Right Heel", value: `${captured.rightHeightMm} mm`, sub: "Right shoe" },
          { label: "Difference", value: `${captured.heightDiffMm} mm`,  sub: "Tolerance 2mm", highlight: true },
        ].map(({ label, value, sub, highlight }) => (
          <div key={label} className="text-center">
            <p className="text-xs mb-1" style={{ color: "#555" }}>{label}</p>
            <p
              className="text-xl font-bold"
              style={{
                color: highlight ? accentColor : "#fff",
                fontFamily: "'Outfit',sans-serif",
              }}
            >
              {value}
            </p>
            <p className="text-xs mt-0.5" style={{ color: "#444" }}>{sub}</p>
          </div>
        ))}
      </motion.div>

      {/* Save error */}
      {saveErr && (
        <p className="mx-4 mt-3 text-xs text-center" style={{ color: "#f87171" }}>
          {saveErr}
        </p>
      )}

      {/* Action buttons */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.26 }}
        className="mx-4 mt-4 mb-8 flex gap-3"
      >
        <button
          onClick={handleRetake}
          className="flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl font-semibold text-sm"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "#aaa",
          }}
        >
          <RotateCcw className="w-4 h-4" />
          Retake
        </button>

        <button
          onClick={handleSave}
          disabled={saving || saved}
          className="flex-[2] flex items-center justify-center gap-2 py-4 rounded-2xl font-semibold text-sm disabled:opacity-50 transition-opacity"
          style={{
            background: saved
              ? "rgba(34,197,94,0.12)"
              : `linear-gradient(135deg,${accentColor}cc,${accentColor}88)`,
            border: `1px solid ${accentColor}44`,
            color: saved ? "#22c55e" : "#fff",
          }}
        >
          {saving ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
          ) : saved ? (
            <><CheckCircle2 className="w-4 h-4" /> Saved</>
          ) : (
            <><Save className="w-4 h-4" /> Save to History</>
          )}
        </button>
      </motion.div>
    </div>
  );
}
