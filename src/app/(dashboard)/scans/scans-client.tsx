"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { CheckCircle2, XCircle, ChevronRight, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelativeTime } from "@/lib/utils";
import type { Scan, Profile } from "@/types/database";

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

export function ScansClient({ scans }: { scans: ScanWithWorker[] }) {
  const [search, setSearch] = useState("");

  const filtered = scans.filter((s) =>
    !search ||
    s.scan_id.toLowerCase().includes(search.toLowerCase()) ||
    s.batch_id.toLowerCase().includes(search.toLowerCase())
  );

  const passed = filtered.filter((s) => s.passed === true);
  const rejected = filtered.filter((s) => s.passed === false);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            Scan History
          </h1>
          <p className="text-sm mt-1" style={{ color: "#555" }}>
            {filtered.length} total · {passed.length} passed · {rejected.length} rejected
          </p>
        </div>
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
  );
}
