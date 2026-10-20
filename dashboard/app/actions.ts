'use server';

import { revalidatePath } from 'next/cache';
import { dbConfigured, errorMessage, sql } from '@/lib/db';
import {
  CHECKLIST_ITEMS, EXIT_REASONS, canRaiseStop, charges, checklistScore, stopAfterBooking,
  round2, stopPrice, targetPrice, tradePnl, type ExitReason, type Settings,
} from '@/lib/engine';
import { getSettings } from '@/lib/settings';
import { cashNow, getLastClose, latestDataDate, pendingBuyReserve } from '@/lib/queries';
import { inr, todayIST } from '@/lib/format';
import type { ActionState, FillRow } from '@/lib/types';

// ---------- helpers ----------

class UserError extends Error {}

const ok = (message: string): ActionState => ({ ok: true, message });
const fail = (message: string): ActionState => ({ ok: false, message });
const NO_DB = 'DATABASE_URL is not set: the dashboard cannot reach the database.';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
function optNum(fd: FormData, key: string, label: string): number | null {
  const raw = str(fd, key);
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UserError(`${label} must be a number.`);
  return n;
}
function reqNum(fd: FormData, key: string, label: string): number {
  const n = optNum(fd, key, label);
  if (n === null) throw new UserError(`${label} is required.`);
  return n;
}
function reqInt(fd: FormData, key: string, label: string): number {
  const n = reqNum(fd, key, label);
  if (!Number.isInteger(n)) throw new UserError(`${label} must be a whole number.`);
  return n;
}
function reqId(fd: FormData, key: string, label: string): number {
  const n = reqInt(fd, key, label);
  if (n < 1) throw new UserError(`${label} is invalid.`);
  return n;
}
function dateField(fd: FormData, key: string, label: string): string {
  const v = str(fd, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
    throw new UserError(`${label} must be a valid date (YYYY-MM-DD).`);
  }
  if (v > todayIST()) throw new UserError(`${label} cannot be in the future.`);
  return v;
}
function symbolField(fd: FormData): string {
  const s = str(fd, 'symbol').toUpperCase();
  if (!/^[A-Z0-9&_-]{1,25}$/.test(s)) throw new UserError('Invalid symbol.');
  return s;
}
function limited(s: string, max: number): string | null {
  return s === '' ? null : s.slice(0, max);
}

async function run(fn: () => Promise<ActionState>): Promise<ActionState> {
  try {
    if (!dbConfigured()) return fail(NO_DB);
    const res = await fn();
    if (res?.ok) revalidatePath('/', 'layout');
    return res;
  } catch (e) {
    if (e instanceof UserError) return fail(e.message);
    console.error('[action]', e);
    return fail('Database error: ' + errorMessage(e));
  }
}

const LOCK_KEY = 7001; // serialises all money-moving transactions

// ---------- buy ----------

