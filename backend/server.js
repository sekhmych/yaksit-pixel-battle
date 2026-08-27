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
    isValidCoordinate,
    normalizeRollbackPayload
} = require("./lib/validation");
const { withTransaction } = require("./lib/transaction");
const {
    isColorInPalette,
    normalizeRoundInput,
    assertPixelAllowed,
    normalizeRoundPixelImport,
    startRoundTx,
    autoStartEligibleDraftTx,
    finishRound
} = require("./lib/rounds");
const {
    serializeBackup,
    validateBackup,
    restoreBackupTx
} = require("./lib/backup");

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

// Как часто проверять расписание раундов (автозавершение истёкшего активного
// и автозапуск подходящего черновика). Не входит в обязательную конфигурацию -
// используется только для ускорения интеграционных тестов.
const ROUND_SYNC_INTERVAL_MS = Number(process.env.ROUND_SYNC_INTERVAL_MS) > 0
    ? Number(process.env.ROUND_SYNC_INTERVAL_MS)
    : 15000;

// Максимальный размер JSON-файла полного игрового бэкапа при восстановлении
// (в байтах). Не входит в обязательную конфигурацию - есть безопасное
// значение по умолчанию. Ограничивает и HTTP body-parser, и валидацию.
const BACKUP_MAX_BYTES = Number(process.env.BACKUP_MAX_BYTES) > 0
    ? Number(process.env.BACKUP_MAX_BYTES)
    : 50 * 1024 * 1024; // 50 MB

const BACKUP_RESTORE_PATH = "/admin/backup/restore";

// Дефолтная палитра для архивного раунда, создаваемого при миграции
// старого (до системы раундов) холста, чтобы не потерять его историю.
const LEGACY_PALETTE = [
    '#000000', '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764',
    '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86'
];

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
// Эндпоинт восстановления бэкапа сам ставит себе увеличенный лимит на тело
// запроса (BACKUP_MAX_BYTES) - остальные маршруты остаются под стандартным
// лимитом body-parser'а, поэтому именно для этого пути глобальные парсеры
// пропускаются.
app.use((req, res, next) => {
    if (req.method === "POST" && req.path === BACKUP_RESTORE_PATH) return next();
    express.json()(req, res, next);
});
app.use((req, res, next) => {
    if (req.method === "POST" && req.path === BACKUP_RESTORE_PATH) return next();
    express.urlencoded({ extended: false })(req, res, next);
});
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

// === СОСТОЯНИЕ РАУНДОВ ===
//
// roundState.active   - раунд со статусом 'active' (рисование разрешено), либо null.
// roundState.view     - раунд, чей холст сейчас показывается посетителям
//                        (активный, а если такого нет - последний по времени).
// roundState.upcoming - ближайший черновик с датой начала в будущем (для статуса
//                        "скоро начнётся"), актуален только когда нет активного раунда.
let roundState = { active: null, view: null, upcoming: null };
const finishingRoundIds = new Set();
const onlineUserIds = new Map(); // socket.id -> userId, для подсчёта онлайна

// Глобальный режим обслуживания на время восстановления бэкапа.
//
// socket.use ниже отсекает НОВЫЕ Socket.IO-события с понятной ошибкой, пока
// maintenanceMode включён - это дешёвый быстрый путь, но НЕ единственная
// защита: если операция уже прошла эту проверку и начала асинхронную
// работу, одного флага недостаточно - она может закоммититься уже ПОСЛЕ
// того, как restore восстановил данные, и молча испортить их. Поэтому
// каждая функция, которая пишет в игровые таблицы (rounds/pixels/
// pixel_history/snapshots/round_archives), обязана сама войти через
// enterGameOp()/withGameOp() в самом начале своей работы (до первого
// await, синхронно) - если maintenanceMode уже включён, вход бросает
// понятную ошибку немедленно; если ещё нет - операция учитывается
// счётчиком activeGameOps, и restore перед стартом транзакции дождётся,
// пока счётчик не опустится до нуля (closeGameOpsForMaintenance).
let maintenanceMode = false;
let activeGameOps = 0;
let gameOpsDrainWaiters = [];

// Только для интеграционных тестов: искусственная задержка внутри уже
// начатой игровой операции, чтобы надёжно и без гонок с реальным временем
// проверить, что restore действительно дожидается таких операций. В
// production переменная не задаётся, поэтому задержка всегда 0 и код ведёт
// себя как раньше.
const TEST_GAME_OP_DELAY_MS = Number(process.env.TEST_GAME_OP_DELAY_MS) || 0;

const MAINTENANCE_BLOCKED_EVENTS = new Set([
    "set_pixel", "delete_pixel", "clear_canvas",
    "create_round", "update_round", "start_round", "finish_round", "delete_round",
    "export_database", "import_database", "rollback_area", "create_manual_snapshot",
    "create_moderator", "delete_moderator", "update_moderator_password"
]);

// Синхронно проверяет и регистрирует начало игровой операции. Между
// проверкой maintenanceMode и инкрементом activeGameOps нет await -
// значит нет и окна для гонки с closeGameOpsForMaintenance().
function enterGameOp() {
    if (maintenanceMode) {
        throw new Error("MAINTENANCE_MODE");
    }
    activeGameOps++;
}

function exitGameOp() {
    activeGameOps--;
    if (maintenanceMode && activeGameOps === 0) {
        const waiters = gameOpsDrainWaiters;
        gameOpsDrainWaiters = [];
        waiters.forEach(resolve => resolve());
    }
}

// Оборачивает игровую операцию: enterGameOp() перед вызовом, exitGameOp()
// гарантированно после - даже если fn бросит исключение.
async function withGameOp(fn) {
    enterGameOp();
    try {
        if (TEST_GAME_OP_DELAY_MS > 0) await sleep(TEST_GAME_OP_DELAY_MS);
        return await fn();
    } finally {
        exitGameOp();
    }
}

