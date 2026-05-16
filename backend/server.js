const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

app.use(express.static(path.join(__dirname, "public")));

// === ГЛОБАЛЬНОЕ СОСТОЯНИЕ (Кэш) ===
// Кэшируем настройки в памяти, чтобы не делать SELECT из базы на каждый клик
let currentSettings = { canvas_size: 50, cooldown: 2, grid_enabled: true, bg_color: '#1f2937' };

// ... (existing code)

// Загружаем настройки из БД при старте сервера
async function initServer() {
    try {
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
        console.error("Ошибка загрузки настроек из БД:", err);
    }
}
initServer();

io.on("connection", async (socket) => {
    console.log(`[+] Пользователь подключился: ${socket.id}`);

    try {
        const pixelsRes = await pool.query(
            "SELECT x, y, color, user_id FROM pixels",
        );
        socket.emit("init_data", {
            pixels: pixelsRes.rows,
            settings: currentSettings, // Отправляем закэшированные настройки
        });
    } catch (err) {
        console.error("Ошибка при инициализации данных:", err);
    }

    // Флаг авторизации для текущего сокета
    let isAdmin = false;

    // Авторизация админа
    socket.on("admin_auth", (password, callback) => {
        const ip = socket.handshake.address;
        const attempt = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };

        if (Date.now() < attempt.lockUntil) {
            const waitSec = Math.ceil((attempt.lockUntil - Date.now()) / 1000);
            return callback({
                success: false,
                message: `Заблокировано. Ждите ${waitSec} сек.`,
            });
        }

        if (password === ADMIN_PASSWORD) {
            isAdmin = true;
            loginAttempts.delete(ip); // Сбрасываем счетчик при успехе
            return callback({ success: true });
        } else {
            attempt.count += 1;
            if (attempt.count >= MAX_ATTEMPTS) {
                attempt.lockUntil = Date.now() + LOCK_TIME_MS;
            }
            loginAttempts.set(ip, attempt);
            return callback({
                success: false,
                message: `Неверный пароль. Осталось попыток: ${MAX_ATTEMPTS - attempt.count}`,
            });
        }
    });

    // ОБРАБОТКА УСТАНОВКИ ПИКСЕЛЯ С ЗАЩИТОЙ
    socket.on("set_pixel", async (data) => {
        const { x, y, color, userId } = data;

        // 1. Валидация входных данных (защита от XSS/инъекций и мусора)
        if (
            !userId ||
            typeof x !== "number" ||
            typeof y !== "number" ||
            typeof color !== "string"
        ) {
            return;
        }

        // 2. Защита границ холста (OOB Error prevention)
        if (
            x < 0 ||
            x >= currentSettings.canvas_size ||
            y < 0 ||
            y >= currentSettings.canvas_size
        ) {
            return; // Игнорируем пиксели вне холста
        }

        // 3. БЭКЕНД-ЗАЩИТА ОТ ТРОТТЛИНГА (Cooldown Check)
        const now = Date.now();
        const lastPlaced = userCooldowns.get(userId) || 0;
        const cooldownMs = currentSettings.cooldown * 1000;

        // Даем небольшую поблажку в 100мс на случай рассинхрона пинга, админ игнорирует кулдаун
        if (!isAdmin && now - lastPlaced < cooldownMs - 100) {
            return;
        }

        // Запоминаем время успешной установки
        if (!isAdmin) {
            userCooldowns.set(userId, now);
        }

        // 4. Сохранение в БД и рассылка
        try {
            await pool.query(
                `INSERT INTO pixels (x, y, color, user_id) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (x, y) 
         DO UPDATE SET color = EXCLUDED.color, user_id = EXCLUDED.user_id, updated_at = CURRENT_TIMESTAMP`,
                [x, y, color, userId],
            );
            io.emit("pixel_update", { x, y, color, userId });
        } catch (err) {
            console.error("Ошибка записи пикселя:", err);
        }
    });

    socket.on("clear_canvas", async () => {
        // Проверка прав админа
        if (!isAdmin) {
            console.log(
                `[Security] Попытка очистки холста без прав. IP: ${socket.handshake.address}`,
            );
            return;
        }
        try {
            await pool.query("DELETE FROM pixels");
            userCooldowns.clear(); // Очищаем историю кулдаунов при рестарте
            io.emit("canvas_cleared");
        } catch (err) {
            console.error("Ошибка очистки холста:", err);
        }
    });

    socket.on("update_settings", async (newSettings) => {
        // Проверка прав админа
        if (!isAdmin) {
            console.log(
                `[Security] Попытка изменения настроек без прав. IP: ${socket.handshake.address}`,
            );
            return;
        }
        try {
            await pool.query(
                `UPDATE settings SET canvas_size = $1, cooldown = $2, grid_enabled = $3, bg_color = $4 WHERE id = 1`,
                [
                    newSettings.canvas_size,
                    newSettings.cooldown,
                    newSettings.grid_enabled,
                    newSettings.bg_color,
                ],
            );

            // Обновляем кэш в памяти
            currentSettings = newSettings;

            io.emit("settings_updated", newSettings);
        } catch (err) {
            console.error("Ошибка обновления настроек:", err);
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
