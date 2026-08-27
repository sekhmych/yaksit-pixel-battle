"use strict";

// Минимальный test harness для интеграционных тестов: поднимает настоящий
// сервер (server.js) отдельным процессом на изолированной тестовой БД
// PostgreSQL и корректно его останавливает (без висящих setInterval/процессов -
// они умирают вместе с дочерним процессом при child.kill()).
//
// Специально НЕ импортирует server.js напрямую в тестовый процесс: сервер
// сам вызывает startServer() при загрузке модуля и держит setInterval-таймеры
// (снапшоты, автозавершение/автозапуск раундов, очистка истории), поэтому
// единственный безопасный способ изолированно запускать/останавливать его в
// тестах без архитектурного рефакторинга - отдельный процесс.

const { Pool } = require("pg");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { io } = require("socket.io-client");

const DB_HOST = process.env.TEST_DB_HOST || process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.TEST_DB_PORT || process.env.DB_PORT || 5432);
const DB_USER = process.env.TEST_DB_USER || process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD || "postgres";

function adminConnection(database = "postgres") {
    return new Pool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database });
}

async function createTestDatabase(prefix) {
    const dbName = `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
    const admin = adminConnection();
    try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
        await admin.end();
    }
    return dbName;
}

async function dropTestDatabase(dbName) {
    const admin = adminConnection();
    try {
        await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [dbName]
        );
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
        await admin.end();
    }
}

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers }, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on("error", reject);
    });
}

function httpPostForm(url, fields, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = new URLSearchParams(fields).toString();
        const req = http.request(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(data),
                ...headers
            }
        }, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

// Универсальный HTTP-запрос с JSON- или сырым телом и произвольными
// заголовками - используется для тестов бэкапа (экспорт/восстановление
// поверх обычного HTTP, а не Socket.IO).
function httpRequest(method, url, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined
            ? undefined
            : (typeof body === "string" ? body : JSON.stringify(body));
        const finalHeaders = { ...headers };
        if (data !== undefined) {
            finalHeaders["Content-Type"] = finalHeaders["Content-Type"] || "application/json";
            finalHeaders["Content-Length"] = Buffer.byteLength(data);
        }
        const req = http.request(url, { method, headers: finalHeaders }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        if (data !== undefined) req.write(data);
        req.end();
    });
}

function extractCookie(res, name) {
    const setCookie = res.headers["set-cookie"] || [];
    for (const c of setCookie) {
        if (c.startsWith(name + "=")) return c.split(";")[0];
    }
    return null;
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
    const start = Date.now();
    for (;;) {
        try {
            const res = await httpGet(baseUrl + "/health");
            if (res.status === 200) return;
        } catch (err) { /* сервер ещё не поднялся */ }
        if (Date.now() - start > timeoutMs) {
            throw new Error("Server did not become healthy in time");
        }
        await sleep(150);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ждёт, пока условие не станет истинным, опрашивая его через равные интервалы.
// Используется вместо фиксированных sleep(), чтобы тесты не были ни слишком
// медленными, ни хрупкими на нагруженном CI.
async function waitUntil(conditionFn, { timeoutMs = 10000, intervalMs = 100, message = "condition" } = {}) {
    const start = Date.now();
    for (;;) {
        const result = await conditionFn();
        if (result) return result;
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for: ${message}`);
        }
        await sleep(intervalMs);
    }
}

let nextPort = 20000 + (process.pid % 10000);
function allocatePort() {
    nextPort += 1;
    return nextPort;
}