// Вызывается restore перед началом транзакции: синхронно закрывает вход
// для новых игровых мутаций (после этой строки enterGameOp() везде уже
// бросает MAINTENANCE_MODE), затем дожидается, пока все уже начатые
// операции не завершатся сами.
async function closeGameOpsForMaintenance() {
    maintenanceMode = true;
    if (activeGameOps === 0) return;
    await new Promise((resolve) => { gameOpsDrainWaiters.push(resolve); });
}

function reopenGameOps() {
    maintenanceMode = false;
}

function publicRound(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        activated_at: row.activated_at,
        finished_at: row.finished_at,
        canvas_size: row.canvas_size,
        cooldown: row.cooldown,
        bg_color: row.bg_color,
        grid_enabled: row.grid_enabled,
        palette: row.palette,
        pixelsPlaced: row.pixelsPlaced || 0
    };
}

function publicUpcoming(row) {
    if (!row) return null;
    return { id: row.id, name: row.name, description: row.description, starts_at: row.starts_at };
}

async function loadRoundState() {
    const activeRes = await pool.query("SELECT * FROM rounds WHERE status = 'active' LIMIT 1");
    const active = activeRes.rows[0] || null;

    let view = active;
    if (!view) {
        const latestRes = await pool.query(
            "SELECT * FROM rounds ORDER BY COALESCE(finished_at, activated_at, created_at) DESC LIMIT 1"
        );
        view = latestRes.rows[0] || null;
    }

    let upcoming = null;
    if (!active) {
        // "Скоро начнётся" имеет смысл только для черновика, чьё начало ещё
        // впереди - просроченный черновик (starts_at в прошлом) не в счёт,
        // иначе он навсегда завис бы в статусе "скоро начнётся".
        const upcomingRes = await pool.query(
            "SELECT id, name, description, starts_at FROM rounds WHERE status = 'draft' AND starts_at > NOW() ORDER BY starts_at ASC LIMIT 1"
        );
        upcoming = upcomingRes.rows[0] || null;
    }

    if (view) {
        const countRes = await pool.query("SELECT COUNT(*)::int AS c FROM pixel_history WHERE round_id = $1", [view.id]);
        view.pixelsPlaced = countRes.rows[0].c;
        if (active && active.id === view.id) active.pixelsPlaced = view.pixelsPlaced;
    }

    return { active, view, upcoming };
}

async function buildPublicInitPayload(extra = {}) {
    const view = roundState.view;
    const pixelsRes = view
        ? await pool.query("SELECT x, y, color, user_id FROM pixels WHERE round_id = $1", [view.id])
        : { rows: [] };
    return {
        pixels: pixelsRes.rows,
        round: publicRound(view),
        upcoming: publicUpcoming(roundState.upcoming),
        onlineCount: onlineUserIds.size,
        serverTime: Date.now(),
        ...extra
    };
}

function broadcastPresence() {
    io.emit("presence_update", { online: onlineUserIds.size });
}

// Рендерит PNG-превью холста раунда через уже подключённый Jimp.
// Используется и снапшотами, и финализацией раунда, и разовой миграцией.
async function renderCanvasPreview(queryable, round) {
    const size = round.canvas_size;
    const image = new Jimp(size, size, round.bg_color || '#1f2937');
    const res = await queryable.query("SELECT x, y, color FROM pixels WHERE round_id = $1", [round.id]);
    res.rows.forEach(p => {
        try {
            const hexColor = Jimp.cssColorToHex(p.color);
            image.setPixelColor(hexColor, p.x, p.y);
        } catch (e) { /* Игнорируем битые цвета */ }
    });
    return image.getBufferAsync(Jimp.MIME_PNG);
}

// Блокирует активный раунд, собирает его финальный PNG и только затем
// переводит его в finished. Это делает превью и число пикселей согласованными.
async function finishAndArchiveRound(roundId) {
    return withGameOp(() => withTransaction(pool, (client) => finishRound(client, {
        roundId,
        buildArchive: async (lockedRound, queryable) => {
            const countRes = await queryable.query(
                "SELECT COUNT(*)::int AS c FROM pixels WHERE round_id = $1",
                [lockedRound.id]
            );
            const preview = await renderCanvasPreview(queryable, lockedRound);
            return { preview, pixelCount: countRes.rows[0].c };
        }
    })));
}

// Массовая вставка пикселей одним/несколькими запросами (используется
// импортом БД и восстановлением области при откате).
async function bulkInsertPixels(client, roundId, pixels) {
    for (let i = 0; i < pixels.length; i += 1000) {
        const chunk = pixels.slice(i, i + 1000);
        const values = chunk.map((p, idx) => {
            const base = idx * 5;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        }).join(", ");
        const params = [];
        chunk.forEach(p => params.push(roundId, p.x, p.y, p.color, p.user_id));
        await client.query(`INSERT INTO pixels (round_id, x, y, color, user_id) VALUES ${values}`, params);
    }
}

// === ФОНОВЫЕ ЗАДАЧИ ===

// enterGameOp() вызывается ДО try - если maintenanceMode уже включён, исключение
// MAINTENANCE_MODE должно долететь до вызывающего (интервала/create_manual_snapshot)
// не будучи проглоченным этим же catch.
async function takeSnapshot() {
    const round = roundState.active;
    if (!round) return;
    enterGameOp();
    try {
        const buffer = await renderCanvasPreview(pool, round);
        await pool.query("INSERT INTO snapshots (round_id, data) VALUES ($1, $2)", [round.id, buffer]);
        console.log(`[Snapshot] Раунд #${round.id}: снимок холста сохранён (${round.canvas_size}x${round.canvas_size})`);
    } catch (err) {
        console.error("Snapshot error:", err);
    } finally {
        exitGameOp();
    }
}

