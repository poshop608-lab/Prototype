"use client";

import { motion } from "framer-motion";
import { CheckCircle2, Circle } from "lucide-react";
import { useScanStore, CAPTURE_ORDER } from "@/store/scan";
import { cn } from "@/lib/utils";
import type { CaptureAngle } from "@/types/database";

const ANGLE_LABELS: Record<CaptureAngle, { short: string; emoji: string }> = {
  top: { short: "Top", emoji: "⬆️" },
  left: { short: "Left", emoji: "◀️" },
  right: { short: "Right", emoji: "▶️" },
  front: { short: "Front", emoji: "👟" },
  back: { short: "Back", emoji: "🔙" },
  sole: { short: "Sole", emoji: "⬇️" },
};

export function AngleProgress() {
  const { capturedImages, currentAngle, setCurrentAngle } = useScanStore();
  const capturedAngles = new Set(capturedImages.map((i) => i.angle));

  return (
    <div className="flex items-center gap-1.5">
      {CAPTURE_ORDER.map((angle, i) => {
        const captured = capturedAngles.has(angle);
        const isCurrent = currentAngle === angle;
        const label = ANGLE_LABELS[angle];

        return (
          <button
            key={angle}
            onClick={() => setCurrentAngle(angle)}
            className={cn(
              "flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg transition-all duration-150",
              isCurrent && "bg-sv-gray-700",
              !isCurrent && !captured && "opacity-50"
            )}
          >
            <div className="relative">
              {captured ? (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                >
                  <CheckCircle2 className="w-5 h-5 text-sv-green" />
                </motion.div>
              ) : (
                <Circle
                  className={cn(
                    "w-5 h-5",
                    isCurrent ? "text-sv-white" : "text-sv-gray-600"
                  )}
                />
              )}
              {isCurrent && !captured && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-sv-white animate-ping" />
              )}
            </div>
            <span
              className={cn(
                "text-[9px] font-medium uppercase tracking-wider",
                isCurrent ? "text-sv-white" : "text-sv-gray-500"
              )}
            >
              {label.short}
            </span>
          </button>
        );
      })}
    </div>
  );
}
