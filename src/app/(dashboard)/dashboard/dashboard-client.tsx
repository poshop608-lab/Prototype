"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import {
  ScanLine,
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  Loader2,
  Package,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/utils";
import type { Profile, Scan } from "@/types/database";

interface Props {
  recentScans: (Scan & { shoe_model?: { name: string; brand: string } | null })[];
  stats: { total: number; completed: number; processing: number; pending: number };
  profile: Profile | null;
}

const statusVariant: Record<string, "success" | "processing" | "warning" | "destructive" | "default"> = {
  completed: "success",
  processing: "processing",
  pending: "warning",
  failed: "destructive",
};

const statCards = (stats: Props["stats"]) => [
  {
    label: "Total Scans",
    value: stats.total,
    icon: ScanLine,
    color: "text-sv-white",
    bg: "bg-sv-gray-700",
  },
  {
    label: "Completed",
    value: stats.completed,
    icon: CheckCircle2,
    color: "text-sv-green",
    bg: "bg-sv-green/10",
  },
  {
    label: "Processing",
    value: stats.processing,
    icon: Loader2,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    animate: true,
  },
  {
    label: "Pending",
    value: stats.pending,
    icon: Clock,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
  },
];

export function DashboardClient({ recentScans, stats, profile }: Props) {
  const cards = statCards(stats);

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex items-start justify-between"
      >
        <div>
          <h1 className="text-2xl font-semibold text-sv-white">
            {profile?.full_name
              ? `Welcome back, ${profile.full_name.split(" ")[0]}`
              : "Dashboard"}
          </h1>
          <p className="text-sv-gray-400 text-sm mt-1">
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        <Link href="/scan">
          <Button size="sm" className="gap-2">
            <ScanLine className="w-4 h-4" />
            New Scan
          </Button>
        </Link>
      </motion.div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((card, i) => {
          const Icon = card.icon;
          return (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.3 }}
            >
              <Card className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs text-sv-gray-500 uppercase tracking-wider mb-2">
                      {card.label}
                    </p>
                    <p className="text-3xl font-light text-sv-white tabular-nums">
                      {card.value}
                    </p>
                  </div>
                  <div className={`w-9 h-9 rounded-lg ${card.bg} flex items-center justify-center flex-shrink-0`}>
                    <Icon
                      className={`w-4 h-4 ${card.color} ${card.animate ? "animate-spin" : ""}`}
                    />
                  </div>
                </div>
              </Card>
            </motion.div>
          );
        })}
      </div>

      {/* Quick actions */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.3 }}
        className="grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        <Link href="/scan">
          <Card className="p-5 border-sv-gray-600 hover:border-sv-gray-500 transition-colors cursor-pointer group">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-sv-white flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
                <ScanLine className="w-6 h-6 text-sv-black" />
              </div>
              <div className="flex-1">
                <div className="font-semibold text-sv-white text-sm">Start New Scan</div>
                <div className="text-sv-gray-400 text-xs mt-0.5">
                  Capture all 6 angles with guided alignment
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-sv-gray-600 group-hover:text-sv-gray-300 transition-colors" />
            </div>
          </Card>
        </Link>

        <Link href="/scans">
          <Card className="p-5 hover:border-sv-gray-600 transition-colors cursor-pointer group">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-sv-gray-700 flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
                <Package className="w-6 h-6 text-sv-gray-300" />
              </div>
              <div className="flex-1">
                <div className="font-semibold text-sv-white text-sm">View All Scans</div>
                <div className="text-sv-gray-400 text-xs mt-0.5">
                  Browse and manage scan history
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-sv-gray-600 group-hover:text-sv-gray-300 transition-colors" />
            </div>
          </Card>
        </Link>
      </motion.div>

      {/* Recent scans */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.3 }}
      >
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Recent Scans</CardTitle>
              <Link href="/scans">
                <Button variant="ghost" size="sm" className="text-xs text-sv-gray-400">
                  View all
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentScans.length === 0 ? (
              <div className="py-12 text-center">
                <ScanLine className="w-10 h-10 text-sv-gray-700 mx-auto mb-3" />
                <p className="text-sv-gray-400 text-sm">No scans yet</p>
                <p className="text-sv-gray-600 text-xs mt-1">
                  Start your first scan to see it here
                </p>
                <Link href="/scan" className="mt-4 inline-block">
                  <Button size="sm" variant="outline">
                    Start scanning
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-1">
                {recentScans.map((scan, i) => (
                  <motion.div
                    key={scan.id}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.3 + i * 0.04 }}
                  >
                    <Link href={`/measurements/${scan.id}`}>
                      <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-sv-gray-800 transition-colors group">
                        <div className="w-8 h-8 rounded-md bg-sv-gray-700 flex items-center justify-center flex-shrink-0">
                          <ScanLine className="w-4 h-4 text-sv-gray-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-sv-white truncate">
                            {scan.shoe_model?.brand} {scan.shoe_model?.name}
                          </div>
                          <div className="text-xs text-sv-gray-500 mt-0.5">
                            {scan.scan_id} · Size {scan.size} · {formatRelativeTime(scan.created_at)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Badge variant={statusVariant[scan.status] || "default"}>
                            {scan.status}
                          </Badge>
                          <ChevronRight className="w-3.5 h-3.5 text-sv-gray-600 group-hover:text-sv-gray-300 transition-colors" />
                        </div>
                      </div>
                    </Link>
                  </motion.div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
