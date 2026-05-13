"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Ruler,
  Download,
  Share2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatDate, formatMeasurement } from "@/lib/utils";
import type { Scan, Measurement, ScanImage } from "@/types/database";

interface Props {
  scan: Scan & {
    shoe_model?: { name: string; brand: string; category: string } | null;
    worker?: { full_name: string | null; email: string } | null;
  };
  measurement: Measurement | null;
  images: ScanImage[];
}

// Technical blueprint SVG visualization
function ShoeBlueprintSVG({ measurement }: { measurement: Measurement | null }) {
  if (!measurement) {
    return (
      <div className="w-full h-48 flex items-center justify-center text-sv-gray-600">
        <div className="text-center">
          <Ruler className="w-8 h-8 mx-auto mb-2" />
          <p className="text-sm">Measurements pending</p>
        </div>
      </div>
    );
  }

  const length = measurement.shoe_length_mm || 265;
  const toeW = measurement.toe_width_mm || 95;
  const heelW = measurement.heel_width_mm || 72;

  // Scale to fit SVG
  const scaleX = 280 / length;
  const svgLength = 280;
  const svgToeW = toeW * scaleX * 0.8;
  const svgHeelW = heelW * scaleX * 0.8;
  const svgMidW = ((toeW + heelW) / 2) * scaleX * 0.85;

  const cx = 220;
  const cy = 100;

  return (
    <svg viewBox="0 0 440 200" className="w-full" style={{ maxHeight: 200 }}>
      <defs>
        <marker
          id="arrow"
          markerWidth="6"
          markerHeight="6"
          refX="3"
          refY="3"
          orient="auto"
        >
          <path d="M 0 0 L 6 3 L 0 6 Z" fill="#3D3D3D" />
        </marker>
      </defs>

      {/* Grid background */}
      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#1C1C1C" strokeWidth="0.5" />
      </pattern>
      <rect width="440" height="200" fill="url(#grid)" />

      {/* Shoe top silhouette */}
      <path
        d={`
          M ${cx - svgLength / 2} ${cy}
          Q ${cx - svgLength / 2 + 20} ${cy - svgHeelW / 2}
            ${cx - svgLength / 4} ${cy - svgMidW / 2}
          Q ${cx + svgLength / 4} ${cy - svgToeW / 2 - 5}
            ${cx + svgLength / 2} ${cy - svgToeW / 2 + 5}
          Q ${cx + svgLength / 2 + 10} ${cy}
            ${cx + svgLength / 2} ${cy + svgToeW / 2 - 5}
          Q ${cx + svgLength / 4} ${cy + svgToeW / 2 + 5}
            ${cx - svgLength / 4} ${cy + svgMidW / 2}
          Q ${cx - svgLength / 2 + 20} ${cy + svgHeelW / 2}
            ${cx - svgLength / 2} ${cy}
          Z
        `}
        fill="#1C1C1C"
        stroke="#3D3D3D"
        strokeWidth="1"
      />

      {/* Length dimension line */}
      <line
        x1={cx - svgLength / 2}
        y1={cy + 45}
        x2={cx + svgLength / 2}
        y2={cy + 45}
        stroke="#3D3D3D"
        strokeWidth="0.8"
        markerEnd="url(#arrow)"
        markerStart="url(#arrow)"
      />
      <text x={cx} y={cy + 58} textAnchor="middle" fill="#666" fontSize="9" fontFamily="monospace">
        {formatMeasurement(measurement.shoe_length_mm || 0)}
      </text>

      {/* Toe width line */}
      <line
        x1={cx + svgLength / 2 - 8}
        y1={cy - svgToeW / 2}
        x2={cx + svgLength / 2 - 8}
        y2={cy + svgToeW / 2}
        stroke="#3D3D3D"
        strokeWidth="0.8"
        markerEnd="url(#arrow)"
        markerStart="url(#arrow)"
      />

      {/* Labels */}
      <text x="12" y="16" fill="#2E2E2E" fontSize="8" fontFamily="monospace" letterSpacing="1">
        STRIDE VISION — TECHNICAL MEASUREMENT
      </text>
      <text x="12" y="192" fill="#2E2E2E" fontSize="7" fontFamily="monospace">
        ACCURACY: {measurement.overall_accuracy?.toFixed(1)}%
      </text>
    </svg>
  );
}

