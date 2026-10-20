import type { Sql, TxSql } from './db.ts';
import { getSettings } from './settings.ts';
import {
  cashFromFills, daysBetween, equityFrom, realizedPnl, taxEstimate, tradePnl, type Settings,
} from './engine.ts';
import type { AlertRow, FillRow, OrderRow, ScanRun, SizingParams, SourceRow, SuggestionRow, TradeRow } from './types.ts';

type Q = Sql | TxSql;

// ---------- shell (header on every page) ----------

export type Shell = {
  dataDate: string | null;
  scanDate: string | null;
  badSources: SourceRow[];
};

export async function getShell(db: Sql): Promise<Shell> {
  const [d] = await db<{ d: string | null }[]>`select max(trade_date) as d from daily_prices`;
  const [s] = await db<{ d: string | null }[]>`select max(scan_date) as d from scan_runs`;
  const bad = await db<SourceRow[]>`
    select source, status, data_date, last_success, last_attempt, message, rows_last
    from data_sources where status <> 'ok' order by source`;
  return { dataDate: d?.d ?? null, scanDate: s?.d ?? null, badSources: bad };
}

export async function latestDataDate(db: Q): Promise<string | null> {
  const [d] = await db<{ d: string | null }[]>`select max(trade_date) as d from daily_prices`;
  return d?.d ?? null;
}

// ---------- portfolio ----------

export type PositionView = TradeRow & {
  last: number | null;
  lastDate: string | null;
  marketValue: number;
  pnl: number;
  pnlPct: number | null;
  daysHeld: number | null;
  alerts: AlertRow[];
  pendingSellQty: number;
  bookedPnl: number;
};

export type ClosedView = TradeRow & { pnl: number; fills: FillRow[] };

export type Portfolio = {
  settings: Settings;
  dataDate: string | null;
  cash: number;
  availableCash: number; // cash less the estimated cost of pending buy orders
  pendingBuyReserve: number;
  equity: number;
  openPnl: number;
  realizedTotal: number; // closed trades + booked partials, net of charges
  realizedClosed: number;
  realizedBooked: number;
  tax: number;
  netAfterTax: number;
  open: PositionView[];
  closed: ClosedView[];
  pendingOrders: OrderRow[];
  lastClose: Record<string, { close: number; date: string }>;
};

export async function getLastClose(db: Q, symbols: string[]): Promise<Record<string, { close: number; date: string }>> {
  const out: Record<string, { close: number; date: string }> = {};
  if (!symbols.length) return out;
  const rows = await db<{ symbol: string; close: number; trade_date: string }[]>`
    select distinct on (symbol) symbol, close, trade_date
    from daily_prices where symbol in ${db(symbols)}
    order by symbol, trade_date desc`;
  for (const r of rows) out[r.symbol] = { close: r.close, date: r.trade_date };
  return out;
}

