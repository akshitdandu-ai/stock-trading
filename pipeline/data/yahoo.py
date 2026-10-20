"""Optional yfinance fallback, used ONLY to fill benchmark index history that NSE files did not provide."""
from __future__ import annotations

import logging

import pandas as pd

log = logging.getLogger("yahoo")

TICKERS = {"Nifty 50": "^NSEI", "Nifty Smallcap 250": "NIFTYSMLCAP250.NS"}


def index_history(index_name: str, days: int = 1100) -> pd.DataFrame:
    """Daily OHLC for a benchmark index from Yahoo Finance; empty frame if unavailable."""
    ticker = TICKERS.get(index_name)
    if not ticker:
        return pd.DataFrame()
    try:
        import yfinance as yf
        df = yf.download(ticker, period=f"{max(1, days // 365 + 1)}y", interval="1d", progress=False, auto_adjust=False)
    except Exception as e:  # network, rate limit, missing package: never fatal
        log.warning("yfinance fallback for %s failed: %s", index_name, e)
        return pd.DataFrame()
    if df is None or df.empty:
        return pd.DataFrame()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    out = pd.DataFrame({
        "index_name": index_name,
        "trade_date": [d.date() for d in df.index],
        "open": df["Open"].values, "high": df["High"].values, "low": df["Low"].values, "close": df["Close"].values,
    }).dropna(subset=["close"])
    return out
