import io
import os
import zipfile
from datetime import date

import pytest

from data import nse

BHAV = (
    "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, "
    "TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\n"
    "ABC, EQ, 20-Oct-2026, 100.00, 101.00, 105.50, 99.50, 104.00, 104.50, 103.00, 200000, 2060.00, 5000, 120000, 60.00\n"
    "XYZ, EQ, 20-Oct-2026, 50.00, 50.00, 51.00, 49.00, 50.50, 50.40, 50.10, 1000, 5.01, 20, -, -\n"
    "BEE, BE, 20-Oct-2026, 10.00, 10.00, 10.50, 9.90, 10.20, 10.30, 10.10, 5000, 5.05, 30, 4000, 80.00\n"
)
INDEX = (
    "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,"
    "Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\n"
    "Nifty 50,20-10-2026,25000.00,25100.00,24900.00,25050.50,50.5,0.2,1,1,20,3,1.2\n"
    "NIFTY SMALLCAP 250,20-10-2026,16000,16100,15900,16050,1,0.1,1,1,1,1,1\n"
    "Nifty Bank,20-10-2026,55000,55500,54800,55200,1,0.1,1,1,1,1,1\n"
    "Nifty Midcap 100,20-10-2026,1,1,1,1,1,1,1,1,1,1,1\n"
)


def test_parse_bhavcopy_filters_eq_and_handles_dashes():
    df = nse.parse_bhavcopy(BHAV.encode())
    assert list(df["symbol"]) == ["ABC", "XYZ"]
    a = df.iloc[0]
    assert a["trade_date"] == date(2026, 10, 20) and a["close"] == 104.5 and a["prev_close"] == 100.0
    assert abs(a["turnover_cr"] - 20.6) < 1e-9                   # 2060 lakh = 20.6 crore
    assert a["deliv_pct"] == 60.0
    assert df.iloc[1]["deliv_pct"] != df.iloc[1]["deliv_pct"]     # NaN, never invented


def test_parse_bhavcopy_wrong_layout_is_a_clear_error():
    with pytest.raises(nse.ParseError, match="missing columns"):
        nse.parse_bhavcopy(b"A,B\n1,2\n")


def test_parse_index_close():
    wanted = {nse.normalise_index_name(n): n for n in ["Nifty 50", "Nifty Smallcap 250", "Nifty Bank"]}
    df = nse.parse_index_close(INDEX.encode(), wanted)
    assert set(df["index_name"]) == {"Nifty 50", "Nifty Smallcap 250", "Nifty Bank"}
    assert df[df["index_name"] == "Nifty Smallcap 250"]["close"].iloc[0] == 16050
    assert df["trade_date"].iloc[0] == date(2026, 10, 20)


def test_parse_price_bands_requires_a_band_column():
    with pytest.raises(nse.ParseError, match="no price-band column"):
        nse.parse_price_bands(b"Symbol,Series,Security Name\nABC,EQ,Abc Ltd\n")
    df = nse.parse_price_bands(b"Symbol,Series,Security Name,Price Band\nABC,EQ,Abc,5\nXYZ,EQ,Xyz,No Band\n")
    assert df["band_pct"].tolist() == [5.0]


def test_parse_mcap_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("Mcap20102026.csv", "Symbol,Series,Security Name,Market Cap(Rs.)\nABC,EQ,Abc,50000000000\n")
    df = nse.parse_mcap_from_pr_zip(buf.getvalue())
    assert df.iloc[0]["symbol"] == "ABC" and df.iloc[0]["market_cap_cr"] == 5000.0


class FakeClient:
    def __init__(self, files):
        self.files, self.calls = files, []

    def get(self, url):
        self.calls.append(url)
        return self.files.get(url)


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="needs TEST_DATABASE_URL")
def test_update_prices_skips_holidays_and_reports_pending_today():
    import psycopg
    from data import loader
    conn = psycopg.connect(os.environ["TEST_DATABASE_URL"], prepare_threshold=None)
    with conn.cursor() as cur:
        cur.execute("truncate daily_prices, index_prices")
    conn.commit()
    d1, d2 = date(2026, 10, 19), date(2026, 10, 20)        # Mon, Tue
    files = {nse.bhavcopy_url(d2): BHAV.encode(), nse.index_close_url(d2): INDEX.encode()}
    # Mon 19th has no file (holiday); Sat/Sun skipped entirely
    stats = loader.update_prices(conn, FakeClient(files), date(2026, 10, 17), date(2026, 10, 21), today=date(2026, 10, 21))
    assert stats["loaded"] == 1 and stats["no_file"] == 2 and stats["pending_today"] is True and not stats["errors"]
    assert loader.latest_data_date(conn) == d2
    again = loader.update_prices(conn, FakeClient(files), d2, d2, today=date(2026, 10, 21))
    assert again["skipped_existing"] == 1 and again["loaded"] == 0
    conn.close()
