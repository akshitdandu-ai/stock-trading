# Swing Paper Trader: dashboard

Next.js (App Router, React 19, TypeScript) dashboard for the NSE swing-trading research + **paper**-trading tool.
It reads the scan results and prices written by the Python pipeline (`../pipeline`) from Supabase Postgres and lets
you confirm paper buys/sells, keep a fundamentals checklist, and review performance. **Paper trading only: there is no
broker integration and no real order is ever sent.**

Contract with the pipeline (money rules, order/fill semantics, jsonb shapes): `../docs/CONTRACT.md`.
Schema: `../supabase/migrations/0001_init.sql` (already applied to Supabase).

## Pages

| Page | What it shows | Tables |
|---|---|---|
| `/` Today | market filter status, data date, unacknowledged alerts (acknowledge / confirm sell), today's breakouts with quick paper-buy | `scan_runs`, `suggestions`, `alerts`, `trades`, `fills`, `orders` |
| `/suggestions` | ranked latest scan (breakouts, near pivot, extended), score breakdown, base details, 7-item checklist, watchlist, paper buy | `suggestions`, `checklists`, `watchlist` |
| `/positions` | open trades, sell / raise stop / notes, pending orders (cancel) | `trades`, `fills`, `orders`, `alerts`, `daily_prices` |
| `/performance` | equity, cash, open and booked P&L, STCG estimate, equity vs Nifty Smallcap 250, drawdown, win rate / expectancy / profit factor | `equity_snapshots`, `trades`, `fills` |
| `/journal` | closed trades with editable notes, P&L by exit reason and by checklist-score bucket | `trades`, `fills` |
| `/backtest` | latest backtest with market filter ON vs OFF | `backtest_runs` |
| `/settings` | edit capital, risk, stop, target, charges, time stop, tax; data sources; last 10 pipeline runs | `settings`, `data_sources`, `data_runs` |
| `GET /api/health` | public: `{ db, latest_data_date, last_scan_date }`, never trading data | `daily_prices`, `scan_runs` |

Every page header shows "Data as of <max trade_date>" and a banner for any `data_sources` row whose status is not `ok`.
Every page renders friendly empty states while the database is empty (run the daily job first).

## Setup

```bash
cd dashboard
npm install
cp .env.example .env.local   # then fill in DATABASE_URL (and DASHBOARD_PASSWORD)
npm run dev                  # http://localhost:3000
```

Environment variables:

| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Supabase **transaction pooler** URL (Project Settings → Database → Connection string → *Transaction pooler*, port 6543). The app uses `prepare: false` for the pooler and requires SSL unless the host is localhost. If it is missing every page shows a setup message instead of crashing. |
| `DASHBOARD_PASSWORD` | recommended | Enables HTTP Basic auth for everything except `/api/health` and static assets (username can be anything). |
| `DATABASE_POOL_MAX` | no | Max connections per instance, default 3. |

Scripts: `npm run dev`, `npm run build`, `npm start`, `npm run typecheck`, `npm test`
(unit tests for `lib/engine.ts`: charges, sizing, tax, P&L, exit rules).

## Deploy to Vercel

1. Import the repository in Vercel and set **Root Directory = `dashboard`** (framework: Next.js, defaults otherwise).
2. Add `DATABASE_URL` (transaction pooler URL) and `DASHBOARD_PASSWORD` under Environment Variables.
3. Deploy. `GET /api/health` should return `{"db":true,...}`.

The build needs no database: every page that queries is `force-dynamic` and reads `DATABASE_URL` at request time.

## How orders work

* **Next open (default):** inserts a `pending` row in `orders` with `price = null` and `created_data_date` = latest data date.
  The evening job (`pipeline/run_daily.py`) fills it at the open of the next session and creates the trade/fills.
* **Manual price:** the dashboard fills immediately in one database transaction: order `filled`, `trades` row
  (buy) or reduced/closed trade (sell), and a `fills` row with charges from `lib/engine.ts`.
* Sells: "Target (book 1/3)" sells `round(qty/3)` (min 1 if qty ≥ 2), sets `booked_third` and moves the stop to at least the
  entry price; with fewer than 2 shares nothing is sold but the trade is marked booked and the stop moves to entry.
  When the quantity reaches 0 the trade closes with `realized_pnl`.
* Stops can only move up. Buys are rejected if they exceed available cash (cash minus the estimated cost of pending buys).

Money amounts that get stored (charges, stop, target, tax) are rounded to 2 decimals, matching `pipeline/engine/sizing.py`.
`lib/engine.ts` must stay identical to that file.
