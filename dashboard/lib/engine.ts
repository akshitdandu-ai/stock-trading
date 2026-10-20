// Pure trading-engine functions. No imports, no I/O.
// These duplicate pipeline/engine (Python) and MUST match docs/CONTRACT.md exactly.
// Money amounts that get stored (charges, stop, target, tax) are rounded to 2 decimals (paise), exactly like
// pipeline/engine/sizing.py. Everything else follows the contract formulas unchanged.

export type Settings = {
  capital: number;
  risk_pct: number;
  stop_pct: number;
  target_pct: number;
  charges_pct_per_side: number;
  dp_charge: number;
  stcg_rate_pct: number;
  cess_pct: number;
  time_stop_days: number;
  time_stop_min_gain_pct: number;
  trail_ema: number;
  watchlist_near_pivot_pct: number;
  extended_pct: number;
  min_price: number;
  min_avg_traded_value_cr: number;
  mcap_min_cr: number;
  mcap_max_cr: number;
  rs_min_excess_pp: number;
  breakout_vol_mult: number;
  breakout_deliv_pct: number;
};

export const DEFAULT_SETTINGS: Settings = {
  capital: 5000,
  risk_pct: 3,
  stop_pct: 8,
  target_pct: 20,
  charges_pct_per_side: 0.12,
  dp_charge: 20,
  stcg_rate_pct: 20,
  cess_pct: 4,
  time_stop_days: 21,
  time_stop_min_gain_pct: 5,
  trail_ema: 21,
  watchlist_near_pivot_pct: 5,
  extended_pct: 5,
  min_price: 50,
  min_avg_traded_value_cr: 10,
  mcap_min_cr: 1000,
  mcap_max_cr: 30000,
  rs_min_excess_pp: 20,
  breakout_vol_mult: 1.5,
  breakout_deliv_pct: 50,
};

export type Side = 'buy' | 'sell';
export type ExitReason = 'stop' | 'target' | 'trail' | 'time_stop' | 'manual';
export const EXIT_REASONS: ExitReason[] = ['target', 'stop', 'trail', 'time_stop', 'manual'];
export const EXIT_REASON_LABELS: Record<ExitReason, string> = {
  target: 'Target hit: book 1/3',
  stop: 'Stop hit',
  trail: 'Trail: closed below EMA',
  time_stop: 'Time stop',
  manual: 'Manual',
};

type ChargeSettings = Pick<Settings, 'charges_pct_per_side' | 'dp_charge'>;

/** Charges for one fill: value * charges_pct_per_side/100, plus dp_charge on sells. */
export function charges(side: Side, qty: number, price: number, s: ChargeSettings): number {
  const value = qty * price;
  const c = value * s.charges_pct_per_side / 100 + (side === 'sell' ? s.dp_charge : 0);
  return round2(c);
}

export function stopPrice(entry: number, s: Pick<Settings, 'stop_pct'>): number {
  return round2(entry * (1 - s.stop_pct / 100));
}

export function targetPrice(entry: number, s: Pick<Settings, 'target_pct'>): number {
  return round2(entry * (1 + s.target_pct / 100));
}

export type SizeResult = {
  qty: number;
  riskQty: number;
  cashQty: number;
  riskAmount: number;
  stop: number;
  limitedBy: 'risk' | 'cash' | null;
  warning: string | null;
};

/**
 * Position size. risk = equity*risk_pct/100; stop = entry*(1-stop_pct/100);
 * qty = floor(risk/(entry-stop)); qty = min(qty, floor(cash/(entry*(1+charges_pct/100)))).
 * `stopOverride` (dashboard-only extension) sizes against a user-chosen stop instead of stop_pct;
 * leave it undefined to follow the contract exactly.
 */
