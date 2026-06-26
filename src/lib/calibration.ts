import { createClient } from "@/lib/supabase/client";
import type { CalibrationData } from "@/lib/cv/types";

const LOCAL_KEY = "sv_calibration_v1";
const TABLE     = "station_settings";

// ─── Local cache ─────────────────────────────────────────────────────────────

function readLocal(): CalibrationData | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as CalibrationData) : null;
  } catch {
    return null;
  }
}

function writeLocal(data: CalibrationData): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable (private browsing quota) — non-fatal
  }
}

// ─── Supabase read/write ──────────────────────────────────────────────────────

export async function loadCalibration(stationId: string): Promise<CalibrationData | null> {
  // Fast path: return local cache immediately so UI is never blocked
  const cached = readLocal();
  if (cached && cached.stationId === stationId) return cached;

  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from(TABLE)
    .select("calibration")
    .eq("station_id", stationId)
    .single();

  if (error || !data?.calibration) return null;

  const cal = data.calibration as CalibrationData;
  writeLocal(cal);
  return cal;
}

export async function saveCalibration(cal: CalibrationData): Promise<void> {
  writeLocal(cal);

  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from(TABLE)
    .upsert(
      { station_id: cal.stationId, calibration: cal, updated_at: new Date().toISOString() },
      { onConflict: "station_id" },
    );
}

// Invalidate local cache (forces re-fetch on next loadCalibration call)
export function clearLocalCalibration(): void {
  try { localStorage.removeItem(LOCAL_KEY); } catch { /* ignore */ }
}

// Synchronous read from local cache only — used in the hot render path
export function getLocalCalibration(): CalibrationData | null {
  return readLocal();
}

// True if calibration exists locally (no network call needed to block startup)
export function isCalibrated(): boolean {
  const cal = readLocal();
  return cal !== null && cal.pxPerMm > 0 && cal.surfaceY > 0;
}
