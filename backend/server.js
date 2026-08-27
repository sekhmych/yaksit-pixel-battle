const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const path = require("path");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const passport = require("passport");
const LocalStrategy = require("passport-local").Strategy;
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const csrf = require("csurf");
const fs = require("fs");
const Tokens = require('csrf');
const Jimp = require('jimp');
const archiver = require('archiver');
const bcrypt = require('bcryptjs');
const { loadConfig } = require("./lib/config");
const {
    isValidColor,
    isValidCoordinate,
    normalizeSettings,
    normalizeImportPayload,
    normalizeRollbackPayload
} = require("./lib/validation");
const { withTransaction } = require("./lib/transaction");

// === ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ОШИБОК ===
process.on('uncaughtException', (err) => {
    console.error('КРИТИЧЕСКАЯ ОШИБКА (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('НЕОБРАБОТАННОЕ ОБЕЩАНИЕ (unhandledRejection):', reason);
});

const config = loadConfig(process.env);
const app = express();
const server = http.createServer(app);

// Доверяем одному reverse proxy только в production.
app.set("trust proxy", config.isProduction ? 1 : false);

const SESSION_SECRET = config.sessionSecret;
const ADMIN_PASSWORD = config.adminPassword;
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// === MIDDLEWARE ПОДГОТОВКИ ===

// 1. Генерация nonce (для CSP)
app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString("base64");
    next();
});

// 2. Helmet (безопасные заголовки)
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "blob:", "'unsafe-eval'"], 
            "style-src": ["'self'", "'unsafe-inline'"], 
            "img-src": ["'self'", "data:", "blob:"],
            "connect-src": ["'self'", "https://pixelbattle.hamaanda.ru", "ws://pixelbattle.hamaanda.ru", "wss://pixelbattle.hamaanda.ru", "https://*.hamaanda.ru", "wss://*.hamaanda.ru"],
            "frame-ancestors": ["'none'"],
        }
    },
    crossOriginEmbedderPolicy: false,
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// 3. Базовые парсеры
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser(SESSION_SECRET));

// 4. Подключение к БД
const pool = new Pool({
    ...config.database,
    connectionTimeoutMillis: 5000
});

console.log(`>>> Параметры БД: host=${config.database.host}, user=${config.database.user}, db=${config.database.database} <<<`);

