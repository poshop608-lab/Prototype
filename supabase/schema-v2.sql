-- ============================================================
-- StrideVision v2 Migration — Shoe Pair Height QC Tool
-- Fully idempotent — safe to re-run multiple times
-- ============================================================

-- Drop obsolete tables
DROP TABLE IF EXISTS public.qc_reports CASCADE;
DROP TABLE IF EXISTS public.measurements CASCADE;
DROP TABLE IF EXISTS public.shoe_models CASCADE;

-- ============================================================
-- MODIFY SCANS TABLE
-- ============================================================
ALTER TABLE public.scans
  DROP COLUMN IF EXISTS shoe_model_id,
  DROP COLUMN IF EXISTS alignment_scores,
  ADD COLUMN IF NOT EXISTS left_height_mm   NUMERIC,
  ADD COLUMN IF NOT EXISTS right_height_mm  NUMERIC,
  ADD COLUMN IF NOT EXISTS left_width_mm    NUMERIC,
  ADD COLUMN IF NOT EXISTS right_width_mm   NUMERIC,
  ADD COLUMN IF NOT EXISTS height_diff_mm   NUMERIC,
  ADD COLUMN IF NOT EXISTS passed           BOOLEAN,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Normalize any old status values before constraint
UPDATE public.scans SET status = 'passed'   WHERE status = 'completed';
UPDATE public.scans SET status = 'rejected' WHERE status = 'failed';
UPDATE public.scans SET status = 'pending'  WHERE status NOT IN ('pending', 'passed', 'rejected');

-- Replace status constraint (always drop first so re-runs don't fail)
ALTER TABLE public.scans DROP CONSTRAINT IF EXISTS scans_status_check;
ALTER TABLE public.scans ADD CONSTRAINT scans_status_check
  CHECK (status IN ('pending', 'passed', 'rejected'));

-- ============================================================
-- MODIFY SCAN_IMAGES TABLE
-- ============================================================

-- Drop old constraints/columns that may or may not exist
ALTER TABLE public.scan_images DROP CONSTRAINT IF EXISTS scan_images_angle_check;
ALTER TABLE public.scan_images DROP CONSTRAINT IF EXISTS scan_images_scan_id_angle_key;
ALTER TABLE public.scan_images DROP CONSTRAINT IF EXISTS scan_images_scan_id_side_key;
ALTER TABLE public.scan_images DROP COLUMN IF EXISTS angle;
ALTER TABLE public.scan_images DROP COLUMN IF EXISTS is_calibrated;
ALTER TABLE public.scan_images DROP COLUMN IF EXISTS calibration_data;
ALTER TABLE public.scan_images DROP COLUMN IF EXISTS alignment_score;
ALTER TABLE public.scan_images ADD COLUMN IF NOT EXISTS side TEXT DEFAULT 'pair';

-- Set all existing rows to 'pair'
UPDATE public.scan_images SET side = 'pair' WHERE side IS NULL;

-- Remove duplicate (scan_id, side) rows — keep only latest per scan
DELETE FROM public.scan_images
WHERE id NOT IN (
  SELECT DISTINCT ON (scan_id, side) id
  FROM public.scan_images
  ORDER BY scan_id, side, created_at DESC
);

-- Add check + unique constraints
ALTER TABLE public.scan_images ADD CONSTRAINT scan_images_side_check
  CHECK (side IN ('pair'));
ALTER TABLE public.scan_images ADD CONSTRAINT scan_images_scan_id_side_key
  UNIQUE (scan_id, side);

-- ============================================================
-- RLS POLICIES
-- ============================================================
DROP POLICY IF EXISTS "Workers can update own pending scans" ON public.scans;
DROP POLICY IF EXISTS "Workers can update own scans" ON public.scans;

CREATE POLICY "Workers can update own scans"
  ON public.scans FOR UPDATE
  USING (auth.uid() = worker_id);

-- ============================================================
-- DONE — verify:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'scans' ORDER BY ordinal_position;
-- ============================================================
