CREATE TABLE IF NOT EXISTS smoke_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT    NOT NULL,
    smoked_at TEXT    NOT NULL  -- ISO 8601, e.g. 2026-06-19T14:30:00.000Z
);

CREATE INDEX IF NOT EXISTS idx_device_smoked ON smoke_logs (device_id, smoked_at);

CREATE TABLE IF NOT EXISTS device_settings (
    device_id      TEXT PRIMARY KEY,
    cooldown_hours REAL NOT NULL DEFAULT 1.0,  -- min 0
    nickname       TEXT
);
