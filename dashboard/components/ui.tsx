import type { ReactNode } from 'react';
import { pnlClass } from '@/lib/format';

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function SetupNeeded() {
  return (
    <div className="banner bad big" role="alert">
      <strong>Database not configured</strong>
      <p>
        The environment variable <code>DATABASE_URL</code> is not set. Copy <code>.env.example</code> to{' '}
        <code>.env.local</code> and set it to your Supabase <em>transaction pooler</em> connection string
        (port 6543), then restart. On Vercel, add it under Project Settings → Environment Variables and redeploy.
      </p>
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: number | null }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${tone !== undefined ? pnlClass(tone) : ''}`}>{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export function NoDataYet() {
  return (
    <Empty title="No market data yet">
      <p>The database is empty. Run the daily job (GitHub Actions → Daily → Run workflow) to load prices and produce the first scan.</p>
    </Empty>
  );
}
