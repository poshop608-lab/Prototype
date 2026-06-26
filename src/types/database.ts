import type { CalibrationData } from "@/lib/cv/types";

export type UserRole = "admin" | "worker" | "qc_inspector";
export type ScanStatus = "pending" | "passed" | "rejected";
export type ShoeSide = "pair";

export interface StationSettings {
  id:          string;
  station_id:  string;
  calibration: CalibrationData;
  updated_at:  string;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, "created_at" | "updated_at">;
        Update: Partial<Omit<Profile, "id">>;
      };
      scans: {
        Row: Scan;
        Insert: Omit<Scan, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Scan, "id">>;
      };
      scan_images: {
        Row: ScanImage;
        Insert: Omit<ScanImage, "id" | "created_at">;
        Update: Partial<Omit<ScanImage, "id">>;
      };
      station_settings: {
        Row: StationSettings;
        Insert: Omit<StationSettings, "id">;
        Update: Partial<Omit<StationSettings, "id">>;
      };
    };
  };
}

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  avatar_url: string | null;
  factory_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Scan {
  id: string;
  scan_id: string;
  worker_id: string;
  batch_id: string;
  size: string;
  status: ScanStatus;
  left_height_mm: number | null;
  right_height_mm: number | null;
  left_width_mm: number | null;
  right_width_mm: number | null;
  height_diff_mm: number | null;
  passed: boolean | null;
  rejection_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  worker?: Profile;
}

export interface ScanImage {
  id: string;
  scan_id: string;
  side: ShoeSide;
  storage_path: string;
  public_url: string | null;
  created_at: string;
}
