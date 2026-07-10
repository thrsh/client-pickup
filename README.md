# Check Pickup Tracker

A plain React + Tailwind app (no meta-framework) for tracking checks awaiting
collector pickup. Public visitors search with no login; admins sign in to
upload files, mark pickups, and view reports.

- **Frontend:** React 18 + Vite, Tailwind CSS, hand-rolled shadcn-style components
- **Database/Auth:** Supabase (Postgres + Auth)
- **Hosting:** Vercel

## 1. Install

```bash
npm install
```

## 2. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run the contents of `supabase/schema.sql`. This
   creates the `checks` and `upload_batches` tables, indexes, and row-level
   security policies (public read-only, authenticated write).
3. Go to **Authentication → Users → Add user** and create one login per
   admin/back-office staff member (email + password). There's no separate
   sign-up page by design — admin accounts are provisioned by whoever owns
   the Supabase project.
4. Go to **Project Settings → API** and copy the **Project URL** and
   **anon public key**.

## 3. Configure environment variables

```bash
cp .env.example .env
```

Fill in:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

## 4. Run locally

```bash
npm run dev
```

- Public lookup page: `http://localhost:5173/`
- Admin sign-in: `http://localhost:5173/admin/login`

## 5. Deploy to Vercel

1. Push this project to a GitHub repo.
2. In Vercel, **New Project → Import** the repo. Framework preset: **Vite**.
3. Add the same two environment variables (`VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`) under **Project Settings → Environment
   Variables**.
4. Deploy. `vercel.json` is already set up so client-side routes
   (`/admin`, `/admin/checks`, etc.) don't 404 on refresh.

## How it works

- **Public page (`/`)** — no login. Lists checks with `status = available`,
  showing the source file name, the row number from that file, check
  number, check date, payor, and amount. Includes debounced search across
  payee / payor / check number and pagination.
- **Admin upload (`/admin/upload`)** — parses `.csv`/`.xlsx`/`.xls` with
  SheetJS, auto-detects column headers, lets you confirm the mapping, shows
  a preview, then inserts rows into Supabase with the file name and the
  original row number attached.
- **Admin checks register (`/admin/checks`)** — searchable, filterable
  table of every check. "Mark picked up" opens a dialog to record the
  collector's name and timestamp; pickups can be undone.
- **Admin reports (`/admin/reports`)** — outstanding value by payor, a
  pickup-status breakdown, an aging chart for unpicked checks, and a
  one-click CSV export of the full register.
- **Admin QR (`/admin/qr`)** — generates a downloadable QR code (PNG)
  that links to the public lookup page, for posting at a pickup counter.

## Notes on security

Row-level security is intentionally simple: any authenticated Supabase user
can write, and anyone (anon) can read. This fits a small back-office team
sharing one Supabase project. If you need per-admin roles or an audit
trail beyond `picked_up_by`/`picked_up_at`, extend `supabase/schema.sql`
with an `admins` table and tighter policies.
