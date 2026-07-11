import { createClient } from "@/lib/supabase/client";
import type { CalibrationData } from "@/lib/cv/types";

const LOCAL_KEY = "sv_cal_v2";
const TABLE     = "station_settings";

function readLocal(): CalibrationData | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as CalibrationData) : null;
  } catch { return null; }
}

function writeLocal(data: CalibrationData): void {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch { /* quota */ }
}

export async function loadCalibration(stationId: string): Promise<CalibrationData | null> {
  const cached = readLocal();
  if (cached?.stationId === stationId) return cached;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (createClient() as any)
    .from(TABLE).select("calibration").eq("station_id", stationId).single();

  if (error || !data?.calibration) return null;
  const cal = data.calibration as CalibrationData;
  writeLocal(cal);
  return cal;
}

export async function saveCalibration(cal: CalibrationData): Promise<void> {
  writeLocal(cal);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (createClient() as any)
    .from(TABLE)
    .upsert(
      { station_id: cal.stationId, calibration: cal, updated_at: new Date().toISOString() },
      { onConflict: "station_id" },
    );
}

export function getLocalCalibration(): CalibrationData | null {
  return readLocal();
}

export function isCalibrated(): boolean {
  const cal = readLocal();
  return cal !== null && cal.pxPerMm > 0;
}

export async function resetCalibration(stationId: string): Promise<void> {
  try { localStorage.removeItem(LOCAL_KEY); } catch { /* quota */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (createClient() as any)
    .from(TABLE)
    .delete()
    .eq("station_id", stationId);
}
