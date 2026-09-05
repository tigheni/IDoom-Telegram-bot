CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    idoom_number TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,
    expiration TEXT,
    last_notified_expiration TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS setup_sessions (
    telegram_id TEXT PRIMARY KEY,
    idoom_number TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
