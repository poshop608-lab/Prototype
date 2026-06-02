"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  ScanLine, CheckCircle2, XCircle, Clock, ChevronRight,
  Camera, ArrowUpRight, Activity,
} from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import type { Profile, Scan } from "@/types/database";

interface Props {
  recentScans: Scan[];
  stats: { total: number; passed: number; rejected: number; pending: number };
  profile: Profile | null;
}

function AnimatedNumber({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const end = value;
    el.textContent = "0";
    const duration = 700;
    const step = (timestamp: number, startTime: number) => {
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = String(Math.round(end * eased));
      if (progress < 1) requestAnimationFrame((t) => step(t, startTime));
    };
    requestAnimationFrame((t) => step(t, t));
  }, [value]);
  return <span ref={ref}>{value}</span>;
}

const statCards = (stats: Props["stats"]) => [
  {
    label: "Total Scans",
    value: stats.total,
    icon: Activity,
    accent: "#06b6d4",
    bg: "rgba(6,182,212,0.08)",
    border: "rgba(6,182,212,0.15)",
  },
  {
    label: "Passed",
    value: stats.passed,
    icon: CheckCircle2,
    accent: "#22c55e",
    bg: "rgba(34,197,94,0.08)",
    border: "rgba(34,197,94,0.15)",
  },
  {
    label: "Rejected",
    value: stats.rejected,
    icon: XCircle,
    accent: "#ef4444",
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.15)",
  },
  {
    label: "Pending",
    value: stats.pending,
    icon: Clock,
    accent: "#f59e0b",
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.15)",
  },
];