export function positionSize(
  input: { equity: number; cash: number; entry: number; stopOverride?: number },
  s: Pick<Settings, 'risk_pct' | 'stop_pct' | 'charges_pct_per_side'>,
): SizeResult {
  const { equity, cash, entry } = input;
  if (!(entry > 0) || !Number.isFinite(entry)) {
    return { qty: 0, riskQty: 0, cashQty: 0, riskAmount: 0, stop: 0, limitedBy: null, warning: 'Enter a valid entry price.' };
  }
  const risk = equity * s.risk_pct / 100;
  const stop =
    input.stopOverride !== undefined && input.stopOverride > 0 && input.stopOverride < entry
      ? input.stopOverride
      : stopPrice(entry, s);
  const riskPerShare = entry - stop;
  const riskQty = riskPerShare > 0 ? Math.max(0, Math.floor(risk / riskPerShare)) : 0;
  const cashQty = Math.max(0, Math.floor(cash / (entry * (1 + s.charges_pct_per_side / 100))));
  let qty = Math.min(riskQty, cashQty);
  let limitedBy: 'risk' | 'cash' | null = riskQty <= cashQty ? 'risk' : 'cash';
  let warning: string | null = null;
  if (qty < 1) {
    qty = 0;
    const why =
      riskQty < 1 && cashQty < 1
        ? 'risk-limited and cash-limited'
        : riskQty < 1
          ? 'risk-limited: 1 share risks more than the per-trade risk budget'
          : 'cash-limited: not enough cash';
    warning = `Too expensive to buy even 1 share (${why}).`;
    limitedBy = riskQty < 1 ? 'risk' : 'cash';
  }
  return { qty, riskQty, cashQty, riskAmount: risk, stop, limitedBy, warning };
}

/** STCG tax estimate = max(0, net realized) * rate/100 * (1 + cess/100). */
export function taxEstimate(
  netRealized: number,
  s: Pick<Settings, 'stcg_rate_pct' | 'cess_pct'>,
): number {
  return round2(Math.max(0, netRealized) * (s.stcg_rate_pct / 100) * (1 + s.cess_pct / 100));
}

export type FillLike = { side: Side; qty: number; price: number; charges: number };

/** Net realized P&L of a CLOSED trade: sells - buys - charges. */
export function tradePnl(fills: FillLike[]): number {
  let sells = 0;
  let buys = 0;
  let ch = 0;
  for (const f of fills) {
    if (f.side === 'sell') sells += f.qty * f.price;
    else buys += f.qty * f.price;
    ch += f.charges;
  }
  return sells - buys - ch;
}

/**
 * Booked P&L on the partial sells of an OPEN trade: proceeds of the shares sold, minus
 * entry_price * qty sold, minus charges on those sell fills, minus entry charges pro rata.
 */
export function bookedPnl(entryPrice: number, initialQty: number, fills: FillLike[]): number {
  const buyCharges = fills.filter((f) => f.side === 'buy').reduce((a, f) => a + f.charges, 0);
  let total = 0;
  for (const f of fills) {
    if (f.side !== 'sell') continue;
    total += f.qty * f.price - entryPrice * f.qty - f.charges;
    if (initialQty > 0) total -= buyCharges * f.qty / initialQty;
  }
  return total;
}

/** Realized net P&L of a trade: full formula when closed, booked partial P&L when open. */
export function realizedPnl(
  trade: { status: 'open' | 'closed'; entry_price: number; initial_qty: number },
  fills: FillLike[],
): number {
  return trade.status === 'closed'
    ? tradePnl(fills)
    : bookedPnl(trade.entry_price, trade.initial_qty, fills);
}

/** cash = capital + sum(sell qty*price - charges) - sum(buy qty*price + charges). */
export function cashFromFills(capital: number, fills: FillLike[]): number {
  let cash = capital;
  for (const f of fills) {
    if (f.side === 'sell') cash += f.qty * f.price - f.charges;
    else cash -= f.qty * f.price + f.charges;
  }
  return cash;
}

/** equity = cash + sum(open qty * latest close). */
export function equityFrom(cash: number, positions: { qty: number; price: number }[]): number {
  return cash + positions.reduce((a, p) => a + p.qty * p.price, 0);
}

// ---------- exit-rule helpers ----------

/** "Book 1/3" qty: round(qty/3), min 1 if qty >= 2; below 2 shares nothing is sold. */
export function bookThirdQty(heldQty: number): number {
  if (heldQty < 2) return 0;
  return Math.max(1, Math.round(heldQty / 3));
}

