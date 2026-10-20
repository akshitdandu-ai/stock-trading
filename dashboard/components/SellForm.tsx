'use client';

import { useState } from 'react';
import { confirmSell } from '@/app/actions';
import { EXIT_REASONS, EXIT_REASON_LABELS, charges, defaultSellQty, type ExitReason } from '@/lib/engine';
import { inr } from '@/lib/format';
import { ActionForm, SubmitButton } from './ActionForm';

export default function SellForm({
  tradeId, symbol, held, entryPrice, entryDate, last, defaultReason = 'manual', chargesPct, dpCharge, dataDate, today, idPrefix = 'sell',
}: {
  tradeId: number;
  symbol: string;
  held: number;
  entryPrice: number;
  entryDate: string;
  last: number | null;
  defaultReason?: ExitReason;
  chargesPct: number;
  dpCharge: number;
  dataDate: string | null;
  today: string;
  idPrefix?: string;
}) {
  const [reason, setReason] = useState<ExitReason>(defaultReason);
  const [mode, setMode] = useState<'next_open' | 'manual'>('next_open');
  const [qtyStr, setQtyStr] = useState('');
  const [qtyEdited, setQtyEdited] = useState(false);
  const [price, setPrice] = useState(last !== null ? String(last) : '');
  const [fillDate, setFillDate] = useState(dataDate && dataDate >= entryDate ? dataDate : today);
  const [notes, setNotes] = useState('');

  const manual = mode === 'manual';
  const bookOnly = reason === 'target' && held < 2;
  const qty = qtyEdited ? Number(qtyStr) : defaultSellQty(reason, held);
  const qtyOk = bookOnly || (Number.isInteger(qty) && qty >= 1 && qty <= held);
  const px = Number(price);
  const est = manual && px > 0 && qtyOk && !bookOnly
    ? qty * (px - entryPrice) - charges('sell', qty, px, { charges_pct_per_side: chargesPct, dp_charge: dpCharge })
    : null;
  const id = `${idPrefix}-${tradeId}`;

  return (
    <ActionForm action={confirmSell} className="form">
      <input type="hidden" name="trade_id" value={tradeId} />
      <input type="hidden" name="mode" value={mode} />
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-reason`}>Reason</label>
          <select id={`${id}-reason`} name="reason" value={reason} onChange={(e) => { setReason(e.target.value as ExitReason); setQtyEdited(false); }}>
            {EXIT_REASONS.map((r) => <option key={r} value={r}>{EXIT_REASON_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-qty`}>Quantity (holding {held})</label>
          <input
            id={`${id}-qty`} name="qty" type="number" min={bookOnly ? 0 : 1} max={held} step={1} inputMode="numeric"
            value={bookOnly ? '0' : qtyEdited ? qtyStr : String(qty)} disabled={bookOnly}
            onChange={(e) => { setQtyEdited(true); setQtyStr(e.target.value); }}
          />
          {bookOnly ? <input type="hidden" name="qty" value="0" /> : null}
          <small>{reason === 'target' ? 'Book 1/3: round(qty/3), min 1.' : 'Prefilled with the full position.'}</small>
        </div>
      </div>
      {bookOnly ? (
        <p className="msg warn">With fewer than 2 shares nothing is sold: the trade is marked "1/3 booked" and the stop moves to your entry price.</p>
      ) : null}

      {!bookOnly ? (
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          <legend className="small muted" style={{ padding: 0 }}>Sell price</legend>
          <label className="radio">
            <input type="radio" checked={!manual} onChange={() => setMode('next_open')} />
            <span>Next open: filled automatically by the evening job (default)</span>
          </label>
          <label className="radio">
            <input type="radio" checked={manual} onChange={() => setMode('manual')} />
            <span>Manual price: I already sold at a specific price, record it now</span>
          </label>
        </fieldset>
      ) : null}

      {manual && !bookOnly ? (
        <div className="row">
          <div className="field">
            <label htmlFor={`${id}-px`}>Sell price (₹)</label>
            <input id={`${id}-px`} name="price" type="number" min="0" step="any" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor={`${id}-fd`}>Fill date</label>
            <input id={`${id}-fd`} name="fill_date" type="date" min={entryDate} max={today} value={fillDate} onChange={(e) => setFillDate(e.target.value)} required />
          </div>
        </div>
      ) : null}

      <div className="field">
        <label htmlFor={`${id}-notes`}>Notes</label>
        <input id={`${id}-notes`} name="notes" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {est !== null ? (
        <p className="small muted">Estimated net on these shares vs entry (after sell charges): <b className={est >= 0 ? 'pos' : 'neg'}>{inr(est)}</b></p>
      ) : null}
      {!qtyOk ? <p className="msg warn">Quantity must be a whole number between 1 and {held}.</p> : null}
      <div className="row center">
        <SubmitButton disabled={!qtyOk || (manual && !bookOnly && !(px > 0))} pendingText="Placing…">Confirm</SubmitButton>
        <span className="small muted">Paper trade only.</span>
      </div>
      <span className="muted small">{symbol}</span>
    </ActionForm>
  );
}
