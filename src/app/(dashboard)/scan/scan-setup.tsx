"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, ScanLine } from "lucide-react";
import { useScanStore } from "@/store/scan";
import { generateScanId } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ShoeModel } from "@/types/database";

const SIZES = ["35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48"];

interface Props {
  shoeModels: ShoeModel[];
}

export function ScanSetup({ shoeModels }: Props) {
  const router = useRouter();
  const { setConfig } = useScanStore();
  const [form, setForm] = useState({
    shoeModelId: "",
    size: "",
    batchId: "",
  });

  function handleStart() {
    const model = shoeModels.find((m) => m.id === form.shoeModelId);
    if (!model) return;

    setConfig({
      shoeModelId: form.shoeModelId,
      shoeModelName: `${model.brand} ${model.name}`,
      category: model.category,
      size: form.size,
      batchId: form.batchId || `BATCH-${Date.now()}`,
    });

    router.push("/scan/capture");
  }

  const isReady = form.shoeModelId && form.size;

  return (
    <div className="max-w-lg mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="space-y-8"
      >
        {/* Header */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-sv-white flex items-center justify-center">
              <ScanLine className="w-5 h-5 text-sv-black" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-sv-white">New Scan</h1>
              <p className="text-sv-gray-400 text-sm">Configure scan parameters</p>
            </div>
          </div>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center gap-2">
          {["Configure", "Capture", "Review"].map((step, i) => (
            <div key={step} className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                  i === 0
                    ? "bg-sv-white text-sv-black"
                    : "bg-sv-gray-700 text-sv-gray-500"
                }`}
              >
                {i + 1}
              </div>
              <span
                className={`text-sm ${
                  i === 0 ? "text-sv-white font-medium" : "text-sv-gray-500"
                }`}
              >
                {step}
              </span>
              {i < 2 && (
                <div className="w-8 h-px bg-sv-gray-700 mx-1" />
              )}
            </div>
          ))}
        </div>

        {/* Form */}
        <div className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-sv-gray-300 uppercase tracking-wider">
              Shoe Model *
            </label>
            <Select
              value={form.shoeModelId}
              onValueChange={(v) => setForm({ ...form, shoeModelId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select shoe model..." />
              </SelectTrigger>
              <SelectContent>
                {shoeModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.brand} — {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-sv-gray-300 uppercase tracking-wider">
                Size (EU) *
              </label>
              <Select
                value={form.size}
                onValueChange={(v) => setForm({ ...form, size: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select size..." />
                </SelectTrigger>
                <SelectContent>
                  {SIZES.map((s) => (
                    <SelectItem key={s} value={s}>
                      EU {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-sv-gray-300 uppercase tracking-wider">
                Batch ID
              </label>
              <Input
                type="text"
                value={form.batchId}
                onChange={(e) => setForm({ ...form, batchId: e.target.value })}
                placeholder="Auto-generated"
              />
            </div>
          </div>

          {/* Selected model info */}
          <AnimatePresence>
            {form.shoeModelId && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                {(() => {
                  const model = shoeModels.find((m) => m.id === form.shoeModelId);
                  if (!model) return null;
                  return (
                    <div className="p-4 rounded-xl border border-sv-gray-700 bg-sv-gray-900 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sv-white font-medium text-sm">
                          {model.brand} {model.name}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-sv-gray-700 text-sv-gray-300 capitalize">
                          {model.category}
                        </span>
                      </div>
                      {model.description && (
                        <p className="text-sv-gray-400 text-xs">{model.description}</p>
                      )}
                      <div className="flex gap-4 text-xs text-sv-gray-500">
                        <span>Tolerance: ±{model.tolerance_mm}mm</span>
                        {form.size && <span>Size: EU {form.size}</span>}
                      </div>
                    </div>
                  );
                })()}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* What to expect */}
        <div className="p-4 rounded-xl border border-sv-gray-800 bg-sv-gray-900/50">
          <p className="text-xs text-sv-gray-500 uppercase tracking-wider mb-3 font-semibold">
            Capture sequence
          </p>
          <div className="grid grid-cols-3 gap-2">
            {["Top", "Left", "Right", "Front", "Back", "Sole"].map((a) => (
              <div
                key={a}
                className="flex items-center gap-1.5 text-xs text-sv-gray-400"
              >
                <div className="w-1 h-1 rounded-full bg-sv-gray-600" />
                {a} View
              </div>
            ))}
          </div>
        </div>

        <Button
          size="xl"
          className="w-full gap-3"
          onClick={handleStart}
          disabled={!isReady}
        >
          Start Capture
          <ArrowRight className="w-5 h-5" />
        </Button>
      </motion.div>
    </div>
  );
}