function isMaintenanceError(err) {
    return err && err.message === "MAINTENANCE_MODE";
}

async function autoFinishExpiredRound() {
    const round = roundState.active;
    if (!round || new Date(round.ends_at).getTime() > Date.now() || finishingRoundIds.has(round.id)) return false;

    finishingRoundIds.add(round.id);
    try {
        const finished = await finishAndArchiveRound(round.id);
        await logAdminAction("AUTO_FINISH_ROUND", { roundId: finished.id, name: finished.name });
        roundState = await loadRoundState();
        io.emit("init_data", await buildPublicInitPayload());
        io.to("admins").emit("admin_rounds_changed");
        console.log("[Rounds] Раунд #" + finished.id + " автоматически завершён по истечении времени");
        return true;
    } catch (err) {
        if (!isMaintenanceError(err)) console.error("Auto-finish error:", err);
        return false;
    } finally {
        finishingRoundIds.delete(round.id);
    }
}

async function autoStartEligibleDraft() {
    // roundState могло только что обновиться внутри autoFinishExpiredRound -
    // перечитываем актуальное значение, а не полагаемся на устаревший кэш.
    if (roundState.active) return false;
    try {
        const started = await withGameOp(() => withTransaction(pool, (client) => autoStartEligibleDraftTx(client)));
        if (!started) return false;
        await logAdminAction("AUTO_START_ROUND", { roundId: started.id, name: started.name });
        roundState = await loadRoundState();
        io.emit("init_data", await buildPublicInitPayload());
        io.to("admins").emit("admin_rounds_changed");
        console.log("[Rounds] Раунд #" + started.id + " автоматически запущен по расписанию");
        return true;
    } catch (err) {
        if (!isMaintenanceError(err)) console.error("Auto-start error:", err);
        return false;
    }
}

// Единая процедура синхронизации расписания раундов: сначала завершаем
// истёкший активный раунд (если есть), затем, если активного раунда нет,
// запускаем самый ранний подходящий черновик. Порядок важен - иначе только
// что истёкший раунд мог бы на мгновение помешать запуску следующего.
async function synchronizeRounds() {
    if (maintenanceMode) return;
    await autoFinishExpiredRound();
    await autoStartEligibleDraft();
}

setInterval(() => { takeSnapshot().catch(() => { /* уже обработано внутри takeSnapshot */ }); }, 10 * 60 * 1000); // Снимок каждые 10 минут
setInterval(synchronizeRounds, ROUND_SYNC_INTERVAL_MS); // Автозавершение + автозапуск по расписанию
setInterval(async () => {
    try {
        await withGameOp(() => pool.query("DELETE FROM pixel_history WHERE created_at < NOW() - INTERVAL '48 hours'"));
        console.log("[Cleanup] Старая история удалена");
    } catch (err) {
        if (!isMaintenanceError(err)) console.error("Cleanup error:", err);
    }
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

function requireAdmin(req, res, next) {
    if (!req.isAuthenticated() || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: "Access Denied" });
    }
    next();
}

