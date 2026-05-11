CREATE TABLE IF NOT EXISTS slack_installations (
  connection_id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL,
  team_name TEXT,
  enterprise_id TEXT,
  user_id TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  bot_access_token_ciphertext TEXT,
  scope TEXT NOT NULL,
  bot_scope TEXT,
  token_type TEXT NOT NULL CHECK (token_type IN ('user', 'bot', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_installations_updated_at
  ON slack_installations(updated_at);

CREATE INDEX IF NOT EXISTS idx_slack_installations_team_user
  ON slack_installations(team_id, user_id);
