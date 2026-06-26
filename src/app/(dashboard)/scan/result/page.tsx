"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { CheckCircle2, XCircle, RotateCcw, Save, Loader2, ArrowLeft } from "lucide-react";
import { useScanStore } from "@/store/scan";
import { createClient } from "@/lib/supabase/client";

export default function ResultPage() {
  const router = useRouter();
  const { captured, config, reset } = useScanStore();
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

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

      const batchId     = config?.batchId ?? `BATCH-${Date.now()}`;
      const scanId      = `SCAN-${Date.now()}`;
      const status      = captured.passed ? "passed" : "rejected";
      const blob        = await (await fetch(captured.annotatedDataUrl)).blob();
      const storagePath = `scans/${user.id}/${scanId}.jpg`;

      const { error: uploadErr } = await sb.storage
        .from("scan-images")
        .upload(storagePath, blob, { contentType: "image/jpeg", upsert: true });
      if (uploadErr) throw uploadErr;

      const { data: urlData } = sb.storage.from("scan-images").getPublicUrl(storagePath);

      const { data: scanRow, error: scanErr } = await db
        .from("scans")
        .insert({
          scan_id: scanId, worker_id: user.id, batch_id: batchId, size: "N/A", status,
          left_height_mm: captured.leftHeightMm, right_height_mm: captured.rightHeightMm,
          left_width_mm: null, right_width_mm: null, height_diff_mm: captured.heightDiffMm,
          passed: captured.passed, rejection_reason: captured.rejectionReason, notes: null,
        })
        .select().single();
      if (scanErr) throw scanErr;

      await db.from("scan_images").insert({
        scan_id: scanRow.id, side: "pair",
        storage_path: storagePath, public_url: urlData?.publicUrl ?? null,
      });

      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [captured, config, saving, saved]);

  if (!captured) return null;

  const passed       = captured.passed;
  const accent       = passed ? "#22c55e" : "#ef4444";
  const accentDim    = passed ? "rgba(34,197,94,0.12)"  : "rgba(239,68,68,0.12)";
  const accentBorder = passed ? "rgba(34,197,94,0.25)"  : "rgba(239,68,68,0.25)";
  const batchLabel   = config?.batchId ?? "";

  return (
    <div className="min-h-dvh flex flex-col" style={{ background: "#080810", color: "#fff" }}>

      {/* ── Header ── */}
      <div
        className="flex items-center gap-3 px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button
          onClick={handleRetake}
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ color: "#666", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <p className="flex-1 text-sm font-semibold text-white" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>
          Scan Result
        </p>
        {batchLabel && (
          <span
            className="text-xs font-medium px-2.5 py-1 rounded-full"
            style={{ background: "rgba(6,182,212,0.1)", color: "#06b6d4", border: "1px solid rgba(6,182,212,0.2)" }}
          >
            {batchLabel}
          </span>
        )}
      </div>

      {/* ── PASS / FAIL banner ── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-4 mt-4 rounded-2xl px-5 py-4 flex items-center gap-4"
        style={{ background: accentDim, border: `1px solid ${accentBorder}` }}
      >
        {passed
          ? <CheckCircle2 className="w-11 h-11 flex-shrink-0" style={{ color: accent }} />
          : <XCircle      className="w-11 h-11 flex-shrink-0" style={{ color: accent }} />
        }
        <div className="min-w-0">
          <p
            className="text-3xl font-black leading-none tracking-wide"
            style={{ color: accent, fontFamily: "'Space Grotesk',sans-serif" }}
          >
            {passed ? "PASSED" : "FAILED"}
          </p>
          <p className="text-xs mt-1.5 leading-snug" style={{ color: passed ? "#86efac" : "#fca5a5" }}>
            {passed
              ? "Height difference within tolerance"
              : (captured.rejectionReason ?? `Difference ${captured.heightDiffMm}mm exceeds 2mm tolerance`)}
          </p>
        </div>
      </motion.div>

      {/* ── Annotated image ── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.08 }}
        className="mx-4 mt-3 rounded-2xl overflow-hidden"
        style={{ border: "1px solid rgba(255,255,255,0.07)" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={captured.annotatedDataUrl}
          alt="Annotated shoe scan"
          className="w-full object-contain"
          style={{ maxHeight: "42vh", background: "#000", display: "block" }}
        />
      </motion.div>

      {/* ── Measurements card ── */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mx-4 mt-3 rounded-2xl overflow-hidden"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <p
          className="px-4 pt-3.5 pb-2 text-xs font-semibold tracking-widest uppercase"
          style={{ color: "#444" }}
        >
          Measurements
        </p>
        <div className="grid grid-cols-3 divide-x" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.06)" }}>
          {[
            { label: "Left Heel",  value: captured.leftHeightMm,  unit: "mm", sub: "Left shoe",    color: "#fff"  },
            { label: "Right Heel", value: captured.rightHeightMm, unit: "mm", sub: "Right shoe",   color: "#fff"  },
            { label: "Difference", value: captured.heightDiffMm,  unit: "mm", sub: "Tolerance 2mm", color: accent },
          ].map(({ label, value, unit, sub, color }) => (
            <div key={label} className="flex flex-col items-center py-4 px-2 gap-0.5">
              <p className="text-xs font-medium" style={{ color: "#555" }}>{label}</p>
              <p
                className="text-2xl font-bold leading-tight mt-1"
                style={{ color, fontFamily: "'Outfit',sans-serif" }}
              >
                {value}
              </p>
              <p className="text-xs font-semibold" style={{ color, opacity: 0.7 }}>{unit}</p>
              <p className="text-xs mt-0.5" style={{ color: "#3a3a4a" }}>{sub}</p>
            </div>
          ))}
        </div>
      </motion.div>

      {/* ── Save error ── */}
      {saveErr && (
        <p className="mx-4 mt-2 text-xs text-center" style={{ color: "#f87171" }}>{saveErr}</p>
      )}

      {/* ── Buttons ── */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.22 }}
        className="mx-4 mt-3 mb-8 flex gap-3"
      >
        <button
          onClick={handleRetake}
          className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl font-semibold text-sm transition-opacity active:opacity-70"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "#888",
          }}
        >
          <RotateCcw className="w-4 h-4" />
          Retake
        </button>

        <button
          onClick={handleSave}
          disabled={saving || saved}
          className="flex-[2] flex items-center justify-center gap-2 py-3.5 rounded-2xl font-semibold text-sm disabled:opacity-60 transition-opacity active:opacity-80"
          style={{
            background: saved
              ? accentDim
              : `linear-gradient(135deg, ${accent}dd, ${accent}99)`,
            border: `1px solid ${accentBorder}`,
            color: saved ? accent : "#fff",
            boxShadow: saved ? "none" : `0 4px 20px ${accent}33`,
          }}
        >
          {saving ? (
            <><Loader2 className="w-4 h-4 animate-spin" />Saving…</>
          ) : saved ? (
            <><CheckCircle2 className="w-4 h-4" />Saved</>
          ) : (
            <><Save className="w-4 h-4" />Save to History</>
          )}
        </button>
      </motion.div>

    </div>
  );
}
