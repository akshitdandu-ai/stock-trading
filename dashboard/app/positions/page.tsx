import PageHeader from '@/components/PageHeader';
import { ButtonForm } from '@/components/ActionForm';
import NotesForm from '@/components/NotesForm';
import RaiseStopForm from '@/components/RaiseStopForm';
import SellForm from '@/components/SellForm';
import { Badge, Empty, SetupNeeded, Stat } from '@/components/ui';
import { dbConfigured, sql } from '@/lib/db';
import { loadPortfolio } from '@/lib/queries';
import { dateLabel, inr, inrSigned, pct, pnlClass, todayIST } from '@/lib/format';
import { cancelOrder } from '../actions';
import type { ExitReason } from '@/lib/engine';

export const dynamic = 'force-dynamic';

const ALERT_LABEL: Record<string, string> = { stop: 'Stop', target: 'Target', trail: 'Trail', time_stop: 'Time stop' };
const ALERT_REASON: Record<string, ExitReason> = { stop: 'stop', target: 'target', trail: 'trail', time_stop: 'time_stop' };

export default async function PositionsPage() {
  if (!dbConfigured()) return <><h1>Positions</h1><SetupNeeded /></>;
  const p = await loadPortfolio(sql());
  const today = todayIST();
  const totalPnl = p.openPnl;

  return (
    <>
      <PageHeader title="Positions" />
      <div className="stats">
        <Stat label="Open positions" value={String(p.open.length)} />
        <Stat label="Open P&L" value={inrSigned(totalPnl)} tone={totalPnl} />
        <Stat label="Cash" value={inr(p.cash)} />
        <Stat label="Equity" value={inr(p.equity)} />
      </div>

      <h2>Open trades</h2>
      {p.open.length === 0 ? (
        <Empty title="No open positions">
          <p>Paper-buy something from Today or Suggestions. Orders placed with &quot;next open&quot; are filled by the evening job, so a new position appears after the next daily run.</p>
        </Empty>
      ) : (
        <div className="grid">
          {p.open.map((t) => (
            <div key={t.id} className="card pos-card">
              <div className="head">
                <span><span className="sym">{t.symbol}</span> {t.booked_third ? <Badge tone="good">1/3 booked</Badge> : null}</span>
                <span className={`${pnlClass(t.pnl)}`}><b>{inrSigned(t.pnl)}</b> ({pct(t.pnlPct, 1, true)})</span>
              </div>
              {t.alerts.length ? (
                <div className="banner warn" style={{ margin: '8px 0' }}>
                  {t.alerts.map((a) => (
                    <div key={a.id}><b>{ALERT_LABEL[a.kind] ?? a.kind}</b>: {a.message} <span className="muted small">({dateLabel(a.alert_date)})</span></div>
                  ))}
                  <span className="small">Acknowledge on the Today page, or use Sell… below.</span>
                </div>
              ) : null}
              <div className="metrics">
                <div><span className="l">Entry</span>{dateLabel(t.entry_date)} @ {inr(t.entry_price)}</div>
                <div><span className="l">Quantity</span>{t.qty}{t.qty !== t.initial_qty ? ` of ${t.initial_qty}` : ''}</div>
                <div><span className="l">Last close</span>{t.last !== null ? inr(t.last) : 'no price yet'}</div>
                <div><span className="l">Stop</span>{inr(t.stop)}</div>
                <div><span className="l">Target</span>{inr(t.target)}</div>
                <div><span className="l">Days held</span>{t.daysHeld ?? '—'}</div>
                <div><span className="l">Value</span>{inr(t.marketValue)}</div>
                {t.booked_third ? <div><span className="l">Booked so far</span><span className={pnlClass(t.bookedPnl)}>{inrSigned(t.bookedPnl)}</span></div> : null}
                {t.pendingSellQty > 0 ? <div><span className="l">Pending sell</span>{t.pendingSellQty} share(s)</div> : null}
              </div>
              {t.notes ? <p className="small muted">Notes: {t.notes}</p> : null}
              <div className="actions">
                <details>
                  <summary><span className="btn small">Sell…</span></summary>
                  <SellForm
                    tradeId={t.id} symbol={t.symbol} held={t.qty} entryPrice={t.entry_price} entryDate={t.entry_date} last={t.last}
                    defaultReason={t.alerts[0] ? ALERT_REASON[t.alerts[0].kind] ?? 'manual' : 'manual'}
                    chargesPct={p.settings.charges_pct_per_side} dpCharge={p.settings.dp_charge} dataDate={p.dataDate} today={today}
                  />
                </details>
                <details>
                  <summary><span className="btn small">Raise stop</span></summary>
                  <RaiseStopForm tradeId={t.id} stop={t.stop} last={t.last} />
                </details>
                <details>
                  <summary><span className="btn small">Notes</span></summary>
                  <NotesForm tradeId={t.id} notes={t.notes} />
                </details>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Pending orders</h2>
      {p.pendingOrders.length === 0 ? (
        <Empty title="No pending orders"><p>Orders waiting for the next open will show up here, where you can cancel them until the evening job fills them.</p></Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Side</th><th>Symbol</th><th className="r">Qty</th><th>Price</th><th>Reason</th><th>Placed</th><th /></tr></thead>
            <tbody>
              {p.pendingOrders.map((o) => (
                <tr key={o.id}>
                  <td><Badge tone={o.side === 'buy' ? 'good' : 'bad'}>{o.side}</Badge></td>
                  <td><b>{o.symbol}</b></td>
                  <td className="r">{o.qty}</td>
                  <td>{o.price === null ? 'next open' : inr(o.price)}</td>
                  <td>{o.reason ?? '—'}</td>
                  <td>after data of {dateLabel(o.created_data_date)}</td>
                  <td><ButtonForm action={cancelOrder} fields={{ order_id: o.id }} label="Cancel" buttonClass="small danger" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
