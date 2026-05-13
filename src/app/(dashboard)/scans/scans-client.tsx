"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ScanLine, Search, Filter, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime } from "@/lib/utils";
import type { Scan } from "@/types/database";

type ScanWithRelations = Scan & {
  shoe_model?: { name: string; brand: string; category: string } | null;
  worker?: { full_name: string | null; email: string } | null;
};

const STATUS_VARIANT: Record<string, any> = {
  completed: "success",
  processing: "processing",
  pending: "warning",
  failed: "destructive",
};

export function ScansClient({ scans }: { scans: ScanWithRelations[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = scans.filter((s) => {
    const matchSearch =
      !search ||
      s.scan_id.toLowerCase().includes(search.toLowerCase()) ||
      s.batch_id.toLowerCase().includes(search.toLowerCase()) ||
      s.shoe_model?.name.toLowerCase().includes(search.toLowerCase()) ||
      s.shoe_model?.brand.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || s.status === statusFilter;
    return matchSearch && matchStatus;
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-sv-white">Scan History</h1>
          <p className="text-sv-gray-400 text-sm mt-1">
            {filtered.length} of {scans.length} scans
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sv-gray-500" />
          <Input
            placeholder="Search scans, batches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 text-sm"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36 h-9 text-sm">
            <Filter className="w-3 h-3 mr-1 text-sv-gray-500" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Scan list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <ScanLine className="w-10 h-10 text-sv-gray-700 mx-auto mb-3" />
            <p className="text-sv-gray-400">No scans found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((scan, i) => (
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
                      <div className="w-9 h-9 rounded-lg bg-sv-gray-800 flex items-center justify-center flex-shrink-0">
                        <ScanLine className="w-4 h-4 text-sv-gray-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-sv-white">
                            {scan.shoe_model?.brand} {scan.shoe_model?.name}
                          </span>
                          <Badge variant={STATUS_VARIANT[scan.status] || "default"}>
                            {scan.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-sv-gray-500 mt-0.5 flex gap-2 flex-wrap">
                          <span>{scan.scan_id}</span>
                          <span>·</span>
                          <span>EU {scan.size}</span>
                          <span>·</span>
                          <span>Batch {scan.batch_id}</span>
                          {scan.worker?.full_name && (
                            <>
                              <span>·</span>
                              <span>{scan.worker.full_name}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="text-xs text-sv-gray-500 hidden md:block">
                          {formatRelativeTime(scan.created_at)}
                        </span>
                        <ChevronRight className="w-4 h-4 text-sv-gray-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