export function DashboardClient({ recentScans, stats, profile }: Props) {
  const cards = statCards(stats);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-8 pb-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex items-start justify-between"
      >
        <div>
          <p className="text-sm font-medium mb-1" style={{ color: "#06b6d4" }}>
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
          <h1 className="text-3xl font-bold text-white tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            {greeting}{profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}
          </h1>
          <p className="text-sm mt-1" style={{ color: "#555" }}>
            Shoe pair inspection dashboard
          </p>
        </div>
        <Link href="/scan">
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-black cursor-pointer"
            style={{ background: "linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)", boxShadow: "0 0 20px rgba(6,182,212,0.3)" }}
          >
            <Camera className="w-4 h-4" />
            New Scan
          </motion.button>
        </Link>
      </motion.div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card, i) => {
          const Icon = card.icon;
          return (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
              whileHover={{ y: -2, transition: { duration: 0.2 } }}
              className="relative rounded-2xl p-5 overflow-hidden cursor-default"
              style={{ background: card.bg, border: `1px solid ${card.border}` }}
            >
              <div className="absolute -top-6 -right-6 w-20 h-20 rounded-full opacity-30 pointer-events-none"
                style={{ background: `radial-gradient(circle, ${card.accent}, transparent 70%)` }}
              />
              <div className="relative">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#555" }}>
                    {card.label}
                  </p>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${card.accent}20` }}>
                    <Icon className="w-4 h-4" style={{ color: card.accent }} />
                  </div>
                </div>
                <p className="text-4xl font-black text-white tabular-nums" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  <AnimatedNumber value={card.value} />
                </p>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Quick actions */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.4 }}
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        <Link href="/scan">
          <motion.div
            whileHover={{ scale: 1.01, y: -1 }}
            whileTap={{ scale: 0.99 }}
            className="relative group flex items-center gap-4 p-5 rounded-2xl cursor-pointer overflow-hidden"
            style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.12), rgba(59,130,246,0.06))", border: "1px solid rgba(6,182,212,0.2)" }}
          >
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
              style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.18), rgba(59,130,246,0.1))" }}
            />
            <div className="relative w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: "linear-gradient(135deg, #06b6d4, #3b82f6)", boxShadow: "0 0 16px rgba(6,182,212,0.4)" }}>
              <Camera className="w-6 h-6 text-white" />
            </div>
            <div className="relative flex-1">
              <div className="font-bold text-white text-base" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Start New Inspection</div>
              <div className="text-xs mt-0.5" style={{ color: "#666" }}>Detect and compare both shoes</div>
            </div>
            <ArrowUpRight className="relative w-5 h-5 opacity-40 group-hover:opacity-100 transition-opacity" style={{ color: "#06b6d4" }} />
          </motion.div>
        </Link>

        <Link href="/scans">
          <motion.div
            whileHover={{ scale: 1.01, y: -1 }}
            whileTap={{ scale: 0.99 }}
            className="relative group flex items-center gap-4 p-5 rounded-2xl cursor-pointer overflow-hidden"
            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}
          >
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
              style={{ background: "rgba(255,255,255,0.03)" }}
            />
            <div className="relative w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}>
              <ScanLine className="w-6 h-6" style={{ color: "#888" }} />
            </div>
            <div className="relative flex-1">
              <div className="font-bold text-white text-base" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>View Scan History</div>
              <div className="text-xs mt-0.5" style={{ color: "#666" }}>Browse passed and rejected scans</div>
            </div>
            <ChevronRight className="relative w-5 h-5 opacity-30 group-hover:opacity-70 transition-opacity text-white" />
          </motion.div>
        </Link>
      </motion.div>

      {/* Recent scans */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.4 }}
        className="rounded-2xl overflow-hidden"
        style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4" style={{ color: "#06b6d4" }} />
            <h2 className="font-bold text-white text-sm uppercase tracking-wider" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              Recent Scans
            </h2>
          </div>
          <Link href="/scans">
            <span className="text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity" style={{ color: "#06b6d4" }}>
              View all →
            </span>
          </Link>
        </div>

        {recentScans.length === 0 ? (
          <div className="py-16 text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: "rgba(6,182,212,0.08)", border: "1px solid rgba(6,182,212,0.15)" }}>
              <Camera className="w-7 h-7" style={{ color: "#06b6d4" }} />
            </div>
            <p className="font-bold text-white mb-1" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>No scans yet</p>
            <p className="text-sm mb-5" style={{ color: "#555" }}>Start your first inspection</p>
            <Link href="/scan">
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-black cursor-pointer"
                style={{ background: "linear-gradient(135deg, #06b6d4, #3b82f6)" }}
              >
                <Camera className="w-4 h-4" />
                Start scanning
              </motion.button>
            </Link>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
            {recentScans.map((scan, i) => {
              const passed = scan.passed;
              const accentColor = passed === true ? "#22c55e" : passed === false ? "#ef4444" : "#f59e0b";
              return (
                <motion.div
                  key={scan.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.35 + i * 0.05 }}
                >
                  <Link href={`/measurements/${scan.id}`}>
                    <div className="flex items-center gap-4 px-6 py-4 hover:bg-white/[0.02] transition-colors group cursor-pointer">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                        style={{ background: `${accentColor}12`, border: `1px solid ${accentColor}20` }}>
                        {passed === true
                          ? <CheckCircle2 className="w-4 h-4" style={{ color: accentColor }} />
                          : <XCircle className="w-4 h-4" style={{ color: accentColor }} />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-white truncate" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                          {passed === true ? "PASSED" : passed === false ? "REJECTED" : "PENDING"}
                        </div>
                        <div className="text-xs mt-0.5 truncate flex gap-2" style={{ color: "#555" }}>
                          <span>{scan.scan_id}</span>
                          {scan.height_diff_mm != null && (
                            <>
                              <span>·</span>
                              <span style={{ color: accentColor }}>Δ {scan.height_diff_mm}mm</span>
                            </>
                          )}
                          <span>·</span>
                          <span>{formatRelativeTime(scan.created_at)}</span>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 opacity-30 group-hover:opacity-70 transition-opacity text-white" />
                    </div>
                  </Link>
                </motion.div>
              );
            })}
          </div>
        )}
      </motion.div>
    </div>
  );
}
