# StrideVision

AI-powered shoe measurement platform — industrial dark-mode PWA built with Next.js 15, Supabase, and TensorFlow.js architecture.

## Stack

- **Frontend**: Next.js 15 (App Router) + TypeScript + TailwindCSS v4
- **UI**: shadcn/ui + Radix UI + Framer Motion
- **Backend**: Supabase (Auth + PostgreSQL + Storage)
- **State**: Zustand with persist middleware
- **Camera**: Web Camera API + DeviceOrientation API
- **PWA**: next-pwa (offline-ready, installable)
- **Deploy**: Vercel

## Features

- **Role-based auth** — admin / worker / qc_inspector with RLS
- **Guided 6-angle capture** — gyroscope alignment scoring, auto-capture at 88% threshold, haptic feedback
- **SVG blueprint visualization** — technical measurement output with dimension lines
- **Admin panel** — scan management, user management, CSV export
- **PWA** — installable, offline-capable, camera access on mobile

## Getting Started

### 1. Clone & install

```bash
git clone https://github.com/poshop608-lab/Prototype.git
cd Prototype
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### 3. Supabase setup

Run the schema in your Supabase SQL editor:

```bash
# Copy contents of supabase/schema.sql into Supabase SQL Editor and run
```

Create a storage bucket named `scan-images` with public access enabled.

### 4. Run

```bash
npm run dev
```

Visit `http://localhost:3000`.

## Project Structure

```
src/
├── app/
│   ├── (auth)/           # Login + Register pages
│   ├── (dashboard)/      # Protected dashboard routes
│   │   ├── dashboard/    # Stats overview
│   │   ├── scan/         # Scan setup + camera capture
│   │   ├── scans/        # Scan history
│   │   ├── measurements/ # Measurement output + blueprint
│   │   └── admin/        # Admin panel (admin role only)
│   └── api/              # API routes (scans, measurements, upload)
├── components/
│   ├── camera/           # CameraView, AlignmentOverlay, AngleProgress
│   ├── layout/           # Sidebar, MobileNav, AuthProvider
│   └── ui/               # shadcn/ui components
├── lib/
│   └── supabase/         # Server + browser Supabase clients
├── store/                # Zustand stores (auth, scan)
└── types/                # Database types
```

## Database Schema

6 tables: `profiles`, `shoe_models`, `scans`, `scan_images`, `measurements`, `qc_reports`

Full RLS policies per role. See `supabase/schema.sql`.

## Camera System

The capture flow uses `getUserMedia` with `facingMode: "environment"` for rear camera. Alignment scoring uses `DeviceOrientationEvent` (gamma/beta axes). Auto-capture triggers when alignment ≥ 88% held for 1200ms. Canvas captures frames and compresses to WebP before Supabase Storage upload.

## Deployment

Push to GitHub and connect to Vercel. Set environment variables in Vercel dashboard.

```bash
vercel --prod
```

