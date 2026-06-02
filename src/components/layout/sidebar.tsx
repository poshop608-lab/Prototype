"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  ScanLine,
  History,
  Shield,
  LogOut,
  Scan,
  User,
  Zap,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuthStore } from "@/store/auth";
import { cn } from "@/lib/utils";

const navItems = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
    roles: ["admin", "worker", "qc_inspector"],
  },
  {
    label: "New Scan",
    href: "/scan",
    icon: ScanLine,
    roles: ["admin", "worker"],
    accent: true,
  },
  {
    label: "Scan History",
    href: "/scans",
    icon: History,
    roles: ["admin", "worker", "qc_inspector"],
  },
  {
    label: "Admin Panel",
    href: "/admin",
    icon: Shield,
    roles: ["admin"],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { profile, reset } = useAuthStore();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const supabase = createClient();

  async function handleSignOut() {
    setIsSigningOut(true);
    await supabase.auth.signOut();
    reset();
    window.location.href = "/login";
  }

  const filteredNav = navItems.filter(
    (item) => !profile?.role || item.roles.includes(profile.role)
  );

  return (
    <div className="flex flex-col h-full w-64 relative overflow-hidden"
      style={{
        background: "linear-gradient(180deg, #0A0A0F 0%, #080810 100%)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Ambient glow top */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-32 rounded-full opacity-20 pointer-events-none"
        style={{ background: "radial-gradient(circle, #06b6d4 0%, transparent 70%)" }}
      />

      {/* Logo */}
      <div className="px-5 pt-6 pb-5 relative"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-3">
          <div className="relative w-9 h-9 flex-shrink-0">
            <div className="absolute inset-0 rounded-xl opacity-40 blur-sm"
              style={{ background: "linear-gradient(135deg, #06b6d4, #3b82f6)" }}
            />
            <div className="relative w-9 h-9 rounded-xl flex items-center justify-center"
              style={{
                background: "linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)",
                boxShadow: "0 0 16px rgba(6,182,212,0.4)",
              }}
            >
              <Scan className="w-4.5 h-4.5 text-white" />
            </div>
          </div>
          <div>
            <div className="text-white font-semibold text-sm leading-none tracking-tight">
              StrideVision
            </div>
            <div className="text-[10px] tracking-widest uppercase mt-1"
              style={{ color: "#06b6d4" }}
            >
              AI Measurement
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {filteredNav.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          const Icon = item.icon;

          return (
            <Link key={item.href} href={item.href}>
              <div className={cn(
                "relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 group cursor-pointer",
                isActive
                  ? "text-white"
                  : "text-[#666] hover:text-white"
              )}
                style={isActive ? {
                  background: "linear-gradient(90deg, rgba(6,182,212,0.15) 0%, rgba(59,130,246,0.08) 100%)",
                  border: "1px solid rgba(6,182,212,0.2)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
                } : {
                  border: "1px solid transparent",
                }}
              >
                {/* Active indicator */}
                {isActive && (
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full"
                    style={{ background: "linear-gradient(180deg, #06b6d4, #3b82f6)", boxShadow: "0 0 8px #06b6d4" }}
                    initial={false}
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}

                {/* Icon */}
                <div className={cn(
                  "w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all duration-200",
                  isActive
                    ? "text-cyan-400"
                    : item.accent
                    ? "text-cyan-500 group-hover:text-cyan-400"
                    : "text-[#555] group-hover:text-[#aaa]"
                )}
                  style={isActive ? {
                    background: "rgba(6,182,212,0.15)",
                  } : {}}
                >
                  <Icon className="w-4 h-4" />
                </div>

                <span className="font-medium flex-1">{item.label}</span>

                {item.accent && !isActive && (
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse"
                    style={{ background: "#06b6d4", boxShadow: "0 0 6px #06b6d4" }}
                  />
                )}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* System status badge */}
      <div className="px-4 mb-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{
            background: "rgba(34,197,94,0.08)",
            border: "1px solid rgba(34,197,94,0.15)",
          }}
        >
          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-[11px] text-green-400 font-medium">System Online</span>
          <Zap className="w-3 h-3 text-green-400 ml-auto" />
        </div>
      </div>

      {/* User section */}
      <div className="p-3"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-3 px-2 py-2 rounded-xl group">
          <div className="relative w-8 h-8 flex-shrink-0">
            <div className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{
                background: "linear-gradient(135deg, #1a1a2e, #16213e)",
                border: "1px solid rgba(6,182,212,0.3)",
              }}
            >
              <User className="w-3.5 h-3.5 text-cyan-400" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-400 border-2"
              style={{ borderColor: "#080810" }}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-white truncate">
              {profile?.full_name || "User"}
            </div>
            <div className="text-[10px] capitalize"
              style={{ color: "#06b6d4" }}
            >
              {profile?.role?.replace("_", " ") || "worker"}
            </div>
          </div>
          <button
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="p-1.5 rounded-lg transition-all duration-200 cursor-pointer"
            style={{ color: "#555" }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.color = "#ef4444";
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.1)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.color = "#555";
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
            title="Sign out"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
