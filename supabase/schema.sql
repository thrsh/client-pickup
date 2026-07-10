-- Check Pickup Tracker — Supabase schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query)

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────
-- Table: upload_batches
-- One row per admin file upload
-- ─────────────────────────────────────────────
create table if not exists upload_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  total_rows int not null default 0,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- Table: checks
-- One row per check in an uploaded file
-- ─────────────────────────────────────────────
create table if not exists checks (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references upload_batches(id) on delete cascade,
  row_number int not null,
  payee text not null,
  payor text not null,
  check_no text not null,
  check_date date,
  amount numeric(14,2) not null default 0,
  status text not null default 'available' check (status in ('available', 'picked_up')),
  picked_up_by text,
  picked_up_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_checks_status on checks(status);
create index if not exists idx_checks_payee on checks using gin (to_tsvector('simple', payee));
create index if not exists idx_checks_payor on checks using gin (to_tsvector('simple', payor));
create index if not exists idx_checks_check_no on checks(check_no);
create index if not exists idx_checks_batch on checks(batch_id);

-- ─────────────────────────────────────────────
-- Row Level Security
-- Public (anon) can only READ checks — never write.
-- Only authenticated admins can insert/update/delete.
-- ─────────────────────────────────────────────
alter table checks enable row level security;
alter table upload_batches enable row level security;

-- Public read access for the collector-facing lookup page
create policy "Public can read checks"
  on checks for select
  to anon
  using (true);

create policy "Public can read upload batch names"
  on upload_batches for select
  to anon
  using (true);

-- Admins (any authenticated user) can manage checks and batches.
-- If you want tighter control, replace `authenticated` with a check
-- against a specific admin role/table.
create policy "Admins can insert checks"
  on checks for insert
  to authenticated
  with check (true);

create policy "Admins can update checks"
  on checks for update
  to authenticated
  using (true)
  with check (true);

create policy "Admins can delete checks"
  on checks for delete
  to authenticated
  using (true);

create policy "Admins can insert batches"
  on upload_batches for insert
  to authenticated
  with check (true);

create policy "Admins can delete batches"
  on upload_batches for delete
  to authenticated
  using (true);

-- ─────────────────────────────────────────────
-- Creating an admin user
-- Go to Authentication > Users > Add user in the Supabase
-- dashboard and create an email/password account. That's the
-- login the /admin/login page uses — no separate "admins" table
-- is required for a single back-office team.
-- ─────────────────────────────────────────────
