"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  ScanLine,
  History,
  Ruler,
  Shield,
  LogOut,
  Scan,
  ChevronRight,
  User,
  Settings,
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
    label: "Measurements",
    href: "/measurements",
    icon: Ruler,
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
    router.push("/login");
  }

  const filteredNav = navItems.filter(
    (item) => !profile?.role || item.roles.includes(profile.role)
  );

  return (
    <div className="flex flex-col h-full w-60 bg-sv-gray-950 border-r border-sv-gray-800">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-sv-gray-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sv-white flex items-center justify-center flex-shrink-0">
            <Scan className="w-4 h-4 text-sv-black" />
          </div>
          <div>
            <div className="text-sv-white font-semibold text-sm leading-none">
              StrideVision
            </div>
            <div className="text-sv-gray-500 text-[10px] tracking-widest uppercase mt-1">
              v1.0
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {filteredNav.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          const Icon = item.icon;

          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 group",
                  isActive
                    ? "bg-sv-gray-700 text-sv-white"
                    : "text-sv-gray-400 hover:text-sv-white hover:bg-sv-gray-800"
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-sv-white rounded-full"
                    initial={false}
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
                <Icon
                  className={cn(
                    "w-4 h-4 flex-shrink-0",
                    item.accent && !isActive && "text-sv-white"
                  )}
                />
                <span className="font-medium">{item.label}</span>
                {item.accent && !isActive && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-sv-white" />
                )}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className="border-t border-sv-gray-800 p-3">
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg">
          <div className="w-7 h-7 rounded-full bg-sv-gray-700 flex items-center justify-center flex-shrink-0">
            <User className="w-3.5 h-3.5 text-sv-gray-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-sv-white truncate">
              {profile?.full_name || "User"}
            </div>
            <div className="text-[10px] text-sv-gray-500 capitalize">
              {profile?.role?.replace("_", " ") || "worker"}
            </div>
          </div>
          <button
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="p-1.5 rounded-md text-sv-gray-500 hover:text-sv-white hover:bg-sv-gray-700 transition-colors"
            title="Sign out"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
