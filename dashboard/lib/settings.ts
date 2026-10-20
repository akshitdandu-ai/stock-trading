import { DEFAULT_SETTINGS, type Settings } from './engine.ts';
import type { Sql, TxSql } from './db.ts';

export { DEFAULT_SETTINGS };
export type { Settings };

/** Merge stored overrides onto the defaults; ignores unknown keys and non-numeric values. */
export function mergeSettings(stored: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
      else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[key] = Number(v);
    }
  }
  return out;
}

export async function getSettings(db: Sql | TxSql): Promise<Settings> {
  const rows = await db<{ data: unknown }[]>`select data from settings where id = 1`;
  return mergeSettings(rows[0]?.data);
}

/** The raw stored overrides (so the form can show which values are customised). */
export async function getStoredSettings(db: Sql): Promise<Record<string, unknown>> {
  const rows = await db<{ data: Record<string, unknown> }[]>`select data from settings where id = 1`;
  return rows[0]?.data ?? {};
}
