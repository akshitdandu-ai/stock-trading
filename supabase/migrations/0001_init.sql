-- NSE swing-trading tool: schema. Paper trading only.
-- All tables have RLS enabled with no policies: the public anon key can read nothing.
-- The Python pipeline and the Next.js server connect as the database owner (bypasses RLS).

-- ---------- market data ----------
create table if not exists symbols (
  symbol        text primary key,
  name          text,
  isin          text,
  listing_date  date,
  sector        text,            -- NSE sector index the stock belongs to (null if unknown)
  industry      text,            -- fallback label from Nifty 500 list
  market_cap_cr numeric,         -- null when NSE market-cap file is unavailable
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);

-- Raw (unadjusted) EQ-series prices from NSE bhavcopy. Splits/bonuses are handled at read time
-- by comparing prev_close with the previous day's close.
create table if not exists daily_prices (
  symbol      text not null,
  trade_date  date not null,
  open        numeric not null,
  high        numeric not null,
  low         numeric not null,
  close       numeric not null,
  prev_close  numeric,
  volume      bigint,
  turnover_cr numeric,           -- traded value in INR crore
  trades      integer,
  deliv_pct   numeric,           -- null when NSE did not publish it
  primary key (symbol, trade_date)
);
create index if not exists daily_prices_date_idx on daily_prices (trade_date);

create table if not exists index_prices (
  index_name text not null,      -- e.g. 'Nifty Smallcap 250', 'Nifty Bank'
  trade_date date not null,
  open       numeric,
  high       numeric,
  low        numeric,
  close      numeric not null,
  primary key (index_name, trade_date)
);

create table if not exists surveillance (   -- ASM / GSM lists
  trade_date date not null,
  symbol     text not null,
  list_type  text not null check (list_type in ('ASM','GSM')),
  stage      text,
  primary key (trade_date, symbol, list_type)
);

create table if not exists price_bands (
  trade_date date not null,
  symbol     text not null,
  band_pct   numeric not null,
  primary key (trade_date, symbol)
);

-- Freshness log: one row per data source, showing whether it is working.
create table if not exists data_sources (
  source        text primary key,        -- 'bhavcopy','indices','equity_list','asm_gsm','price_bands','market_cap','sector_lists'
  status        text not null,           -- 'ok' | 'error' | 'unavailable'
  data_date     date,                    -- latest trading date this source has loaded
  last_success  timestamptz,
  last_attempt  timestamptz,
  message       text,
  rows_last     integer
);

create table if not exists data_runs (
  id          bigserial primary key,
  kind        text not null,             -- 'daily' | 'backfill' | 'backtest'
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  data_date   date,
  ok          boolean,
  message     text
);

-- ---------- config ----------
create table if not exists settings (
  id         integer primary key default 1 check (id = 1),
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- scanner output ----------
create table if not exists scan_runs (
  scan_date        date primary key,
  data_date        date not null,
  market_filter_on boolean not null,     -- true = new buys allowed
  market_detail    jsonb not null,       -- index close, 50/200 DMA, reasons, warnings (filters skipped etc.)
  counts           jsonb not null,       -- funnel: universe, passed filters, trend, setups, breakouts, watchlist
  created_at       timestamptz not null default now()
);

create table if not exists suggestions (
  scan_date    date not null references scan_runs(scan_date) on delete cascade,
  symbol       text not null,
  grp          text not null check (grp in ('breakout','watchlist','extended')),
  sector       text,
  close        numeric not null,
  pivot        numeric not null,
  dist_pct     numeric not null,         -- (pivot - close) / pivot * 100; negative = above pivot
  stop         numeric not null,
  target       numeric not null,
  qty          integer not null,         -- from position sizing; 0 = cannot afford 1 share
  size_warning text,
  score        numeric not null,
  breakdown    jsonb not null,           -- {component: {points, max, detail}}
  details      jsonb not null,           -- base length/depth, contractions, volumes, rs, ...
  screener_url text not null,
  primary key (scan_date, symbol)
);

create table if not exists watchlist (
  symbol   text primary key,
  added_at timestamptz not null default now(),
  note     text
);

-- Manual fundamentals checklist (phase 3)
create table if not exists checklists (
  symbol     text primary key,
  items      jsonb not null default '{}'::jsonb,   -- {eps_growth:true, revenue_growth:false, ...} 7 keys
  score      integer not null default 0,           -- number of ticked items, 0..7
  notes      text,
  updated_at timestamptz not null default now()
);

-- ---------- paper trading ----------
create table if not exists trades (
  id              bigserial primary key,
  symbol          text not null,
  status          text not null default 'open' check (status in ('open','closed')),
  entry_date      date not null,
  entry_price     numeric not null,
  initial_qty     integer not null,
  qty             integer not null,              -- shares still held
  stop            numeric not null,              -- only ever moves up
  target          numeric not null,
  booked_third    boolean not null default false,
  checklist_score integer,
  entry_reason    text,
  notes           text,
  exit_date       date,
  exit_reason     text,                          -- 'stop','trail','time_stop','target','manual'
  realized_pnl    numeric,                       -- net of charges, set when closed
  created_at      timestamptz not null default now()
);

create table if not exists fills (
  id        bigserial primary key,
  trade_id  bigint not null references trades(id) on delete cascade,
  fill_date date not null,
  side      text not null check (side in ('buy','sell')),
  qty       integer not null,
  price     numeric not null,
  charges   numeric not null default 0,           -- brokerage-type % charge + DP charge on sells
  reason    text,
  note      text
);

-- A confirmed paper buy/sell. price null = fill at next trading day's open (done by run_daily.py).
create table if not exists orders (
  id              bigserial primary key,
  side            text not null check (side in ('buy','sell')),
  symbol          text not null,
  trade_id        bigint references trades(id) on delete set null,   -- required for sells
  qty             integer not null,
  price           numeric,
  status          text not null default 'pending' check (status in ('pending','filled','cancelled')),
  reason          text,
  checklist_score integer,
  notes           text,
  stop            numeric,                        -- buy orders: stop at entry (default entry * (1 - stop_pct))
  created_data_date date not null,                -- latest data date when confirmed; fills on first session after it
  created_at      timestamptz not null default now(),
  fill_date       date,
  fill_price      numeric
);

create table if not exists alerts (
  id           bigserial primary key,
  alert_date   date not null,
  trade_id     bigint references trades(id) on delete cascade,
  symbol       text not null,
  kind         text not null,                    -- 'stop','target','trail','time_stop'
  message      text not null,
  acknowledged boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (alert_date, trade_id, kind)
);

create table if not exists equity_snapshots (
  snap_date    date primary key,
  cash         numeric not null,
  equity       numeric not null,                 -- cash + market value of open positions
  open_pnl     numeric not null,
  realized_pnl numeric not null,
  bench_close  numeric                           -- Nifty Smallcap 250 close
);

-- ---------- backtests ----------
create table if not exists backtest_runs (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  label        text not null,                    -- 'market filter ON' | 'market filter OFF'
  filter_on    boolean not null,
  params       jsonb not null,
  period_start date,
  period_end   date,
  metrics      jsonb not null,
  equity_curve jsonb not null,                   -- [{d:'2024-01-02', equity:5000, bench:100.0}, ...]
  trades       jsonb not null,
  notes        text
);

-- ---------- security: RLS on, no policies ----------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
