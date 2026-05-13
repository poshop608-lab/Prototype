export type UserRole = "admin" | "worker" | "qc_inspector";
export type ScanStatus = "pending" | "processing" | "completed" | "failed";
export type CaptureAngle =
  | "top"
  | "left"
  | "right"
  | "front"
  | "back"
  | "sole";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, "created_at" | "updated_at">;
        Update: Partial<Omit<Profile, "id">>;
      };
      shoe_models: {
        Row: ShoeModel;
        Insert: Omit<ShoeModel, "id" | "created_at">;
        Update: Partial<Omit<ShoeModel, "id">>;
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
      measurements: {
        Row: Measurement;
        Insert: Omit<Measurement, "id" | "created_at">;
        Update: Partial<Omit<Measurement, "id">>;
      };
      qc_reports: {
        Row: QCReport;
        Insert: Omit<QCReport, "id" | "created_at">;
        Update: Partial<Omit<QCReport, "id">>;
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

export interface ShoeModel {
  id: string;
  name: string;
  brand: string;
  category: string;
  description: string | null;
  target_measurements: Record<string, number> | null;
  tolerance_mm: number;
  created_at: string;
  created_by: string;
}

export interface Scan {
  id: string;
  scan_id: string;
  worker_id: string;
  shoe_model_id: string;
  batch_id: string;
  size: string;
  status: ScanStatus;
  alignment_scores: Record<string, number> | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  shoe_model?: ShoeModel;
  worker?: Profile;
}

export interface ScanImage {
  id: string;
  scan_id: string;
  angle: CaptureAngle;
  storage_path: string;
  public_url: string | null;
  alignment_score: number | null;
  is_calibrated: boolean;
  calibration_data: Record<string, unknown> | null;
  created_at: string;
}

export interface Measurement {
  id: string;
  scan_id: string;
  shoe_length_mm: number | null;
  toe_width_mm: number | null;
  heel_width_mm: number | null;
  sole_length_mm: number | null;
  sole_width_mm: number | null;
  heel_height_mm: number | null;
  instep_height_mm: number | null;
  overall_accuracy: number | null;
  processing_metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface QCReport {
  id: string;
  scan_id: string;
  inspector_id: string;
  passed: boolean;
  defects: string[] | null;
  notes: string | null;
  created_at: string;
}
