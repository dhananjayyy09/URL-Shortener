CREATE TABLE urls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  original_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL,
  user_id UUID NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT urls_code_key UNIQUE (code),
  CONSTRAINT urls_code_not_empty CHECK (length(code) > 0),
  CONSTRAINT urls_original_url_not_empty CHECK (length(btrim(original_url)) > 0),
  CONSTRAINT urls_expires_after_created CHECK (expires_at IS NULL OR expires_at > created_at)
);
