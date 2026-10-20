# NSE swing-trading research & paper-trading tool

A personal tool for Indian stocks (NSE). **Paper trading only: no broker connection, no real orders.** No F&O, no intraday.
Holding period 1-3 months. Starting paper capital ₹5,000 (editable in Settings).

```
 NSE public files ──► GitHub Actions (18:30 IST) ──► Supabase Postgres ◄── Next.js dashboard on Vercel
  bhavcopy, indices     pipeline/run_daily.py           prices, scans,        Today · Suggestions · Positions
  lists                 fetch → fills → exit alerts     trades, backtests     Performance · Journal · Backtest · Settings
                        → equity snapshot → scan
```

| Part | Where | What |
|---|---|---|
| Data layer | `pipeline/data/` | NSE bhavcopy (prices + delivery %), index closes, lists; incremental, retries, holidays, split adjustment |
| Scanner | `pipeline/scanner/` | market filter, universe filter, trend template, base/VCP, breakout, 0-100 score |
| Paper engine | `pipeline/engine/` | sizing, charges, STCG estimate, exit rules, order fills, alerts, equity snapshots |
| Backtest | `pipeline/backtest/` | the same rules replayed on stored history, filter ON vs OFF |
| Dashboard | `dashboard/` | Next.js app (Today, Suggestions + fundamentals checklist, Positions, Performance, Journal, Backtest, Settings) |
| Database | `supabase/migrations/` | schema (RLS on, no public policies) |
| Contract | `docs/CONTRACT.md` | the shared rules between Python and the dashboard |

## One-time setup (≈10 minutes)

1. **Database password / URL.** Supabase project `stock-trading` already has the schema. In Supabase: *Project → Connect → Session pooler*, copy the URI and put your database password in it (reset it under *Project Settings → Database* if you don't have it).
2. **GitHub secret.** Repo → *Settings → Secrets and variables → Actions → New repository secret*: `SUPABASE_DB_URL` = that URI.
3. **Vercel env vars** (project `stock-trading`, Root Directory `dashboard`): `DATABASE_URL` = the *Transaction pooler* URI (port 6543), `DASHBOARD_PASSWORD` = any password you choose (HTTP Basic auth; username can be anything).
4. **First data load.** GitHub → *Actions → Daily run → Run workflow* (loads ~3 years of history; takes 20-40 minutes the first time, then ~1 minute per evening).
5. **Backtest.** *Actions → Backtest → Run workflow*. Results appear on the dashboard's Backtest page.

After that it runs by itself on weekdays at 18:30 IST (with a 21:00 IST catch-up if NSE published late).

## How a day works
- **Evening:** the job loads the day's NSE files, fills any paper orders you confirmed (at the next session's open), checks exit rules on closing prices for every open position, snapshots equity, then scans.
- **You:** open the dashboard, read *Today* (market filter, alerts, breakouts), tick the fundamentals checklist on a suggestion, and press **Confirm** on a paper buy. The entry defaults to the next day's open and fills automatically next evening (or enter a price to fill immediately).

## Rules implemented (from the spec)
- **Market filter:** new buys only if Nifty Smallcap 250 > its 50 DMA > its 200 DMA, else "No new buys: market filter off".
- **Universe:** price > ₹50, 50-day average traded value > ₹10 cr, market cap ₹1,000-30,000 cr, no ASM/GSM, no 5%/10% price band.
- **Trend template:** close > 50 > 150 > 200 DMA; 200 DMA above its level a month ago; close within 25% of 52-week high and ≥ 30% above 52-week low; 6-month return beats Smallcap 250 by ≥ 20 pp.
- **Base / VCP:** 3-10 week base, depth 10-30%, ≥ 2 pullbacks each smaller than the last, volume in the last contraction below the 50-day average, pivot = highest high of the base. *Breakout today* = close > pivot, volume ≥ 1.5× 50-day average, delivery ≥ 50%. *Extended* = close > 5% above pivot (not suggested).
- **Score (0-100)** with a visible breakdown: relative strength 30, closeness to pivot 25, tightness of last contraction 20, volume dry-up 15, sector strength 10 (top-3 sector indices by 3-month return).
- **Engine:** risk 3% of equity per trade, stop 8% below entry, qty = risk ÷ (entry − stop) capped by cash; charges 0.12% per side + ₹20 DP per sell; STCG estimate 20% + 4% cess on net gains. Exits on closing prices: close ≤ stop → sell at next open; +20% → book 1/3 and move stop to entry; then trail with a close below the 21-day EMA; flat (< 5% gain) after 21 sessions → time-stop; stops only move up.

## Assumptions and honest limits (read these)
- **NSE file formats are unverified from my build environment.** My build sandbox cannot reach nseindia.com, so the fetchers follow NSE's published file layouts from knowledge and were tested only against sample files and a fake NSE. The first Actions run is the real test: the dashboard's Settings page lists every data source with status (`ok` / `error` / `unavailable`) and the error text. A broken source is **never faked**: the matching filter is skipped and the Today page says so in red.
- **ASM/GSM** come from NSE's public report endpoints (`/api/reportASM`, `/api/reportGSM`), one request each per day. These sit on nseindia.com's website rather than the file archive and may be blocked from GitHub's IP ranges. If they fail, the ASM/GSM filter is not applied and you are told. Set `NSE_SKIP_WEBSITE_API=1` to disable them. Price bands (from `sec_list`) and market cap (from the PR zip) are likewise best-effort.
- **Splits/bonuses:** prices are stored raw; history is back-adjusted from NSE's own previous-close field when it jumps more than 2% against the prior close.
- **"Base" = the last ≤ 50 sessions before today.** After a breakout day the pivot moves up, so a stock appears as *Breakout today* only on its breakout day (and *Extended* only if it gapped > 5% above the pivot that day).
- **"Near pivot" = within 5% below the pivot** (configurable, `watchlist_near_pivot_pct`). A close above the pivot with weak volume/delivery goes to the watchlist with the reason shown.
- Stocks with < 252 sessions of history (recent IPOs) cannot pass the trend template.
- **Time-stop** counts trading sessions since entry. **Booking 1/3** sells `round(qty/3)` (min 1 if qty ≥ 2); with 1 share nothing is sold but the stop still moves to entry.
- **Backtest:** next-open fills, no slippage; only price/liquidity filters can be applied historically; survivorship bias is reduced (each day's universe is that day's bhavcopy) but not eliminated. The backtest page says this in full. Small samples are noisy. Results can be poor; the page shows them as they are.
- **Fundamentals (phase 3)** are a manual checklist. Candidates for automation, **not implemented, your call:** results calendar (NSE board-meeting announcements, public) and promoter holding/pledge (NSE shareholding-pattern filings, public). Screener.in has no sanctioned free API, so it is only linked.

## Local development
```bash
cd pipeline && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
python -m pytest -q                         # unit tests (no network, no DB)
export SUPABASE_DB_URL=...                  # then:
python run_daily.py                         # the evening job
python -m backtest.run
cd ../dashboard && cp .env.example .env.local && npm install && npm run dev
```
DB integration tests run when `TEST_DATABASE_URL` points at a Postgres that has `supabase/migrations/0001_init.sql` applied.