// 5. Сессии
const sessionMiddleware = session({
    store: new pgSession({ pool, tableName: 'session' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: config.isProduction,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProduction
    }
});
app.use(sessionMiddleware);

// 6. Passport
function timingSafeEqualStr(a, b) {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

passport.use(new LocalStrategy({
    usernameField: 'username',
    passwordField: 'password'
}, async (username, password, done) => {
    // Мастер-админ
    if (username === 'admin' && timingSafeEqualStr(password, ADMIN_PASSWORD)) {
        return done(null, { id: 'admin', role: 'admin' });
    }
    // Модераторы
    try {
        const res = await pool.query("SELECT * FROM moderators WHERE username = $1", [username]);
        if (res.rows.length > 0) {
            const mod = res.rows[0];
            let match = false;
            try { match = await bcrypt.compare(password, mod.password); } catch (e) { match = false; }
            if (match) {
                return done(null, { id: mod.username, role: 'moderator' });
            }
        }
    } catch (err) { return done(err); }

    return done(null, false, { message: 'Неверный логин или пароль' });
}));

// Rate-limit брутфорса логина (по IP)
const loginAttempts = new Map();
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
function loginRateLimit(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    const entry = loginAttempts.get(key) || { count: 0, startTime: now };
    if (now - entry.startTime > LOGIN_WINDOW_MS) { entry.count = 0; entry.startTime = now; }
    entry.count++;
    loginAttempts.set(key, entry);
    if (entry.count > LOGIN_LIMIT) {
        return res.status(429).send("Слишком много попыток входа. Попробуйте позже.");
    }
    next();
}

passport.serializeUser((user, done) => done(null, JSON.stringify(user)));
passport.deserializeUser((data, done) => {
    try {
        // Проверяем, является ли data JSON-строкой (новый формат)
        if (data && (data.startsWith('{') || data.startsWith('['))) {
            return done(null, JSON.parse(data));
        }
        // Если это просто строка 'admin' (старый формат)
        if (data === 'admin') {
            return done(null, { id: 'admin', role: 'admin' });
        }
        done(null, false);
    } catch (err) {
        done(null, false);
    }
});

app.use(passport.initialize());
app.use(passport.session());

// 7. CSRF
const csrfProtection = csrf({ cookie: false });

// 8. Утилитарные middleware
const noCache = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
};

// Обработчик CSRF ошибок
app.use((err, req, res, next) => {
    if (err.code !== 'EBADCSRFTOKEN') return next(err);
    res.status(403).send('Ошибка безопасности: CSRF-токен невалиден. Пожалуйста, обновите страницу.');
});

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

async function takeSnapshot() {
    try {
        const size = currentSettings.canvas_size;
        // Создаем изображение с фоновым цветом
        const image = new Jimp(size, size, currentSettings.bg_color || '#1f2937');

        // Получаем все пиксели
        const res = await pool.query("SELECT x, y, color FROM pixels");
        res.rows.forEach(p => {
            try {
                // Преобразуем HEX в числовой формат Jimp и ставим пиксель
                const hexColor = Jimp.cssColorToHex(p.color);
                image.setPixelColor(hexColor, p.x, p.y);
            } catch (e) { /* Игнорируем битые цвета */ }
        });

        const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
        await pool.query("INSERT INTO snapshots (data) VALUES ($1)", [buffer]);
        console.log(`[Snapshot] Снимок холста сохранен (${size}x${size}) через Jimp`);
    } catch (err) { console.error("Snapshot error:", err); }
}

// Фоновые задачи
setInterval(takeSnapshot, 10 * 60 * 1000); // Снимок каждые 10 минут
setInterval(async () => {
    try {
        await pool.query("DELETE FROM pixel_history WHERE created_at < NOW() - INTERVAL '48 hours'");
        console.log("[Cleanup] Старая история удалена");
    } catch (err) { console.error("Cleanup error:", err); }
}, 60 * 60 * 1000); // Очистка каждый час

function sendHtmlWithContext(res, filePath, csrfToken = null) {
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return res.status(500).send("Server Error");
        let processedHtml = data.replace(/<script/g, `<script nonce="${res.locals.nonce}"`);
        if (csrfToken) {
            processedHtml = processedHtml.replace('</head>', `<meta name="csrf-token" content="${csrfToken}">\n</head>`);
            processedHtml = processedHtml.replace(/<form([^>]+)>/g, `<form$1>\n<input type="hidden" name="_csrf" value="${csrfToken}">`);
        }
        res.send(processedHtml);
    });
}

const tokens = new Tokens();
function verifyAdminCsrf(socket, payload) {
    if (!socket.isAdmin) return false;
    if (!payload || !payload.auth || !payload.auth.csrfToken) return false;
    const secret = socket.request.session && socket.request.session.csrfSecret;
    if (!secret) return false;
    return tokens.verify(secret, payload.auth.csrfToken);
}

async function logAdminAction(action, details) {
    try {
        await pool.query("INSERT INTO admin_logs (action, details) VALUES ($1, $2)", [action, JSON.stringify(details)]);
        io.to("admins").emit("admin_log_entry", { action, details, created_at: new Date().toISOString() });
    } catch (err) { console.error("Log error:", err); }
}

// === МАРШРУТЫ ===

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", time: new Date().toISOString(), port: process.env.PORT || 8080 });
});

app.get("/admin/download-timelapse", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== 'admin') {
        return res.status(403).send("Access Denied");
    }

    try {
        const snapshotsRes = await pool.query("SELECT data, created_at FROM snapshots ORDER BY created_at ASC");
        
        if (snapshotsRes.rows.length === 0) {
            return res.status(404).send("No snapshots found");
        }

        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment(`pixel-battle-timelapse-${new Date().toISOString().split('T')[0]}.zip`);
        archive.pipe(res);

        snapshotsRes.rows.forEach((row, index) => {
            const time = new Date(row.created_at).toISOString().replace(/[:.]/g, '-');
            archive.append(row.data, { name: `snapshot_${time}_${index}.png` });
        });

        await archive.finalize();
        await logAdminAction("DOWNLOAD_TIMELAPSE", { user: req.user.id });
    } catch (err) {
        console.error("Zip error:", err);
        res.status(500).send("Error creating archive");
    }
});

app.get("/admin/login", csrfProtection, (req, res) => {
    if (req.isAuthenticated()) return res.redirect("/admin");
    sendHtmlWithContext(res, path.join(__dirname, "public", "login.html"), req.csrfToken());
});

