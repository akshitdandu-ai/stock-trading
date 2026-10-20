"""NSE public-file downloads and parsers.

Only publicly downloadable files are used (no login, no scraping of rendered pages). Every fetcher
raises or returns None on failure so the caller can record an honest status; nothing is invented.

NOTE: URLs/column layouts follow NSE's published formats as last known. If NSE changes a file, the
parser raises a clear ParseError and the source shows as 'error' in the dashboard.
"""
from __future__ import annotations

import io
import re
import time
import zipfile
from datetime import date

import pandas as pd
import requests

ARCHIVES = "https://nsearchives.nseindia.com"
WWW = "https://www.nseindia.com"

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept": "text/csv,application/zip,application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": WWW + "/",
}


class FetchError(RuntimeError):
    """Network / HTTP failure that is not a plain 404."""


class ParseError(RuntimeError):
    """File downloaded but did not have the expected layout."""


class NseClient:
    def __init__(self, min_delay: float = 0.6, retries: int = 4, timeout: int = 40):
        self.s = requests.Session()
        self.s.headers.update(HEADERS)
        self.min_delay = min_delay
        self.retries = retries
        self.timeout = timeout
        self._last = 0.0

    def get(self, url: str) -> bytes | None:
        """Return body bytes, or None for a 404 (no such file: holiday, weekend, not published yet).

        Retries 429/5xx/timeouts with exponential backoff; raises FetchError after the last retry,
        or immediately on 401/403 (access blocked)."""
        last_err = ""
        for attempt in range(self.retries + 1):
            wait = self.min_delay - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                r = self.s.get(url, timeout=self.timeout)
            except requests.RequestException as e:
                last_err = f"{type(e).__name__}: {e}"
            else:
                if r.status_code == 200:
                    return r.content
                if r.status_code == 404:
                    return None
                if r.status_code in (401, 403):
                    raise FetchError(f"{url} -> HTTP {r.status_code} (access blocked by NSE or the network)")
                last_err = f"HTTP {r.status_code}"
            if attempt < self.retries:
                time.sleep(min(60, 2 ** (attempt + 1)))
        raise FetchError(f"{url} failed after {self.retries + 1} attempts ({last_err})")


# ---------------------------------------------------------------- URL builders
def ddmmyyyy(d: date) -> str:
    return d.strftime("%d%m%Y")


def bhavcopy_url(d: date) -> str:
    return f"{ARCHIVES}/products/content/sec_bhavdata_full_{ddmmyyyy(d)}.csv"


def udiff_bhavcopy_url(d: date) -> str:
    return f"{ARCHIVES}/content/cm/BhavCopy_NSE_CM_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip"


def index_close_url(d: date) -> str:
    return f"{ARCHIVES}/content/indices/ind_close_all_{ddmmyyyy(d)}.csv"


EQUITY_LIST_URL = f"{ARCHIVES}/content/equities/EQUITY_L.csv"


def sector_list_url(stem: str) -> str:
    return f"{ARCHIVES}/content/indices/ind_{stem}list.csv"


NIFTY500_LIST_URL = f"{ARCHIVES}/content/indices/ind_nifty500list.csv"


def sec_list_url(d: date) -> str:
    return f"{ARCHIVES}/content/equities/sec_list_{ddmmyyyy(d)}.csv"


def pr_zip_url(d: date) -> str:
    return f"{ARCHIVES}/archives/equities/bhavcopy/pr/PR{d.strftime('%d%m%y')}.zip"


# ---------------------------------------------------------------- parsing helpers
def _read_csv(raw: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), skipinitialspace=True, dtype=str, encoding_errors="replace")
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.astype(str).str.replace(",", "", regex=False).str.strip().replace({"-": None, "": None}),
                         errors="coerce")


def _find_col(df: pd.DataFrame, *needles: str, required: bool = True) -> str | None:
    """First column whose lowercase name contains all needles."""
    for c in df.columns:
        low = c.lower()
        if all(n in low for n in needles):
            return c
    if required:
        raise ParseError(f"expected a column containing {needles} in {list(df.columns)}")
    return None


