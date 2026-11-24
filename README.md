# FoodMitra — Restaurant 360°

A full-stack luxury restaurant website and smart dining operations platform featuring cryptographic QR table ordering, multi-round table sessions, separate kitchen ticketing, consolidated billing, online payment verification, real-time WebSocket synchronization, and role-based operations dashboards.

## Architecture Overview

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Recharts, jsPDF
- **Backend**: Node.js + Express + `ws` WebSocket Server (`server.ts`)
- **Database**: Relational SQLite (`better-sqlite3` with WAL mode, foreign keys, ACID transactions, and integer paise monetary columns)
- **Automated QA**: Vitest integration suite (`tests/restaurant360.test.ts`) + in-app Automated QA Lab (`/staff` → Automated QA Lab) running against an isolated in-memory SQLite database

## Core Workflow

```
One Restaurant
  → 10+ Tables with Cryptographic QR Tokens (/order?table=N&token=...)
  → Automatic Table Identification & Session Binding
  → Multiple Orders per Active Table Session (Repeat Ordering)
  → Separate Kitchen Tickets per Order (KT-1001, KT-1002...)
  → One Consolidated Table Session Bill & Tax Invoice (INV-...)
  → Server-Verified Online Payments (Razorpay / Sandbox Demo Mode)
  → Real-Time WebSocket Sync across Customer Tracker, Kitchen KDS, Counter POS, Waiter & Admin
```

## Getting Started

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Configure environment** (copy `.env.example` to `.env` if needed):
   - `PORT`: Defaults to `3000`
   - `DB_PATH`: Defaults to `./data/restaurant360.db`
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`: Optional for live Razorpay mode. When unset, the app operates in **Simulated Sandbox Payment Mode** with server-side HMAC-SHA256 signature verification.
3. **Run development server**:
   ```bash
   npm run dev
   ```
   Opens at `http://localhost:3000`.

## Accessing Dashboards & Demo Credentials

Click **Staff & Operations Portal** in the website footer (or navigate to `/staff`):

| Role | Email | Demo Password | Access Scope |
| --- | --- | --- | --- |
| Super Admin / Owner | `owner@foodmitra.in` | `Owner@360` | Full system, settings, QR regeneration, QA Lab, demo reset |
| Restaurant Admin | `admin@foodmitra.in` | `Admin@360` | Menu, categories, tables, QRs, staff, coupons, reports |
| Kitchen Chef | `chef@foodmitra.in` | `Chef@360` | Kitchen Display System (KDS) & ticket transitions |
| Counter / POS | `counter@foodmitra.in` | `Counter@360` | Table grid, consolidated bills, payments, refunds, PDF invoices |
| Dining Waiter | `waiter@foodmitra.in` | `Waiter@360` | Assigned tables & ready-to-serve delivery workflow |

## Testing QR Ordering

1. Log in as Admin or Super Admin on `/staff`.
2. Open **Tables & QR Codes**.
3. Click **Open QR** on any table (e.g., Table 02) to open `/order?table=2&token=...`.
4. Add dishes, apply coupon `FOODMITRA10`, complete payment, watch the order update live from the **Kitchen KDS**, place a second round from the same table, and settle the consolidated bill in **Counter POS**.

## Automated Testing & Build

```bash
# Type check
npm run lint

# Run all 10 end-to-end integration tests & benchmarks
npm test

# Production build & start
npm run build
npm start
```
