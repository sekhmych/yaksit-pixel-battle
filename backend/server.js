const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const path = require("path");

// === ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ОШИБОК ===
process.on('uncaughtException', (err) => {
    console.error('КРИТИЧЕСКАЯ ОШИБКА (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('НЕОБРАБОТАННОЕ ОБЕЩАНИЕ (unhandledRejection):', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    pingTimeout: 30000,
    pingInterval: 10000
});

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Проверка подключения к БД
pool.on('error', (err) => {
    console.error('Непредвиденная ошибка БД:', err);
});

app.use(express.static(path.join(__dirname, "public")));

// === ГЛОБАЛЬНОЕ СОСТОЯНИЕ (Кэш) ===
let currentSettings = { canvas_size: 50, cooldown: 2, grid_enabled: true, bg_color: '#1f2937' };

// Пароль админа из переменной окружения
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

// Блокировка от брутфорса (IP -> { count, lockUntil })
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_TIME_MS = 5 * 60 * 1000; // 5 минут

// Хранилище кулдаунов: Map <userId, timestamp>
const userCooldowns = new Map();

// Загружаем настройки из БД при старте сервера
async function initServer() {
    try {
        const client = await pool.connect();
        console.log("Соединение с БД установлено");
        client.release();

        // Миграция: добавляем колонку bg_color, если её нет
        await pool.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS bg_color VARCHAR(10) DEFAULT '#1f2937'");
        
        const settingsRes = await pool.query(
            "SELECT canvas_size, cooldown, grid_enabled, bg_color FROM settings WHERE id = 1",
        );
        if (settingsRes.rows.length > 0) {
            currentSettings = settingsRes.rows[0];
        }
        console.log("Настройки загружены:", currentSettings);
    } catch (err) {
        console.error("ОШИБКА ПРИ СТАРТЕ СЕРВЕРА:", err);
    }
}
initServer();

io.on("connection", async (socket) => {
    console.log(`[+] Пользователь подключился: ${socket.id}`);

    try {
        const pixelsRes = await pool.query("SELECT x, y, color, user_id FROM pixels");
        socket.emit("init_data", {
            pixels: pixelsRes.rows,
            settings: currentSettings, 
        });
    } catch (err) {
        console.error("Ошибка при инициализации данных:", err);
    }

    let isAdmin = false;

    socket.on("admin_auth", (password, callback) => {
        try {
            const ip = socket.handshake.address;
            const attempt = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };

            if (Date.now() < attempt.lockUntil) {
                const waitSec = Math.ceil((attempt.lockUntil - Date.now()) / 1000);
                return callback({ success: false, message: `Заблокировано. Ждите ${waitSec} сек.` });
            }

            if (password === ADMIN_PASSWORD) {
                isAdmin = true;
                loginAttempts.delete(ip); 
                return callback({ success: true });
            } else {
                attempt.count += 1;
                if (attempt.count >= MAX_ATTEMPTS) attempt.lockUntil = Date.now() + LOCK_TIME_MS;
                loginAttempts.set(ip, attempt);
                return callback({ success: false, message: `Неверный пароль. Осталось попыток: ${MAX_ATTEMPTS - attempt.count}` });
            }
        } catch (err) {
            console.error("Ошибка admin_auth:", err);
            if (typeof callback === 'function') callback({ success: false, message: "Внутренняя ошибка сервера" });
        }
    });

    socket.on("set_pixel", async (data) => {
        try {
            if (!data) return;
            const { x, y, color, userId } = data;

            if (!userId || typeof x !== "number" || typeof y !== "number" || typeof color !== "string") return;

            if (x < 0 || x >= currentSettings.canvas_size || y < 0 || y >= currentSettings.canvas_size) return;

            const now = Date.now();
            const lastPlaced = userCooldowns.get(userId) || 0;
            const cooldownMs = currentSettings.cooldown * 1000;

            if (!isAdmin && now - lastPlaced < cooldownMs - 100) return;

            if (!isAdmin) userCooldowns.set(userId, now);

            await pool.query(
                `INSERT INTO pixels (x, y, color, user_id) 
                 VALUES ($1, $2, $3, $4) 
                 ON CONFLICT (x, y) 
                 DO UPDATE SET color = EXCLUDED.color, user_id = EXCLUDED.user_id, updated_at = CURRENT_TIMESTAMP`,
                [x, y, color, userId],
            );
            io.emit("pixel_update", { x, y, color, userId });
        } catch (err) {
            console.error("ОШИБКА set_pixel:", err);
        }
    });

    socket.on("clear_canvas", async () => {
        if (!isAdmin) return;
        try {
            await pool.query("DELETE FROM pixels");
            userCooldowns.clear(); 
            io.emit("canvas_cleared");
        } catch (err) {
            console.error("Ошибка очистки холста:", err);
        }
    });

    socket.on("update_settings", async (newSettings) => {
        if (!isAdmin || !newSettings) return;
        try {
            await pool.query(
                `UPDATE settings SET canvas_size = $1, cooldown = $2, grid_enabled = $3, bg_color = $4 WHERE id = 1`,
                [
                    newSettings.canvas_size || 50,
                    newSettings.cooldown || 2,
                    newSettings.grid_enabled !== undefined ? newSettings.grid_enabled : true,
                    newSettings.bg_color || '#1f2937',
                ],
            );
            currentSettings = { ...currentSettings, ...newSettings };
            io.emit("settings_updated", currentSettings);
        } catch (err) {
            console.error("Ошибка обновления настроек:", err);
        }
    });

    socket.on("export_database", async (callback) => {
        if (!isAdmin) return;
        try {
            const pixelsRes = await pool.query("SELECT x, y, color, user_id FROM pixels");
            if (typeof callback === 'function') callback({ success: true, pixels: pixelsRes.rows, settings: currentSettings });
        } catch (err) {
            console.error("Export error:", err);
            if (typeof callback === 'function') callback({ success: false, message: "Ошибка экспорта" });
        }
    });

    socket.on("import_database", async (data, callback) => {
        if (!isAdmin || !data) return;
        try {
            const { pixels, settings } = data;
            await pool.query("BEGIN");
            await pool.query("DELETE FROM pixels");
            if (pixels && pixels.length > 0) {
                for (let i = 0; i < pixels.length; i += 1000) {
                    const chunk = pixels.slice(i, i + 1000);
                    const values = [];
                    const params = [];
                    chunk.forEach((p, index) => {
                        const offset = index * 4;
                        params.push(p.x, p.y, p.color, p.user_id || 'imported');
                        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
                    });
                    await pool.query(`INSERT INTO pixels (x, y, color, user_id) VALUES ${values.join(", ")}`, params);
                }
            }
            if (settings) {
                await pool.query(
                    `UPDATE settings SET canvas_size = $1, cooldown = $2, grid_enabled = $3, bg_color = $4 WHERE id = 1`,
                    [
                        settings.canvas_size || 50, 
                        settings.cooldown || 2, 
                        settings.grid_enabled !== undefined ? settings.grid_enabled : true, 
                        settings.bg_color || '#1f2937'
                    ]
                );
                currentSettings = { ...currentSettings, ...settings };
            }
            await pool.query("COMMIT");
            const updatedPixels = await pool.query("SELECT x, y, color, user_id FROM pixels");
            io.emit("init_data", { pixels: updatedPixels.rows, settings: currentSettings });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            await pool.query("ROLLBACK");
            console.error("Import error:", err);
            if (typeof callback === 'function') callback({ success: false, message: "Ошибка импорта: " + err.message });
        }
    });

    socket.on("disconnect", () => {
        console.log(`[-] Пользователь отключился: ${socket.id}`);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Бэкенд сервер запущен на порту ${PORT}`);
});