/** Default sell qty for an exit reason: 'target' books 1/3, everything else exits fully. */
export function defaultSellQty(reason: ExitReason, heldQty: number): number {
  return reason === 'target' ? bookThirdQty(heldQty) : heldQty;
}

/** After booking 1/3 the stop moves to at least the entry price. */
export function stopAfterBooking(stop: number, entryPrice: number): number {
  return Math.max(stop, entryPrice);
}

export function canRaiseStop(current: number, next: number): { ok: boolean; message: string | null } {
  if (!Number.isFinite(next) || next <= 0) return { ok: false, message: 'Stop must be a positive price.' };
  if (!(next > current)) {
    return { ok: false, message: `Stops can only move up: new stop must be above the current ₹${current}.` };
  }
  return { ok: true, message: null };
}

export function gainPct(entryPrice: number, lastPrice: number): number {
  return (lastPrice / entryPrice - 1) * 100;
}

/** Calendar days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a: string, b: string): number {
  const ta = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const tb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((tb - ta) / 86400000);
}

export function isStopHit(close: number, stop: number): boolean {
  return close <= stop;
}
export function isTargetHit(close: number, target: number): boolean {
  return close >= target;
}
/** Time stop: held >= time_stop_days calendar days and gain below time_stop_min_gain_pct. */
export function isTimeStopDue(
  daysHeld: number,
  gainPercent: number,
  s: Pick<Settings, 'time_stop_days' | 'time_stop_min_gain_pct'>,
): boolean {
  return daysHeld >= s.time_stop_days && gainPercent < s.time_stop_min_gain_pct;
}

// ---------- checklist ----------

export const CHECKLIST_ITEMS = [
  { key: 'eps_growth', label: 'EPS growth ≥ 25% YoY' },
  { key: 'revenue_growth', label: 'Revenue growth ≥ 20% YoY' },
  { key: 'accelerating', label: 'Growth accelerating vs previous quarter' },
  { key: 'debt_equity', label: 'Debt/Equity < 1' },
  { key: 'promoter', label: 'Promoter pledge zero and holding stable' },
  { key: 'no_results_soon', label: 'No results due in the next 2 weeks' },
  { key: 'no_red_flags', label: 'No auditor exit / SEBI order / promoter selling' },
] as const;
export type ChecklistKey = (typeof CHECKLIST_ITEMS)[number]['key'];

export function checklistScore(items: Record<string, unknown> | null | undefined): number {
  if (!items) return 0;
  return CHECKLIST_ITEMS.filter((c) => items[c.key] === true).length;
}

export function scoreBucket(score: number | null | undefined): '0–3' | '4–5' | '6–7' | 'none' {
  if (score === null || score === undefined) return 'none';
  if (score <= 3) return '0–3';
  if (score <= 5) return '4–5';
  return '6–7';
}

// ---------- performance statistics ----------

export type TradeStats = {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null; // negative number
  expectancy: number | null;
  profitFactor: number | null; // Infinity when there are wins and no losses
  grossWin: number;
  grossLoss: number; // positive magnitude
  total: number;
};

export function tradeStats(pnls: number[]): TradeStats {
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const n = pnls.length;
  const winRate = n ? wins.length / n : null;
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? -grossLoss / losses.length : null;
  const expectancy = n ? pnls.reduce((a, b) => a + b, 0) / n : null;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;
  return {
    n, wins: wins.length, losses: losses.length, winRate, avgWin, avgLoss, expectancy, profitFactor,
    grossWin, grossLoss, total: pnls.reduce((a, b) => a + b, 0),
  };
}

/** Drawdown from running peak, in percent (<= 0). */
export function drawdownSeries(values: number[]): number[] {
  let peak = -Infinity;
  return values.map((v) => {
    if (v > peak) peak = v;
    return peak > 0 ? (v / peak - 1) * 100 : 0;
  });
}

/** Rebase a series so its first non-null value equals `base`. Null stays null. */
export function rebase(values: (number | null)[], base: number): (number | null)[] {
  const first = values.find((v) => v !== null && v !== undefined && v > 0);
  if (first === undefined || first === null) return values.map(() => null);
  return values.map((v) => (v === null || v === undefined ? null : (v / first) * base));
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
