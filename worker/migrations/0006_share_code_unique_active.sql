-- 一裝置同時只允許一組有效分享碼（並發產碼防護，DB 層保證）
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_one_active
  ON share_codes (device_id) WHERE revoked_at IS NULL;
