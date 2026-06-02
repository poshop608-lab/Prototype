"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ScanLine, History, Shield } from "lucide-react";
import { useAuthStore } from "@/store/auth";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Home", href: "/dashboard", icon: LayoutDashboard, roles: ["admin", "worker", "qc_inspector"] },
  { label: "Scan", href: "/scan", icon: ScanLine, roles: ["admin", "worker"] },
  { label: "History", href: "/scans", icon: History, roles: ["admin", "worker", "qc_inspector"] },
  { label: "Admin", href: "/admin", icon: Shield, roles: ["admin"] },
];

export function MobileNav() {
  const pathname = usePathname();
  const { profile } = useAuthStore();

  // Hide nav on capture page — it uses fixed inset-0 fullscreen
  if (pathname === "/scan/capture") return null;

  const filtered = navItems.filter(
    (item) => !profile?.role || item.roles.includes(profile.role)
  );

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-sv-gray-800 bg-sv-gray-950/95 backdrop-blur-md">
      <div className="flex items-center justify-around px-2 py-2 safe-area-pb">
        {filtered.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          const Icon = item.icon;

          return (
            <Link key={item.href} href={item.href} className="flex-1">
              <div
                className={cn(
                  "flex flex-col items-center gap-1 py-1 rounded-lg transition-colors",
                  isActive ? "text-sv-white" : "text-sv-gray-500"
                )}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[10px] font-medium">{item.label}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
