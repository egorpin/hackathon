"""Deployment scaffold; game, authentication and WebSocket are not implemented yet."""

import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
STATIC_DIR = Path(os.environ.get("STATIC_DIR", "client/dist"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DATA_DIR / "mars.sqlite3") as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS deployment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("INSERT OR IGNORE INTO deployment_meta VALUES ('schema', 'scaffold-v1')")
    yield


app = FastAPI(title="Mars Colony", lifespan=lifespan)


@app.get("/api/health")
def health():
    with sqlite3.connect(DATA_DIR / "mars.sqlite3", timeout=2) as db:
        db.execute("SELECT value FROM deployment_meta WHERE key = 'schema'").fetchone()
    return {"status": "ok", "stage": "scaffold"}


# API routes must be registered before this catch-all static mount.
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="client")