export async function confirmBuy(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const symbol = symbolField(fd);
    const qty = reqInt(fd, 'qty', 'Quantity');
    if (qty < 1) throw new UserError('Quantity must be at least 1 share.');
    if (qty > 10_000_000) throw new UserError('Quantity is unrealistically large.');
    const manual = str(fd, 'mode') === 'manual';
    const entryReason = limited(str(fd, 'reason'), 60) ?? 'manual';
    const notes = limited(str(fd, 'notes'), 2000);
    const stopIn = optNum(fd, 'stop', 'Stop');
    if (stopIn !== null && stopIn <= 0) throw new UserError('Stop must be a positive price.');

    const price = manual ? reqNum(fd, 'price', 'Entry price') : null;
    if (price !== null && !(price > 0)) throw new UserError('Entry price must be greater than 0.');
    const fillDate = manual ? dateField(fd, 'fill_date', 'Fill date') : null;

    return await sql().begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
      const s = await getSettings(tx);
      const dataDate = await latestDataDate(tx);
      if (!dataDate) throw new UserError('There is no price data yet: run the daily job first.');

      const held = await tx`select id from trades where symbol = ${symbol} and status = 'open' limit 1`;
      if (held.length) throw new UserError(`You already hold ${symbol}. Adding to a position is not supported.`);
      const pend = await tx`select id from orders where symbol = ${symbol} and side = 'buy' and status = 'pending' limit 1`;
      if (pend.length) throw new UserError(`There is already a pending buy order for ${symbol}. Cancel it first.`);

      const cash = await cashNow(tx, s.capital);
      const available = cash - (await pendingBuyReserve(tx, s));
      const cs = await tx<{ score: number }[]>`select score from checklists where symbol = ${symbol}`;
      const checklist = cs[0]?.score ?? null;

      if (!manual) {
        const lc = (await getLastClose(tx, [symbol]))[symbol];
        if (!lc) throw new UserError(`No price data for ${symbol}.`);
        const need = qty * lc.close * (1 + s.charges_pct_per_side / 100);
        if (need > available + 1e-9) {
          throw new UserError(
            `Not enough cash: ${qty} × ${inr(lc.close)} (last close) + charges is about ${inr(need)}, but available cash is ${inr(available)}.`,
          );
        }
        if (stopIn !== null && stopIn >= lc.close) throw new UserError(`Stop must be below the last close (${inr(lc.close)}).`);
        await tx`
          insert into orders (side, symbol, qty, price, status, reason, checklist_score, notes, stop, created_data_date)
          values ('buy', ${symbol}, ${qty}, null, 'pending', ${entryReason}, ${checklist}, ${notes}, ${stopIn}, ${dataDate})`;
        return ok(`Buy order for ${qty} × ${symbol} placed. It fills automatically at the next session's open when the evening job runs.`);
      }

      const px = price as number;
      const stop = stopIn ?? stopPrice(px, s);
      if (stop >= px) throw new UserError('Stop must be below the entry price.');
      const ch = charges('buy', qty, px, s);
      const need = qty * px + ch;
      if (need > available + 1e-9) {
        throw new UserError(`Not enough cash: this buy costs ${inr(need)} including charges, but available cash is ${inr(available)}.`);
      }
      const target = targetPrice(px, s);
      const [order] = await tx<{ id: number }[]>`
        insert into orders (side, symbol, qty, price, status, reason, checklist_score, notes, stop, created_data_date, fill_date, fill_price)
        values ('buy', ${symbol}, ${qty}, ${px}, 'filled', ${entryReason}, ${checklist}, ${notes}, ${stop}, ${dataDate}, ${fillDate}, ${px})
        returning id`;
      const [trade] = await tx<{ id: number }[]>`
        insert into trades (symbol, status, entry_date, entry_price, initial_qty, qty, stop, target, booked_third,
                            checklist_score, entry_reason, notes)
        values (${symbol}, 'open', ${fillDate}, ${px}, ${qty}, ${qty}, ${stop}, ${target}, false, ${checklist}, ${entryReason}, ${notes})
        returning id`;
      await tx`
        insert into fills (trade_id, fill_date, side, qty, price, charges, reason)
        values (${trade.id}, ${fillDate}, 'buy', ${qty}, ${px}, ${ch}, ${entryReason})`;
      await tx`update orders set trade_id = ${trade.id} where id = ${order.id}`;
      return ok(`Bought ${qty} × ${symbol} at ${inr(px)} (charges ${inr(ch)}). Stop ${inr(stop)}, target ${inr(target)}.`);
    });
  });
}

// ---------- sell ----------

