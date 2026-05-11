ALTER TABLE slack_installations ADD COLUMN user_refresh_token_ciphertext TEXT;
ALTER TABLE slack_installations ADD COLUMN user_token_expires_at TEXT;
ALTER TABLE slack_installations ADD COLUMN bot_refresh_token_ciphertext TEXT;
ALTER TABLE slack_installations ADD COLUMN bot_token_expires_at TEXT;