// Запускает настоящий backend/server.js как дочерний процесс на свежей,
// изолированной тестовой БД. options.beforeStart(pool), если передан,
// выполняется ДО старта сервера - используется, чтобы засеять БД старой
// (до системы раундов) схемой перед проверкой миграции.
async function startTestServer(options = {}) {
    // Обычно каждый вызов создаёт свежую изолированную БД и сам её удаляет
    // при stop(). Если передан options.dbName - используем уже существующую
    // БД и по умолчанию НЕ удаляем её при остановке (нужно для проверки
    // идемпотентности миграции: второй запуск сервера на той же БД).
    const reusingDatabase = Boolean(options.dbName);
    const dbName = options.dbName || await createTestDatabase(options.dbPrefix || "pixelbattle_it");
    const dropOnStop = options.dropOnStop !== undefined ? options.dropOnStop : !reusingDatabase;

    if (typeof options.beforeStart === "function") {
        const seedPool = adminConnection(dbName);
        try {
            await options.beforeStart(seedPool);
        } finally {
            await seedPool.end();
        }
    }

    const port = options.port || allocatePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        CORS_ORIGINS: baseUrl,
        DB_USER, DB_PASSWORD, DB_HOST, DB_PORT: String(DB_PORT), DB_NAME: dbName,
        ADMIN_PASSWORD: "integration-test-admin-password",
        SESSION_SECRET: "integration-test-session-secret-value-0123456789",
        ROUND_SYNC_INTERVAL_MS: String(options.roundSyncIntervalMs || 300),
        ...(options.extraEnv || {})
    };

    const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], { env });

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.stdout.on("data", (d) => { stdout += d.toString(); });

    // Единственное место, где фиксируется факт и подробности выхода
    // дочернего процесса - используется и waitForExit(), и stop(), чтобы не
    // пытаться убить уже завершившийся процесс (SIGTERM/SIGKILL по мёртвому
    // pid либо no-op, либо ошибка ESRCH).
    let exitInfo = null;
    const exitPromise = new Promise((resolve) => {
        child.once("exit", (code, signal) => {
            exitInfo = { code, signal };
            resolve(exitInfo);
        });
    });

    try {
        await waitForHealth(baseUrl);
    } catch (err) {
        child.kill("SIGKILL");
        await dropTestDatabase(dbName).catch(() => {});
        throw new Error(`Server failed to start: ${err.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    }

    const pool = adminConnection(dbName);

    return {
        baseUrl,
        port,
        dbName,
        pool,
        child,
        getLogs: () => ({ stdout, stderr }),
        getExitInfo: () => exitInfo,
        // Отправляет сигнал дочернему процессу напрямую - используется
        // тестами graceful shutdown, которым нужен полный контроль над
        // моментом отправки SIGTERM/SIGINT (в отличие от stop(), который
        // сам решает, когда и как останавливать сервер при уборке теста).
        // No-op, если процесс уже завершился.
        signal(sig = "SIGTERM") {
            if (exitInfo) return;
            child.kill(sig);
        },
        // Ждёт реального завершения процесса (а не просто HTTP-ответа) и
        // возвращает { code, signal } - тесты используют это, чтобы отличить
        // штатный graceful-выход (code === 0, signal === null) от
        // принудительного (SIGKILL fallback ниже, или ненулевой exit code
        // при неудавшемся graceful shutdown).
        waitForExit(timeoutMs = 20000) {
            if (exitInfo) return Promise.resolve(exitInfo);
            return Promise.race([
                exitPromise,
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error(`Процесс не завершился за ${timeoutMs}мс`)),
                    timeoutMs
                ))
            ]);
        },
        // Даёт серверу шанс на настоящий graceful SIGTERM-выход (теперь,
        // когда он есть) и только если тот не укладывается в отведённое
        // время - принудительно добивает SIGKILL. Жёсткий SIGKILL остаётся
        // только аварийным fallback самого test harness, а не основным
        // способом остановки.
        async stop({ forceKillAfterMs = 10000 } = {}) {
            await pool.end().catch(() => {});
            if (!exitInfo) {
                await new Promise((resolve) => {
                    child.kill("SIGTERM");
                    const forceKill = setTimeout(() => {
                        if (!exitInfo) child.kill("SIGKILL");
                    }, forceKillAfterMs);
                    forceKill.unref();
                    exitPromise.then(resolve);
                });
            }
            if (dropOnStop) {
                await dropTestDatabase(dbName).catch(() => {});
            }
        }
    };
}

// Полный цикл авторизации админа: логин по HTTP (получение CSRF-токена и
// cookie сессии), затем подключение Socket.IO-сокета с той же cookie.
// Повторяет ровно тот флоу, что использует настоящая админ-панель.
async function adminSession(baseUrl) {
    const home = await httpGet(baseUrl + "/");
    const uidCookie = extractCookie(home, "uid");

    const loginPage = await httpGet(baseUrl + "/admin/login");
    const csrfMatch = loginPage.body.match(/name="_csrf" value="([^"]+)"/);
    if (!csrfMatch) throw new Error("CSRF token not found on login page");
    const loginSessionCookie = (loginPage.headers["set-cookie"] || [])[0];

    const loginRes = await httpPostForm(baseUrl + "/admin/login", {
        username: "admin",
        password: "integration-test-admin-password",
        _csrf: csrfMatch[1]
    }, { Cookie: loginSessionCookie });

    const authedCookies = (loginRes.headers["set-cookie"] || [])
        .map(c => c.split(";")[0])
        .concat([loginSessionCookie])
        .join("; ");

    const adminPage = await httpGet(baseUrl + "/admin", { Cookie: authedCookies });
    const adminCsrfMatch = adminPage.body.match(/name="csrf-token" content="([^"]+)"/);
    if (!adminCsrfMatch) throw new Error("CSRF token not found on admin page");
    const csrfToken = adminCsrfMatch[1];

    const cookies = (adminPage.headers["set-cookie"] || [])
        .map(c => c.split(";")[0])
        .concat(authedCookies.split("; "))
        .concat([uidCookie])
        .filter(Boolean)
        .join("; ");

    const socket = io(baseUrl, { extraHeaders: { Cookie: cookies }, transports: ["websocket"] });
    // Сервер регистрирует обработчики socket.on(...) ПОСЛЕ await внутри
    // io.on("connection", ...), поэтому событие 'connect' на клиенте может
    // наступить раньше, чем сервер успеет их зарегистрировать. Ждём
    // 'init_data' - оно приходит уже после регистрации всех обработчиков,
    // так что это надёжная точка синхронизации перед первым emit с ack.
    await new Promise((resolve, reject) => {
        socket.once("init_data", resolve);
        socket.once("connect_error", reject);
        setTimeout(() => reject(new Error("admin socket did not receive init_data in time")), 8000);
    });

    function emit(event, data) {
        return new Promise((resolve) => {
            socket.emit(event, { auth: { csrfToken }, data }, resolve);
        });
    }

    return { socket, csrfToken, cookies, emit, close: () => socket.close() };
}

// Обычный посетитель: только анонимная подписанная uid-cookie, без логина.
async function visitorSession(baseUrl) {
    const home = await httpGet(baseUrl + "/");
    const uidCookie = extractCookie(home, "uid");
    if (!uidCookie) throw new Error("uid cookie not issued");

    const socket = io(baseUrl, { extraHeaders: { Cookie: uidCookie }, transports: ["websocket"] });
    // См. комментарий в adminSession: ждём init_data, а не голый 'connect'.
    // Сохраняем сам payload - тестам гонки нужно проверить, что состояние,
    // которое видит только что подключившийся клиент, реально совпадает с
    // тем, что восстановил backup.
    const initData = await new Promise((resolve, reject) => {
        socket.once("init_data", resolve);
        socket.once("connect_error", reject);
        setTimeout(() => reject(new Error("visitor socket did not receive init_data in time")), 8000);
    });

    return { socket, cookie: uidCookie, initData, close: () => socket.close() };
}

module.exports = {
    startTestServer,
    adminSession,
    visitorSession,
    waitUntil,
    sleep,
    httpGet,
    httpRequest
};
