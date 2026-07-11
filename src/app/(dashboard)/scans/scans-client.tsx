"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, XCircle, ChevronRight, Search, FileDown, X, ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelativeTime } from "@/lib/utils";
import type { Scan } from "@/types/database";
import type { PdfFilter } from "@/lib/export-pdf";

type ScanWithWorker = Scan & { worker?: { full_name: string | null; email: string } | null };

function ScanRow({ scan, i }: { scan: ScanWithWorker; i: number }) {
  const passed = scan.passed;
  const accentColor = passed === true ? "#22c55e" : passed === false ? "#ef4444" : "#f59e0b";

  return (
    <motion.div
      key={scan.id}
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: i * 0.03 }}
    >
      <Link href={`/measurements/${scan.id}`}>
        <Card className="hover:border-sv-gray-600 transition-colors cursor-pointer">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: `${accentColor}15`, border: `1px solid ${accentColor}25` }}
              >
                {passed === true
                  ? <CheckCircle2 className="w-4 h-4" style={{ color: accentColor }} />
                  : <XCircle className="w-4 h-4" style={{ color: accentColor }} />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold" style={{ color: accentColor, fontFamily: "'Space Grotesk', sans-serif" }}>
                    {passed === true ? "PASSED" : "REJECTED"}
                  </span>
                  <span className="text-xs font-mono" style={{ color: "#555" }}>{scan.scan_id}</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap mt-0.5 text-xs" style={{ color: "#555" }}>
                  {scan.left_height_mm != null && (
                    <span>L: {scan.left_height_mm}mm</span>
                  )}
                  {scan.right_height_mm != null && (
                    <>
                      <span>·</span>
                      <span>R: {scan.right_height_mm}mm</span>
                    </>
                  )}
                  {scan.height_diff_mm != null && (
                    <>
                      <span>·</span>
                      <span style={{ color: accentColor }}>Δ {scan.height_diff_mm}mm</span>
                    </>
                  )}
                  {scan.rejection_reason && (
                    <>
                      <span>·</span>
                      <span className="truncate max-w-[180px]" style={{ color: "#ef4444" }}>{scan.rejection_reason}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs hidden md:block" style={{ color: "#444" }}>
                  {formatRelativeTime(scan.created_at)}
                </span>
                <ChevronRight className="w-4 h-4" style={{ color: "#444" }} />
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    </motion.div>
  );
}

// ── PDF Export Modal ──────────────────────────────────────────────────────────

const FILTER_OPTIONS: { label: string; value: PdfFilter["type"] }[] = [
  { label: "All records",   value: "all"      },
  { label: "Last 30 scans", value: "last30"   },
  { label: "Last 7 days",   value: "last7days" },
  { label: "Last 30 days",  value: "last30days"},
  { label: "Custom range",  value: "custom"   },
];

function ExportModal({ scans, onClose }: { scans: ScanWithWorker[]; onClose: () => void }) {
  const [filterType, setFilterType] = useState<PdfFilter["type"]>("all");
  const [fromDate,   setFromDate]   = useState("");
  const [toDate,     setToDate]     = useState("");
  const [exporting,  setExporting]  = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const selectedLabel = FILTER_OPTIONS.find(o => o.value === filterType)?.label ?? "All records";

  const handleExport = async () => {
    setExporting(true);
    const filter: PdfFilter =
      filterType === "custom"
        ? { type: "custom", from: fromDate, to: toDate }
        : { type: filterType as Exclude<PdfFilter["type"], "custom"> };

    // Dynamic import keeps jsPDF out of initial bundle
    const { exportScansPdf } = await import("@/lib/export-pdf");
    exportScansPdf(scans, filter);
    setExporting(false);
    onClose();
  };

  const canExport = filterType !== "custom" || (fromDate && toDate && fromDate <= toDate);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0,  scale: 1    }}
        exit={{ opacity: 0,    y: 24, scale: 0.97 }}
        className="w-full max-w-sm rounded-2xl p-5 space-y-5"
        style={{ background: "#111", border: "1px solid rgba(255,255,255,0.09)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileDown className="w-4 h-4" style={{ color: "#06b6d4" }} />
            <p className="font-bold text-white text-sm" style={{ fontFamily: "'Space Grotesk',sans-serif" }}>
              Export PDF Report
            </p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.05)", color: "#666" }}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Filter dropdown */}
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#444" }}>Date Filter</p>
          <div className="relative">
            <button
              onClick={() => setShowPicker(p => !p)}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm text-white"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              {selectedLabel}
              <ChevronDown className="w-3.5 h-3.5" style={{ color: "#555" }} />
            </button>
            <AnimatePresence>
              {showPicker && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0  }}
                  exit={{ opacity: 0,   y: -4  }}
                  className="absolute z-10 w-full mt-1 rounded-xl overflow-hidden"
                  style={{ background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)" }}
                >
                  {FILTER_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => { setFilterType(opt.value); setShowPicker(false); }}
                      className="w-full text-left px-3 py-2.5 text-sm transition-colors"
                      style={{
                        color: filterType === opt.value ? "#06b6d4" : "#aaa",
                        background: filterType === opt.value ? "rgba(6,182,212,0.08)" : "transparent",
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Custom date range */}
          {filterType === "custom" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="grid grid-cols-2 gap-2"
            >
              <div>
                <p className="text-xs mb-1" style={{ color: "#555" }}>From</p>
                <input
                  type="date"
                  value={fromDate}
                  onChange={e => setFromDate(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-lg text-xs text-white"
                  style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
                />
              </div>
              <div>
                <p className="text-xs mb-1" style={{ color: "#555" }}>To</p>
                <input
                  type="date"
                  value={toDate}
                  onChange={e => setToDate(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-lg text-xs text-white"
                  style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
                />
              </div>
            </motion.div>
          )}
        </div>

        {/* Preview count */}
        <p className="text-xs" style={{ color: "#555" }}>
          {scans.length} total records loaded · PDF will include matching rows
        </p>

        {/* Export button */}
        <button
          onClick={handleExport}
          disabled={!canExport || exporting}
          className="w-full py-3 rounded-xl text-sm font-bold text-black disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ background: "linear-gradient(135deg,#06b6d4,#3b82f6)" }}
        >
          <FileDown className="w-4 h-4" />
          {exporting ? "Generating…" : "Download PDF"}
        </button>
      </motion.div>
    </motion.div>
  );
}

// ── Main client ───────────────────────────────────────────────────────────────

export function ScansClient({ scans }: { scans: ScanWithWorker[] }) {
  const [search,      setSearch]      = useState("");
  const [showExport,  setShowExport]  = useState(false);

  const filtered = scans.filter((s) =>
    !search ||
    s.scan_id.toLowerCase().includes(search.toLowerCase()) ||
    s.batch_id.toLowerCase().includes(search.toLowerCase())
  );

  const passed   = filtered.filter((s) => s.passed === true);
  const rejected = filtered.filter((s) => s.passed === false);

  return (
    <>
      <AnimatePresence>
        {showExport && (
          <ExportModal scans={scans} onClose={() => setShowExport(false)} />
        )}
      </AnimatePresence>

      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              Scan History
            </h1>
            <p className="text-sm mt-1" style={{ color: "#555" }}>
              {filtered.length} total · {passed.length} passed · {rejected.length} rejected
            </p>
          </div>

          {/* Export button */}
          <button
            onClick={() => setShowExport(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold flex-shrink-0"
            style={{
              background: "rgba(6,182,212,0.1)",
              border: "1px solid rgba(6,182,212,0.3)",
              color: "#06b6d4",
            }}
          >
            <FileDown className="w-3.5 h-3.5" />
            Export PDF
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "#555" }} />
          <Input
            placeholder="Search by scan ID or batch..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 text-sm"
          />
        </div>

        {/* Tabs */}
        <Tabs defaultValue="passed">
          <TabsList className="mb-4">
            <TabsTrigger value="passed" className="gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "#22c55e" }} />
              Passed ({passed.length})
            </TabsTrigger>
            <TabsTrigger value="rejected" className="gap-1.5">
              <XCircle className="w-3.5 h-3.5" style={{ color: "#ef4444" }} />
              Rejected ({rejected.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="passed">
            {passed.length === 0 ? (
              <Card>
                <CardContent className="py-16 text-center">
                  <CheckCircle2 className="w-10 h-10 mx-auto mb-3" style={{ color: "rgba(34,197,94,0.3)" }} />
                  <p style={{ color: "#555" }}>No passed scans yet</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-1.5">
                {passed.map((scan, i) => <ScanRow key={scan.id} scan={scan} i={i} />)}
              </div>
            )}
          </TabsContent>

          <TabsContent value="rejected">
            {rejected.length === 0 ? (
              <Card>
                <CardContent className="py-16 text-center">
                  <XCircle className="w-10 h-10 mx-auto mb-3" style={{ color: "rgba(239,68,68,0.3)" }} />
                  <p style={{ color: "#555" }}>No rejected scans</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-1.5">
                {rejected.map((scan, i) => <ScanRow key={scan.id} scan={scan} i={i} />)}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
