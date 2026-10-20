'use client';

import { useMemo, useState } from 'react';
import { toggleWatchlist } from '@/app/actions';
import { dateLabel, inr, num, pct } from '@/lib/format';
import type { SizingParams, SuggestionRow } from '@/lib/types';
import BuyForm from './BuyForm';
import ChecklistForm from './ChecklistForm';
import { ButtonForm } from './ActionForm';
import { Badge } from './ui';

export type WatchRow = { symbol: string; added_at: string; checklist_score: number | null };

const DETAIL_LABELS: [string, string, 'num' | 'pct' | 'x' | 'list' | 'bool' | 'inr'][] = [
  ['base_weeks', 'Base length (weeks)', 'num'],
  ['base_depth_pct', 'Base depth', 'pct'],
  ['contractions', 'Contractions (depth %)', 'list'],
  ['last_contraction_depth_pct', 'Last contraction depth', 'pct'],
  ['vol_ratio_last_contraction', 'Volume ratio, last contraction', 'num'],
  ['breakout_volume_x', 'Breakout volume (× average)', 'x'],
  ['deliv_pct', 'Delivery %', 'pct'],
  ['rs_excess_pp', 'RS excess vs Smallcap 250 (pp)', 'num'],
  ['sma50', '50-day SMA', 'inr'],
  ['sma150', '150-day SMA', 'inr'],
  ['sma200', '200-day SMA', 'inr'],
  ['high_52w', '52-week high', 'inr'],
  ['low_52w', '52-week low', 'inr'],
  ['extended', 'Extended', 'bool'],
];

function fmtDetail(v: unknown, kind: string): string {
  if (v === null || v === undefined) return '—';
  if (kind === 'list') return Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? x.toFixed(1) : String(x))).join(' → ') || '—' : String(v);
  if (kind === 'bool') return v ? 'Yes' : 'No';
  if (typeof v !== 'number') return String(v);
  if (kind === 'pct') return pct(v, 1);
  if (kind === 'x') return `${num(v)}×`;
  if (kind === 'inr') return inr(v);
  return num(v);
}

