"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Calibration removed — system is zero-config.
// Redirect admins back to dashboard.
export default function CalibratePage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin"); }, [router]);
  return null;
}
