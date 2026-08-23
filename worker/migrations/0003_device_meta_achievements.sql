-- 裝置中繼資料：名稱、上次開啟、IP、裝置型號（User-Agent）、上次抽菸快照
ALTER TABLE device_settings ADD COLUMN nickname TEXT;
ALTER TABLE device_settings ADD COLUMN last_seen_at TEXT;
ALTER TABLE device_settings ADD COLUMN last_ip TEXT;
ALTER TABLE device_settings ADD COLUMN last_user_agent TEXT;
ALTER TABLE device_settings ADD COLUMN last_smoked_at TEXT;  -- 快照，成就計算不依賴 smoke_logs

-- 回填：已有 logs 的裝置補上 last_smoked_at
UPDATE device_settings SET last_smoked_at = (
  SELECT MAX(smoked_at) FROM smoke_logs WHERE smoke_logs.device_id = device_settings.device_id
);
INSERT INTO device_settings (device_id, last_smoked_at)
SELECT device_id, MAX(smoked_at) FROM smoke_logs
WHERE device_id NOT IN (SELECT device_id FROM device_settings)
GROUP BY device_id;

-- 成就徽章：達成過就永久保留（破戒不沒收）
CREATE TABLE IF NOT EXISTS achievements (
    device_id TEXT NOT NULL,
    badge     TEXT NOT NULL,   -- '1m' | '3m' | '6m'
    earned_at TEXT NOT NULL,
    PRIMARY KEY (device_id, badge)
);
