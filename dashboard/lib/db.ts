import postgres from 'postgres';

const globalForDb = globalThis as unknown as { __swingSql?: postgres.Sql };

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Lazy singleton. Never called at build time: every page that queries is force-dynamic and
 * checks dbConfigured() first.
 */
export function sql(): postgres.Sql {
  if (!globalForDb.__swingSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    globalForDb.__swingSql = postgres(url, {
      // Required for Supabase's transaction pooler (port 6543) and harmless elsewhere.
      prepare: false,
      max: Number(process.env.DATABASE_POOL_MAX) || 3,
      idle_timeout: 20,
      connect_timeout: 15,
      ssl: local || /sslmode=disable/.test(url) ? false : 'require',
      onnotice: () => {},
      types: {
        // numeric -> JS number (money amounts here are small; float is fine)
        numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
        // bigint (bigserial ids, count(*), volume) -> JS number
        bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
        // date -> 'YYYY-MM-DD' string (avoids timezone shifts through JS Date)
        date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
        // timestamptz -> ISO string (plain data that can cross the server/client boundary)
        timestamptz: {
          to: 1184,
          from: [1184],
          serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
          parse: (x: string) => new Date(x).toISOString(),
        },
      },
    });
  }
  return globalForDb.__swingSql;
}

export type Sql = postgres.Sql;
export type TxSql = postgres.TransactionSql;

/** Message safe to show in the UI for a thrown database error. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/postgres(ql)?:\/\/[^\s]+/gi, '[connection string hidden]');
}
