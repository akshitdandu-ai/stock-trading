'use client';

import { useState } from 'react';
import { saveChecklist } from '@/app/actions';
import { CHECKLIST_ITEMS } from '@/lib/engine';
import { ActionForm, SubmitButton } from './ActionForm';

export default function ChecklistForm({
  symbol, items, notes,
}: { symbol: string; items: Record<string, boolean> | null; notes: string | null }) {
  const [state, setState] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CHECKLIST_ITEMS.map((c) => [c.key, items?.[c.key] === true])),
  );
  const score = CHECKLIST_ITEMS.filter((c) => state[c.key]).length;
  return (
    <ActionForm action={saveChecklist} className="form">
      <input type="hidden" name="symbol" value={symbol} />
      <div className="row center">
        <h3 style={{ margin: 0 }}>Fundamentals checklist</h3>
        <span className={`badge ${score >= 6 ? 'good' : score >= 4 ? 'warn' : ''}`}>{score}/7</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Check these by hand on Screener.in, then save.</p>
      <div className="checklist">
        {CHECKLIST_ITEMS.map((c) => (
          <label key={c.key}>
            <input
              type="checkbox" name={c.key} checked={state[c.key]}
              onChange={(e) => setState((s) => ({ ...s, [c.key]: e.target.checked }))}
            />
            {c.label}
          </label>
        ))}
      </div>
      <textarea name="notes" defaultValue={notes ?? ''} maxLength={2000} placeholder="Checklist notes (optional)" aria-label="Checklist notes" />
      <div><SubmitButton className="small" pendingText="Saving…">Save checklist</SubmitButton></div>
    </ActionForm>
  );
}
