"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useScanStore } from "@/store/scan";

// Scan page redirects straight to capture — no setup step needed.
// Batch ID is auto-generated so workers never need to enter anything.
export default function ScanPage() {
  const router = useRouter();
  const { setConfig, reset } = useScanStore();

  useEffect(() => {
    reset();
    setConfig({ batchId: `BATCH-${Date.now()}` });
    router.replace("/scan/capture");
  }, [reset, setConfig, router]);

  return null;
}