# ---------------------------------------------------------------- bhavcopy (prices + delivery)
BHAV_COLUMNS = ["symbol", "trade_date", "open", "high", "low", "close", "prev_close",
                "volume", "turnover_cr", "trades", "deliv_pct"]


def parse_bhavcopy(raw: bytes) -> pd.DataFrame:
    """sec_bhavdata_full_*.csv -> EQ-series rows with delivery %."""
    df = _read_csv(raw)
    need = {"SYMBOL", "SERIES", "DATE1", "PREV_CLOSE", "OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE",
            "CLOSE_PRICE", "TTL_TRD_QNTY", "TURNOVER_LACS"}
    missing = need - set(df.columns)
    if missing:
        raise ParseError(f"bhavcopy is missing columns {sorted(missing)}; got {list(df.columns)}")
    df = df[df["SERIES"].str.strip() == "EQ"].copy()
    out = pd.DataFrame({
        "symbol": df["SYMBOL"].str.strip(),
        "trade_date": pd.to_datetime(df["DATE1"].str.strip(), format="%d-%b-%Y", errors="coerce").dt.date,
        "open": _num(df["OPEN_PRICE"]),
        "high": _num(df["HIGH_PRICE"]),
        "low": _num(df["LOW_PRICE"]),
        "close": _num(df["CLOSE_PRICE"]),
        "prev_close": _num(df["PREV_CLOSE"]),
        "volume": _num(df["TTL_TRD_QNTY"]),
        "turnover_cr": _num(df["TURNOVER_LACS"]) / 100.0,   # lakhs -> crore
        "trades": _num(df["NO_OF_TRADES"]) if "NO_OF_TRADES" in df.columns else None,
        "deliv_pct": _num(df["DELIV_PER"]) if "DELIV_PER" in df.columns else None,
    })
    return _clean_prices(out)


