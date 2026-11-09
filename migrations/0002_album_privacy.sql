ALTER TABLE albums ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE albums ADD COLUMN edit_token_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_albums_slug_visibility ON albums(slug, visibility);
