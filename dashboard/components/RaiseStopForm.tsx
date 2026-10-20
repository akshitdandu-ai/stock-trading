'use client';

import { useState } from 'react';
import { raiseStop } from '@/app/actions';
import { inr } from '@/lib/format';
import { ActionForm, SubmitButton } from './ActionForm';

export default function RaiseStopForm({ tradeId, stop, last }: { tradeId: number; stop: number; last: number | null }) {
  const [v, setV] = useState('');
  const n = Number(v);
  const bad = v !== '' && !(n > stop);
  return (
    <ActionForm action={raiseStop} className="form">
      <input type="hidden" name="trade_id" value={tradeId} />
      <div className="row">
        <div className="field">
          <label htmlFor={`rs-${tradeId}`}>New stop (₹)</label>
          <input id={`rs-${tradeId}`} name="stop" type="number" step="any" min="0" value={v} onChange={(e) => setV(e.target.value)} required />
          <small>Current {inr(stop)}{last !== null ? `, last close ${inr(last)}` : ''}. Stops only move up.</small>
        </div>
        <SubmitButton disabled={v === '' || bad} pendingText="Saving…">Raise stop</SubmitButton>
      </div>
      {bad ? <p className="msg err">The new stop must be above the current stop ({inr(stop)}).</p> : null}
    </ActionForm>
  );
}
