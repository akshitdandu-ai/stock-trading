import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS as S,
  charges, stopPrice, targetPrice, positionSize, taxEstimate, tradePnl, bookedPnl, realizedPnl,
  cashFromFills, equityFrom, bookThirdQty, defaultSellQty, stopAfterBooking, canRaiseStop, daysBetween,
  isStopHit, isTargetHit, isTimeStopDue, gainPct, checklistScore, scoreBucket, tradeStats,
  drawdownSeries, rebase, CHECKLIST_ITEMS,
} from '../lib/engine.ts';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('charges: percent per side plus DP charge on sells only', () => {
  close(charges('buy', 10, 100, S), 1000 * 0.12 / 100);
  close(charges('sell', 10, 100, S), 1000 * 0.12 / 100 + 20);
  close(charges('buy', 0, 100, S), 0);
});

test('money values that get stored are rounded to paise like the pipeline', () => {
  assert.equal(charges('buy', 7, 123.45, S), 1.04); // 864.15 * 0.0012 = 1.03698
  assert.equal(charges('sell', 7, 123.45, S), 21.04);
  assert.equal(stopPrice(123.45, S), 113.57); // 113.574
  assert.equal(targetPrice(123.45, S), 148.14);
  assert.equal(taxEstimate(333.33, S), 69.33); // 69.33264
});

test('stop and target prices', () => {
  close(stopPrice(100, S), 92);
  close(targetPrice(100, S), 120);
});

test('positionSize: risk-limited', () => {
  // equity 5000, risk 3% = 150; entry 100 stop 92 -> 150/8 = 18.75 -> 18; cash large
  const r = positionSize({ equity: 5000, cash: 100000, entry: 100 }, S);
  assert.equal(r.qty, 18);
  assert.equal(r.riskQty, 18);
  assert.equal(r.limitedBy, 'risk');
  assert.equal(r.warning, null);
  close(r.stop, 92);
  close(r.riskAmount, 150);
});

test('positionSize: cash-limited', () => {
  // risk qty = 150/8 = 18, cash 1000 / (100*1.0012) = 9.98 -> 9
  const r = positionSize({ equity: 5000, cash: 1000, entry: 100 }, S);
  assert.equal(r.riskQty, 18);
  assert.equal(r.cashQty, 9);
  assert.equal(r.qty, 9);
  assert.equal(r.limitedBy, 'cash');
});

test('positionSize: too expensive -> qty 0 with warning (risk-limited)', () => {
  // 1 share at 5000 risks 400 > 150 budget
  const r = positionSize({ equity: 5000, cash: 5000, entry: 5000 }, S);
  assert.equal(r.qty, 0);
  assert.equal(r.riskQty, 0);
  assert.match(r.warning ?? '', /too expensive to buy even 1 share/i);
  assert.match(r.warning ?? '', /risk-limited/);
});

test('positionSize: too expensive (cash-limited)', () => {
  const r = positionSize({ equity: 100000, cash: 50, entry: 100 }, S);
  assert.equal(r.qty, 0);
  assert.match(r.warning ?? '', /cash-limited/);
});

test('positionSize: invalid entry', () => {
  assert.equal(positionSize({ equity: 5000, cash: 5000, entry: 0 }, S).qty, 0);
  assert.equal(positionSize({ equity: 5000, cash: 5000, entry: NaN }, S).qty, 0);
});

test('positionSize: stop override only affects risk sizing', () => {
  // stop 95 -> risk/share 5 -> 150/5 = 30
  const r = positionSize({ equity: 5000, cash: 100000, entry: 100, stopOverride: 95 }, S);
  assert.equal(r.qty, 30);
  close(r.stop, 95);
  // override above entry is ignored
  assert.equal(positionSize({ equity: 5000, cash: 100000, entry: 100, stopOverride: 105 }, S).qty, 18);
});

test('taxEstimate: 20% + 4% cess on positive net only', () => {
  close(taxEstimate(1000, S), 208);
  assert.equal(taxEstimate(-500, S), 0);
  assert.equal(taxEstimate(0, S), 0);
});

test('tradePnl: closed trade = sells - buys - charges', () => {
  const fills = [
    { side: 'buy' as const, qty: 10, price: 100, charges: 1.2 },
    { side: 'sell' as const, qty: 4, price: 120, charges: 20.576 },
    { side: 'sell' as const, qty: 6, price: 110, charges: 20.792 },
  ];
  close(tradePnl(fills), 480 + 660 - 1000 - 1.2 - 20.576 - 20.792);
});

