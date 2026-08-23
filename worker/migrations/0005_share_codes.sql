-- 分享碼：監護人（家人）憑碼唯讀查看裝置的統計與戒菸進度
CREATE TABLE IF NOT EXISTS share_codes (
    code       TEXT PRIMARY KEY,   -- 6 碼，A-Z2-9（排除易混淆字元）
    device_id  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT                -- NULL = 有效
);

CREATE INDEX IF NOT EXISTS idx_share_device ON share_codes (device_id);
