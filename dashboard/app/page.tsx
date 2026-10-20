import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { ButtonForm } from '@/components/ActionForm';
import BuyForm from '@/components/BuyForm';
import SellForm from '@/components/SellForm';
import { Badge, Empty, SetupNeeded, Stat } from '@/components/ui';
import { dbConfigured, sql } from '@/lib/db';
import { loadPortfolio, getLatestScan, loadSuggestions, sizingParams } from '@/lib/queries';
import { dateLabel, inr, inrSigned, num, pct, todayIST } from '@/lib/format';
import type { ExitReason } from '@/lib/engine';
import { acknowledgeAlert } from './actions';

export const dynamic = 'force-dynamic';

const ALERT_REASON: Record<string, ExitReason> = { stop: 'stop', target: 'target', trail: 'trail', time_stop: 'time_stop' };
const ALERT_LABEL: Record<string, string> = { stop: 'Stop', target: 'Target', trail: 'Trail', time_stop: 'Time stop' };

export default async function TodayPage() {
  if (!dbConfigured()) return <><h1>Today</h1><SetupNeeded /></>;
  const db = sql();
  const [p, scan] = await Promise.all([loadPortfolio(db), getLatestScan(db)]);
  const suggestions = scan ? await loadSuggestions(db, scan.scan_date) : [];
  const breakouts = suggestions.filter((s) => s.grp === 'breakout');
  const sizing = sizingParams(p);
  const today = todayIST();
  const md = scan?.market_detail ?? {};
  const warnings = Array.isArray(md.warnings) ? md.warnings.map(String) : [];
  const alerts = p.open.flatMap((pos) => pos.alerts.map((a) => ({ a, pos })));

  return (
    <>
      <PageHeader title="Today" />

      {!scan ? (
        <Empty title={p.dataDate ? 'No scan has been run yet' : 'No data yet'}>
          <p>Run the daily job (GitHub Actions → Daily → Run workflow). It loads prices, scans for setups and fills this page.</p>
        </Empty>
      ) : (
        <>
          <div className={`banner big ${scan.market_filter_on ? 'good' : 'bad'}`} role="status">
            <strong>{scan.market_filter_on ? 'New buys allowed' : 'No new buys: market filter off'}</strong>
            <span className="small">
              Nifty Smallcap 250 close {num(md.index_close)} · 50 DMA {num(md.sma50)} · 200 DMA {num(md.sma200)}
              {md.rule ? <> · rule: <code>{md.rule}</code></> : null}
              {' '}· scan of {dateLabel(scan.scan_date)} (data {dateLabel(scan.data_date)})
            </span>
          </div>
          {warnings.length ? (
            <div className="banner warn" role="alert">
              <strong>Some filters could not be applied</strong>
              <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          ) : null}
          {p.dataDate && scan.data_date < p.dataDate ? (
            <div className="banner info">The latest scan is based on data up to {dateLabel(scan.data_date)}, but prices are loaded up to {dateLabel(p.dataDate)}. Run the daily job to refresh the scan.</div>
          ) : null}
        </>
      )}

      <h2>Portfolio</h2>
      <div className="stats">
        <Stat label="Equity" value={inr(p.equity)} hint={`started with ${inr(p.settings.capital)}`} />
        <Stat label="Cash" value={inr(p.cash)} hint={p.pendingBuyReserve > 0 ? `${inr(p.availableCash)} after pending buys` : undefined} />
        <Stat label="Open P&L" value={inrSigned(p.openPnl)} tone={p.openPnl} hint={`${p.open.length} open position${p.open.length === 1 ? '' : 's'}`} />
        <Stat label="Pending orders" value={String(p.pendingOrders.length)} hint="fill at next open" />
      </div>

      <h2>Alerts for open positions {alerts.length ? <Badge tone="bad">{alerts.length}</Badge> : null}</h2>
      {alerts.length === 0 ? (
        <Empty title="No unacknowledged alerts">
          <p>{p.open.length ? 'Your open positions have no pending alerts.' : 'You have no open positions.'}</p>
        </Empty>
      ) : (
        <div className="grid cols-auto">
          {alerts.map(({ a, pos }) => (
            <div key={a.id} className="card">
              <div className="row center" style={{ justifyContent: 'space-between' }}>
                <span><b>{a.symbol}</b> <Badge tone={a.kind === 'stop' ? 'bad' : a.kind === 'target' ? 'good' : 'warn'}>{ALERT_LABEL[a.kind] ?? a.kind}</Badge></span>
                <span className="small muted">{dateLabel(a.alert_date)}</span>
              </div>
              <p>{a.message}</p>
              <p className="small muted">
                Holding {pos.qty} · entry {inr(pos.entry_price)} · last {inr(pos.last)} ({pct(pos.pnlPct, 1, true)}) · stop {inr(pos.stop)}
              </p>
              <div className="row center">
                <ButtonForm action={acknowledgeAlert} fields={{ alert_id: a.id }} label="Acknowledge" />
              </div>
              <details style={{ marginTop: 8 }}>
                <summary><span className="btn small primary" style={{ background: 'var(--accent)', color: 'var(--accent-ink)', borderColor: 'var(--accent)' }}>Confirm sell…</span></summary>
                <SellForm
                  tradeId={pos.id} symbol={pos.symbol} held={pos.qty} entryPrice={pos.entry_price} entryDate={pos.entry_date}
                  last={pos.last} defaultReason={ALERT_REASON[a.kind] ?? 'manual'} chargesPct={p.settings.charges_pct_per_side}
                  dpCharge={p.settings.dp_charge} dataDate={p.dataDate} today={today} idPrefix={`alert-${a.id}`}
                />
              </details>
            </div>
          ))}
        </div>
      )}

      <h2>Today&apos;s breakouts {breakouts.length ? <Badge>{breakouts.length}</Badge> : null}</h2>
      {!scan ? null : breakouts.length === 0 ? (
        <Empty title="No breakouts in the latest scan">
          <p>Nothing cleared its pivot on volume. See <Link href="/suggestions">Suggestions</Link> for stocks close to their pivot.</p>
        </Empty>
      ) : (
        <>
          {!scan.market_filter_on ? (
            <div className="banner bad">Market filter is off: the plan says do not open new positions, whatever these cards look like.</div>
          ) : null}
          <div className="grid cols-auto">
            {breakouts.map((s) => {
              const d = s.details as Record<string, unknown>;
              return (
                <div key={s.symbol} className="card" style={!scan.market_filter_on ? { opacity: 0.75 } : undefined}>
                  <div className="row center" style={{ justifyContent: 'space-between' }}>
                    <span><b style={{ fontSize: '1.1rem' }}>{s.symbol}</b> <span className="muted small">{s.sector ?? ''}</span></span>
                    <Badge tone="good">score {num(s.score, 1)}</Badge>
                  </div>
                  <p className="small" style={{ margin: '6px 0' }}>
                    Close {inr(s.close)} · pivot {inr(s.pivot)} · stop {inr(s.stop)} · target {inr(s.target)}
                    {typeof d.breakout_volume_x === 'number' ? <> · volume {num(d.breakout_volume_x)}×</> : null}
                    {typeof d.deliv_pct === 'number' ? <> · delivery {pct(d.deliv_pct, 0)}</> : null}
                  </p>
                  <p className="small">
                    Suggested qty <b className={s.qty === 0 ? 'neg' : ''}>{s.qty}</b>
                    {s.qty === 0 ? ' (too expensive to buy even 1 share)' : ''}
                    {s.checklist_score !== null ? <> · checklist {s.checklist_score}/7</> : null}
                  </p>
                  <div className="row center" style={{ marginTop: 6 }}>
                    {s.held ? <Badge tone="good">Already held</Badge> : s.pending_buy ? <Badge tone="warn">Buy order pending</Badge> : null}
                    <a className="btn small" href={s.screener_url} target="_blank" rel="noopener noreferrer">Screener.in ↗</a>
                  </div>
                  {!s.held && !s.pending_buy ? (
                    <details style={{ marginTop: 8 }}>
                      <summary><span className="btn small primary" style={{ background: 'var(--accent)', color: 'var(--accent-ink)', borderColor: 'var(--accent)' }}>Paper buy…</span></summary>
                      <BuyForm symbol={s.symbol} close={s.close} reason="breakout" suggestedQty={s.qty} sizing={sizing} dataDate={p.dataDate} today={today} />
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