app.post("/admin/login", loginRateLimit, csrfProtection, passport.authenticate("local", {
    successRedirect: "/admin",
    failureRedirect: "/admin/login"
}));

app.get("/admin/logout", (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect("/");
    });
});

app.get("/admin", csrfProtection, noCache, (req, res) => {
    if (!req.isAuthenticated()) return res.redirect("/admin/login");
    sendHtmlWithContext(res, path.join(__dirname, "public", "admin.html"), req.csrfToken());
});

app.get("/", (req, res) => {
    let userId = req.signedCookies.uid;
    if (!userId) {
        userId = "u_" + crypto.randomBytes(8).toString("hex");
        res.cookie("uid", userId, { 
            signed: true, 
            maxAge: 365 * 24 * 60 * 60 * 1000, 
            httpOnly: true,
            sameSite: 'lax',
            secure: config.isProduction
        });
    }
    sendHtmlWithContext(res, path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public"), { index: false }));

// === SOCKET.IO ===

const io = new Server(server, {
    cors: { origin: config.allowedOrigins, methods: ["GET", "POST"], credentials: true },
    pingTimeout: 30000,
    pingInterval: 10000
});

const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));
io.use(wrap(passport.initialize()));
io.use(wrap(passport.session()));

io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) return next(new Error("Auth error"));
    const parser = cookieParser(SESSION_SECRET);
    const req = { headers: { cookie: cookieHeader } };
    parser(req, {}, () => {
        const userId = req.signedCookies.uid;
        if (!userId) return next(new Error("Invalid ID"));
        socket.userId = userId;
        // Роли
        socket.isAdmin = !!(socket.request.user && socket.request.user.role === 'admin');
        socket.isModerator = !!(socket.request.user && socket.request.user.role === 'moderator');
        socket.canEditCanvas = socket.isAdmin || socket.isModerator;
        next();
    });
});

let currentSettings = { canvas_size: 50, cooldown: 2, grid_enabled: true, bg_color: "#1f2937" };
const userCooldowns = new Map();
const messageRates = new Map();
const MSG_LIMIT = 100; 
const MSG_WINDOW_MS = 1000; 
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

