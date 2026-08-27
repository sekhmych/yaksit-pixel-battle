-- 1. Сессии
CREATE TABLE IF NOT EXISTS "session" (
    "sid" varchar NOT NULL COLLATE "default",
    "sess" json NOT NULL,
    "expire" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);

-- Первичный ключ для сессий (если нет)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'session_pkey') THEN
        ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- 2. Раунды: каждый раунд определяет свой холст, кулдаун и палитру.
-- Одновременно активным может быть только один раунд (частичный уникальный индекс ниже).
CREATE TABLE IF NOT EXISTS rounds (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'finished')),
    starts_at TIMESTAMP NOT NULL,
    ends_at TIMESTAMP NOT NULL,
    canvas_size INT NOT NULL,
    cooldown INT NOT NULL,
    bg_color VARCHAR(10) NOT NULL DEFAULT '#1f2937',
    grid_enabled BOOLEAN NOT NULL DEFAULT true,
    palette JSONB NOT NULL,
    activated_at TIMESTAMP,
    finished_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_single_active ON rounds ((true)) WHERE status = 'active';

-- Финальный слепок (превью PNG) каждого завершённого раунда - "архив".
CREATE TABLE IF NOT EXISTS round_archives (
    round_id INTEGER PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
    preview BYTEA NOT NULL,
    pixel_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Основные таблицы игры. Холст и история привязаны к конкретному раунду,
-- поэтому пиксели завершённого раунда никогда не удаляются и не перезаписываются.
CREATE TABLE IF NOT EXISTS pixels (
    round_id INTEGER NOT NULL REFERENCES rounds(id),
    x INT,
    y INT,
    color VARCHAR(10) NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (round_id, x, y)
);

CREATE TABLE IF NOT EXISTS settings (
    id INT PRIMARY KEY,
    canvas_size INT NOT NULL,
    cooldown INT NOT NULL,
    grid_enabled BOOLEAN NOT NULL,
    bg_color VARCHAR(10) DEFAULT '#1f2937'
);

CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(50) PRIMARY KEY,
    last_placed_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderators (
    username VARCHAR(50) PRIMARY KEY,
    password VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_logs (
    id SERIAL PRIMARY KEY,
    action VARCHAR(100) NOT NULL,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. История и Таймлапс
CREATE TABLE IF NOT EXISTS pixel_history (
    id SERIAL PRIMARY KEY,
    round_id INTEGER NOT NULL REFERENCES rounds(id),
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    color VARCHAR(50) NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pixel_history_time ON pixel_history(created_at);
CREATE INDEX IF NOT EXISTS idx_pixel_history_coords ON pixel_history(x, y);
CREATE INDEX IF NOT EXISTS idx_pixel_history_round ON pixel_history(round_id);

CREATE TABLE IF NOT EXISTS snapshots (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id),
    data BYTEA NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Примечание: на свежей базе данных (этот файл) таблицы создаются уже в
-- финальной форме с системой раундов - переносить в архив нечего.
-- Безопасная миграция уже существующей продовой БД (старый глобальный
-- холст без раундов -> архивный раунд) выполняется идемпотентно в
-- backend/server.js::initDatabase() при каждом запуске сервера.
