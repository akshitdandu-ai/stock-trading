export type ActionState = { ok: boolean; message: string } | null;

export type TradeRow = {
  id: number;
  symbol: string;
  status: 'open' | 'closed';
  entry_date: string;
  entry_price: number;
  initial_qty: number;
  qty: number;
  stop: number;
  target: number;
  booked_third: boolean;
  checklist_score: number | null;
  entry_reason: string | null;
  notes: string | null;
  exit_date: string | null;
  exit_reason: string | null;
  realized_pnl: number | null;
};

export type FillRow = {
  id: number;
  trade_id: number;
  fill_date: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  charges: number;
  reason: string | null;
};

export type OrderRow = {
  id: number;
  side: 'buy' | 'sell';
  symbol: string;
  trade_id: number | null;
  qty: number;
  price: number | null;
  status: 'pending' | 'filled' | 'cancelled';
  reason: string | null;
  notes: string | null;
  stop: number | null;
  created_data_date: string;
  created_at: string;
};

export type AlertRow = {
  id: number;
  alert_date: string;
  trade_id: number | null;
  symbol: string;
  kind: string;
  message: string;
  acknowledged: boolean;
};

export type SourceRow = {
  source: string;
  status: string;
  data_date: string | null;
  last_success: string | null;
  last_attempt: string | null;
  message: string | null;
  rows_last: number | null;
};

export type ScoreComponent = { points: number; max: number; detail?: string };

export type SuggestionRow = {
  scan_date: string;
  symbol: string;
  grp: 'breakout' | 'watchlist' | 'extended';
  sector: string | null;
  close: number;
  pivot: number;
  dist_pct: number;
  stop: number;
  target: number;
  qty: number;
  size_warning: string | null;
  score: number;
  breakdown: Record<string, ScoreComponent>;
  details: Record<string, unknown>;
  screener_url: string;
  // joined state
  checklist_items: Record<string, boolean> | null;
  checklist_score: number | null;
  checklist_notes: string | null;
  on_watchlist: boolean;
  held: boolean;
  pending_buy: boolean;
};

export type MarketDetail = {
  index_close?: number;
  sma50?: number;
  sma200?: number;
  rule?: string;
  ok?: boolean;
  warnings?: string[];
  [k: string]: unknown;
};

export type ScanRun = {
  scan_date: string;
  data_date: string;
  market_filter_on: boolean;
  market_detail: MarketDetail;
  counts: Record<string, number>;
  created_at: string;
};

export type SizingParams = {
  equity: number;
  cash: number; // available cash (cash less pending buys)
  risk_pct: number;
  stop_pct: number;
  target_pct: number;
  charges_pct_per_side: number;
  dp_charge: number;
};
