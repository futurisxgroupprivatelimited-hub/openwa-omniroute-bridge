-- 003_char_knowledge.sql — smart character setup: knowledge base, social links, media/drive, auto-gen sources
ALTER TABLE characters ADD COLUMN IF NOT EXISTS knowledge_base  text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS social_links    jsonb NOT NULL DEFAULT '[]';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS drive_link      text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS source_links    jsonb NOT NULL DEFAULT '[]';
ALTER TABLE characters ADD COLUMN IF NOT EXISTS sources_verified boolean NOT NULL DEFAULT false;
