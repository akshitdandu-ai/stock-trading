'use client';

import { useId, useRef, useState } from 'react';
import { dateShort } from '@/lib/format';

export type ChartSeries = { name: string; color: string; values: (number | null)[] };

const W = 760;
const PAD = { l: 62, r: 16, t: 12, b: 28 };

const fmtInr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

function formatValue(v: number, kind: 'inr' | 'num' | 'pct'): string {
  if (kind === 'inr') return fmtInr.format(v);
  if (kind === 'pct') return `${v.toFixed(1)}%`;
  return v.toFixed(1);
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) out.push(Math.round(v / step * 1e6) / 1e6 * step);
  return out;
}

export default function LineChart({
  dates, series, kind = 'num', area = false, height = 280, label, baseline,
}: {
  dates: string[];
  series: ChartSeries[];
  kind?: 'inr' | 'num' | 'pct';
  area?: boolean; // fill between the line and `baseline` (used for drawdown)
  height?: number;
  label: string;
  baseline?: number;
}) {
  const uid = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const n = dates.length;
  const H = height;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (n === 0 || all.length === 0) {
    return <div className="empty">Not enough data to draw this chart yet.</div>;
  }
  let lo = Math.min(...all, ...(baseline !== undefined ? [baseline] : []));
  let hi = Math.max(...all, ...(baseline !== undefined ? [baseline] : []));
  const padv = (hi - lo || Math.abs(hi) * 0.02 || 1) * 0.08;
  lo -= padv; hi += padv;
  if (area && baseline !== undefined && baseline === 0 && hi > 0) hi = 0 + padv * 0.2;
  const ticks = niceTicks(lo, hi, 5).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
  const yMin = Math.min(lo, ticks[0] ?? lo);
  const yMax = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const X = (i: number) => PAD.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * ih;

  const xTickIdx = n <= 1 ? [0] : [...new Set([0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1])];

  function segPoints(values: (number | null)[]): [number, number][][] {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) { if (cur.length) out.push(cur); cur = []; return; }
      cur.push([X(i), Y(v)]);
    });
    if (cur.length) out.push(cur);
    return out;
  }
  const line = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

  function onMove(e: React.PointerEvent) {
    const el = ref.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const idx = n === 1 ? 0 : Math.round(((px - PAD.l) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, idx)));
  }

  const base = baseline !== undefined ? Y(baseline) : PAD.t + ih;
  const summary = series
    .map((s) => {
      const vals = s.values.filter((v): v is number => v !== null);
      return vals.length ? `${s.name} from ${formatValue(vals[0], kind)} to ${formatValue(vals[vals.length - 1], kind)}` : '';
    })
    .filter(Boolean)
    .join('; ');

  return (
    <div>
      {series.length >= 2 ? (
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}><span className="sw" style={{ background: s.color }} />{s.name}</span>
          ))}
        </div>
      ) : null}
      <div className="chart" ref={ref} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}. ${summary}`}>
          <g className="grid">
            {ticks.map((t) => <line key={t} x1={PAD.l} x2={W - PAD.r} y1={Y(t)} y2={Y(t)} />)}
          </g>
          <g className="axis">
            {ticks.map((t) => (
              <text key={t} x={PAD.l - 8} y={Y(t) + 4} textAnchor="end">{formatValue(t, kind)}</text>
            ))}
            {xTickIdx.map((i, k) => (
              <text key={i} x={X(i)} y={H - 8} textAnchor={k === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}>
                {dateShort(dates[i])}
              </text>
            ))}
          </g>
          {area && series[0]
            ? segPoints(series[0].values).map((pts, i) => (
                <path
                  key={`a${i}`}
                  d={`${line(pts)}L${pts[pts.length - 1][0].toFixed(1)},${base.toFixed(1)}L${pts[0][0].toFixed(1)},${base.toFixed(1)}Z`}
                  fill={series[0].color} opacity={0.14}
                />
              ))
            : null}
          {series.map((s) => (
            <g key={s.name}>
              {segPoints(s.values).map((pts, i) => (
                <path key={i} d={line(pts)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {(() => {
                let last = -1;
                s.values.forEach((v, i) => { if (v !== null) last = i; });
                return last >= 0 && s.values[last] !== null ? (
                  <circle cx={X(last)} cy={Y(s.values[last] as number)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                ) : null;
              })()}
            </g>
          ))}
          {hover !== null ? (
            <g>
              <line x1={X(hover)} x2={X(hover)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
              {series.map((s) => {
                const v = s.values[hover];
                return v !== null && v !== undefined ? (
                  <circle key={`${uid}${s.name}`} cx={X(hover)} cy={Y(v)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                ) : null;
              })}
            </g>
          ) : null}
        </svg>
        {hover !== null ? (
          <div
            className="tooltip"
            style={{
              left: `${(X(hover) / W) * 100}%`,
              top: 4,
              transform: X(hover) > W * 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
            }}
          >
            <div><b>{dates[hover]}</b></div>
            {series.map((s) => (
              <div key={s.name}>
                <span className="sw" style={{ background: s.color, display: 'inline-block', width: 10, height: 3, marginRight: 6, verticalAlign: 'middle' }} />
                {s.name}: {s.values[hover] !== null && s.values[hover] !== undefined ? formatValue(s.values[hover] as number, kind) : '—'}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