def parse_udiff_bhavcopy(raw: bytes) -> pd.DataFrame:
    """New-format (UDiFF) CM bhavcopy zip -> EQ rows, no delivery %. Used only as a fallback."""
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = next((n for n in z.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise ParseError("UDiFF zip has no csv")
        df = _read_csv(z.read(name))
    need = {"TckrSymb", "SctySrs", "TradDt", "OpnPric", "HghPric", "LwPric", "ClsPric", "PrvsClsgPric",
            "TtlTradgVol", "TtlTrfVal"}
    missing = need - set(df.columns)
    if missing:
        raise ParseError(f"UDiFF bhavcopy is missing columns {sorted(missing)}")
    df = df[df["SctySrs"].str.strip() == "EQ"].copy()
    out = pd.DataFrame({
        "symbol": df["TckrSymb"].str.strip(),
        "trade_date": pd.to_datetime(df["TradDt"].str.strip(), errors="coerce").dt.date,
        "open": _num(df["OpnPric"]), "high": _num(df["HghPric"]), "low": _num(df["LwPric"]),
        "close": _num(df["ClsPric"]), "prev_close": _num(df["PrvsClsgPric"]),
        "volume": _num(df["TtlTradgVol"]),
        "turnover_cr": _num(df["TtlTrfVal"]) / 1e7,       # rupees -> crore
        "trades": _num(df["TtlNbOfTxsExctd"]) if "TtlNbOfTxsExctd" in df.columns else None,
        "deliv_pct": None,
    })
    return _clean_prices(out)


def _clean_prices(out: pd.DataFrame) -> pd.DataFrame:
    out = out.dropna(subset=["symbol", "trade_date", "open", "high", "low", "close"])
    out = out[(out["close"] > 0) & (out["high"] >= out["low"])]
    out = out.drop_duplicates(["symbol", "trade_date"], keep="last")
    return out[BHAV_COLUMNS].reset_index(drop=True)


# ---------------------------------------------------------------- index closes
INDEX_COLUMNS = ["index_name", "trade_date", "open", "high", "low", "close"]


def parse_index_close(raw: bytes, wanted: dict[str, str]) -> pd.DataFrame:
    """ind_close_all_*.csv -> rows for the wanted indices. `wanted` maps lowercase name -> canonical name."""
    df = _read_csv(raw)
    c_name = _find_col(df, "index name")
    c_date = _find_col(df, "date")
    c_open = _find_col(df, "open")
    c_high = _find_col(df, "high")
    c_low = _find_col(df, "low")
    c_close = _find_col(df, "clos")
    names = df[c_name].str.strip().str.replace(r"\s+", " ", regex=True)
    canon = names.str.lower().map(wanted)
    df = df[canon.notna()].copy()
    if df.empty:
        raise ParseError("none of the wanted indices found in ind_close_all file")
    out = pd.DataFrame({
        "index_name": canon[canon.notna()],
        "trade_date": pd.to_datetime(df[c_date].str.strip(), format="%d-%m-%Y", errors="coerce").dt.date,
        "open": _num(df[c_open]), "high": _num(df[c_high]), "low": _num(df[c_low]),
        "close": _num(df[c_close]),
    }).dropna(subset=["trade_date", "close"])
    return out[INDEX_COLUMNS].drop_duplicates(["index_name", "trade_date"]).reset_index(drop=True)


# ---------------------------------------------------------------- reference lists
def parse_equity_list(raw: bytes) -> pd.DataFrame:
    df = _read_csv(raw)
    c_sym = _find_col(df, "symbol")
    c_name = _find_col(df, "name")
    c_series = _find_col(df, "series")
    c_list = _find_col(df, "listing", required=False)
    c_isin = _find_col(df, "isin", required=False)
    df = df[df[c_series].str.strip() == "EQ"]
    return pd.DataFrame({
        "symbol": df[c_sym].str.strip(),
        "name": df[c_name].str.strip(),
        "isin": df[c_isin].str.strip() if c_isin else None,
        "listing_date": pd.to_datetime(df[c_list].str.strip(), format="%d-%b-%Y", errors="coerce").dt.date
        if c_list else None,
    }).reset_index(drop=True)


def parse_constituents(raw: bytes) -> pd.DataFrame:
    """ind_*list.csv -> symbol, industry (if present)."""
    df = _read_csv(raw)
    c_sym = _find_col(df, "symbol")
    c_ind = _find_col(df, "industry", required=False)
    return pd.DataFrame({
        "symbol": df[c_sym].str.strip(),
        "industry": df[c_ind].str.strip() if c_ind else None,
    })


def parse_price_bands(raw: bytes) -> pd.DataFrame:
    """sec_list_*.csv -> symbol, band_pct. Raises ParseError if the file carries no band column."""
    df = _read_csv(raw)
    c_sym = _find_col(df, "symbol")
    c_band = _find_col(df, "band", required=False)
    if c_band is None:
        raise ParseError(f"no price-band column in sec_list file (columns: {list(df.columns)})")
    c_series = _find_col(df, "series", required=False)
    if c_series:
        df = df[df[c_series].str.strip() == "EQ"]
    band = df[c_band].astype(str).str.extract(r"(\d+(?:\.\d+)?)")[0].astype(float)
    out = pd.DataFrame({"symbol": df[c_sym].str.strip(), "band_pct": band}).dropna()
    if out.empty:
        raise ParseError("sec_list price-band column was empty")
    return out.drop_duplicates("symbol").reset_index(drop=True)


def parse_mcap_from_pr_zip(raw: bytes) -> pd.DataFrame:
    """PR*.zip contains a 'Mcap' csv with Market Cap(Rs.) per symbol -> market_cap_cr."""
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = next((n for n in z.namelist() if "mcap" in n.lower() and n.lower().endswith(".csv")), None)
        if not name:
            raise ParseError(f"no Mcap csv inside PR zip (members: {z.namelist()[:10]})")
        df = _read_csv(z.read(name))
    c_sym = _find_col(df, "symbol")
    c_cap = _find_col(df, "market cap")
    c_series = _find_col(df, "series", required=False)
    if c_series:
        df = df[df[c_series].str.strip() == "EQ"]
    cap = _num(df[c_cap]) / 1e7   # rupees -> crore
    out = pd.DataFrame({"symbol": df[c_sym].str.strip(), "market_cap_cr": cap}).dropna()
    if out.empty:
        raise ParseError("Mcap file had no usable rows")
    return out.drop_duplicates("symbol").reset_index(drop=True)


def normalise_index_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()).lower()
