-- Station calibration settings.
-- One row per physical inspection station.
-- calibration JSONB holds CalibrationData (see src/lib/cv/types.ts).

create table if not exists public.station_settings (
  id           uuid         primary key default gen_random_uuid(),
  station_id   text         not null unique,
  calibration  jsonb        not null,
  updated_at   timestamptz  not null default now()
);

-- Only admins and qc_inspectors may read/write calibration.
alter table public.station_settings enable row level security;

create policy "admins_full_access" on public.station_settings
  for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('admin', 'qc_inspector')
    )
  );

-- Workers can read (needed at scan startup to load calibration).
create policy "workers_read" on public.station_settings
  for select
  using (auth.uid() is not null);