const measurementFields = [
  { key: "shoe_length_mm", label: "Shoe Length", icon: "↔" },
  { key: "toe_width_mm", label: "Toe Width", icon: "↕" },
  { key: "heel_width_mm", label: "Heel Width", icon: "↕" },
  { key: "sole_length_mm", label: "Sole Length", icon: "↔" },
  { key: "sole_width_mm", label: "Sole Width", icon: "↕" },
  { key: "heel_height_mm", label: "Heel Height", icon: "↑" },
  { key: "instep_height_mm", label: "Instep Height", icon: "↑" },
] as const;

export function MeasurementClient({ scan, measurement, images }: Props) {
  const statusVariant = {
    completed: "success" as const,
    processing: "processing" as const,
    pending: "warning" as const,
    failed: "destructive" as const,
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-4"
      >
        <Link href="/scans">
          <button className="mt-1 p-1.5 rounded-md text-sv-gray-400 hover:text-sv-white hover:bg-sv-gray-800 transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold text-sv-white">
              {scan.shoe_model?.brand} {scan.shoe_model?.name}
            </h1>
            <Badge variant={statusVariant[scan.status] || "default"}>
              {scan.status}
            </Badge>
          </div>
          <div className="text-sv-gray-400 text-sm mt-1 flex items-center gap-3 flex-wrap">
            <span>{scan.scan_id}</span>
            <span>·</span>
            <span>EU {scan.size}</span>
            <span>·</span>
            <span>Batch {scan.batch_id}</span>
            <span>·</span>
            <span>{formatDate(scan.created_at)}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-1.5">
            <Download className="w-3.5 h-3.5" />
            Export
          </Button>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Blueprint visualization */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="lg:col-span-2"
        >
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-sv-gray-700 flex items-center justify-center">
                  <span className="text-[10px] text-sv-gray-300">↔</span>
                </div>
                Technical Blueprint
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="rounded-lg bg-sv-black border border-sv-gray-800 overflow-hidden">
                <ShoeBlueprintSVG measurement={measurement} />
              </div>

              {/* Accuracy */}
              {measurement?.overall_accuracy && (
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-sv-gray-400">Overall Accuracy</span>
                    <span
                      className="font-semibold"
                      style={{
                        color:
                          measurement.overall_accuracy >= 90
                            ? "#22C55E"
                            : measurement.overall_accuracy >= 75
                            ? "#F59E0B"
                            : "#EF4444",
                      }}
                    >
                      {measurement.overall_accuracy.toFixed(1)}%
                    </span>
                  </div>
                  <Progress
                    value={measurement.overall_accuracy}
                    indicatorClassName={
                      measurement.overall_accuracy >= 90
                        ? "bg-sv-green"
                        : measurement.overall_accuracy >= 75
                        ? "bg-amber-400"
                        : "bg-sv-red"
                    }
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Measurements list */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="h-full">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Dimensions</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-1">
              {measurementFields.map((field) => {
                const value = measurement?.[field.key];
                return (
                  <div
                    key={field.key}
                    className="flex items-center justify-between py-2.5 border-b border-sv-gray-800 last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded bg-sv-gray-800 flex items-center justify-center text-[10px] text-sv-gray-400">
                        {field.icon}
                      </span>
                      <span className="text-xs text-sv-gray-400">{field.label}</span>
                    </div>
                    <span className="text-sm font-medium text-sv-white tabular-nums">
                      {value != null ? formatMeasurement(value) : "—"}
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Captured images */}
      {images.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Captured Images ({images.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="aspect-square rounded-lg bg-sv-gray-800 overflow-hidden relative group"
                  >
                    {img.public_url ? (
                      <img
                        src={img.public_url}
                        alt={img.angle}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-sv-gray-600 text-xs capitalize">
                          {img.angle}
                        </span>
                      </div>
                    )}
                    <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between">
                      <span className="text-[9px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded capitalize">
                        {img.angle}
                      </span>
                      {img.alignment_score != null && (
                        <span className="text-[9px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded">
                          {img.alignment_score.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Alignment scores */}
      {scan.alignment_scores && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Alignment Scores</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {Object.entries(scan.alignment_scores as Record<string, number>).map(
                  ([angle, score]) => (
                    <div key={angle} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-sv-gray-400 capitalize">
                          {angle}
                        </span>
                        <span
                          className="text-xs font-medium"
                          style={{
                            color:
                              score >= 85
                                ? "#22C55E"
                                : score >= 60
                                ? "#F59E0B"
                                : "#EF4444",
                          }}
                        >
                          {score.toFixed(0)}%
                        </span>
                      </div>
                      <Progress
                        value={score}
                        indicatorClassName={
                          score >= 85
                            ? "bg-sv-green"
                            : score >= 60
                            ? "bg-amber-400"
                            : "bg-sv-red"
                        }
                      />
                    </div>
                  )
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