// Полный логический бэкап ИГРОВЫХ данных (раунды/пиксели/история/снимки/
// архивы) - НЕ pg_dump, НЕ сессии/модераторы/пароли/секреты. Читается из
// одного согласованного snapshot БД (REPEATABLE READ), чтобы связанные
// таблицы не оказались от разных моментов времени.
app.get("/admin/backup/export", requireAdmin, noCache, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const [rounds, pixels, pixelHistory, snapshots, roundArchives] = await Promise.all([
            client.query("SELECT * FROM rounds ORDER BY id"),
            client.query("SELECT * FROM pixels ORDER BY round_id, x, y"),
            client.query("SELECT * FROM pixel_history ORDER BY id"),
            client.query("SELECT * FROM snapshots ORDER BY id"),
            client.query("SELECT * FROM round_archives ORDER BY round_id")
        ]);
        await client.query("COMMIT");

        const backup = serializeBackup({
            rounds: rounds.rows,
            pixels: pixels.rows,
            pixelHistory: pixelHistory.rows,
            snapshots: snapshots.rows,
            roundArchives: roundArchives.rows
        });

        // Экспорт должен быть симметричен импорту: если сериализованный бэкап
        // сам не пройдёт лимит BACKUP_MAX_BYTES при восстановлении, мы не
        // должны отдавать его на скачивание - сервер бы выдал файл, который
        // сам же не смог бы восстановить.
        const json = JSON.stringify(backup);
        const byteLength = Buffer.byteLength(json, "utf8");
        if (byteLength > BACKUP_MAX_BYTES) {
            console.error(`Backup export too large: ${byteLength} bytes > BACKUP_MAX_BYTES=${BACKUP_MAX_BYTES}`);
            return res.status(413).json({
                success: false,
                error: `Бэкап (${byteLength} байт) превышает BACKUP_MAX_BYTES (${BACKUP_MAX_BYTES} байт). Увеличьте лимит через переменную окружения BACKUP_MAX_BYTES, чтобы разрешить экспорт и восстановление бэкапов такого размера.`
            });
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="yaksit-pixel-battle-game-backup-${stamp}.json"`);
        res.send(json);
        await logAdminAction("EXPORT_GAME_BACKUP", {
            user: req.user.id,
            rounds: rounds.rowCount,
            pixels: pixels.rowCount,
            pixelHistory: pixelHistory.rowCount,
            snapshots: snapshots.rowCount,
            roundArchives: roundArchives.rowCount,
            byteLength
        });
    } catch (err) {
        console.error("Backup export error:", err);
        try { await client.query("ROLLBACK"); } catch (_) { /* no-op */ }
        res.status(500).json({ success: false, error: "Server error" });
    } finally {
        client.release();
    }
});

// Восстановление игровых данных из бэкапа. Полностью заменяет rounds/
// pixels/pixel_history/snapshots/round_archives проверенным содержимым
// файла; session/moderators/users/settings/admin_logs не затрагиваются.
app.post(BACKUP_RESTORE_PATH, requireAdmin, csrfProtection, express.json({ limit: BACKUP_MAX_BYTES }), async (req, res) => {
    const contentLength = Number(req.headers["content-length"]);
    const validated = validateBackup(req.body, {
        maxBytes: BACKUP_MAX_BYTES,
        rawByteLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
    });
    if (!validated.ok) {
        return res.status(400).json({ success: false, error: validated.error });
    }

    if (maintenanceMode) {
        return res.status(409).json({ success: false, error: "Восстановление уже выполняется." });
    }

    // Закрываем вход для новых игровых мутаций синхронно (внутри
    // closeGameOpsForMaintenance maintenanceMode=true выставляется до первого
    // await), затем дожидаемся уже начатых операций - только после этого
    // безопасно стартовать транзакцию восстановления. Вход остаётся закрытым
    // до перезагрузки roundState и рассылки init_data, чтобы ни одна
    // параллельная операция не могла подмешать устаревшие данные между
    // COMMIT восстановления и обновлением состояния сервера.
    await closeGameOpsForMaintenance();
    try {
        const summary = await withTransaction(pool, (client) => restoreBackupTx(client, validated.value));

        roundState = await loadRoundState();
        io.emit("init_data", await buildPublicInitPayload());
        io.to("admins").emit("admin_rounds_changed");

        await logAdminAction("RESTORE_GAME_BACKUP", {
            user: req.user.id,
            exportedAt: validated.value.exportedAt,
            ...summary
        });

        res.json({ success: true, summary });
    } catch (err) {
        console.error("Backup restore error:", err);
        res.status(500).json({ success: false, error: "Не удалось восстановить бэкап - изменения отменены." });
    } finally {
        reopenGameOps();
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

// Публичная страница архива завершённых раундов (список и просмотр одного раунда).
app.get("/archive", (req, res) => {
    sendHtmlWithContext(res, path.join(__dirname, "public", "archive.html"));
});
app.get("/archive/:id", (req, res) => {
    sendHtmlWithContext(res, path.join(__dirname, "public", "archive.html"));
});

// === ПУБЛИЧНОЕ JSON API АРХИВА ===

app.get("/api/rounds/archive", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.id, r.name, r.description, r.starts_at, r.ends_at, r.finished_at, r.canvas_size,
                   COALESCE(ra.pixel_count, 0) AS pixel_count,
                   (ra.round_id IS NOT NULL) AS has_preview
            FROM rounds r
            LEFT JOIN round_archives ra ON ra.round_id = r.id
            WHERE r.status = 'finished'
            ORDER BY r.finished_at DESC NULLS LAST, r.id DESC
        `);
        res.json({ rounds: result.rows });
    } catch (err) {
        console.error("Archive list error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.get("/api/rounds/archive/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    try {
        const result = await pool.query(`
            SELECT r.id, r.name, r.description, r.starts_at, r.ends_at, r.finished_at, r.canvas_size,
                   COALESCE(ra.pixel_count, 0) AS pixel_count,
                   (ra.round_id IS NOT NULL) AS has_preview
            FROM rounds r
            LEFT JOIN round_archives ra ON ra.round_id = r.id
            WHERE r.id = $1 AND r.status = 'finished'
        `, [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
        res.json({ round: result.rows[0] });
    } catch (err) {
        console.error("Archive detail error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.get("/api/rounds/archive/:id/preview.png", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).send("Invalid id");
    try {
        const result = await pool.query(
            "SELECT ra.preview FROM round_archives ra JOIN rounds r ON r.id = ra.round_id WHERE ra.round_id = $1 AND r.status = 'finished'",
            [id]
        );
        if (result.rows.length === 0) return res.status(404).send("Not found");
        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=86400, immutable");
        res.send(result.rows[0].preview);
    } catch (err) {
        console.error("Archive preview error:", err);
        res.status(500).send("Server error");
    }
});

app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Обработчик CSRF- и body-parser-ошибок. Должен идти ПОСЛЕ всех маршрутов:
// Express ищет error-handling middleware, продолжая обход стека вперёд от
// точки, где случилась ошибка, а не с начала - если зарегистрировать этот
// обработчик раньше самих маршрутов, он никогда не будет достигнут и клиент
// получит дефолтную страницу ошибки Express со стектрейсом.
app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).send('Ошибка безопасности: CSRF-токен невалиден. Пожалуйста, обновите страницу.');
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
        return res.status(413).json({ success: false, error: 'Файл превышает допустимый размер.' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ success: false, error: 'Невалидный JSON.' });
    }
    console.error("Unhandled request error:", err);
    return res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера.' });
});

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

const userCooldowns = new Map();
const userPlacementsInFlight = new Set();
const messageRates = new Map();
const MSG_LIMIT = 100;
const MSG_WINDOW_MS = 1000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

