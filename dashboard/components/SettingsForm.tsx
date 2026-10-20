'use client';

import { useState } from 'react';
import { saveSettings } from '@/app/actions';
import type { Settings } from '@/lib/engine';
import { ActionForm, SubmitButton } from './ActionForm';

const FIELDS: { key: keyof Settings; label: string; hint: string; step?: string }[] = [
  { key: 'capital', label: 'Capital (₹)', hint: 'Starting paper capital', step: '1' },
  { key: 'risk_pct', label: 'Risk per trade (% of equity)', hint: 'Sets position size', step: '0.1' },
  { key: 'stop_pct', label: 'Stop (% below entry)', hint: 'Default stop distance', step: '0.1' },
  { key: 'target_pct', label: 'Target (% above entry)', hint: 'First target', step: '0.1' },
  { key: 'charges_pct_per_side', label: 'Charges (% per side)', hint: 'Brokerage, STT, etc. on each fill', step: '0.01' },
  { key: 'dp_charge', label: 'DP charge (₹ per sell)', hint: 'Flat charge on every sell', step: '0.01' },
  { key: 'time_stop_days', label: 'Time stop (calendar days)', hint: 'Exit a stalled trade after this many days', step: '1' },
  { key: 'time_stop_min_gain_pct', label: 'Time stop: minimum gain (%)', hint: 'Time stop only fires if gain is below this', step: '0.1' },
  { key: 'stcg_rate_pct', label: 'STCG tax rate (%)', hint: 'Short-term capital gains', step: '0.1' },
  { key: 'cess_pct', label: 'Cess (% of tax)', hint: 'Health & education cess', step: '0.1' },
];

export default function SettingsForm({ values, defaults }: { values: Settings; defaults: Settings }) {
  const [v, setV] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, String(values[f.key])])),
  );
  return (
    <ActionForm action={saveSettings} className="form">
      <div className="grid cols-auto">
        {FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`s-${f.key}`}>{f.label}</label>
            <input
              id={`s-${f.key}`} name={f.key} type="number" step={f.step ?? 'any'} inputMode="decimal" required
              value={v[f.key]} onChange={(e) => setV((s) => ({ ...s, [f.key]: e.target.value }))} style={{ width: '100%' }}
            />
            <small>
              {f.hint}. Default {defaults[f.key]}.
              {String(values[f.key]) !== String(defaults[f.key]) ? <> Currently customised.</> : null}
            </small>
          </div>
        ))}
      </div>
      <div className="row center">
        <SubmitButton pendingText="Saving…">Save settings</SubmitButton>
        <button type="button" onClick={() => setV(Object.fromEntries(FIELDS.map((f) => [f.key, String(defaults[f.key])])))}>
          Fill with defaults
        </button>
      </div>
    </ActionForm>
  );
}
