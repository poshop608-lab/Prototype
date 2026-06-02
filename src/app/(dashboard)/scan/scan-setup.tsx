"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Camera, CheckCircle2, ScanLine, ArrowRight } from "lucide-react";
import { useScanStore } from "@/store/scan";
import { Input } from "@/components/ui/input";
import { generateScanId } from "@/lib/utils";

const STEPS = ["Setup", "Capture", "Result"];

export function ScanSetup() {
  const router = useRouter();
  const { setConfig, reset } = useScanStore();
  const [batchId, setBatchId] = useState(`BATCH-${Date.now()}`);

  function handleStart() {
    reset();
    setConfig({ batchId: batchId || `BATCH-${Date.now()}` });
    router.push("/scan/capture");
  }

  return (
    <div className="max-w-lg mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="space-y-6"
      >
        {/* Header */}
        <div className="flex items-center gap-4">
          <div className="relative w-12 h-12 flex-shrink-0">
            <div className="absolute inset-0 rounded-xl blur-sm opacity-60"
              style={{ background: "linear-gradient(135deg, #06b6d4, #3b82f6)" }} />
            <div className="relative w-12 h-12 rounded-xl flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #06b6d4, #3b82f6)", boxShadow: "0 0 20px rgba(6,182,212,0.4)" }}>
              <ScanLine className="w-6 h-6 text-white" />
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              Shoe Pair Inspection
            </h1>
            <p className="text-sm mt-0.5" style={{ color: "#555" }}>
              Height comparison — left vs right
            </p>
          </div>
        </div>

        {/* Step indicators */}
        <div className="flex items-center gap-0">
          {STEPS.map((step, i) => (
            <div key={step} className="flex items-center">
              <div className="flex items-center gap-2">
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                  style={i === 0 ? {
                    background: "linear-gradient(135deg, #06b6d4, #3b82f6)",
                    boxShadow: "0 0 10px rgba(6,182,212,0.4)",
                    color: "white",
                  } : {
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    color: "#444",
                  }}
                >
                  {i + 1}
                </div>
                <span className="text-sm font-medium" style={{ color: i === 0 ? "white" : "#444" }}>
                  {step}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className="w-10 h-px mx-3" style={{ background: "rgba(255,255,255,0.07)" }} />
              )}
            </div>
          ))}
        </div>

        {/* Instructions card */}
        <div
          className="rounded-2xl p-5 space-y-4"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#555" }}>
            How to position shoes
          </p>
          {[
            { icon: "1", text: "Place both shoes on a flat table at same height as camera" },
            { icon: "2", text: "Position heels touching in the center, toes pointing outward" },
            { icon: "3", text: "Camera should see the full side profile of both shoes" },
            { icon: "4", text: "Hold still — app detects and measures automatically" },
          ].map(({ icon, text }) => (
            <div key={icon} className="flex items-start gap-3">
              <div
                className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5"
                style={{ background: "rgba(6,182,212,0.1)", color: "#06b6d4", border: "1px solid rgba(6,182,212,0.2)" }}
              >
                {icon}
              </div>
              <p className="text-sm" style={{ color: "#888" }}>{text}</p>
            </div>
          ))}
        </div>

        {/* Detection info */}
        <div
          className="rounded-2xl p-5"
          style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)" }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Camera className="w-4 h-4" style={{ color: "#06b6d4" }} />
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#06b6d4" }}>
              What the camera does
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Detects", value: "Both shoes in one frame" },
              { label: "Measures", value: "Height + width of each" },
              { label: "Compares", value: "Height difference (mm)" },
              { label: "Tolerance", value: "≤ 3mm = PASS, > 3mm = REJECT" },
            ].map(({ label, value }) => (
              <div key={label}>
                <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "#444" }}>{label}</p>
                <p className="text-xs mt-0.5" style={{ color: "#888" }}>{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Batch ID */}
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#555" }}>
            Batch ID <span style={{ color: "#444" }}>(optional)</span>
          </label>
          <Input
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            placeholder="Auto-generated"
            className="h-11 text-white rounded-xl border-0"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
          />
        </div>

        {/* CTA */}
        <motion.button
          onClick={handleStart}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl text-sm font-bold text-black"
          style={{
            background: "linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)",
            boxShadow: "0 0 24px rgba(6,182,212,0.35)",
            cursor: "pointer",
            fontFamily: "'Space Grotesk', sans-serif",
          }}
        >
          <Camera className="w-5 h-5" />
          Open Camera
          <ArrowRight className="w-5 h-5" />
        </motion.button>
      </motion.div>
    </div>
  );
}
