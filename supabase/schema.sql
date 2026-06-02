-- ============================================================
-- StrideVision Database Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================================
-- PROFILES (extends auth.users)
-- ============================================================
create table public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text not null,
  full_name text,
  role text not null default 'worker' check (role in ('admin', 'worker', 'qc_inspector')),
  avatar_url text,
  factory_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Admins can view all profiles"
  on public.profiles for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

create policy "Admins can update all profiles"
  on public.profiles for update
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    coalesce(new.raw_user_meta_data->>'role', 'worker')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- SHOE MODELS
-- ============================================================
create table public.shoe_models (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  brand text not null,
  category text not null default 'athletic',
  description text,
  target_measurements jsonb,
  tolerance_mm numeric not null default 2.0,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

alter table public.shoe_models enable row level security;

create policy "All authenticated users can view shoe models"
  on public.shoe_models for select
  using (auth.role() = 'authenticated');

create policy "Admins can manage shoe models"
  on public.shoe_models for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- Insert sample shoe models
insert into public.shoe_models (name, brand, category, description, tolerance_mm)
values
  ('Air Runner Pro', 'Velocity', 'athletic', 'High-performance running shoe', 1.5),
  ('Classic Leather', 'Heritage', 'formal', 'Premium leather dress shoe', 1.0),
  ('Trail Blazer X', 'OutdoorTech', 'outdoor', 'Rugged trail running shoe', 2.0),
  ('Urban Walker', 'StreetStep', 'casual', 'Everyday comfort sneaker', 1.5),
  ('Performance Boot', 'WorkForce', 'safety', 'Safety-toe work boot', 1.0);

-- ============================================================
-- SCANS
-- ============================================================
create table public.scans (
  id uuid primary key default uuid_generate_v4(),
  scan_id text not null unique,
  worker_id uuid not null references public.profiles(id) on delete cascade,
  shoe_model_id uuid not null references public.shoe_models(id) on delete restrict,
  batch_id text not null,
  size text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  alignment_scores jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.scans enable row level security;

create policy "Workers can view own scans"
  on public.scans for select
  using (auth.uid() = worker_id);

create policy "Workers can create scans"
  on public.scans for insert
  with check (auth.uid() = worker_id);

create policy "Workers can update own pending scans"
  on public.scans for update
  using (auth.uid() = worker_id and status = 'pending');

create policy "Admins and QC can view all scans"
  on public.scans for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('admin', 'qc_inspector')
    )
  );

create policy "Admins can update any scan"
  on public.scans for update
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- Auto-update updated_at
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger scans_updated_at
  before update on public.scans
  for each row execute procedure public.update_updated_at();

-- ============================================================
-- SCAN IMAGES
-- ============================================================
create table public.scan_images (
  id uuid primary key default uuid_generate_v4(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  angle text not null check (angle in ('top', 'left', 'right', 'front', 'back', 'sole')),
  storage_path text not null,
  public_url text,
  alignment_score numeric,
  is_calibrated boolean not null default false,
  calibration_data jsonb,
  created_at timestamptz not null default now(),
  unique(scan_id, angle)
);

alter table public.scan_images enable row level security;

create policy "Users can view scan images they have access to"
  on public.scan_images for select
  using (
    exists (
      select 1 from public.scans s
      where s.id = scan_id and (
        s.worker_id = auth.uid() or
        exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role in ('admin', 'qc_inspector')
        )
      )
    )
  );

create policy "Workers can insert images for their scans"
  on public.scan_images for insert
  with check (
    exists (
      select 1 from public.scans s
      where s.id = scan_id and s.worker_id = auth.uid()
    )
  );

-- ============================================================
-- MEASUREMENTS
-- ============================================================
create table public.measurements (
  id uuid primary key default uuid_generate_v4(),
  scan_id uuid not null references public.scans(id) on delete cascade unique,
  shoe_length_mm numeric,
  toe_width_mm numeric,
  heel_width_mm numeric,
  sole_length_mm numeric,
  sole_width_mm numeric,
  heel_height_mm numeric,
  instep_height_mm numeric,
  overall_accuracy numeric check (overall_accuracy between 0 and 100),
  processing_metadata jsonb,
  created_at timestamptz not null default now()
);

alter table public.measurements enable row level security;

create policy "Users can view measurements for accessible scans"
  on public.measurements for select
  using (
    exists (
      select 1 from public.scans s
      where s.id = scan_id and (
        s.worker_id = auth.uid() or
        exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role in ('admin', 'qc_inspector')
        )
      )
    )
  );

create policy "System can insert measurements"
  on public.measurements for insert
  with check (auth.role() = 'authenticated');

-- ============================================================
-- QC REPORTS
-- ============================================================
create table public.qc_reports (
  id uuid primary key default uuid_generate_v4(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  inspector_id uuid not null references public.profiles(id) on delete cascade,
  passed boolean not null,
  defects text[],
  notes text,
  created_at timestamptz not null default now()
);

alter table public.qc_reports enable row level security;

create policy "QC inspectors and admins can manage reports"
  on public.qc_reports for all
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'qc_inspector')
    )
  );

create policy "Workers can view QC reports for their scans"
  on public.qc_reports for select
  using (
    exists (
      select 1 from public.scans s
      where s.id = scan_id and s.worker_id = auth.uid()
    )
  );

-- ============================================================
-- STORAGE BUCKETS
-- ============================================================
-- Run these in the Supabase dashboard > Storage:
-- 1. Create bucket "scan-images" with public access
-- 2. Create bucket "avatars" with public access

-- Storage policies (add via Supabase Dashboard)
-- insert policy: authenticated users can upload to scan-images
-- select policy: public read access to scan-images

-- ============================================================
-- INDEXES
-- ============================================================
create index idx_scans_worker_id on public.scans(worker_id);
create index idx_scans_status on public.scans(status);
create index idx_scans_created_at on public.scans(created_at desc);
create index idx_scan_images_scan_id on public.scan_images(scan_id);
create index idx_measurements_scan_id on public.measurements(scan_id);
create index idx_qc_reports_scan_id on public.qc_reports(scan_id);
