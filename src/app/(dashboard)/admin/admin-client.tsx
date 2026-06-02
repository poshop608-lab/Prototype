"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Users,
  ScanLine,
  CheckCircle2,
  XCircle,
  Download,
  Search,
  Shield,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelativeTime, formatDate } from "@/lib/utils";
import type { Profile, Scan } from "@/types/database";

type ScanWithWorker = Scan & {
  worker?: { full_name: string | null; email: string } | null;
};

interface Stats {
  total: number;
  passed: number;
  rejected: number;
  workers: number;
}

interface Props {
  scans: ScanWithWorker[];
  users: Profile[];
  stats: Stats;
}

const ROLE_VARIANT: Record<string, string> = {
  admin: "destructive",
  qc_inspector: "secondary",
  worker: "outline",
};

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  delay,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  color: string;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
    >
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-sv-gray-500 mb-1">{label}</p>
              <p className="text-2xl font-semibold text-sv-white tabular-nums">
                {value}
              </p>
            </div>
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${color}18` }}
            >
              <Icon className="w-4 h-4" style={{ color }} />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function exportCSV(data: Record<string, unknown>[], filename: string) {
  if (!data.length) return;
  const keys = Object.keys(data[0]);
  const csv = [
    keys.join(","),
    ...data.map((row) =>
      keys
        .map((k) => {
          const v = row[k];
          if (v == null) return "";
          if (typeof v === "object") return JSON.stringify(JSON.stringify(v));
          return String(v).includes(",") ? `"${v}"` : String(v);
        })
        .join(",")
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function AdminClient({ scans, users, stats }: Props) {
  const [scanSearch, setScanSearch] = useState("");
  const [scanStatus, setScanStatus] = useState("all");
  const [userSearch, setUserSearch] = useState("");
  const [userRole, setUserRole] = useState("all");
  const [sortField, setSortField] = useState<"created_at" | "scan_id">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filteredScans = scans
    .filter((s) => {
      const q = scanSearch.toLowerCase();
      const matchSearch =
        !q ||
        s.scan_id.toLowerCase().includes(q) ||
        s.batch_id.toLowerCase().includes(q) ||
        s.worker?.full_name?.toLowerCase().includes(q) ||
        s.worker?.email.toLowerCase().includes(q);
      const matchStatus =
        scanStatus === "all" ||
        (scanStatus === "passed" && s.passed === true) ||
        (scanStatus === "rejected" && s.passed === false) ||
        (scanStatus === "pending" && s.passed === null);
      return matchSearch && matchStatus;
    })
    .sort((a, b) => {
      const av = a[sortField] ?? "";
      const bv = b[sortField] ?? "";
      return sortDir === "asc" ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
    });

  const filteredUsers = users.filter((u) => {
    const q = userSearch.toLowerCase();
    const matchSearch =
      !q ||
      u.full_name?.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q);
    const matchRole = userRole === "all" || u.role === userRole;
    return matchSearch && matchRole;
  });

  function toggleSort(field: typeof sortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sv-gray-800 flex items-center justify-center">
            <Shield className="w-4 h-4 text-sv-gray-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-sv-white">Admin Panel</h1>
            <p className="text-sv-gray-500 text-xs">System management</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() =>
            exportCSV(
              filteredScans.map((s) => ({
                scan_id: s.scan_id,
                batch_id: s.batch_id,
                left_height_mm: s.left_height_mm ?? "",
                right_height_mm: s.right_height_mm ?? "",
                height_diff_mm: s.height_diff_mm ?? "",
                passed: s.passed === true ? "passed" : s.passed === false ? "rejected" : "pending",
                rejection_reason: s.rejection_reason ?? "",
                worker: s.worker?.full_name || s.worker?.email,
                created_at: s.created_at,
              })),
              `stridevision-scans-${new Date().toISOString().slice(0, 10)}.csv`
            )
          }
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </Button>
      </motion.div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Scans" value={stats.total} icon={ScanLine} color="#9CA3AF" delay={0} />
        <StatCard label="Passed" value={stats.passed} icon={CheckCircle2} color="#22C55E" delay={0.05} />
        <StatCard label="Rejected" value={stats.rejected} icon={XCircle} color="#EF4444" delay={0.1} />
        <StatCard label="Workers" value={stats.workers} icon={Users} color="#A78BFA" delay={0.15} />
      </div>

      {/* Tabs */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <Tabs defaultValue="scans">
          <TabsList className="mb-4">
            <TabsTrigger value="scans">
              Scans ({filteredScans.length})
            </TabsTrigger>
            <TabsTrigger value="users">
              Users ({filteredUsers.length})
            </TabsTrigger>
          </TabsList>

          {/* Scans Tab */}
          <TabsContent value="scans" className="space-y-3">
            <div className="flex gap-3 flex-wrap">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sv-gray-500" />
                <Input
                  placeholder="Search scan ID, batch, worker..."
                  value={scanSearch}
                  onChange={(e) => setScanSearch(e.target.value)}
                  className="pl-8 h-9 text-sm"
                />
              </div>
              <Select value={scanStatus} onValueChange={setScanStatus}>
                <SelectTrigger className="w-36 h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All status</SelectItem>
                  <SelectItem value="passed">Passed</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-sv-gray-800">
                      <th
                        className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium cursor-pointer hover:text-sv-white transition-colors"
                        onClick={() => toggleSort("scan_id")}
                      >
                        <span className="flex items-center gap-1">
                          Scan ID
                          {sortField === "scan_id" ? (
                            sortDir === "asc" ? (
                              <ChevronUp className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )
                          ) : null}
                        </span>
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        Worker
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        L Height
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        R Height
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        Diff
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        Status
                      </th>
                      <th
                        className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium cursor-pointer hover:text-sv-white transition-colors"
                        onClick={() => toggleSort("created_at")}
                      >
                        <span className="flex items-center gap-1">
                          Date
                          {sortField === "created_at" ? (
                            sortDir === "asc" ? (
                              <ChevronUp className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )
                          ) : null}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredScans.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-4 py-12 text-center text-sv-gray-600 text-sm"
                        >
                          No scans found
                        </td>
                      </tr>
                    ) : (
                      filteredScans.map((scan) => {
                        const isPassed = scan.passed === true;
                        const isRejected = scan.passed === false;
                        const statusColor = isPassed ? "#22c55e" : isRejected ? "#ef4444" : "#f59e0b";
                        const statusLabel = isPassed ? "PASSED" : isRejected ? "REJECTED" : "PENDING";
                        return (
                          <tr
                            key={scan.id}
                            className="border-b border-sv-gray-900 hover:bg-sv-gray-900/50 transition-colors"
                          >
                            <td className="px-4 py-3">
                              <div>
                                <span className="font-mono text-xs text-sv-white">
                                  {scan.scan_id}
                                </span>
                                <div className="text-sv-gray-600 text-[10px]">
                                  {scan.batch_id}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="text-xs text-sv-gray-400">
                                {scan.worker?.full_name || scan.worker?.email || "—"}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-xs text-sv-gray-300">
                                {scan.left_height_mm != null ? `${scan.left_height_mm}mm` : "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-xs text-sv-gray-300">
                                {scan.right_height_mm != null ? `${scan.right_height_mm}mm` : "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className="text-xs font-medium"
                                style={{ color: scan.height_diff_mm != null ? statusColor : "#555" }}
                              >
                                {scan.height_diff_mm != null ? `Δ ${scan.height_diff_mm}mm` : "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                style={{
                                  color: statusColor,
                                  background: `${statusColor}18`,
                                  border: `1px solid ${statusColor}30`,
                                }}
                              >
                                {statusLabel}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-xs text-sv-gray-500">
                                {formatRelativeTime(scan.created_at)}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </TabsContent>

          {/* Users Tab */}
          <TabsContent value="users" className="space-y-3">
            <div className="flex gap-3 flex-wrap">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sv-gray-500" />
                <Input
                  placeholder="Search users..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="pl-8 h-9 text-sm"
                />
              </div>
              <Select value={userRole} onValueChange={setUserRole}>
                <SelectTrigger className="w-36 h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="qc_inspector">QC Inspector</SelectItem>
                  <SelectItem value="worker">Worker</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-sv-gray-800">
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        Name
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        Email
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        Role
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-sv-gray-500 font-medium">
                        Joined
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.length === 0 ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-4 py-12 text-center text-sv-gray-600 text-sm"
                        >
                          No users found
                        </td>
                      </tr>
                    ) : (
                      filteredUsers.map((user) => (
                        <tr
                          key={user.id}
                          className="border-b border-sv-gray-900 hover:bg-sv-gray-900/50 transition-colors"
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-full bg-sv-gray-800 flex items-center justify-center flex-shrink-0">
                                <span className="text-[10px] text-sv-gray-400 font-medium">
                                  {(user.full_name || user.email)
                                    .charAt(0)
                                    .toUpperCase()}
                                </span>
                              </div>
                              <span className="text-xs text-sv-white">
                                {user.full_name || "—"}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs text-sv-gray-400">
                              {user.email}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <Badge
                              variant={(ROLE_VARIANT[user.role] || "default") as "destructive" | "secondary" | "outline" | "default"}
                            >
                              {user.role}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs text-sv-gray-500">
                              {formatDate(user.created_at)}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </motion.div>
    </div>
  );
}
