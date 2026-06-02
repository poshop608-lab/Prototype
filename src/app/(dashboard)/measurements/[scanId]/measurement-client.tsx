"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, XCircle, Ruler, Calendar, User, Hash } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { Scan, ScanImage, Profile } from "@/types/database";

interface Props {
  scan: Scan & { worker?: Profile | null };
  image: ScanImage | null;
}

export function ScanDetailClient({ scan, image }: Props) {
  const passed = scan.passed;
  const accentColor = passed === true ? "#22c55e" : passed === false ? "#ef4444" : "#f59e0b";
  const statusLabel = passed === true ? "PASSED" : passed === false ? "REJECTED" : "PENDING";

  const rows = [
    { label: "Left Shoe Height", value: scan.left_height_mm != null ? `${scan.left_height_mm} mm` : "—", highlight: false },
    { label: "Right Shoe Height", value: scan.right_height_mm != null ? `${scan.right_height_mm} mm` : "—", highlight: false },
    { label: "Left Shoe Width", value: scan.left_width_mm != null ? `${scan.left_width_mm} mm` : "—", highlight: false },
    { label: "Right Shoe Width", value: scan.right_width_mm != null ? `${scan.right_width_mm} mm` : "—", highlight: false },
    { label: "Height Difference", value: scan.height_diff_mm != null ? `${scan.height_diff_mm} mm` : "—", highlight: true },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3"
      >
        <Link href="/scans">
          <button className="mt-0.5 p-1.5 rounded-md transition-colors"
            style={{ color: "#666", border: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.03)" }}>
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              Scan Detail
            </h1>
            <span
              className="text-xs font-bold px-2.5 py-1 rounded-full"
              style={{ background: `${accentColor}18`, color: accentColor, border: `1px solid ${accentColor}30` }}
            >
              {statusLabel}
            </span>
          </div>
          <div className="flex items-center gap-3 flex-wrap mt-1 text-xs" style={{ color: "#555" }}>
            <span className="flex items-center gap-1"><Hash className="w-3 h-3" />{scan.scan_id}</span>
            <span>·</span>
            <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{formatDate(scan.created_at)}</span>
            {scan.worker?.full_name && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1"><User className="w-3 h-3" />{scan.worker.full_name}</span>
              </>
            )}
          </div>
        </div>
      </motion.div>

      {/* Pass / Reject banner */}
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.05 }}
        className="rounded-2xl p-5 flex items-center gap-4"
        style={{ background: `${accentColor}10`, border: `1px solid ${accentColor}25` }}
      >
        {passed === true
          ? <CheckCircle2 className="w-8 h-8 flex-shrink-0" style={{ color: accentColor }} />
          : <XCircle className="w-8 h-8 flex-shrink-0" style={{ color: accentColor }} />
        }
        <div>
          <p className="font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            {passed === true ? "Height match within tolerance" : "Height mismatch detected"}
          </p>
          {scan.rejection_reason && (
            <p className="text-sm mt-0.5" style={{ color: "#888" }}>{scan.rejection_reason}</p>
          )}
        </div>
      </motion.div>

      {/* Measurements table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-2xl overflow-hidden"
        style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="flex items-center gap-2 px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
          <Ruler className="w-4 h-4" style={{ color: "#06b6d4" }} />
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#555" }}>Measurements</p>
        </div>
        <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
          {rows.map(({ label, value, highlight }) => (
            <div key={label} className="flex items-center justify-between px-5 py-3.5">
              <span className="text-sm" style={{ color: "#666" }}>{label}</span>
              <span
                className="text-sm font-bold tabular-nums"
                style={{ color: highlight ? accentColor : "white" }}
              >
                {value}
              </span>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Annotated image */}
      {image?.public_url && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <div className="px-5 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.02)" }}>
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#555" }}>Captured Image</p>
          </div>
          <img
            src={image.public_url}
            alt="Shoe pair with measurement annotations"
            className="w-full object-cover"
          />
        </motion.div>
      )}

      {/* Meta */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="rounded-2xl overflow-hidden"
        style={{ background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
          {[
            { label: "Batch ID", value: scan.batch_id },
            { label: "Scan ID", value: scan.scan_id },
            { label: "Worker", value: scan.worker?.full_name || scan.worker?.email || "—" },
            { label: "Date", value: formatDate(scan.created_at) },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between px-5 py-3">
              <span className="text-xs font-medium uppercase tracking-wider" style={{ color: "#444" }}>{label}</span>
              <span className="text-xs font-mono" style={{ color: "#888" }}>{value}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
