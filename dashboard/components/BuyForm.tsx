'use client';

import { useState } from 'react';
import { confirmBuy } from '@/app/actions';
import { charges, positionSize, stopPrice, targetPrice } from '@/lib/engine';
import { inr } from '@/lib/format';
import type { SizingParams } from '@/lib/types';
import { ActionForm, SubmitButton } from './ActionForm';

export default function BuyForm({
  symbol, close, reason, suggestedQty, sizing, dataDate, today,
}: {
  symbol: string;
  close: number;
  reason: string;
  suggestedQty: number;
  sizing: SizingParams;
  dataDate: string | null;
  today: string;
}) {
  const [mode, setMode] = useState<'next_open' | 'manual'>('next_open');
  const [price, setPrice] = useState(String(close));
  const [fillDate, setFillDate] = useState(dataDate ?? today);
  const [stopStr, setStopStr] = useState('');
  const [stopEdited, setStopEdited] = useState(false);
  const [qtyStr, setQtyStr] = useState('');
  const [qtyEdited, setQtyEdited] = useState(false);
  const [entryReason, setEntryReason] = useState(reason);
  const [notes, setNotes] = useState('');

  const manual = mode === 'manual';
  const priceNum = Number(price);
  const entry = manual && priceNum > 0 ? priceNum : close;
  const defaultStop = stopPrice(entry, sizing);
  const stopNum = stopEdited ? Number(stopStr) : manual ? Number(defaultStop.toFixed(2)) : NaN;
  const stopOverride = Number.isFinite(stopNum) && stopNum > 0 && stopNum < entry ? stopNum : undefined;
  const size = positionSize({ equity: sizing.equity, cash: sizing.cash, entry, stopOverride }, sizing);
  const qty = qtyEdited ? Number(qtyStr) : size.qty;
  const qtyValid = Number.isInteger(qty) && qty >= 1;
  const cost = qtyValid ? qty * entry + charges('buy', qty, entry, sizing) : 0;
  const overCash = qtyValid && cost > sizing.cash + 1e-9;
  const stopShown = stopEdited ? stopStr : manual ? defaultStop.toFixed(2) : '';
  const effectiveStop = stopOverride ?? defaultStop;
  const maxLoss = qtyValid ? qty * (entry - effectiveStop) : 0;
  const manualInvalid = manual && !(priceNum > 0);

  return (
    <ActionForm action={confirmBuy} className="form">
      <input type="hidden" name="symbol" value={symbol} />
      <input type="hidden" name="mode" value={mode} />

      <div className="row">
        <div className="field">
          <label htmlFor={`qty-${symbol}`}>Quantity</label>
          <input
            id={`qty-${symbol}`} name="qty" type="number" min={1} step={1} inputMode="numeric"
            value={qtyEdited ? qtyStr : String(size.qty)}
            onChange={(e) => { setQtyEdited(true); setQtyStr(e.target.value); }}
          />
          <small>
            Scan suggested {suggestedQty}; sized now: {size.qty}
            {qtyEdited ? (
              <> · <button type="button" className="small" onClick={() => setQtyEdited(false)}>use sized qty</button></>
            ) : null}
          </small>
        </div>
      </div>

      {size.qty === 0 && !qtyEdited ? (
        <p className="msg err" role="alert">
          {size.warning ?? 'Too expensive to buy even 1 share.'} Equity {inr(sizing.equity)}, available cash {inr(sizing.cash)}.
        </p>
      ) : null}

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend className="small muted" style={{ padding: 0 }}>Entry price</legend>
        <label className="radio">
          <input type="radio" checked={!manual} onChange={() => setMode('next_open')} />
          <span>Next open: filled automatically by the evening job (default)</span>
        </label>
        <label className="radio">
          <input type="radio" checked={manual} onChange={() => setMode('manual')} />
          <span>Manual price: I already bought at a specific price, record it now</span>
        </label>
      </fieldset>

      {manual ? (
        <div className="row">
          <div className="field">
            <label htmlFor={`px-${symbol}`}>Entry price (₹)</label>
            <input id={`px-${symbol}`} name="price" type="number" min="0" step="any" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor={`fd-${symbol}`}>Fill date</label>
            <input id={`fd-${symbol}`} name="fill_date" type="date" max={today} value={fillDate} onChange={(e) => setFillDate(e.target.value)} required />
          </div>
        </div>
      ) : null}

      <div className="row">
        <div className="field">
          <label htmlFor={`stop-${symbol}`}>Stop (₹)</label>
          <input
            id={`stop-${symbol}`} name="stop" type="number" min="0" step="any" inputMode="decimal"
            value={stopShown}
            placeholder={`${sizing.stop_pct}% below fill ≈ ${defaultStop.toFixed(2)}`}
            onChange={(e) => { setStopEdited(true); setStopStr(e.target.value); }}
          />
          <small>{manual ? `Default: ${sizing.stop_pct}% below entry.` : `Leave blank for ${sizing.stop_pct}% below the actual fill price.`}</small>
        </div>
        <div className="field">
          <label htmlFor={`why-${symbol}`}>Entry reason</label>
          <input id={`why-${symbol}`} name="reason" value={entryReason} maxLength={60} onChange={(e) => setEntryReason(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`notes-${symbol}`}>Notes</label>
        <textarea id={`notes-${symbol}`} name="notes" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {qtyValid ? (
        <p className="small muted">
          {manual ? 'Cost' : `Estimated cost at last close ${inr(close)}`}: <b>{inr(cost)}</b> incl. charges {inr(charges('buy', qty, entry, sizing))}
          {' · '}max loss at stop ≈ {inr(maxLoss)} ({((maxLoss / sizing.equity) * 100).toFixed(1)}% of equity)
          {' · '}target {inr(targetPrice(entry, sizing))}
          {' · '}available cash {inr(sizing.cash)}
        </p>
      ) : null}
      {overCash ? (
        <p className="msg err" role="alert">Not enough cash for {qty} shares: needs {inr(cost)}, available {inr(sizing.cash)}.</p>
      ) : null}
      {!qtyValid ? <p className="msg warn">Enter a whole number of shares (at least 1).</p> : null}

      <div className="row center">
        <SubmitButton disabled={!qtyValid || overCash || manualInvalid} pendingText="Placing…">Confirm</SubmitButton>
        <span className="small muted">Paper trade only: no real order is sent anywhere.</span>
      </div>
    </ActionForm>
  );
}
