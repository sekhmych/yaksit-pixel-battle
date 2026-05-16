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

// === ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ОШИБОК ===
process.on('uncaughtException', (err) => {
    console.error('КРИТИЧЕСКАЯ ОШИБКА (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('НЕОБРАБОТАННОЕ ОБЕЩАНИЕ (unhandledRejection):', reason);
});

const app = express();
const server = http.createServer(app);

// Доверяем прокси (Nginx)
app.set('trust proxy', 1);

const SESSION_SECRET = process.env.SESSION_SECRET || "default_secret_dont_use_in_prod";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

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
            "script-src": ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "blob:"], 
            "style-src": ["'self'", "'unsafe-inline'"], 
            "img-src": ["'self'", "data:", "blob:"],
            "connect-src": ["'self'", "https://pixelbattle.hamaanda.ru", "ws://pixelbattle.hamaanda.ru", "wss://pixelbattle.hamaanda.ru"],
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
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// 5. Сессии
const sessionMiddleware = session({
    store: new pgSession({ pool, tableName: 'session' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 30 * 24 * 60 * 60 * 1000, 
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
});
app.use(sessionMiddleware);

// 6. Passport
passport.use(new LocalStrategy({
    usernameField: 'password', 
    passwordField: 'password'
}, (username, password, done) => {
    if (password === ADMIN_PASSWORD) return done(null, { id: 'admin', role: 'admin' });
    return done(null, false, { message: 'Неверный пароль' });
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    if (id === 'admin') return done(null, { id: 'admin', role: 'admin' });
    done(new Error("User not found"));
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

app.get("/admin/login", csrfProtection, (req, res) => {
    if (req.isAuthenticated()) return res.redirect("/admin");
    sendHtmlWithContext(res, path.join(__dirname, "public", "login.html"), req.csrfToken());
});

app.post("/admin/login", csrfProtection, passport.authenticate("local", {
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
            secure: process.env.NODE_ENV === 'production'
        });
    }
    sendHtmlWithContext(res, path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public"), { index: false }));

// === SOCKET.IO ===

const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ["*"];
const io = new Server(server, { 
    cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
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
        socket.isAdmin = !!(socket.request.user && socket.request.user.id === 'admin');
        next();
    });
});

let currentSettings = { canvas_size: 50, cooldown: 2, grid_enabled: true, bg_color: '#1f2937' };
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
        const initPayload = { pixels: pixelsRes.rows, settings: currentSettings, userId: userId };
        if (isAdmin) {
            const logsRes = await pool.query("SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100");
            initPayload.adminLogs = logsRes.rows;
        }
        socket.emit("init_data", initPayload);
        const lastPlaced = userCooldowns.get(userId) || 0;
        socket.emit("user_status", { lastPlaced });
    } catch (err) { console.error(err); }

    socket.on("set_pixel", async (data) => {
        try {
            if (!data) return;
            const { x, y, color } = data;
            if (typeof x !== "number" || typeof y !== "number" || typeof color !== "string") return;
            if (x < 0 || x >= currentSettings.canvas_size || y < 0 || y >= currentSettings.canvas_size) return;
            const now = Date.now();
            const lastPlaced = userCooldowns.get(userId) || 0;
            const cooldownMs = currentSettings.cooldown * 1000;
            if (!isAdmin && now - lastPlaced < cooldownMs - 100) return;
            if (!isAdmin) {
                userCooldowns.set(userId, now);
                await pool.query("INSERT INTO users (user_id, last_placed_at) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET last_placed_at = EXCLUDED.last_placed_at", [userId, now]);
            }
            await pool.query(`INSERT INTO pixels (x, y, color, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT (x, y) DO UPDATE SET color = EXCLUDED.color, user_id = EXCLUDED.user_id, updated_at = CURRENT_TIMESTAMP`, [x, y, color, userId]);
            io.emit("pixel_update", { x, y, color, userId });
        } catch (err) { console.error(err); }
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
        const newSettings = payload.data;
        try {
            await pool.query(`UPDATE settings SET canvas_size = $1, cooldown = $2, grid_enabled = $3, bg_color = $4 WHERE id = 1`, [newSettings.canvas_size || 50, newSettings.cooldown || 2, newSettings.grid_enabled !== undefined ? newSettings.grid_enabled : true, newSettings.bg_color || '#1f2937']);
            currentSettings = { ...currentSettings, ...newSettings };
            await logAdminAction("UPDATE_SETTINGS", { user: userId, settings: newSettings });
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
        const data = payload.data;
        try {
            const { pixels, settings } = data;
            await pool.query("BEGIN");
            await pool.query("DELETE FROM pixels");
            if (pixels && pixels.length > 0) {
                for (let i = 0; i < pixels.length; i += 1000) {
                    const chunk = pixels.slice(i, i + 1000);
                    const values = chunk.map((p, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`).join(", ");
                    const params = [];
                    chunk.forEach(p => params.push(p.x, p.y, p.color, p.user_id || 'imported'));
                    await pool.query(`INSERT INTO pixels (x, y, color, user_id) VALUES ${values}`, params);
                }
            }
            if (settings) {
                await pool.query(`UPDATE settings SET canvas_size = $1, cooldown = $2, grid_enabled = $3, bg_color = $4 WHERE id = 1`, [settings.canvas_size, settings.cooldown, settings.grid_enabled, settings.bg_color]);
                currentSettings = { ...currentSettings, ...settings };
            }
            await pool.query("COMMIT");
            await logAdminAction("IMPORT_DB", { user: userId, pixelCount: pixels ? pixels.length : 0 });
            const updatedPixels = await pool.query("SELECT x, y, color, user_id FROM pixels");
            io.emit("init_data", { pixels: updatedPixels.rows, settings: currentSettings });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { await pool.query("ROLLBACK"); if (typeof callback === 'function') callback({ success: false }); }
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
            console.log(`[${attempts}] БД готова.`);
        } catch (err) {
            if (attempts > 30) process.exit(1);
            await sleep(2000);
        }
    }
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS "session" ("sid" varchar NOT NULL COLLATE "default", "sess" json NOT NULL, "expire" timestamp(6) NOT NULL) WITH (OIDS=FALSE);`).catch(() => {});
        const pkExists = await client.query(`SELECT 1 FROM information_schema.table_constraints WHERE table_name='session' AND constraint_type='PRIMARY KEY'`);
        if (pkExists.rowCount === 0) await client.query(`ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;`).catch(() => {});
        await client.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`);
        await client.query(`CREATE TABLE IF NOT EXISTS pixels (x INT, y INT, color VARCHAR(10) NOT NULL, user_id VARCHAR(50) NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (x, y))`);
        await client.query(`CREATE TABLE IF NOT EXISTS settings (id INT PRIMARY KEY, canvas_size INT NOT NULL, cooldown INT NOT NULL, grid_enabled BOOLEAN NOT NULL, bg_color VARCHAR(10) DEFAULT '#1f2937')`);
        await client.query(`CREATE TABLE IF NOT EXISTS users (user_id VARCHAR(50) PRIMARY KEY, last_placed_at BIGINT NOT NULL)`);
        await client.query(`CREATE TABLE IF NOT EXISTS admin_logs (id SERIAL PRIMARY KEY, action VARCHAR(100) NOT NULL, details JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`INSERT INTO settings (id, canvas_size, cooldown, grid_enabled, bg_color) VALUES (1, 50, 2, true, '#1f2937') ON CONFLICT (id) DO NOTHING`);
        const settingsRes = await client.query("SELECT * FROM settings WHERE id = 1");
        if (settingsRes.rows.length > 0) currentSettings = settingsRes.rows[0];
        const usersRes = await client.query("SELECT user_id, last_placed_at FROM users");
        usersRes.rows.forEach(u => userCooldowns.set(u.user_id, parseInt(u.last_placed_at)));
    } catch (err) { console.error(err); process.exit(1); } finally { if (client) client.release(); }
}

async function startServer() {
    await initDatabase();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`>>> Server running on port ${PORT} <<<`));
}
startServer();
