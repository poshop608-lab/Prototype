-- ============================================================
-- CRITICAL FIX: infinite recursion in profiles RLS policies
-- The admin policies query public.profiles inside a policy ON
-- public.profiles → infinite loop. Fix with security definer fn.
-- ============================================================

-- 1. Helper function that bypasses RLS to check role
create or replace function public.get_my_role()
returns text
language sql
security definer
stable
as $$
  select role from public.profiles where id = auth.uid()
$$;

-- 2. Drop all existing profiles policies
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Admins can view all profiles" on public.profiles;
drop policy if exists "Admins can update all profiles" on public.profiles;

-- 3. Re-create profiles policies using the helper (no recursion)
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Admins can view all profiles"
  on public.profiles for select
  using (public.get_my_role() = 'admin');

create policy "Admins can update all profiles"
  on public.profiles for update
  using (public.get_my_role() = 'admin');

-- ============================================================
-- Fix scans policies (also used get_my_role to avoid recursion)
-- ============================================================
drop policy if exists "Workers can view own scans" on public.scans;
drop policy if exists "Workers can create scans" on public.scans;
drop policy if exists "Workers can update own pending scans" on public.scans;
drop policy if exists "Workers can update own scans" on public.scans;
drop policy if exists "Admins and QC can view all scans" on public.scans;
drop policy if exists "Admins can update any scan" on public.scans;

create policy "Workers can view own scans"
  on public.scans for select
  using (auth.uid()::uuid = worker_id);

create policy "Workers can create scans"
  on public.scans for insert
  with check (auth.uid()::uuid = worker_id);

create policy "Workers can update own scans"
  on public.scans for update
  using (auth.uid()::uuid = worker_id);

create policy "Admins and QC can view all scans"
  on public.scans for select
  using (public.get_my_role() in ('admin', 'qc_inspector'));

create policy "Admins can update any scan"
  on public.scans for update
  using (public.get_my_role() = 'admin');

-- ============================================================
-- Fix scan_images policies
-- ============================================================
drop policy if exists "Users can view scan images they have access to" on public.scan_images;
drop policy if exists "Workers can insert images for their scans" on public.scan_images;

create policy "Users can view scan images they have access to"
  on public.scan_images for select
  using (
    exists (
      select 1 from public.scans s
      where s.id = scan_images.scan_id
        and (s.worker_id = auth.uid()::uuid or public.get_my_role() in ('admin', 'qc_inspector'))
    )
  );

create policy "Workers can insert images for their scans"
  on public.scan_images for insert
  with check (
    exists (
      select 1 from public.scans s
      where s.id = scan_images.scan_id and s.worker_id = auth.uid()::uuid
    )
  );

-- ============================================================
-- Fix measurements policies
-- ============================================================
drop policy if exists "Users can view measurements for accessible scans" on public.measurements;
drop policy if exists "System can insert measurements" on public.measurements;

create policy "Users can view measurements for accessible scans"
  on public.measurements for select
  using (
    exists (
      select 1 from public.scans s
      where s.id = measurements.scan_id
        and (s.worker_id = auth.uid()::uuid or public.get_my_role() in ('admin', 'qc_inspector'))
    )
  );

create policy "System can insert measurements"
  on public.measurements for insert
  with check (auth.role() = 'authenticated');

-- ============================================================
-- Fix shoe_models policies
-- ============================================================
drop policy if exists "All authenticated users can view shoe models" on public.shoe_models;
drop policy if exists "Admins can manage shoe models" on public.shoe_models;
drop policy if exists "Public can read shoe models" on public.shoe_models;

create policy "Public can read shoe models"
  on public.shoe_models for select
  using (true);

create policy "Admins can manage shoe models"
  on public.shoe_models for all
  using (public.get_my_role() = 'admin');

-- ============================================================
-- Storage bucket + policies for scan-images
-- ============================================================
insert into storage.buckets (id, name, public)
values ('scan-images', 'scan-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Authenticated users can upload scan images" on storage.objects;
drop policy if exists "Public read access to scan images" on storage.objects;
drop policy if exists "Users can update own scan image objects" on storage.objects;

create policy "Authenticated users can upload scan images"
  on storage.objects for insert
  with check (bucket_id = 'scan-images' and auth.role() = 'authenticated');

create policy "Public read access to scan images"
  on storage.objects for select
  using (bucket_id = 'scan-images');

create policy "Users can update scan image objects"
  on storage.objects for update
  using (bucket_id = 'scan-images' and auth.role() = 'authenticated');