function Panel({
  s, sizing, dataDate, today, marketOn,
}: { s: SuggestionRow; sizing: SizingParams; dataDate: string | null; today: string; marketOn: boolean | null }) {
  const [buying, setBuying] = useState(false);
  const comps = Object.entries(s.breakdown ?? {});
  const notes = Array.isArray(s.details?.notes) ? (s.details.notes as unknown[]).map(String) : [];
  const known = new Set([...DETAIL_LABELS.map((d) => d[0]), 'notes']);
  const extra = Object.entries(s.details ?? {}).filter(([k, v]) => !known.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'));
  return (
    <div className="grid cols-2">
      <div>
        <h3>Score breakdown: {num(s.score)}</h3>
        {comps.length ? (
          <div className="comp">
            {comps.map(([k, c]) => (
              <div key={k} style={{ display: 'contents' }}>
                <div>
                  <b>{k.replace(/_/g, ' ')}</b>
                  <div className="muted">{num(c.points)} / {num(c.max)}</div>
                </div>
                <div>
                  <div className="bar"><span style={{ width: `${Math.max(0, Math.min(100, c.max ? (c.points / c.max) * 100 : 0))}%` }} /></div>
                  {c.detail ? <div className="muted">{c.detail}</div> : null}
                </div>
              </div>
            ))}
          </div>
        ) : <p className="muted">No breakdown available.</p>}

        <h3>Base details</h3>
        <dl className="kv">
          {DETAIL_LABELS.filter(([k]) => s.details && k in s.details).map(([k, label, kind]) => (
            <div key={k} style={{ display: 'contents' }}><dt>{label}</dt><dd>{fmtDetail(s.details[k], kind)}</dd></div>
          ))}
          {extra.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}><dt>{k.replace(/_/g, ' ')}</dt><dd>{String(v)}</dd></div>
          ))}
        </dl>
        {notes.length ? <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
        {s.size_warning ? <p className="msg warn">{s.size_warning}</p> : null}
      </div>

      <div>
        <ChecklistForm symbol={s.symbol} items={s.checklist_items} notes={s.checklist_notes} />
        <div className="row center" style={{ marginTop: 14 }}>
          <ButtonForm
            action={toggleWatchlist}
            fields={{ symbol: s.symbol, on: s.on_watchlist ? '0' : '1' }}
            label={s.on_watchlist ? 'Remove from watchlist' : 'Add to watchlist'}
          />
          {s.held ? <Badge tone="good">Already held</Badge> : s.pending_buy ? <Badge tone="warn">Buy order pending</Badge> : (
            <button type="button" className="primary small" onClick={() => setBuying((b) => !b)} aria-expanded={buying}>
              {buying ? 'Close' : 'Paper buy…'}
            </button>
          )}
          <a className="btn small" href={s.screener_url} target="_blank" rel="noopener noreferrer">Screener.in ↗</a>
        </div>
        {buying && !s.held && !s.pending_buy ? (
          <div className="card" style={{ marginTop: 12 }}>
            <h3>Paper buy {s.symbol}</h3>
            {marketOn === false ? <p className="msg warn">Market filter is OFF: the plan says no new buys right now.</p> : null}
            {s.grp === 'extended' ? <p className="msg warn">This stock is extended past its pivot: chasing it is against the rules.</p> : null}
            <BuyForm
              symbol={s.symbol} close={s.close} reason={s.grp === 'breakout' ? 'breakout' : s.grp === 'watchlist' ? 'watchlist' : 'extended'}
              suggestedQty={s.qty} sizing={sizing} dataDate={dataDate} today={today}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Table({
  rows, open, setOpen, ...ctx
}: {
  rows: SuggestionRow[];
  open: string | null;
  setOpen: (s: string | null) => void;
  sizing: SizingParams; dataDate: string | null; today: string; marketOn: boolean | null;
}) {
  if (!rows.length) return <p className="muted small">Nothing matches the current filters.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Symbol</th><th>Sector</th><th className="r">Close</th><th className="r">Pivot</th>
            <th className="r">To pivot</th><th className="r">Stop</th><th className="r">1st target</th>
            <th className="r">Qty</th><th className="r">Score</th><th>Link</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const isOpen = open === s.symbol;
            return [
              <tr key={s.symbol} className="clickable" onClick={() => setOpen(isOpen ? null : s.symbol)}>
                <td>
                  <button
                    type="button" className="small" style={{ border: 0, background: 'none', padding: 0, fontWeight: 700 }}
                    aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : s.symbol); }}
                  >
                    {isOpen ? '▾' : '▸'} {s.symbol}
                  </button>{' '}
                  {s.on_watchlist ? <span title="On your watchlist">★</span> : null}{' '}
                  {s.held ? <Badge tone="good">held</Badge> : null}
                  {s.pending_buy ? <Badge tone="warn">order pending</Badge> : null}
                  {s.checklist_score !== null ? <> <Badge tone={s.checklist_score >= 6 ? 'good' : undefined}>{s.checklist_score}/7</Badge></> : null}
                </td>
                <td>{s.sector ?? '—'}</td>
                <td className="r">{inr(s.close)}</td>
                <td className="r">{inr(s.pivot)}</td>
                <td className="r">{s.dist_pct <= 0 ? `+${Math.abs(s.dist_pct).toFixed(1)}% above` : `${s.dist_pct.toFixed(1)}% below`}</td>
                <td className="r">{inr(s.stop)}</td>
                <td className="r">{inr(s.target)}</td>
                <td className={`r ${s.qty === 0 ? 'neg' : ''}`} title={s.qty === 0 ? 'Too expensive to buy even 1 share' : undefined}>{s.qty}{s.qty === 0 ? ' ⚠' : ''}</td>
                <td className="r"><b>{num(s.score, 1)}</b></td>
                <td><a href={s.screener_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Screener ↗</a></td>
              </tr>,
              isOpen ? (
                <tr key={`${s.symbol}-x`} className="expanded-row">
                  <td colSpan={10}><Panel s={s} {...ctx} /></td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function SuggestionsView({
  suggestions, watchlist, scanDate, marketOn, sizing, dataDate, today,
}: {
  suggestions: SuggestionRow[];
  watchlist: WatchRow[];
  scanDate: string | null;
  marketOn: boolean | null;
  sizing: SizingParams;
  dataDate: string | null;
  today: string;
}) {
  const [tab, setTab] = useState<'ideas' | 'watch'>('ideas');
  const [group, setGroup] = useState('all');
  const [sector, setSector] = useState('all');
  const [minScore, setMinScore] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const sectors = useMemo(() => [...new Set(suggestions.map((s) => s.sector).filter((x): x is string => !!x))].sort(), [suggestions]);
  const filtered = useMemo(() => {
    const min = minScore === '' ? -Infinity : Number(minScore);
    const needle = q.trim().toLowerCase();
    return suggestions
      .filter((s) => (group === 'all' || s.grp === group) && (sector === 'all' || s.sector === sector))
      .filter((s) => s.score >= min && (!needle || s.symbol.toLowerCase().includes(needle) || (s.sector ?? '').toLowerCase().includes(needle)))
      .sort((a, b) => b.score - a.score);
  }, [suggestions, group, sector, minScore, q]);

  const breakouts = filtered.filter((s) => s.grp === 'breakout');
  const near = filtered.filter((s) => s.grp === 'watchlist');
  const extended = filtered.filter((s) => s.grp === 'extended');
  const ctx = { sizing, dataDate, today, marketOn };

  const inScan = new Set(suggestions.map((s) => s.symbol));
  const watchRows = suggestions.filter((s) => s.on_watchlist).sort((a, b) => b.score - a.score);
  const watchOnly = watchlist.filter((w) => !inScan.has(w.symbol));

  return (
    <div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'ideas'} className="tab" onClick={() => setTab('ideas')}>Ranked ideas ({suggestions.length})</button>
        <button role="tab" aria-selected={tab === 'watch'} className="tab" onClick={() => setTab('watch')}>My watchlist ({watchlist.length})</button>
      </div>

      {tab === 'ideas' ? (
        <>
          <div className="filters">
            <div className="field">
              <label htmlFor="f-group">Group</label>
              <select id="f-group" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="all">All</option>
                <option value="breakout">Breakouts</option>
                <option value="watchlist">Near pivot</option>
                <option value="extended">Extended</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-sector">Sector</label>
              <select id="f-sector" value={sector} onChange={(e) => setSector(e.target.value)}>
                <option value="all">All sectors</option>
                {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-min">Min score</label>
              <input id="f-min" type="number" inputMode="decimal" min={0} step="1" value={minScore} placeholder="0" onChange={(e) => setMinScore(e.target.value)} style={{ width: '6rem' }} />
            </div>
            <div className="field">
              <label htmlFor="f-q">Search</label>
              <input id="f-q" type="search" value={q} placeholder="Symbol or sector" onChange={(e) => setQ(e.target.value)} />
            </div>
            <span className="small muted">Scan of {dateLabel(scanDate)}</span>
          </div>

          <h2>Breakouts today ({breakouts.length})</h2>
          <Table rows={breakouts} open={open} setOpen={setOpen} {...ctx} />

          <h2>Watchlist: near pivot ({near.length})</h2>
          <Table rows={near} open={open} setOpen={setOpen} {...ctx} />

          <details className="section" style={{ marginTop: 18 }}>
            <summary>Extended: do not buy ({extended.length})</summary>
            <p className="small muted">These are already too far above their pivot. Listed so you can see what you missed, not as buy ideas.</p>
            <Table rows={extended} open={open} setOpen={setOpen} {...ctx} />
          </details>
        </>
      ) : (
        <>
          <h2>Watchlist stocks in the latest scan ({watchRows.length})</h2>
          {watchRows.length ? <Table rows={watchRows} open={open} setOpen={setOpen} {...ctx} /> : (
            <p className="muted small">None of your watchlist stocks appear in the latest scan.</p>
          )}
          <h2>Watchlist stocks not in the latest scan ({watchOnly.length})</h2>
          {watchOnly.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Symbol</th><th>Added</th><th>Checklist</th><th>Link</th><th /></tr></thead>
                <tbody>
                  {watchOnly.map((w) => (
                    <tr key={w.symbol}>
                      <td><b>{w.symbol}</b></td>
                      <td>{w.added_at.slice(0, 10)}</td>
                      <td>{w.checklist_score !== null ? `${w.checklist_score}/7` : 'not checked'}</td>
                      <td><a href={`https://www.screener.in/company/${encodeURIComponent(w.symbol)}/`} target="_blank" rel="noopener noreferrer">Screener ↗</a></td>
                      <td><ButtonForm action={toggleWatchlist} fields={{ symbol: w.symbol, on: '0' }} label="Remove" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted small">No other watchlist stocks. Add one from a suggestion row.</p>}
        </>
      )}
    </div>
  );
}
