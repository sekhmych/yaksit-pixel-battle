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

-- 2. Основные таблицы игры
CREATE TABLE IF NOT EXISTS pixels (
    x INT, 
    y INT, 
    color VARCHAR(10) NOT NULL, 
    user_id VARCHAR(50) NOT NULL, 
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
    PRIMARY KEY (x, y)
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

-- 3. История и Таймлапс
CREATE TABLE IF NOT EXISTS pixel_history (
    id SERIAL PRIMARY KEY, 
    x INTEGER NOT NULL, 
    y INTEGER NOT NULL, 
    color VARCHAR(50) NOT NULL, 
    user_id VARCHAR(50) NOT NULL, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pixel_history_time ON pixel_history(created_at);
CREATE INDEX IF NOT EXISTS idx_pixel_history_coords ON pixel_history(x, y);

CREATE TABLE IF NOT EXISTS snapshots (
    id SERIAL PRIMARY KEY, 
    data BYTEA NOT NULL, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Начальные настройки
INSERT INTO settings (id, canvas_size, cooldown, grid_enabled, bg_color) 
VALUES (1, 50, 2, true, '#1f2937') 
ON CONFLICT (id) DO NOTHING;