test('bookedPnl: partial sell of an open trade with pro-rata entry charges', () => {
  const fills = [
    { side: 'buy' as const, qty: 9, price: 100, charges: 1.08 },
    { side: 'sell' as const, qty: 3, price: 120, charges: 20.432 },
  ];
  // proceeds 360 - cost 300 - charges 20.432 - entry charges 1.08*3/9
  close(bookedPnl(100, 9, fills), 360 - 300 - 20.432 - 1.08 / 3);
  const t = { status: 'open' as const, entry_price: 100, initial_qty: 9 };
  close(realizedPnl(t, fills), bookedPnl(100, 9, fills));
  close(realizedPnl({ ...t, status: 'closed' }, fills), tradePnl(fills));
});

test('bookedPnl on every share sold equals tradePnl', () => {
  const fills = [
    { side: 'buy' as const, qty: 9, price: 100, charges: 1.08 },
    { side: 'sell' as const, qty: 3, price: 120, charges: 20.4 },
    { side: 'sell' as const, qty: 6, price: 130, charges: 20.9 },
  ];
  close(bookedPnl(100, 9, fills), tradePnl(fills));
});

test('cash and equity', () => {
  const fills = [
    { side: 'buy' as const, qty: 10, price: 100, charges: 1.2 },
    { side: 'sell' as const, qty: 3, price: 120, charges: 20.432 },
  ];
  const cash = cashFromFills(5000, fills);
  close(cash, 5000 - 1001.2 + 360 - 20.432);
  close(equityFrom(cash, [{ qty: 7, price: 118 }]), cash + 826);
  close(cashFromFills(5000, []), 5000);
});

test('bookThirdQty: round(qty/3), min 1 if qty >= 2, none below 2', () => {
  assert.equal(bookThirdQty(0), 0);
  assert.equal(bookThirdQty(1), 0);
  assert.equal(bookThirdQty(2), 1);
  assert.equal(bookThirdQty(3), 1);
  assert.equal(bookThirdQty(4), 1);
  assert.equal(bookThirdQty(5), 2);
  assert.equal(bookThirdQty(9), 3);
  assert.equal(bookThirdQty(10), 3);
  assert.equal(bookThirdQty(11), 4);
});

test('defaultSellQty and stopAfterBooking', () => {
  assert.equal(defaultSellQty('target', 9), 3);
  assert.equal(defaultSellQty('stop', 9), 9);
  assert.equal(defaultSellQty('manual', 1), 1);
  assert.equal(stopAfterBooking(92, 100), 100);
  assert.equal(stopAfterBooking(105, 100), 105);
});

test('canRaiseStop only allows higher stops', () => {
  assert.equal(canRaiseStop(92, 95).ok, true);
  assert.equal(canRaiseStop(92, 92).ok, false);
  assert.equal(canRaiseStop(92, 90).ok, false);
  assert.equal(canRaiseStop(92, -1).ok, false);
  assert.equal(canRaiseStop(92, NaN).ok, false);
});

test('days, stop/target/time-stop rules', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-22'), 21);
  assert.equal(daysBetween('2026-02-27', '2026-03-02'), 3);
  assert.equal(isStopHit(92, 92), true);
  assert.equal(isStopHit(93, 92), false);
  assert.equal(isTargetHit(120, 120), true);
  assert.equal(isTargetHit(119.9, 120), false);
  close(gainPct(100, 104), 4);
  assert.equal(isTimeStopDue(21, 4, S), true);
  assert.equal(isTimeStopDue(21, 5, S), false);
  assert.equal(isTimeStopDue(20, 0, S), false);
});

test('checklist score and buckets', () => {
  assert.equal(CHECKLIST_ITEMS.length, 7);
  assert.equal(checklistScore({}), 0);
  assert.equal(checklistScore({ eps_growth: true, debt_equity: true, bogus: true, promoter: false }), 2);
  assert.equal(checklistScore(null), 0);
  assert.equal(scoreBucket(0), '0–3');
  assert.equal(scoreBucket(3), '0–3');
  assert.equal(scoreBucket(4), '4–5');
  assert.equal(scoreBucket(5), '4–5');
  assert.equal(scoreBucket(6), '6–7');
  assert.equal(scoreBucket(7), '6–7');
  assert.equal(scoreBucket(null), 'none');
});

test('tradeStats', () => {
  const s = tradeStats([100, -50, 200, -50]);
  assert.equal(s.n, 4);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.avgWin, 150);
  assert.equal(s.avgLoss, -50);
  assert.equal(s.expectancy, 50);
  assert.equal(s.profitFactor, 3);
  const e = tradeStats([]);
  assert.equal(e.winRate, null);
  assert.equal(e.profitFactor, null);
  assert.equal(tradeStats([10, 20]).profitFactor, Infinity);
});

test('drawdownSeries and rebase', () => {
  const dd = drawdownSeries([100, 110, 99, 120]);
  assert.deepEqual(dd.map((x) => Math.round(x * 100) / 100), [0, 0, -10, 0]);
  assert.deepEqual(rebase([50, 100, null, 25], 100), [100, 200, null, 50]);
  assert.deepEqual(rebase([null, null], 100), [null, null]);
});