export async function loadPortfolio(db: Sql): Promise<Portfolio> {
  const settings = await getSettings(db);
  const dataDate = await latestDataDate(db);
  const trades = await db<TradeRow[]>`
    select id, symbol, status, entry_date, entry_price, initial_qty, qty, stop, target, booked_third,
           checklist_score, entry_reason, notes, exit_date, exit_reason, realized_pnl
    from trades order by entry_date desc, id desc`;
  const fills = await db<FillRow[]>`
    select id, trade_id, fill_date, side, qty, price, charges, reason from fills order by fill_date, id`;
  const pendingOrders = await db<OrderRow[]>`
    select id, side, symbol, trade_id, qty, price, status, reason, notes, stop, created_data_date, created_at
    from orders where status = 'pending' order by created_at desc`;
  const alerts = await db<AlertRow[]>`
    select a.id, a.alert_date, a.trade_id, a.symbol, a.kind, a.message, a.acknowledged
    from alerts a join trades t on t.id = a.trade_id
    where a.acknowledged = false and t.status = 'open' order by a.alert_date desc, a.id desc`;

  const symbols = [...new Set([...trades.filter((t) => t.status === 'open').map((t) => t.symbol), ...pendingOrders.map((o) => o.symbol)])];
  const lastClose = await getLastClose(db, symbols);

  const fillsByTrade: Record<number, FillRow[]> = {};
  for (const f of fills) (fillsByTrade[f.trade_id] ??= []).push(f);

  const cash = cashFromFills(settings.capital, fills);

  const open: PositionView[] = [];
  const closed: ClosedView[] = [];
  let realizedClosed = 0;
  let realizedBooked = 0;
  for (const t of trades) {
    const tf = fillsByTrade[t.id] ?? [];
    const pnl = realizedPnl(t, tf);
    if (t.status === 'closed') {
      const final = t.realized_pnl ?? tradePnl(tf);
      realizedClosed += final;
      closed.push({ ...t, pnl: final, fills: tf });
    } else {
      realizedBooked += pnl;
      const lc = lastClose[t.symbol];
      const last = lc ? lc.close : null;
      const mark = last ?? t.entry_price;
      open.push({
        ...t,
        last,
        lastDate: lc?.date ?? null,
        marketValue: t.qty * mark,
        pnl: t.qty * (mark - t.entry_price),
        pnlPct: last !== null ? (last / t.entry_price - 1) * 100 : null,
        daysHeld: dataDate ? daysBetween(t.entry_date, dataDate) : null,
        alerts: alerts.filter((a) => a.trade_id === t.id),
        pendingSellQty: pendingOrders.filter((o) => o.side === 'sell' && o.trade_id === t.id).reduce((a, o) => a + o.qty, 0),
        bookedPnl: pnl,
      });
    }
  }

  const equity = equityFrom(cash, open.map((p) => ({ qty: p.qty, price: p.last ?? p.entry_price })));
  const openPnl = open.reduce((a, p) => a + p.pnl, 0);
  const realizedTotal = realizedClosed + realizedBooked;
  const tax = taxEstimate(realizedTotal, settings);
  const pendingBuyReserve = pendingOrders
    .filter((o) => o.side === 'buy')
    .reduce((a, o) => {
      const est = o.price ?? lastClose[o.symbol]?.close ?? 0;
      return a + o.qty * est * (1 + settings.charges_pct_per_side / 100);
    }, 0);

  return {
    settings, dataDate, cash, availableCash: cash - pendingBuyReserve, pendingBuyReserve, equity, openPnl,
    realizedTotal, realizedClosed, realizedBooked, tax, netAfterTax: equity - settings.capital - tax,
    open, closed, pendingOrders, lastClose,
  };
}

/** Cash from all fills, usable inside a transaction. */
export async function cashNow(db: Q, capital: number): Promise<number> {
  const [r] = await db<{ net: number }[]>`
    select coalesce(sum(case when side = 'sell' then qty * price - charges else -(qty * price + charges) end), 0) as net
    from fills`;
  return capital + (r?.net ?? 0);
}

// ---------- scan ----------

export async function getLatestScan(db: Sql): Promise<ScanRun | null> {
  const rows = await db<ScanRun[]>`
    select scan_date, data_date, market_filter_on, market_detail, counts, created_at
    from scan_runs order by scan_date desc limit 1`;
  return rows[0] ?? null;
}

/** Estimated cash tied up by pending buy orders (qty * last close * (1 + charge)). */
export async function pendingBuyReserve(db: Q, s: Settings): Promise<number> {
  const orders = await db<{ symbol: string; qty: number; price: number | null }[]>`
    select symbol, qty, price from orders where status = 'pending' and side = 'buy'`;
  if (!orders.length) return 0;
  const lc = await getLastClose(db, [...new Set(orders.map((o) => o.symbol))]);
  return orders.reduce((a, o) => a + o.qty * (o.price ?? lc[o.symbol]?.close ?? 0) * (1 + s.charges_pct_per_side / 100), 0);
}

export function sizingParams(p: Portfolio): SizingParams {
  const s = p.settings;
  return {
    equity: p.equity, cash: p.availableCash, risk_pct: s.risk_pct, stop_pct: s.stop_pct, target_pct: s.target_pct,
    charges_pct_per_side: s.charges_pct_per_side, dp_charge: s.dp_charge,
  };
}

export async function loadSuggestions(db: Sql, scanDate: string): Promise<SuggestionRow[]> {
  return db<SuggestionRow[]>`
    select s.scan_date, s.symbol, s.grp, s.sector, s.close, s.pivot, s.dist_pct, s.stop, s.target, s.qty,
           s.size_warning, s.score, s.breakdown, s.details, s.screener_url,
           c.items as checklist_items, c.score as checklist_score, c.notes as checklist_notes,
           exists (select 1 from watchlist w where w.symbol = s.symbol) as on_watchlist,
           exists (select 1 from trades t where t.symbol = s.symbol and t.status = 'open') as held,
           exists (select 1 from orders o where o.symbol = s.symbol and o.side = 'buy' and o.status = 'pending') as pending_buy
    from suggestions s left join checklists c on c.symbol = s.symbol
    where s.scan_date = ${scanDate}
    order by s.score desc, s.symbol`;
}
