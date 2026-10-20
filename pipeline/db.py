"""Postgres (Supabase) connection helpers."""
from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime, timezone

import psycopg


def database_url() -> str:
    url = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "SUPABASE_DB_URL is not set. Use the Supabase *session pooler* connection string "
            "(Project Settings -> Database -> Connection string -> Session pooler)."
        )
    return url


def connect() -> psycopg.Connection:
    # prepare_threshold=None: pgbouncer/Supavisor pooler connections cannot reuse prepared statements.
    return psycopg.connect(database_url(), prepare_threshold=None, autocommit=False)


@contextmanager
def transaction(conn):
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def log_source(conn, source: str, status: str, *, data_date=None, message: str | None = None,
               rows: int | None = None) -> None:
    """Upsert the freshness row for a data source. last_success only moves forward on 'ok'."""
    now = datetime.now(timezone.utc)
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into data_sources (source, status, data_date, last_success, last_attempt, message, rows_last)
            values (%s, %s, %s, %s, %s, %s, %s)
            on conflict (source) do update set
              status = excluded.status,
              data_date = coalesce(excluded.data_date, data_sources.data_date),
              last_success = coalesce(excluded.last_success, data_sources.last_success),
              last_attempt = excluded.last_attempt,
              message = excluded.message,
              rows_last = coalesce(excluded.rows_last, data_sources.rows_last)
            """,
            (source, status, data_date, now if status == "ok" else None, now, message, rows),
        )
    conn.commit()


def start_run(conn, kind: str) -> int:
    with conn.cursor() as cur:
        cur.execute("insert into data_runs (kind) values (%s) returning id", (kind,))
        run_id = cur.fetchone()[0]
    conn.commit()
    return run_id


def finish_run(conn, run_id: int, ok: bool, message: str, data_date=None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "update data_runs set finished_at = now(), ok = %s, message = %s, data_date = %s where id = %s",
            (ok, message[:2000], data_date, run_id),
        )
    conn.commit()
