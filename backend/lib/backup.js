"use strict";

// Полный логический бэкап ИГРОВЫХ данных (раунды, пиксели, история пикселей,
// снимки, архивы раундов с PNG). Никогда не включает session/moderators/
// users/settings/admin_logs - там либо секреты и учётные данные, либо
// служебное состояние, не являющееся игровым прогрессом.

const { isValidColor } = require("./validation");
const { isValidPalette } = require("./rounds");

const BACKUP_FORMAT = "yaksit-pixel-battle-game-backup";
const BACKUP_VERSION = 1;

// Безопасные значения по умолчанию - не про размер файла в байтах (это уже
// ограничивает express.json({ limit })), а про количество строк, чтобы даже
// небольшой по объёму, но патологически сформированный JSON не мог вызвать
// чрезмерную нагрузку на восстановление.
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_ROUNDS = 10000;
const MAX_SNAPSHOTS = 100000;
const MAX_PIXEL_HISTORY = 5000000;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_USER_ID_LENGTH = 50;
const MAX_COLOR_FIELD_LENGTH = 10;
const ROUND_STATUSES = new Set(["draft", "active", "finished"]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Строгая схема v1: неизвестные поля отклоняются, а не молча игнорируются -
// это не даёт бэкапу незаметно протащить лишние данные (например поле,
// которое в будущей версии формата получит другой смысл) через валидацию.
function unknownKey(obj, allowedKeys) {
    for (const key of Object.keys(obj)) {
        if (!allowedKeys.includes(key)) return key;
    }
    return null;
}

const TOP_LEVEL_KEYS = ["format", "version", "exported_at", "data"];
const DATA_KEYS = ["rounds", "pixels", "pixel_history", "snapshots", "round_archives"];
const ROUND_KEYS = ["id", "name", "description", "status", "starts_at", "ends_at", "canvas_size", "cooldown", "bg_color", "grid_enabled", "palette", "activated_at", "finished_at", "created_at"];
const PIXEL_KEYS = ["round_id", "x", "y", "color", "user_id", "updated_at"];
const PIXEL_HISTORY_KEYS = ["id", "round_id", "x", "y", "color", "user_id", "created_at"];
const SNAPSHOT_KEYS = ["id", "round_id", "data_base64", "created_at"];
const ROUND_ARCHIVE_KEYS = ["round_id", "preview_base64", "pixel_count", "created_at"];

function isNonEmptyString(v, maxLength) {
    return typeof v === "string" && v.length > 0 && v.length <= maxLength;
}

function isIsoDateString(v) {
    if (typeof v !== "string") return false;
    const d = new Date(v);
    return !Number.isNaN(d.getTime());
}

function isPositiveInt(v) {
    return Number.isInteger(v) && v > 0;
}

function isNonNegativeInt(v) {
    return Number.isInteger(v) && v >= 0;
}

// Декодирует и проверяет base64-поле. Возвращает Buffer или null, если
// строка не является корректным base64.
function decodeBase64Field(value) {
    if (typeof value !== "string" || !BASE64_RE.test(value)) return null;
    // Node прощает "мусорный" base64 без падения, поэтому дополнительно
    // проверяем, что усечение до кратности 4 после strip не съедает контент -
    // Buffer.from сам справляется с паддингом корректно для валидных строк.
    try {
        const buf = Buffer.from(value, "base64");
        return buf;
    } catch (e) {
        return null;
    }
}

function looksLikePng(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

// === СЕРИАЛИЗАЦИЯ (DB-строки -> JSON-бэкап) ===
//
// Чистая функция: принимает уже выбранные из БД строки (как их возвращает
// node-postgres - бинарные колонки приходят как Buffer) и строит финальный
// JSON-объект бэкапа. Бинарные поля кодируются в base64 под именем
// `<поле>_base64`, с чем корреспондирует и validateBackup ниже.
function serializeBackup({ rounds, pixels, pixelHistory, snapshots, roundArchives }, exportedAt = new Date()) {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: exportedAt.toISOString(),
        data: {
            rounds: rounds.map(r => ({
                id: r.id,
                name: r.name,
                description: r.description,
                status: r.status,
                starts_at: toIso(r.starts_at),
                ends_at: toIso(r.ends_at),
                canvas_size: r.canvas_size,
                cooldown: r.cooldown,
                bg_color: r.bg_color,
                grid_enabled: r.grid_enabled,
                palette: r.palette,
                activated_at: toIso(r.activated_at),
                finished_at: toIso(r.finished_at),
                created_at: toIso(r.created_at)
            })),
            pixels: pixels.map(p => ({
                round_id: p.round_id,
                x: p.x,
                y: p.y,
                color: p.color,
                user_id: p.user_id,
                updated_at: toIso(p.updated_at)
            })),
            pixel_history: pixelHistory.map(h => ({
                id: h.id,
                round_id: h.round_id,
                x: h.x,
                y: h.y,
                color: h.color,
                user_id: h.user_id,
                created_at: toIso(h.created_at)
            })),
            snapshots: snapshots.map(s => ({
                id: s.id,
                round_id: s.round_id,
                data_base64: Buffer.from(s.data).toString("base64"),
                created_at: toIso(s.created_at)
            })),
            round_archives: roundArchives.map(a => ({
                round_id: a.round_id,
                preview_base64: Buffer.from(a.preview).toString("base64"),
                pixel_count: a.pixel_count,
                created_at: toIso(a.created_at)
            }))
        }
    };
}

function toIso(value) {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// === ВАЛИДАЦИЯ (JSON-бэкап -> проверенная, готовая к вставке структура) ===
//
// Возвращает { ok: true, value } с уже декодированными Buffer-ами для
// бинарных полей, либо { ok: false, error }. Ничего не трогает в БД -
// чистая функция, поэтому её удобно покрывать unit-тестами.
function validateBackup(json, options = {}) {
    const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;

    if (options.rawByteLength !== undefined && options.rawByteLength > maxBytes) {
        return { ok: false, error: `Файл бэкапа превышает допустимый размер (${maxBytes} байт).` };
    }

    if (!isPlainObject(json)) {
        return { ok: false, error: "Бэкап должен быть JSON-объектом." };
    }
    const unknownTopKey = unknownKey(json, TOP_LEVEL_KEYS);
    if (unknownTopKey) {
        return { ok: false, error: `Неизвестное поле верхнего уровня: ${unknownTopKey}.` };
    }
    if (json.format !== BACKUP_FORMAT) {
        return { ok: false, error: `Неизвестный формат файла (ожидался "${BACKUP_FORMAT}").` };
    }
    if (json.version !== BACKUP_VERSION) {
        return { ok: false, error: `Неподдерживаемая версия бэкапа: ${json.version}.` };
    }
    if (!isIsoDateString(json.exported_at)) {
        return { ok: false, error: "Некорректное поле exported_at." };
    }
    if (!isPlainObject(json.data)) {
        return { ok: false, error: "Отсутствует или некорректно поле data." };
    }
    const unknownDataKey = unknownKey(json.data, DATA_KEYS);
    if (unknownDataKey) {
        return { ok: false, error: `Неизвестное поле в data: ${unknownDataKey}.` };
    }

    const { rounds, pixels, pixel_history: pixelHistory, snapshots, round_archives: roundArchives } = json.data;
    if (!Array.isArray(rounds) || !Array.isArray(pixels) || !Array.isArray(pixelHistory) ||
        !Array.isArray(snapshots) || !Array.isArray(roundArchives)) {
        return { ok: false, error: "data.rounds, data.pixels, data.pixel_history, data.snapshots и data.round_archives должны быть массивами." };
    }

    if (rounds.length > MAX_ROUNDS) return { ok: false, error: `Слишком много раундов в бэкапе (максимум ${MAX_ROUNDS}).` };
    if (snapshots.length > MAX_SNAPSHOTS) return { ok: false, error: `Слишком много снимков в бэкапе (максимум ${MAX_SNAPSHOTS}).` };
    if (pixelHistory.length > MAX_PIXEL_HISTORY) return { ok: false, error: `Слишком много записей истории в бэкапе (максимум ${MAX_PIXEL_HISTORY}).` };

    // --- rounds ---
    const roundById = new Map();
    let activeCount = 0;
    const validatedRounds = [];

    for (const r of rounds) {
        if (!isPlainObject(r)) return { ok: false, error: "Некорректная запись в data.rounds." };
        const unknownRoundKey = unknownKey(r, ROUND_KEYS);
        if (unknownRoundKey) return { ok: false, error: `Неизвестное поле в записи раунда: ${unknownRoundKey}.` };
        if (!isPositiveInt(r.id)) return { ok: false, error: `Некорректный id раунда: ${JSON.stringify(r.id)}.` };
        if (roundById.has(r.id)) return { ok: false, error: `Повторяющийся id раунда: ${r.id}.` };
        if (!isNonEmptyString(r.name, MAX_NAME_LENGTH)) return { ok: false, error: `Некорректное название раунда #${r.id}.` };
        if (r.description !== null && !isNonEmptyString(r.description, MAX_DESCRIPTION_LENGTH)) {
            return { ok: false, error: `Некорректное описание раунда #${r.id}.` };
        }
        if (!ROUND_STATUSES.has(r.status)) return { ok: false, error: `Некорректный статус раунда #${r.id}: ${r.status}.` };
        if (!isIsoDateString(r.starts_at) || !isIsoDateString(r.ends_at)) {
            return { ok: false, error: `Некорректные даты начала/окончания раунда #${r.id}.` };
        }
        if (!isPositiveInt(r.canvas_size) || r.canvas_size > 100000) {
            return { ok: false, error: `Некорректный размер холста раунда #${r.id}.` };
        }
        if (!isNonNegativeInt(r.cooldown)) return { ok: false, error: `Некорректный кулдаун раунда #${r.id}.` };
        if (!isValidColor(r.bg_color)) return { ok: false, error: `Некорректный цвет фона раунда #${r.id}.` };
        if (typeof r.grid_enabled !== "boolean") return { ok: false, error: `Некорректное поле grid_enabled раунда #${r.id}.` };
        if (!isValidPalette(r.palette)) return { ok: false, error: `Некорректная палитра раунда #${r.id}.` };
        if (r.activated_at !== null && !isIsoDateString(r.activated_at)) {
            return { ok: false, error: `Некорректное поле activated_at раунда #${r.id}.` };
        }
        if (r.finished_at !== null && !isIsoDateString(r.finished_at)) {
            return { ok: false, error: `Некорректное поле finished_at раунда #${r.id}.` };
        }
        if (!isIsoDateString(r.created_at)) return { ok: false, error: `Некорректное поле created_at раунда #${r.id}.` };
        if (r.status === "active") activeCount += 1;

        const normalized = {
            id: r.id,
            name: r.name,
            description: r.description,
            status: r.status,
            starts_at: r.starts_at,
            ends_at: r.ends_at,
            canvas_size: r.canvas_size,
            cooldown: r.cooldown,
            bg_color: r.bg_color,
            grid_enabled: r.grid_enabled,
            palette: r.palette,
            activated_at: r.activated_at,
            finished_at: r.finished_at,
            created_at: r.created_at
        };
        roundById.set(r.id, normalized);
        validatedRounds.push(normalized);
    }

    // Инвариант системы раундов: одновременно активен не более одного раунда.
    if (activeCount > 1) {
        return { ok: false, error: `В бэкапе больше одного активного раунда (${activeCount}).` };
    }

    // --- pixels ---
    const validatedPixels = [];
    const pixelKeys = new Set();
    for (const p of pixels) {
        if (!isPlainObject(p)) return { ok: false, error: "Некорректная запись в data.pixels." };
        const unknownPixelKey = unknownKey(p, PIXEL_KEYS);
        if (unknownPixelKey) return { ok: false, error: `Неизвестное поле в записи пикселя: ${unknownPixelKey}.` };
        const round = roundById.get(p.round_id);
        if (!round) return { ok: false, error: `pixels ссылается на несуществующий round_id ${p.round_id}.` };
        if (!isNonNegativeInt(p.x) || p.x >= round.canvas_size || !isNonNegativeInt(p.y) || p.y >= round.canvas_size) {
            return { ok: false, error: `Пиксель вне холста раунда #${round.id}: (${p.x}, ${p.y}).` };
        }
        if (!isValidColor(p.color)) return { ok: false, error: `Некорректный цвет пикселя раунда #${round.id}.` };
        if (!isNonEmptyString(p.user_id, MAX_USER_ID_LENGTH)) return { ok: false, error: `Некорректный user_id пикселя раунда #${round.id}.` };
        if (!isIsoDateString(p.updated_at)) return { ok: false, error: `Некорректная дата пикселя раунда #${round.id}.` };
        const key = round.id + ":" + p.x + ":" + p.y;
        if (pixelKeys.has(key)) return { ok: false, error: `Повторяющийся пиксель (${p.x}, ${p.y}) в раунде #${round.id}.` };
        pixelKeys.add(key);
        validatedPixels.push({ round_id: round.id, x: p.x, y: p.y, color: p.color, user_id: p.user_id, updated_at: p.updated_at });
    }

    // --- pixel_history ---
    const validatedHistory = [];
    const historyIds = new Set();
    for (const h of pixelHistory) {
        if (!isPlainObject(h)) return { ok: false, error: "Некорректная запись в data.pixel_history." };
        const unknownHistoryKey = unknownKey(h, PIXEL_HISTORY_KEYS);
        if (unknownHistoryKey) return { ok: false, error: `Неизвестное поле в записи истории: ${unknownHistoryKey}.` };
        if (!isPositiveInt(h.id)) return { ok: false, error: `Некорректный id записи истории: ${JSON.stringify(h.id)}.` };
        if (historyIds.has(h.id)) return { ok: false, error: `Повторяющийся id записи истории: ${h.id}.` };
        const round = roundById.get(h.round_id);
        if (!round) return { ok: false, error: `pixel_history ссылается на несуществующий round_id ${h.round_id}.` };
        if (!Number.isInteger(h.x) || !Number.isInteger(h.y)) {
            return { ok: false, error: `Некорректные координаты записи истории #${h.id}.` };
        }
        if (!isValidColor(h.color)) return { ok: false, error: `Некорректный цвет записи истории #${h.id}.` };
        if (!isNonEmptyString(h.user_id, MAX_USER_ID_LENGTH)) return { ok: false, error: `Некорректный user_id записи истории #${h.id}.` };
        if (!isIsoDateString(h.created_at)) return { ok: false, error: `Некорректная дата записи истории #${h.id}.` };
        historyIds.add(h.id);
        validatedHistory.push({ id: h.id, round_id: round.id, x: h.x, y: h.y, color: h.color, user_id: h.user_id, created_at: h.created_at });
    }

    // --- snapshots ---
    const validatedSnapshots = [];
    const snapshotIds = new Set();
    for (const s of snapshots) {
        if (!isPlainObject(s)) return { ok: false, error: "Некорректная запись в data.snapshots." };
        const unknownSnapshotKey = unknownKey(s, SNAPSHOT_KEYS);
        if (unknownSnapshotKey) return { ok: false, error: `Неизвестное поле в записи снимка: ${unknownSnapshotKey}.` };
        if (!isPositiveInt(s.id)) return { ok: false, error: `Некорректный id снимка: ${JSON.stringify(s.id)}.` };
        if (snapshotIds.has(s.id)) return { ok: false, error: `Повторяющийся id снимка: ${s.id}.` };
        if (s.round_id !== null && !roundById.has(s.round_id)) {
            return { ok: false, error: `snapshots ссылается на несуществующий round_id ${s.round_id}.` };
        }
        if (!isIsoDateString(s.created_at)) return { ok: false, error: `Некорректная дата снимка #${s.id}.` };
        const buf = decodeBase64Field(s.data_base64);
        if (!buf || buf.length === 0) return { ok: false, error: `Некорректный base64 в снимке #${s.id}.` };
        if (!looksLikePng(buf)) return { ok: false, error: `Снимок #${s.id} не является корректным PNG.` };
        snapshotIds.add(s.id);
        validatedSnapshots.push({ id: s.id, round_id: s.round_id, data: buf, created_at: s.created_at });
    }

    // --- round_archives ---
    const validatedArchives = [];
    const archiveRoundIds = new Set();
    for (const a of roundArchives) {
        if (!isPlainObject(a)) return { ok: false, error: "Некорректная запись в data.round_archives." };
        const unknownArchiveKey = unknownKey(a, ROUND_ARCHIVE_KEYS);
        if (unknownArchiveKey) return { ok: false, error: `Неизвестное поле в записи архива: ${unknownArchiveKey}.` };
        const round = roundById.get(a.round_id);
        if (!round) return { ok: false, error: `round_archives ссылается на несуществующий round_id ${a.round_id}.` };
        if (round.status !== "finished") {
            return { ok: false, error: `round_archives ссылается на раунд #${a.round_id}, который не завершён.` };
        }
        if (archiveRoundIds.has(a.round_id)) return { ok: false, error: `Повторяющийся архив для раунда #${a.round_id}.` };
        if (!isNonNegativeInt(a.pixel_count)) return { ok: false, error: `Некорректный pixel_count архива раунда #${a.round_id}.` };
        if (!isIsoDateString(a.created_at)) return { ok: false, error: `Некорректная дата архива раунда #${a.round_id}.` };
        const buf = decodeBase64Field(a.preview_base64);
        if (!buf || buf.length === 0) return { ok: false, error: `Некорректный base64 в архиве раунда #${a.round_id}.` };
        if (!looksLikePng(buf)) return { ok: false, error: `Превью архива раунда #${a.round_id} не является корректным PNG.` };
        archiveRoundIds.add(a.round_id);
        validatedArchives.push({ round_id: a.round_id, preview: buf, pixel_count: a.pixel_count, created_at: a.created_at });
    }

    return {
        ok: true,
        value: {
            exportedAt: json.exported_at,
            rounds: validatedRounds,
            pixels: validatedPixels,
            pixelHistory: validatedHistory,
            snapshots: validatedSnapshots,
            roundArchives: validatedArchives
        }
    };
}

// Сбрасывает SERIAL-последовательность таблицы на MAX(column)+1 (или на 1,
// если таблица пуста) - выполняется после явной вставки значений id.
async function resetSequence(client, table, column) {
    await client.query(
        `SELECT setval(
            pg_get_serial_sequence($1, $2),
            COALESCE((SELECT MAX(${column}) FROM ${table}), 1),
            (SELECT MAX(${column}) FROM ${table}) IS NOT NULL
        )`,
        [table, column]
    );
}

async function bulkInsert(client, table, columns, rows, rowToParams) {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values = chunk.map((row, idx) => {
            const base = idx * columns.length;
            const placeholders = columns.map((_, c) => `$${base + c + 1}`);
            return `(${placeholders.join(", ")})`;
        }).join(", ");
        const params = [];
        chunk.forEach(row => params.push(...rowToParams(row)));
        await client.query(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`,
            params
        );
    }
}

// Восстанавливает игровые данные внутри уже открытой транзакции (client).
// Полностью заменяет содержимое rounds/pixels/pixel_history/snapshots/
// round_archives проверенными данными validateBackup(); никогда не
// затрагивает session/moderators/users/settings/admin_logs.
// ACCESS EXCLUSIVE блокирует все параллельные транзакции над этими
// таблицами до конца восстановления (или до отката при ошибке).
async function restoreBackupTx(client, validated) {
    await client.query("LOCK TABLE round_archives, snapshots, pixel_history, pixels, rounds IN ACCESS EXCLUSIVE MODE");

    await client.query("DELETE FROM round_archives");
    await client.query("DELETE FROM snapshots");
    await client.query("DELETE FROM pixel_history");
    await client.query("DELETE FROM pixels");
    await client.query("DELETE FROM rounds");

    await bulkInsert(
        client, "rounds",
        ["id", "name", "description", "status", "starts_at", "ends_at", "canvas_size", "cooldown", "bg_color", "grid_enabled", "palette", "activated_at", "finished_at", "created_at"],
        validated.rounds,
        r => [r.id, r.name, r.description, r.status, r.starts_at, r.ends_at, r.canvas_size, r.cooldown, r.bg_color, r.grid_enabled, JSON.stringify(r.palette), r.activated_at, r.finished_at, r.created_at]
    );

    await bulkInsert(
        client, "pixels",
        ["round_id", "x", "y", "color", "user_id", "updated_at"],
        validated.pixels,
        p => [p.round_id, p.x, p.y, p.color, p.user_id, p.updated_at]
    );

    await bulkInsert(
        client, "pixel_history",
        ["id", "round_id", "x", "y", "color", "user_id", "created_at"],
        validated.pixelHistory,
        h => [h.id, h.round_id, h.x, h.y, h.color, h.user_id, h.created_at]
    );

    await bulkInsert(
        client, "snapshots",
        ["id", "round_id", "data", "created_at"],
        validated.snapshots,
        s => [s.id, s.round_id, s.data, s.created_at]
    );

    await bulkInsert(
        client, "round_archives",
        ["round_id", "preview", "pixel_count", "created_at"],
        validated.roundArchives,
        a => [a.round_id, a.preview, a.pixel_count, a.created_at]
    );

    await resetSequence(client, "rounds", "id");
    await resetSequence(client, "pixel_history", "id");
    await resetSequence(client, "snapshots", "id");

    return {
        rounds: validated.rounds.length,
        pixels: validated.pixels.length,
        pixelHistory: validated.pixelHistory.length,
        snapshots: validated.snapshots.length,
        roundArchives: validated.roundArchives.length
    };
}

module.exports = {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    DEFAULT_MAX_BYTES,
    serializeBackup,
    validateBackup,
    restoreBackupTx,
    looksLikePng,
    decodeBase64Field
};