io.on("connection", async (socket) => {
    socket.use(([event, ...args], next) => {
        if (socket.isAdmin) return next();
        const now = Date.now();
        const rate = messageRates.get(socket.id) || { count: 0, startTime: now };
        if (now - rate.startTime > MSG_WINDOW_MS) { rate.count = 1; rate.startTime = now; } else { rate.count++; }
        messageRates.set(socket.id, rate);
        if (rate.count > MSG_LIMIT) return;
        next();
    });

    const userId = socket.userId;
    const isAdmin = socket.isAdmin;
    if (isAdmin) socket.join("admins");
    
    socket.on("disconnect", () => messageRates.delete(socket.id));

    try {
        const pixelsRes = await pool.query("SELECT x, y, color, user_id FROM pixels");
        const initPayload = { 
            pixels: pixelsRes.rows, 
            settings: currentSettings, 
            userId: userId,
            role: socket.request.user ? socket.request.user.role : 'user'
        };
        if (socket.canEditCanvas) {
            const logsRes = await pool.query("SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100");
            initPayload.adminLogs = logsRes.rows;
        }
        socket.emit("init_data", initPayload);
        const lastPlaced = userCooldowns.get(userId) || 0;
        const cooldownMs = currentSettings.cooldown * 1000;
        const remainingCooldownMs = Math.max(0, cooldownMs - (Date.now() - lastPlaced));
        socket.emit("user_status", { remainingCooldownMs });
    } catch (err) { console.error(err); }

    socket.on("set_pixel", async (data) => {
        try {
            if (!data) return;
            const { x, y, color } = data;
            if (
                !isValidCoordinate(x, currentSettings.canvas_size) ||
                !isValidCoordinate(y, currentSettings.canvas_size) ||
                !isValidColor(color)
            ) return;
            const now = Date.now();
            const lastPlaced = userCooldowns.get(userId) || 0;
            const cooldownMs = currentSettings.cooldown * 1000;
            if (!socket.canEditCanvas && now - lastPlaced < cooldownMs - 100) return;
            if (!socket.canEditCanvas) {
                userCooldowns.set(userId, now);
                await pool.query("INSERT INTO users (user_id, last_placed_at) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET last_placed_at = EXCLUDED.last_placed_at", [userId, now]);
            }
            await pool.query(`INSERT INTO pixels (x, y, color, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT (x, y) DO UPDATE SET color = EXCLUDED.color, user_id = EXCLUDED.user_id, updated_at = CURRENT_TIMESTAMP`, [x, y, color, userId]);
            
            // Запись в историю для откатов
            await pool.query(`INSERT INTO pixel_history (x, y, color, user_id) VALUES ($1, $2, $3, $4)`, [x, y, color, userId]);

            io.emit("pixel_update", { x, y, color, userId });
            if (socket.canEditCanvas) {
                await logAdminAction("SET_PIXEL", { user: userId, x, y, color, role: socket.isAdmin ? 'admin' : 'moderator' });
            }
        } catch (err) { console.error(err); }
    });

    socket.on("delete_pixel", async (payload) => {
        if (!socket.canEditCanvas) return;
        const data = payload && payload.data ? payload.data : payload;
        const { x, y } = data;
        if (
            !isValidCoordinate(x, currentSettings.canvas_size) ||
            !isValidCoordinate(y, currentSettings.canvas_size)
        ) return;
        try {
            await pool.query("DELETE FROM pixels WHERE x = $1 AND y = $2", [x, y]);
            await logAdminAction("DELETE_PIXEL", { user: userId, x, y, role: socket.isAdmin ? 'admin' : 'moderator' });
            io.emit("pixel_deleted", { x, y });
        } catch (err) { console.error(err); }
    });

    // === УПРАВЛЕНИЕ МОДЕРАТОРАМИ ===

    socket.on("list_moderators", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        try {
            const res = await pool.query("SELECT username, created_at FROM moderators ORDER BY created_at DESC");
            if (typeof callback === 'function') callback({ success: true, moderators: res.rows });
        } catch (err) { if (typeof callback === 'function') callback({ success: false }); }
    });

    socket.on("create_moderator", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const { username, password } = payload.data;
        if (
            typeof username !== "string" ||
            username.length < 3 ||
            username.length > 50 ||
            typeof password !== "string" ||
            password.length < 8 ||
            password.length > 72
        ) return callback && callback({ success: false, error: "Invalid moderator credentials" });
        try {
            const hash = await bcrypt.hash(password, 12);
            await pool.query("INSERT INTO moderators (username, password) VALUES ($1, $2)", [username, hash]);
            await logAdminAction("CREATE_MODERATOR", { admin: userId, moderator: username });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ success: false, error: "Username already exists" }); }
    });

    socket.on("delete_moderator", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const { username } = payload.data;
        try {
            await pool.query("DELETE FROM moderators WHERE username = $1", [username]);
            await logAdminAction("DELETE_MODERATOR", { admin: userId, moderator: username });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ success: false }); }
    });

    socket.on("update_moderator_password", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const { username, newPassword } = payload.data;
        if (
            typeof username !== "string" ||
            username.length < 3 ||
            username.length > 50 ||
            typeof newPassword !== "string" ||
            newPassword.length < 8 ||
            newPassword.length > 72
        ) return callback && callback({ success: false, error: "Invalid moderator credentials" });
        try {
            const hash = await bcrypt.hash(newPassword, 12);
            await pool.query("UPDATE moderators SET password = $1 WHERE username = $2", [hash, username]);
            await logAdminAction("UPDATE_MOD_PASSWORD", { admin: userId, moderator: username });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ success: false }); }
    });

    socket.on("create_manual_snapshot", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        try {
            await takeSnapshot();
            await logAdminAction("MANUAL_SNAPSHOT", { user: userId });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ success: false }); }
    });

    socket.on("clear_canvas", async (payload) => {
        if (!verifyAdminCsrf(socket, payload)) return;
        try {
            await pool.query("DELETE FROM pixels");
            await logAdminAction("CLEAR_CANVAS", { user: userId });
            io.emit("canvas_cleared");
        } catch (err) { console.error(err); }
    });

    socket.on("update_settings", async (payload) => {
        if (!verifyAdminCsrf(socket, payload) || !payload.data) return;
        const validated = normalizeSettings(payload.data, currentSettings);
        if (!validated) return;
        try {
            await pool.query(`UPDATE settings SET canvas_size = $1, cooldown = $2, grid_enabled = $3, bg_color = $4 WHERE id = 1`, [validated.canvas_size, validated.cooldown, validated.grid_enabled, validated.bg_color]);
            currentSettings = validated;
            await logAdminAction("UPDATE_SETTINGS", { user: userId, settings: validated });
            io.emit("settings_updated", currentSettings);
        } catch (err) { console.error(err); }
    });

    socket.on("export_database", async (payload, callback) => {
        if (!verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        try {
            const pixelsRes = await pool.query("SELECT x, y, color, user_id FROM pixels");
            await logAdminAction("EXPORT_DB", { user: userId });
            if (typeof callback === 'function') callback({ success: true, pixels: pixelsRes.rows, settings: currentSettings });
        } catch (err) { if (typeof callback === 'function') callback({ success: false }); }
    });

    socket.on("import_database", async (payload, callback) => {
        if (!verifyAdminCsrf(socket, payload) || !payload.data) return callback && callback({ success: false });

        const normalized = normalizeImportPayload(payload.data, currentSettings);
        if (!normalized.ok) {
            return callback && callback({ success: false, error: normalized.error });
        }

        const { pixels, settings } = normalized.value;
        try {
            await withTransaction(pool, async (client) => {
                await client.query("DELETE FROM pixels");

                for (let i = 0; i < pixels.length; i += 1000) {
                    const chunk = pixels.slice(i, i + 1000);
                    const values = chunk.map((p, index) => `(${index * 4 + 1}, ${index * 4 + 2}, ${index * 4 + 3}, ${index * 4 + 4})`).join(", ");
                    const params = [];
                    chunk.forEach(p => params.push(p.x, p.y, p.color, p.user_id));
                    await client.query(`INSERT INTO pixels (x, y, color, user_id) VALUES ${values}`, params);
                }

                await client.query(
                    "UPDATE settings SET canvas_size = $1, cooldown = $2, grid_enabled = $3, bg_color = $4 WHERE id = 1",
                    [settings.canvas_size, settings.cooldown, settings.grid_enabled, settings.bg_color]
                );
            });

            currentSettings = settings;
            await logAdminAction("IMPORT_DB", { user: userId, pixelCount: pixels.length });
            const updatedPixels = await pool.query("SELECT x, y, color, user_id FROM pixels");
            io.emit("init_data", { pixels: updatedPixels.rows, settings: currentSettings });
            if (typeof callback === "function") callback({ success: true });
        } catch (err) {
            console.error("Import error:", err);
            if (typeof callback === "function") callback({ success: false });
        }
    });

    socket.on("rollback_area", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });

        const rollback = normalizeRollbackPayload(payload.data, currentSettings.canvas_size);
        if (!rollback) {
            return callback && callback({ success: false, error: "Invalid rollback parameters" });
        }

        try {
            const restoredPixels = await withTransaction(pool, async (client) => {
                const targetTime = new Date(Date.now() - rollback.timeAgoMinutes * 60 * 1000);
                const res = await client.query(`
                    SELECT DISTINCT ON (x, y) x, y, color, user_id
                    FROM pixel_history
                    WHERE x >= $1 AND x <= $2 AND y >= $3 AND y <= $4 AND created_at <= $5
                    ORDER BY x, y, created_at DESC
                `, [rollback.x1, rollback.x2, rollback.y1, rollback.y2, targetTime]);

                await client.query(
                    "DELETE FROM pixels WHERE x >= $1 AND x <= $2 AND y >= $3 AND y <= $4",
                    [rollback.x1, rollback.x2, rollback.y1, rollback.y2]
                );

                for (let i = 0; i < res.rows.length; i += 1000) {
                    const chunk = res.rows.slice(i, i + 1000);
                    const values = chunk.map((p, index) => `(${index * 4 + 1}, ${index * 4 + 2}, ${index * 4 + 3}, ${index * 4 + 4})`).join(", ");
                    const params = [];
                    chunk.forEach(p => params.push(p.x, p.y, p.color, p.user_id));
                    await client.query(`INSERT INTO pixels (x, y, color, user_id) VALUES ${values}`, params);
                }

                return res.rows.length;
            });

            await logAdminAction("ROLLBACK_AREA", { user: userId, ...rollback });
            const updatedPixels = await pool.query("SELECT x, y, color, user_id FROM pixels");
            io.emit("init_data", { pixels: updatedPixels.rows, settings: currentSettings });
            if (typeof callback === "function") callback({ success: true, count: restoredPixels });
        } catch (err) {
            console.error("Rollback error:", err);
            if (typeof callback === "function") callback({ success: false });
        }
    });
});