export async function confirmSell(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const tradeId = reqId(fd, 'trade_id', 'Trade');
    const reason = str(fd, 'reason') as ExitReason;
    if (!EXIT_REASONS.includes(reason)) throw new UserError('Choose a sell reason.');
    const manual = str(fd, 'mode') === 'manual';
    const notes = limited(str(fd, 'notes'), 2000);
    const qtyRaw = str(fd, 'qty');
    const price = manual ? reqNum(fd, 'price', 'Sell price') : null;
    if (price !== null && !(price > 0)) throw new UserError('Sell price must be greater than 0.');
    const fillDate = manual ? dateField(fd, 'fill_date', 'Fill date') : null;

    return await sql().begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
      const s = await getSettings(tx);
      const dataDate = await latestDataDate(tx);
      if (!dataDate) throw new UserError('There is no price data yet: run the daily job first.');
      const [t] = await tx<{
        id: number; symbol: string; status: string; entry_date: string; entry_price: number; qty: number; stop: number; booked_third: boolean;
      }[]>`select id, symbol, status, entry_date, entry_price, qty, stop, booked_third from trades where id = ${tradeId} for update`;
      if (!t) throw new UserError('Trade not found.');
      if (t.status !== 'open') throw new UserError('That trade is already closed.');

      // Book 1/3 with fewer than 2 shares: nothing to sell, just mark it and move the stop to entry.
      if (reason === 'target' && t.qty < 2) {
        await tx`update trades set booked_third = true, stop = ${stopAfterBooking(t.stop, t.entry_price)} where id = ${t.id}`;
        return ok(`Only ${t.qty} share held: nothing sold, marked 1/3 as booked and moved the stop to the entry price (${inr(t.entry_price)}).`);
      }

      const qty = Number(qtyRaw);
      if (qtyRaw === '' || !Number.isInteger(qty) || qty < 1) throw new UserError('Quantity must be a whole number of at least 1.');
      if (qty > t.qty) throw new UserError(`You only hold ${t.qty} share(s) of ${t.symbol}.`);

      const [{ pending }] = await tx<{ pending: number }[]>`
        select coalesce(sum(qty), 0) as pending from orders where trade_id = ${t.id} and side = 'sell' and status = 'pending'`;
      if (qty + pending > t.qty) {
        throw new UserError(`There are already pending sell orders for ${pending} share(s); only ${t.qty - pending} more can be sold. Cancel a pending order first.`);
      }

      if (!manual) {
        await tx`
          insert into orders (side, symbol, trade_id, qty, price, status, reason, notes, created_data_date)
          values ('sell', ${t.symbol}, ${t.id}, ${qty}, null, 'pending', ${reason}, ${notes}, ${dataDate})`;
        return ok(`Sell order for ${qty} × ${t.symbol} (${reason}) placed. It fills at the next session's open when the evening job runs.`);
      }

      const px = price as number;
      const date = fillDate as string;
      if (date < t.entry_date) throw new UserError(`Fill date cannot be before the entry date (${t.entry_date}).`);
      const ch = charges('sell', qty, px, s);
      await tx`
        insert into orders (side, symbol, trade_id, qty, price, status, reason, notes, created_data_date, fill_date, fill_price)
        values ('sell', ${t.symbol}, ${t.id}, ${qty}, ${px}, 'filled', ${reason}, ${notes}, ${dataDate}, ${date}, ${px})`;
      await tx`
        insert into fills (trade_id, fill_date, side, qty, price, charges, reason, note)
        values (${t.id}, ${date}, 'sell', ${qty}, ${px}, ${ch}, ${reason}, ${notes})`;
      const remaining = t.qty - qty;
      const booked = t.booked_third || reason === 'target';
      const stop = reason === 'target' ? stopAfterBooking(t.stop, t.entry_price) : t.stop;
      if (remaining > 0) {
        await tx`update trades set qty = ${remaining}, booked_third = ${booked}, stop = ${stop} where id = ${t.id}`;
        return ok(`Sold ${qty} × ${t.symbol} at ${inr(px)} (charges ${inr(ch)}). ${remaining} share(s) remain.${reason === 'target' ? ` Stop moved to ${inr(stop)}.` : ''}`);
      }
      const fills = await tx<FillRow[]>`select id, trade_id, fill_date, side, qty, price, charges, reason from fills where trade_id = ${t.id}`;
      const pnl = round2(tradePnl(fills));
      await tx`
        update trades set qty = 0, status = 'closed', booked_third = ${booked}, stop = ${stop},
               exit_date = ${date}, exit_reason = ${reason}, realized_pnl = ${pnl}
        where id = ${t.id}`;
      await tx`update alerts set acknowledged = true where trade_id = ${t.id}`;
      return ok(`Sold ${qty} × ${t.symbol} at ${inr(px)}. Trade closed with net P&L ${inr(pnl)} after charges.`);
    });
  });
}

export async function cancelOrder(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const id = reqId(fd, 'order_id', 'Order');
    const rows = await sql()`update orders set status = 'cancelled' where id = ${id} and status = 'pending' returning id`;
    if (!rows.length) throw new UserError('That order is no longer pending (it may already have been filled).');
    return ok('Order cancelled.');
  });
}

