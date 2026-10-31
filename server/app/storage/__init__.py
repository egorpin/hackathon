"""SQLite storage and transaction boundary for server operations."""
import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


class Database:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    salt BLOB NOT NULL, password_hash BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, map_version TEXT NOT NULL, stage TEXT NOT NULL,
                    landing_sites TEXT NOT NULL DEFAULT '{}');
                CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), name TEXT NOT NULL,
                    progress TEXT NOT NULL DEFAULT '{}',
                    UNIQUE(id, world_id));
                CREATE TABLE IF NOT EXISTS team_members (
                    world_id TEXT NOT NULL REFERENCES worlds(id), user_id TEXT NOT NULL REFERENCES users(id),
                    team_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(world_id, user_id),
                    FOREIGN KEY(team_id, world_id) REFERENCES teams(id, world_id)
                );
                CREATE TABLE IF NOT EXISTS players (
                    world_id TEXT NOT NULL, user_id TEXT NOT NULL, position TEXT, orientation TEXT,
                    oxygen REAL, inventory TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(world_id, user_id),
                    FOREIGN KEY(world_id, user_id) REFERENCES team_members(world_id, user_id)
                );
                CREATE TABLE IF NOT EXISTS buildings (
                    id TEXT PRIMARY KEY, world_id TEXT NOT NULL, cell_id TEXT NOT NULL, type TEXT NOT NULL,
                    team_id TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES users(id), stock TEXT NOT NULL DEFAULT '{}',
                    UNIQUE(world_id, cell_id), FOREIGN KEY(team_id, world_id) REFERENCES teams(id, world_id)
                );
                CREATE TABLE IF NOT EXISTS team_storage (team_id TEXT PRIMARY KEY REFERENCES teams(id), resources TEXT NOT NULL DEFAULT '{}');
                CREATE TABLE IF NOT EXISTS rovers (
                    id TEXT PRIMARY KEY, world_id TEXT NOT NULL, team_id TEXT NOT NULL, position TEXT NOT NULL,
                    cargo TEXT NOT NULL DEFAULT '{}', program TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(team_id, world_id) REFERENCES teams(id, world_id)
                );
                CREATE TABLE IF NOT EXISTS agent_memory (
                    world_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, memory TEXT NOT NULL DEFAULT '{}',
                    PRIMARY KEY(world_id, user_id, agent_id), FOREIGN KEY(world_id, user_id) REFERENCES team_members(world_id, user_id)
                );
                CREATE TABLE IF NOT EXISTS agent_messages (
                    id TEXT PRIMARY KEY, world_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
                    role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
                    FOREIGN KEY(world_id, user_id) REFERENCES team_members(world_id, user_id)
                );
                CREATE TABLE IF NOT EXISTS command_results (
                    world_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(world_id, user_id, request_id),
                    FOREIGN KEY(world_id, user_id) REFERENCES team_members(world_id, user_id)
                );
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY, world_id TEXT NOT NULL, team_id TEXT NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, created_at INTEGER NOT NULL,
                    FOREIGN KEY(team_id, world_id) REFERENCES teams(id, world_id)
                );
                INSERT OR IGNORE INTO worlds(id, map_version, stage) VALUES ('demo-world', 'pending', 'lobby');
                INSERT OR IGNORE INTO teams(id, world_id, name) VALUES ('demo-team', 'demo-world', 'Expedition');
                INSERT OR IGNORE INTO team_storage(team_id) VALUES ('demo-team');
            """)

    @staticmethod
    def token_hash(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def register(self, username, salt, password_hash, token, lifetime):
        user_id = str(uuid.uuid4())
        with self.connect() as db:
            db.execute("INSERT INTO users VALUES (?, ?, ?, ?)", (user_id, username, salt, password_hash))
            db.execute("INSERT INTO team_members VALUES ('demo-world', ?, 'demo-team', 'player')", (user_id,))
            db.execute("INSERT INTO players(world_id, user_id) VALUES ('demo-world', ?)", (user_id,))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (self.token_hash(token), user_id, int(time.time()) + lifetime))
        return self.identity(token)

    def password_record(self, username):
        with self.connect() as db:
            return db.execute("SELECT id, salt, password_hash FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()

    def create_session(self, user_id, token, lifetime):
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (self.token_hash(token), user_id, int(time.time()) + lifetime))
        return self.identity(token)

    def identity(self, token):
        if not token or len(token) > 256:
            return None
        with self.connect() as db:
            row = db.execute("""SELECT u.id AS user_id, u.username, m.world_id, m.team_id
                FROM sessions s JOIN users u ON u.id=s.user_id
                JOIN team_members m ON m.user_id=u.id AND m.world_id='demo-world'
                WHERE s.token_hash=? AND s.expires_at>?""", (self.token_hash(token), int(time.time()))).fetchone()
            return dict(row) if row else None

    def delete_session(self, token):
        if token and len(token) <= 256:
            with self.connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (self.token_hash(token),))

    def send_chat(self, identity, request_id, text):
        fingerprint = hashlib.sha256(json.dumps({"type": "chat.send", "text": text}, ensure_ascii=False,
                                                sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT fingerprint, result FROM command_results WHERE world_id=? AND user_id=? AND request_id=?",
                                  (identity["world_id"], identity["user_id"], request_id)).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    return {"type": "action.result", "request_id": request_id,
                            "payload": {"ok": False, "code": "REQUEST_CONFLICT"}}, None
                return json.loads(previous["result"]), None
            message_id = str(uuid.uuid4())
            timestamp = int(time.time())
            db.execute("INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?)",
                       (message_id, identity["world_id"], identity["team_id"], identity["user_id"], text, timestamp))
            result = {"type": "action.result", "request_id": request_id, "payload": {"ok": True, "message_id": message_id}}
            db.execute("INSERT INTO command_results VALUES (?, ?, ?, ?, ?)",
                       (identity["world_id"], identity["user_id"], request_id, fingerprint, json.dumps(result)))
            event = {"type": "chat.message", "payload": {"id": message_id, "user_id": identity["user_id"],
                     "username": identity["username"], "text": text, "created_at": timestamp}}
        return result, event
