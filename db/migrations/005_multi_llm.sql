-- 005_multi_llm.sql — multi-model gateways and usage metering
CREATE TABLE IF NOT EXISTS llm_endpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  base_url      text NOT NULL,
  bearer_token  text,
  model         text NOT NULL,
  is_active     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index to enforce that only one endpoint can be active at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_endpoints_active 
  ON llm_endpoints(is_active) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS llm_usage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id        uuid REFERENCES wa_sessions(id) ON DELETE SET NULL,
  character_id      uuid REFERENCES characters(id) ON DELETE SET NULL,
  endpoint_id       uuid REFERENCES llm_endpoints(id) ON DELETE SET NULL,
  model_name        text NOT NULL,
  context_tokens    int NOT NULL DEFAULT 0,
  generated_tokens  int NOT NULL DEFAULT 0,
  total_tokens      int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_user ON llm_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_endpoint ON llm_usage(endpoint_id, created_at DESC);

-- Migrate legacy gateway settings from admin_settings to llm_endpoints if exists and empty
INSERT INTO llm_endpoints (name, base_url, bearer_token, model, is_active)
SELECT 
  'Legacy Gateway', 
  COALESCE(MAX(CASE WHEN key='llm_base_url' THEN value#>>'{}' END), 'http://localhost:20128'),
  MAX(CASE WHEN key='llm_bearer' THEN value#>>'{}' END),
  COALESCE(MAX(CASE WHEN key='llm_default_model' THEN value#>>'{}' END), 'antigravity/gemini-2.5-flash'),
  true
FROM admin_settings
WHERE key IN ('llm_base_url', 'llm_bearer', 'llm_default_model')
HAVING NOT EXISTS (SELECT 1 FROM llm_endpoints);