export async function raiseStop(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const id = reqId(fd, 'trade_id', 'Trade');
    const next = reqNum(fd, 'stop', 'Stop');
    return await sql().begin(async (tx) => {
      const [t] = await tx<{ symbol: string; status: string; stop: number }[]>`
        select symbol, status, stop from trades where id = ${id} for update`;
      if (!t) throw new UserError('Trade not found.');
      if (t.status !== 'open') throw new UserError('That trade is closed.');
      const check = canRaiseStop(t.stop, next);
      if (!check.ok) throw new UserError(check.message ?? 'Invalid stop.');
      const lc = (await getLastClose(tx, [t.symbol]))[t.symbol];
      if (lc && next >= lc.close) throw new UserError(`Stop must be below the last close (${inr(lc.close)}).`);
      await tx`update trades set stop = ${next} where id = ${id}`;
      return ok(`Stop for ${t.symbol} raised from ${inr(t.stop)} to ${inr(next)}.`);
    });
  });
}

export async function saveTradeNotes(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const id = reqId(fd, 'trade_id', 'Trade');
    const notes = limited(str(fd, 'notes'), 4000);
    const rows = await sql()`update trades set notes = ${notes} where id = ${id} returning id`;
    if (!rows.length) throw new UserError('Trade not found.');
    return ok('Notes saved.');
  });
}

// ---------- checklist / watchlist / alerts ----------

export async function saveChecklist(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const symbol = symbolField(fd);
    const items: Record<string, boolean> = {};
    for (const c of CHECKLIST_ITEMS) items[c.key] = fd.get(c.key) === 'on';
    const score = checklistScore(items);
    const notes = limited(str(fd, 'notes'), 2000);
    const db = sql();
    await db`
      insert into checklists (symbol, items, score, notes, updated_at)
      values (${symbol}, ${db.json(items)}, ${score}, ${notes}, now())
      on conflict (symbol) do update set items = excluded.items, score = excluded.score,
        notes = excluded.notes, updated_at = now()`;
    return ok(`Checklist saved: ${score}/7.`);
  });
}

export async function toggleWatchlist(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const symbol = symbolField(fd);
    const add = str(fd, 'on') === '1';
    const db = sql();
    if (add) {
      await db`insert into watchlist (symbol) values (${symbol}) on conflict (symbol) do nothing`;
      return ok(`${symbol} added to watchlist.`);
    }
    await db`delete from watchlist where symbol = ${symbol}`;
    return ok(`${symbol} removed from watchlist.`);
  });
}

export async function acknowledgeAlert(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const id = reqId(fd, 'alert_id', 'Alert');
    await sql()`update alerts set acknowledged = true where id = ${id}`;
    return ok('Alert acknowledged.');
  });
}

// ---------- settings ----------

type Field = { key: keyof Settings; label: string; min: number; max: number; int?: boolean; minExclusive?: boolean };
const SETTING_FIELDS: Field[] = [
  { key: 'capital', label: 'Capital', min: 0, max: 1e9, minExclusive: true },
  { key: 'risk_pct', label: 'Risk per trade %', min: 0, max: 100, minExclusive: true },
  { key: 'stop_pct', label: 'Stop %', min: 0, max: 90, minExclusive: true },
  { key: 'target_pct', label: 'Target %', min: 0, max: 1000, minExclusive: true },
  { key: 'charges_pct_per_side', label: 'Charges % per side', min: 0, max: 5 },
  { key: 'dp_charge', label: 'DP charge', min: 0, max: 10000 },
  { key: 'time_stop_days', label: 'Time stop days', min: 1, max: 365, int: true },
  { key: 'time_stop_min_gain_pct', label: 'Time stop minimum gain %', min: -100, max: 1000 },
  { key: 'stcg_rate_pct', label: 'STCG rate %', min: 0, max: 100 },
  { key: 'cess_pct', label: 'Cess %', min: 0, max: 100 },
];

export async function saveSettings(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const patch: Record<string, number> = {};
    for (const f of SETTING_FIELDS) {
      const n = reqNum(fd, f.key, f.label);
      if (f.int && !Number.isInteger(n)) throw new UserError(`${f.label} must be a whole number.`);
      if (n < f.min || n > f.max || (f.minExclusive && n === f.min)) {
        throw new UserError(`${f.label} must be ${f.minExclusive ? 'greater than' : 'at least'} ${f.min} and at most ${f.max}.`);
      }
      patch[f.key] = n;
    }
    const db = sql();
    // Merge into the existing row so pipeline-only keys (scanner thresholds etc.) are preserved.
    await db`
      insert into settings (id, data, updated_at) values (1, ${db.json(patch)}, now())
      on conflict (id) do update set data = settings.data || excluded.data, updated_at = now()`;
    return ok('Settings saved.');
  });
}

