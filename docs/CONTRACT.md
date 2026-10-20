# Contract between the Python pipeline (`pipeline/`) and the Next.js dashboard (`dashboard/`)

Both talk to the same Supabase Postgres (schema: `supabase/migrations/0001_init.sql`). Paper trading only.

## Settings (`settings` table, row id=1, `data` jsonb; missing keys fall back to these defaults)
```json
{
  "capital": 5000, "risk_pct": 3, "stop_pct": 8, "target_pct": 20,
  "charges_pct_per_side": 0.12, "dp_charge": 20,
  "stcg_rate_pct": 20, "cess_pct": 4,
  "time_stop_days": 21, "time_stop_min_gain_pct": 5, "trail_ema": 21,
  "watchlist_near_pivot_pct": 5, "extended_pct": 5,
  "min_price": 50, "min_avg_traded_value_cr": 10, "mcap_min_cr": 1000, "mcap_max_cr": 30000,
  "rs_min_excess_pp": 20, "breakout_vol_mult": 1.5, "breakout_deliv_pct": 50
}
```
The dashboard Settings page edits: capital, risk_pct, stop_pct, target_pct, charges_pct_per_side, dp_charge, time_stop_days, time_stop_min_gain_pct (+ tax rates). Others read-only/advanced.

## Money rules (duplicated in `pipeline/engine/` (Python) and `dashboard/lib/engine.ts` — keep identical)
- charges for one fill = `value * charges_pct_per_side/100` + (`dp_charge` if side = sell). value = qty*price.
- position size: `risk = equity * risk_pct/100`; `stop = entry * (1 - stop_pct/100)`; `qty = floor(risk / (entry - stop))`; then `qty = min(qty, floor(cash / (entry * (1 + charges_pct/100))))`. If qty < 1 → qty 0 and warn "too expensive to buy even 1 share" (say whether risk-limited or cash-limited).
- `target = entry * (1 + target_pct/100)`.
- equity = cash + sum(open qty * latest close). cash = capital + sum(sell qty*price - charges) - sum(buy qty*price + charges), over all `fills`.
- STCG tax estimate = max(0, sum of realized net P&L over all closed trades and partial sells) * (stcg_rate_pct)/100 * (1 + cess_pct/100)  (20% + 4% cess => 20.8%).
- Trade realized net P&L: for a closed trade = sum(sell qty*price) - sum(buy qty*price) - sum(charges). Booked P&L on partial sells of open trades: proceeds of the sold shares minus (entry_price * qty sold) minus charges on those fills (and entry charges pro rata).

## Order / fill semantics
- The dashboard "Confirm paper buy/sell" inserts an `orders` row.
  - `price` NULL (default, "next open"): `pipeline/run_daily.py` fills it at the OPEN of the first trading session after `created_data_date`, creating/updating `trades` + `fills`.
  - `price` set (user override, with a fill date, default = latest data date): the DASHBOARD fills it immediately (order status 'filled', creates trades/fills in one DB transaction).
- Buy fill: insert `trades` (status open, entry_date, entry_price, initial_qty = qty = order qty, stop = order.stop or entry*(1-stop_pct/100), target, checklist_score from order, entry_reason, notes) + a `fills` buy row.
- Sell fill: insert `fills` sell row, reduce `trades.qty`. If reason = 'target' (book 1/3): `booked_third = true`, `stop = max(stop, entry_price)`. If qty reaches 0: `status='closed'`, `exit_date`, `exit_reason`, `realized_pnl`.
- Sell order qty for "book 1/3": `round(qty/3)` min 1 if qty >= 2; if qty < 2, no shares sold but booked_third=true and stop = entry.
- Stops can only move up (reject lower values).
- Exit reasons: 'stop','target','trail','time_stop','manual'.

## Alerts (written by pipeline each evening, `alerts` table; dashboard shows unacknowledged ones for open trades)
kind in 'stop' ("sell at next open"), 'target' ("book 1/3, move stop to entry"), 'trail' (after booking, close below 21-day EMA), 'time_stop'.

## Scanner output
`scan_runs` (latest `scan_date`) + `suggestions` rows for that date. `grp`: 'breakout' | 'watchlist' | 'extended'. `breakdown` jsonb: `{ "relative_strength": {"points":18.2,"max":30,"detail":"6M +45.0pp vs Smallcap 250"}, "closeness_to_pivot": {...}, "tightness": {...}, "volume_dryup": {...}, "sector_strength": {...} }`. `details` jsonb has: base_weeks, base_depth_pct, contractions (array of depth %), last_contraction_depth_pct, vol_ratio_last_contraction, breakout_volume_x, deliv_pct, rs_excess_pp, sma50/150/200, high_52w, low_52w, extended (bool), notes (array of strings).
`scan_runs.market_detail`: `{ index_close, sma50, sma200, rule: "close>50DMA>200DMA", ok, warnings: [..] }`. `warnings` lists filters that could not be applied because a data source was unavailable (e.g. "ASM/GSM list unavailable: filter NOT applied") — the dashboard must display them prominently.
`data_sources` rows give per-source freshness; "data as of" = `max(trade_date)` in `daily_prices` (also `scan_runs.data_date`) and must be shown on every page.

## Checklist (phase 3)
`checklists.items` keys: `eps_growth` (EPS growth >= 25% YoY), `revenue_growth` (>= 20% YoY), `accelerating` (growth accelerating vs previous quarter), `debt_equity` (D/E < 1), `promoter` (pledge zero and holding stable), `no_results_soon` (no results due in next 2 weeks), `no_red_flags` (no auditor exit / SEBI order / promoter selling). score = number of true keys.

## Backtest output
`backtest_runs` (latest two rows: filter_on true/false). `metrics` jsonb: trades, win_rate, avg_win, avg_loss, expectancy, expectancy_r, profit_factor, max_drawdown_pct, cagr_pct, total_return_pct, final_equity, start_capital. `equity_curve`: `[{"d":"YYYY-MM-DD","equity":n,"bench":n}]` (bench rebased to start capital). `trades`: array of `{symbol, entry_date, entry_price, exit_date, exit_price, qty, pnl, ret_pct, reason}`. `notes` has survivorship-bias explanation text.