// === ЗАПУСК ===

async function initDatabase() {
    let client;
    let connected = false;
    let attempts = 0;
    while (!connected) {
        try {
            attempts++;
            client = await pool.connect();
            connected = true;
            console.log(`[${attempts}] БД подключена.`);
        } catch (err) {
            console.log(`[${attempts}] Ожидание БД... (${err.message})`);
            if (attempts > 30) {
                console.error("Не удалось подключиться к БД после 30 попыток.");
                process.exit(1);
            }
            await sleep(2000);
        }
    }

    try {
        console.log("Проверка и инициализация таблиц...");
        
        // 1. Сессии
        await client.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                "sid" varchar NOT NULL COLLATE "default",
                "sess" json NOT NULL,
                "expire" timestamp(6) NOT NULL
            ) WITH (OIDS=FALSE);
        `);
        const pkExists = await client.query(`
            SELECT 1 FROM information_schema.table_constraints 
            WHERE table_name='session' AND constraint_type='PRIMARY KEY'
        `);
        if (pkExists.rowCount === 0) {
            await client.query('ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE');
        }
        await client.query('CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")');

        // 2. Основные таблицы игры
        await client.query(`
            CREATE TABLE IF NOT EXISTS pixels (
                x INT, 
                y INT, 
                color VARCHAR(10) NOT NULL, 
                user_id VARCHAR(50) NOT NULL, 
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
                PRIMARY KEY (x, y)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INT PRIMARY KEY, 
                canvas_size INT NOT NULL, 
                cooldown INT NOT NULL, 
                grid_enabled BOOLEAN NOT NULL, 
                bg_color VARCHAR(10) DEFAULT '#1f2937'
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id VARCHAR(50) PRIMARY KEY, 
                last_placed_at BIGINT NOT NULL
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS moderators (
                username VARCHAR(50) PRIMARY KEY, 
                password VARCHAR(100) NOT NULL, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_logs (
                id SERIAL PRIMARY KEY, 
                action VARCHAR(100) NOT NULL, 
                details JSONB, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Одноразовая совместимая миграция старых plaintext-паролей модераторов.
        const moderatorsRes = await client.query("SELECT username, password FROM moderators");
        for (const moderator of moderatorsRes.rows) {
            if (!BCRYPT_HASH_RE.test(moderator.password)) {
                const hash = await bcrypt.hash(moderator.password, 12);
                await client.query("UPDATE moderators SET password = $1 WHERE username = $2", [hash, moderator.username]);
            }
        }

        // 3. История и Таймлапс
        await client.query(`
            CREATE TABLE IF NOT EXISTS pixel_history (
                id SERIAL PRIMARY KEY, 
                x INTEGER NOT NULL, 
                y INTEGER NOT NULL, 
                color VARCHAR(50) NOT NULL, 
                user_id VARCHAR(50) NOT NULL, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_pixel_history_time ON pixel_history(created_at)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_pixel_history_coords ON pixel_history(x, y)');

        await client.query(`
            CREATE TABLE IF NOT EXISTS snapshots (
                id SERIAL PRIMARY KEY, 
                data BYTEA NOT NULL, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 4. Начальные настройки
        await client.query(`
            INSERT INTO settings (id, canvas_size, cooldown, grid_enabled, bg_color) 
            VALUES (1, 50, 2, true, '#1f2937') 
            ON CONFLICT (id) DO NOTHING
        `);

        // Загрузка данных в память
        const settingsRes = await client.query("SELECT * FROM settings WHERE id = 1");
        if (settingsRes.rows.length > 0) currentSettings = settingsRes.rows[0];

        const usersRes = await client.query("SELECT user_id, last_placed_at FROM users");
        usersRes.rows.forEach(u => userCooldowns.set(u.user_id, parseInt(u.last_placed_at)));

        console.log("Инициализация БД успешно завершена.");
    } catch (err) {
        console.error("Ошибка при инициализации БД:", err);
        process.exit(1);
    } finally {
        if (client) client.release();
    }
}

async function startServer() {
    await initDatabase();
    const PORT = config.port;
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`>>> Сервер запущен! <<<`);
        console.log(`>>> Слушает на: 0.0.0.0:${PORT} <<<`);
    });
}
startServer();
