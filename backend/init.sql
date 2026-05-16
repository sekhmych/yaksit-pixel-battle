-- Создаем таблицу для пикселей
CREATE TABLE IF NOT EXISTS pixels (
    x INT,
    y INT,
    color VARCHAR(10) NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (x, y) -- Координаты x и y уникальны
);

-- Создаем таблицу для глобальных настроек
CREATE TABLE IF NOT EXISTS settings (
    id INT PRIMARY KEY,
    canvas_size INT NOT NULL,
    cooldown INT NOT NULL,
    grid_enabled BOOLEAN NOT NULL,
    bg_color VARCHAR(10) DEFAULT '#1f2937'
);

-- Вставляем базовые настройки при первом запуске (если их нет)
INSERT INTO settings (id, canvas_size, cooldown, grid_enabled, bg_color)
VALUES (1, 50, 2, true, '#1f2937')
ON CONFLICT (id) DO NOTHING;