io.on("connection", async (socket) => {
    socket.use(([event, ...args], next) => {
        if (maintenanceMode && MAINTENANCE_BLOCKED_EVENTS.has(event)) {
            const ack = args[args.length - 1];
            if (typeof ack === "function") ack({ success: false, error: "Идёт восстановление игровых данных, подождите и попробуйте снова." });
            return;
        }
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

    onlineUserIds.set(socket.id, userId);
    broadcastPresence();

    socket.on("disconnect", () => {
        messageRates.delete(socket.id);
        onlineUserIds.delete(socket.id);
        broadcastPresence();
    });

    try {
        const payload = await buildPublicInitPayload({
            userId,
            role: socket.request.user ? socket.request.user.role : 'user'
        });
        if (socket.canEditCanvas) {
            const logsRes = await pool.query("SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100");
            payload.adminLogs = logsRes.rows;
        }
        socket.emit("init_data", payload);

        const lastPlaced = userCooldowns.get(userId) || 0;
        const cooldownMs = (roundState.active ? roundState.active.cooldown : 0) * 1000;
        const remainingCooldownMs = Math.max(0, cooldownMs - (Date.now() - lastPlaced));
        socket.emit("user_status", { remainingCooldownMs });
    } catch (err) { console.error(err); }

    socket.on("set_pixel", async (data) => {
        let placementLocked = false;
        try {
            if (!data) return;
            const { x, y, color } = data;
            const round = roundState.active;
            if (round && finishingRoundIds.has(round.id)) return;

            const allowed = assertPixelAllowed({ activeRound: round, x, y, color });
            if (!allowed.ok) return;

            const now = Date.now();
            const lastPlaced = userCooldowns.get(userId) || 0;
            const cooldownMs = round.cooldown * 1000;
            if (!socket.canEditCanvas && (userPlacementsInFlight.has(userId) || now - lastPlaced < cooldownMs - 100)) return;

            // Не даём двум сообщениям одного пользователя одновременно обойти кулдаун.
            if (!socket.canEditCanvas) {
                userPlacementsInFlight.add(userId);
                placementLocked = true;
            }

            const placed = await withGameOp(() => withTransaction(pool, async (client) => {
                if (finishingRoundIds.has(round.id)) return false;

                // finishRound берёт FOR UPDATE на ту же строку. Значит финальный
                // снимок ждёт все начатые размещения, а после завершения новые
                // транзакции уже не увидят active-раунд.
                const activeCheck = await client.query(
                    "SELECT id, status, canvas_size, palette FROM rounds WHERE id = $1 AND status = 'active' FOR SHARE",
                    [round.id]
                );
                if (activeCheck.rows.length === 0) return false;

                // Палитра читается из той же заблокированной строки БД, а не
                // только из in-memory-кэша: изменение палитры нельзя обойти
                // гонкой между UPDATE rounds и обновлением roundState.
                const databaseAllowed = assertPixelAllowed({
                    activeRound: activeCheck.rows[0],
                    x,
                    y,
                    color
                });
                if (!databaseAllowed.ok) return false;

                await client.query(
                    "INSERT INTO pixels (round_id, x, y, color, user_id) VALUES ($1, $2, $3, $4, $5) " +
                    "ON CONFLICT (round_id, x, y) DO UPDATE SET color = EXCLUDED.color, user_id = EXCLUDED.user_id, updated_at = CURRENT_TIMESTAMP",
                    [round.id, x, y, color, userId]
                );
                await client.query(
                    "INSERT INTO pixel_history (round_id, x, y, color, user_id) VALUES ($1, $2, $3, $4, $5)",
                    [round.id, x, y, color, userId]
                );
                return true;
            }));
            if (!placed) return;

            if (!socket.canEditCanvas) {
                userCooldowns.set(userId, now);
                await pool.query(
                    "INSERT INTO users (user_id, last_placed_at) VALUES ($1, $2) " +
                    "ON CONFLICT (user_id) DO UPDATE SET last_placed_at = EXCLUDED.last_placed_at",
                    [userId, now]
                );
            }

            round.pixelsPlaced = (round.pixelsPlaced || 0) + 1;
            if (roundState.view && roundState.view.id === round.id) roundState.view.pixelsPlaced = round.pixelsPlaced;

            io.emit("pixel_update", { x, y, color, userId });
            io.emit("round_stats", { roundId: round.id, pixelsPlaced: round.pixelsPlaced });
            if (socket.canEditCanvas) {
                await logAdminAction("SET_PIXEL", { user: userId, x, y, color, role: socket.isAdmin ? 'admin' : 'moderator' });
            }
        } catch (err) {
            if (!isMaintenanceError(err)) console.error(err);
        } finally {
            if (placementLocked) userPlacementsInFlight.delete(userId);
        }
    });

    socket.on("delete_pixel", async (payload) => {
        if (!socket.canEditCanvas) return;
        const round = roundState.active;
        if (!round) return;
        const data = payload && payload.data ? payload.data : payload;
        const { x, y } = data;
        if (
            !isValidCoordinate(x, round.canvas_size) ||
            !isValidCoordinate(y, round.canvas_size)
        ) return;
        try {
            await withGameOp(() => pool.query("DELETE FROM pixels WHERE round_id = $1 AND x = $2 AND y = $3", [round.id, x, y]));
            await logAdminAction("DELETE_PIXEL", { user: userId, x, y, role: socket.isAdmin ? 'admin' : 'moderator' });
            io.emit("pixel_deleted", { x, y });
        } catch (err) { if (!isMaintenanceError(err)) console.error(err); }
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
            // takeSnapshot() сам входит через enterGameOp/exitGameOp.
            await takeSnapshot();
            await logAdminAction("MANUAL_SNAPSHOT", { user: userId });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (typeof callback === 'function') callback({ success: false, error: isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова." : undefined });
        }
    });

    socket.on("clear_canvas", async (payload, callback) => {
        if (!verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const round = roundState.active;
        if (!round) return callback && callback({ success: false, error: "Нет активного раунда" });
        try {
            await withGameOp(() => pool.query("DELETE FROM pixels WHERE round_id = $1", [round.id]));
            await logAdminAction("CLEAR_CANVAS", { user: userId, roundId: round.id });
            round.pixelsPlaced = 0;
            io.emit("canvas_cleared");
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (!isMaintenanceError(err)) console.error(err);
            if (typeof callback === 'function') callback({ success: false, error: isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова." : undefined });
        }
    });

    // === УПРАВЛЕНИЕ РАУНДАМИ ===

    socket.on("list_rounds", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        try {
            const res = await pool.query("SELECT * FROM rounds ORDER BY created_at DESC");
            if (typeof callback === 'function') callback({ success: true, rounds: res.rows.map(publicRound) });
        } catch (err) { console.error(err); if (typeof callback === 'function') callback({ success: false }); }
    });

    socket.on("create_round", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const normalized = normalizeRoundInput(payload.data);
        if (!normalized.ok) return callback && callback({ success: false, error: normalized.error });
        const v = normalized.value;
        try {
            const res = await withGameOp(() => pool.query(
                `INSERT INTO rounds (name, description, status, starts_at, ends_at, canvas_size, cooldown, bg_color, grid_enabled, palette)
                 VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                [v.name, v.description, v.starts_at, v.ends_at, v.canvas_size, v.cooldown, v.bg_color, v.grid_enabled, JSON.stringify(v.palette)]
            ));
            await logAdminAction("CREATE_ROUND", { user: userId, roundId: res.rows[0].id, name: v.name });
            roundState = await loadRoundState();
            io.to("admins").emit("admin_rounds_changed");
            if (roundState.upcoming) io.emit("round_updated", { upcoming: publicUpcoming(roundState.upcoming) });
            if (typeof callback === 'function') callback({ success: true, round: publicRound(res.rows[0]) });
        } catch (err) {
            if (!isMaintenanceError(err)) console.error(err);
            if (typeof callback === 'function') callback({ success: false, error: isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова." : "Server error" });
        }
    });

    socket.on("update_round", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const data = (payload && payload.data) || {};
        const roundId = Number(data.id);
        if (!Number.isInteger(roundId)) return callback && callback({ success: false, error: "Invalid round id" });
        try {
            const existingRes = await pool.query("SELECT * FROM rounds WHERE id = $1", [roundId]);
            if (existingRes.rows.length === 0) return callback && callback({ success: false, error: "Round not found" });
            const existing = existingRes.rows[0];
            if (existing.status === "finished") return callback && callback({ success: false, error: "Раунд уже завершён и не может быть изменён" });

            const isDraft = existing.status === "draft";
            const merged = {
                name: data.name !== undefined ? data.name : existing.name,
                description: data.description !== undefined ? data.description : existing.description,
                starts_at: (isDraft && data.starts_at !== undefined) ? data.starts_at : existing.starts_at,
                ends_at: data.ends_at !== undefined ? data.ends_at : existing.ends_at,
                canvas_size: (isDraft && data.canvas_size !== undefined) ? data.canvas_size : existing.canvas_size,
                cooldown: data.cooldown !== undefined ? data.cooldown : existing.cooldown,
                bg_color: data.bg_color !== undefined ? data.bg_color : existing.bg_color,
                grid_enabled: data.grid_enabled !== undefined ? data.grid_enabled : existing.grid_enabled,
                palette: data.palette !== undefined ? data.palette : existing.palette
            };

            const normalized = normalizeRoundInput(merged);
            if (!normalized.ok) return callback && callback({ success: false, error: normalized.error });
            const v = normalized.value;

            const res = await withGameOp(() => pool.query(
                `UPDATE rounds SET name = $1, description = $2, starts_at = $3, ends_at = $4, canvas_size = $5,
                    cooldown = $6, bg_color = $7, grid_enabled = $8, palette = $9
                 WHERE id = $10 RETURNING *`,
                [v.name, v.description, v.starts_at, v.ends_at, v.canvas_size, v.cooldown, v.bg_color, v.grid_enabled, JSON.stringify(v.palette), roundId]
            ));
            const updated = res.rows[0];

            await logAdminAction("UPDATE_ROUND", { user: userId, roundId, name: v.name });
            roundState = await loadRoundState();
            io.to("admins").emit("admin_rounds_changed");

            if (roundState.active && roundState.active.id === roundId) {
                io.emit("round_updated", { round: publicRound(roundState.active) });
            } else if (roundState.upcoming && roundState.upcoming.id === roundId) {
                io.emit("round_updated", { upcoming: publicUpcoming(roundState.upcoming) });
            }

            if (typeof callback === 'function') callback({ success: true, round: publicRound(updated) });
        } catch (err) {
            if (!isMaintenanceError(err)) console.error(err);
            if (typeof callback === 'function') callback({ success: false, error: isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова." : "Server error" });
        }
    });

    socket.on("start_round", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const roundId = Number(payload.data && payload.data.id);
        if (!Number.isInteger(roundId)) return callback && callback({ success: false, error: "Invalid round id" });
        try {
            const started = await withGameOp(() => withTransaction(pool, (client) => startRoundTx(client, roundId)));
            await logAdminAction("START_ROUND", { user: userId, roundId, name: started.name });
            roundState = await loadRoundState();
            io.emit("init_data", await buildPublicInitPayload());
            io.to("admins").emit("admin_rounds_changed");
            if (typeof callback === 'function') callback({ success: true, round: publicRound(started) });
        } catch (err) {
            const message = err.message === "ANOTHER_ROUND_ACTIVE" ? "Другой раунд уже активен"
                : err.message === "ROUND_NOT_DRAFT" ? "Раунд не является черновиком"
                : isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова."
                : "Server error";
            if (typeof callback === 'function') callback({ success: false, error: message });
        }
    });

    socket.on("finish_round", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const roundId = Number(payload.data && payload.data.id);
        if (!Number.isInteger(roundId)) return callback && callback({ success: false, error: "Invalid round id" });
        if (finishingRoundIds.has(roundId)) {
            return callback && callback({ success: false, error: "Раунд уже завершается" });
        }

        finishingRoundIds.add(roundId);
        try {
            const finished = await finishAndArchiveRound(roundId);
            await logAdminAction("FINISH_ROUND", { user: userId, roundId: finished.id, name: finished.name });
            roundState = await loadRoundState();
            io.emit("init_data", await buildPublicInitPayload());
            io.to("admins").emit("admin_rounds_changed");
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (!isMaintenanceError(err)) console.error(err);
            if (typeof callback === 'function') callback({ success: false, error: isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова." : "Раунд не активен или не удалось создать архив" });
        } finally {
            finishingRoundIds.delete(roundId);
        }
    });

    socket.on("delete_round", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const roundId = Number(payload.data && payload.data.id);
        if (!Number.isInteger(roundId)) return callback && callback({ success: false, error: "Invalid round id" });
        try {
            // Условие "status = 'draft'" в WHERE - единственная защита, которая
            // здесь нужна: черновик никогда не имел пикселей/истории/снимков
            // (они создаются только для активного раунда), поэтому удаление
            // черновика не может задеть данные завершённых раундов.
            const res = await withGameOp(() => pool.query(
                "DELETE FROM rounds WHERE id = $1 AND status = 'draft' RETURNING id, name",
                [roundId]
            ));
            if (res.rows.length === 0) {
                return callback && callback({ success: false, error: "Удалить можно только черновик" });
            }
            await logAdminAction("DELETE_ROUND", { user: userId, roundId, name: res.rows[0].name });
            roundState = await loadRoundState();
            io.to("admins").emit("admin_rounds_changed");
            io.emit("round_updated", { upcoming: publicUpcoming(roundState.upcoming) });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (!isMaintenanceError(err)) console.error(err);
            if (typeof callback === 'function') callback({ success: false, error: isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова." : "Server error" });
        }
    });

    socket.on("export_database", async (payload, callback) => {
        if (!verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const round = roundState.active;
        if (!round) return callback && callback({ success: false, error: "Нет активного раунда" });
        try {
            const pixelsRes = await pool.query("SELECT x, y, color, user_id FROM pixels WHERE round_id = $1", [round.id]);
            await logAdminAction("EXPORT_DB", { user: userId, roundId: round.id });
            if (typeof callback === 'function') callback({ success: true, pixels: pixelsRes.rows, round: publicRound(round) });
        } catch (err) { if (typeof callback === 'function') callback({ success: false }); }
    });

    socket.on("import_database", async (payload, callback) => {
        if (!verifyAdminCsrf(socket, payload) || !payload.data) return callback && callback({ success: false });
        const round = roundState.active;
        if (!round) return callback && callback({ success: false, error: "Нет активного раунда" });

        const normalized = normalizeRoundPixelImport(payload.data, round);
        if (!normalized.ok) {
            return callback && callback({ success: false, error: normalized.error });
        }

        const { pixels } = normalized.value;
        try {
            await withGameOp(() => withTransaction(pool, async (client) => {
                await client.query("DELETE FROM pixels WHERE round_id = $1", [round.id]);
                await bulkInsertPixels(client, round.id, pixels);
            }));

            await logAdminAction("IMPORT_DB", { user: userId, roundId: round.id, pixelCount: pixels.length });
            roundState = await loadRoundState();
            io.emit("init_data", await buildPublicInitPayload());
            if (typeof callback === "function") callback({ success: true });
        } catch (err) {
            if (!isMaintenanceError(err)) console.error("Import error:", err);
            if (typeof callback === "function") callback({ success: false, error: isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова." : undefined });
        }
    });

    socket.on("rollback_area", async (payload, callback) => {
        if (!socket.isAdmin || !verifyAdminCsrf(socket, payload)) return callback && callback({ success: false });
        const round = roundState.active;
        if (!round) return callback && callback({ success: false, error: "Нет активного раунда" });

        const rollback = normalizeRollbackPayload(payload.data, round.canvas_size);
        if (!rollback) {
            return callback && callback({ success: false, error: "Invalid rollback parameters" });
        }

        try {
            const restoredPixels = await withGameOp(() => withTransaction(pool, async (client) => {
                const targetTime = new Date(Date.now() - rollback.timeAgoMinutes * 60 * 1000);
                const res = await client.query(`
                    SELECT DISTINCT ON (x, y) x, y, color, user_id
                    FROM pixel_history
                    WHERE round_id = $1 AND x >= $2 AND x <= $3 AND y >= $4 AND y <= $5 AND created_at <= $6
                    ORDER BY x, y, created_at DESC
                `, [round.id, rollback.x1, rollback.x2, rollback.y1, rollback.y2, targetTime]);

                await client.query(
                    "DELETE FROM pixels WHERE round_id = $1 AND x >= $2 AND x <= $3 AND y >= $4 AND y <= $5",
                    [round.id, rollback.x1, rollback.x2, rollback.y1, rollback.y2]
                );

                // Восстанавливаем только те цвета, что всё ещё входят в палитру раунда.
                const restorable = res.rows.filter(p => isColorInPalette(p.color, round.palette));
                await bulkInsertPixels(client, round.id, restorable);

                return restorable.length;
            }));

            await logAdminAction("ROLLBACK_AREA", { user: userId, roundId: round.id, ...rollback });
            roundState = await loadRoundState();
            io.emit("init_data", await buildPublicInitPayload());
            if (typeof callback === "function") callback({ success: true, count: restoredPixels });
        } catch (err) {
            if (!isMaintenanceError(err)) console.error("Rollback error:", err);
            if (typeof callback === "function") callback({ success: false, error: isMaintenanceError(err) ? "Идёт восстановление игровых данных, подождите и попробуйте снова." : undefined });
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

        // 2. Раунды: холст, кулдаун и палитра, которые определяют игровую сессию.
        await client.query(`
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
            )
        `);
        // Гарантирует, что активным может быть не более одного раунда одновременно.
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_single_active ON rounds ((true)) WHERE status = 'active'`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS round_archives (
                round_id INTEGER PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
                preview BYTEA NOT NULL,
                pixel_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3. Основные таблицы игры
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

        // 4. История и Таймлапс
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

        // 5. Начальные настройки (используются только как источник значений
        // для архивного "легаси"-раунда при миграции, см. ниже).
        await client.query(`
            INSERT INTO settings (id, canvas_size, cooldown, grid_enabled, bg_color)
            VALUES (1, 50, 2, true, '#1f2937')
            ON CONFLICT (id) DO NOTHING
        `);

        // === МИГРАЦИЯ НА СИСТЕМУ РАУНДОВ ===
        // Идемпотентно добавляет round_id к существующим таблицам холста/истории/
        // снимков и, если в БД уже было накоплено состояние без раундов, переносит
        // его целиком в архивный завершённый раунд - без единого DELETE по данным.
        await client.query("ALTER TABLE pixels ADD COLUMN IF NOT EXISTS round_id INTEGER REFERENCES rounds(id)");
        await client.query("ALTER TABLE pixel_history ADD COLUMN IF NOT EXISTS round_id INTEGER REFERENCES rounds(id)");
        await client.query("ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS round_id INTEGER REFERENCES rounds(id)");

        const orphanPixels = await client.query("SELECT COUNT(*)::int AS c FROM pixels WHERE round_id IS NULL");
        const orphanHistory = await client.query("SELECT COUNT(*)::int AS c FROM pixel_history WHERE round_id IS NULL");
        const orphanSnapshots = await client.query("SELECT COUNT(*)::int AS c FROM snapshots WHERE round_id IS NULL");

        if (orphanPixels.rows[0].c > 0 || orphanHistory.rows[0].c > 0 || orphanSnapshots.rows[0].c > 0) {
            const legacySettingsRes = await client.query("SELECT * FROM settings WHERE id = 1");
            const legacySettings = legacySettingsRes.rows[0] || { canvas_size: 50, cooldown: 2, grid_enabled: true, bg_color: '#1f2937' };

            const earliestRes = await client.query("SELECT MIN(created_at) AS t FROM pixel_history");
            const startsAt = earliestRes.rows[0].t || new Date();

            const legacyRoundRes = await client.query(
                `INSERT INTO rounds (name, description, status, starts_at, ends_at, canvas_size, cooldown, bg_color, grid_enabled, palette, activated_at, finished_at)
                 VALUES ($1, $2, 'finished', $3, CURRENT_TIMESTAMP, $4, $5, $6, $7, $8, $3, CURRENT_TIMESTAMP)
                 RETURNING *`,
                [
                    "Архив: холст до системы раундов",
                    "Автоматически создан при миграции на систему раундов, чтобы сохранить прежнее состояние общего холста.",
                    startsAt,
                    legacySettings.canvas_size,
                    legacySettings.cooldown,
                    legacySettings.bg_color,
                    legacySettings.grid_enabled,
                    JSON.stringify(LEGACY_PALETTE)
                ]
            );
            const legacyRound = legacyRoundRes.rows[0];

            await client.query("UPDATE pixels SET round_id = $1 WHERE round_id IS NULL", [legacyRound.id]);
            await client.query("UPDATE pixel_history SET round_id = $1 WHERE round_id IS NULL", [legacyRound.id]);
            await client.query("UPDATE snapshots SET round_id = $1 WHERE round_id IS NULL", [legacyRound.id]);

            const previewBuffer = await renderCanvasPreview(client, legacyRound);
            const pixelCountRes = await client.query("SELECT COUNT(*)::int AS c FROM pixels WHERE round_id = $1", [legacyRound.id]);
            await client.query(
                `INSERT INTO round_archives (round_id, preview, pixel_count) VALUES ($1, $2, $3)
                 ON CONFLICT (round_id) DO NOTHING`,
                [legacyRound.id, previewBuffer, pixelCountRes.rows[0].c]
            );

            console.log(`[Migration] Существующий холст и история перенесены в архивный раунд #${legacyRound.id} без потери данных.`);
        }

        await client.query("ALTER TABLE pixels ALTER COLUMN round_id SET NOT NULL");
        await client.query("ALTER TABLE pixel_history ALTER COLUMN round_id SET NOT NULL");

        // Переносим первичный ключ pixels на (round_id, x, y): холст становится
        // независимым для каждого раунда, старые раунды остаются нетронутыми.
        const pixelsPk = await client.query(`
            SELECT tc.constraint_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
            WHERE tc.table_name = 'pixels' AND tc.constraint_type = 'PRIMARY KEY'
            GROUP BY tc.constraint_name
        `);
        const hasCorrectPk = pixelsPk.rows.length > 0 && pixelsPk.rows[0].cols === 'round_id,x,y';
        if (!hasCorrectPk) {
            if (pixelsPk.rows.length > 0) {
                await client.query(`ALTER TABLE pixels DROP CONSTRAINT "${pixelsPk.rows[0].constraint_name}"`);
            }
            await client.query('ALTER TABLE pixels ADD CONSTRAINT pixels_pkey PRIMARY KEY (round_id, x, y)');
        }

        await client.query('CREATE INDEX IF NOT EXISTS idx_pixel_history_round ON pixel_history(round_id)');

        // Загрузка состояния раундов в память
        roundState = await loadRoundState();

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
