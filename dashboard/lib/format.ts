const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INR0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

export function inr(n: number | null | undefined, digits: 0 | 2 = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (digits === 0 ? INR0 : INR).format(n);
}

/** Signed rupee amount, e.g. +₹1,234.50 / -₹80.00 */
export function inrSigned(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + INR.format(n);
}

export function num(n: number | null | undefined, maxDigits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n === Math.round(n) ? NUM.format(n) : new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxDigits }).format(n);
}

export function pct(n: number | null | undefined, digits = 1, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (signed && n > 0 ? '+' : '') + n.toFixed(digits) + '%';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' (or ISO timestamp) -> '20 Oct 2026'. Pure string handling, no timezone shifts. */
export function dateLabel(d: string | null | undefined): string {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function dateShort(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}` : d;
}

/** ISO timestamp -> '20 Oct 2026, 7:15 pm IST' */
export function dateTimeLabel(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d) + ' IST';
}

/** Today's date in IST as YYYY-MM-DD. */
export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}
