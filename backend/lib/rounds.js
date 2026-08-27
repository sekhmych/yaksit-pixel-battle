"use strict";

const { isValidColor } = require("./validation");

const STATUSES = ["draft", "active", "finished"];
const MAX_PALETTE_SIZE = 64;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MIN_CANVAS_SIZE = 10;
const MAX_CANVAS_SIZE = 1000;
const MIN_COOLDOWN = 0;
const MAX_COOLDOWN = 3600;

function isValidPalette(palette) {
    if (!Array.isArray(palette) || palette.length === 0 || palette.length > MAX_PALETTE_SIZE) {
        return false;
    }
    const seen = new Set();
    for (const color of palette) {
        if (!isValidColor(color)) return false;
        const key = color.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
    }
    return true;
}

function isColorInPalette(color, palette) {
    if (!isValidColor(color) || !Array.isArray(palette)) return false;
    const key = color.toLowerCase();
    return palette.some(c => typeof c === "string" && c.toLowerCase() === key);
}

function parseDate(value) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value !== "string" && typeof value !== "number") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// Валидирует и нормализует входные данные раунда (создание или полное обновление).
function normalizeRoundInput(input) {
    if (!input || typeof input !== "object") {
        return { ok: false, error: "Invalid round payload." };
    }

    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) {
        return { ok: false, error: "Round name must be 1-200 characters." };
    }

    let description = null;
    if (input.description !== undefined && input.description !== null && input.description !== "") {
        if (typeof input.description !== "string" || input.description.length > MAX_DESCRIPTION_LENGTH) {
            return { ok: false, error: "Invalid round description." };
        }
        description = input.description;
    }

    const startsAt = parseDate(input.starts_at);
    const endsAt = parseDate(input.ends_at);
    if (!startsAt || !endsAt || endsAt.getTime() <= startsAt.getTime()) {
        return { ok: false, error: "Round end time must be after the start time." };
    }

    const canvasSize = Number.isInteger(input.canvas_size) ? input.canvas_size : null;
    if (canvasSize === null || canvasSize < MIN_CANVAS_SIZE || canvasSize > MAX_CANVAS_SIZE) {
        return { ok: false, error: "Invalid canvas size." };
    }

    const cooldown = Number.isInteger(input.cooldown) ? input.cooldown : null;
    if (cooldown === null || cooldown < MIN_COOLDOWN || cooldown > MAX_COOLDOWN) {
        return { ok: false, error: "Invalid cooldown." };
    }

    const bgColor = isValidColor(input.bg_color) ? input.bg_color : null;
    if (!bgColor) {
        return { ok: false, error: "Invalid background color." };
    }

    const gridEnabled = typeof input.grid_enabled === "boolean" ? input.grid_enabled : true;

    if (!isValidPalette(input.palette)) {
        return { ok: false, error: "Palette must contain 1-64 unique hex colors." };
    }
    const palette = input.palette.map(c => c.toLowerCase());

    return {
        ok: true,
        value: {
            name,
            description,
            starts_at: startsAt,
            ends_at: endsAt,
            canvas_size: canvasSize,
            cooldown,
            bg_color: bgColor,
            grid_enabled: gridEnabled,
            palette
        }
    };
}

// Проверяет, разрешено ли поставить пиксель: должен быть активный раунд,
// координаты в пределах его холста и цвет строго из его палитры.
function assertPixelAllowed({ activeRound, x, y, color }) {
    if (!activeRound || activeRound.status !== "active") {
        return { ok: false, error: "NO_ACTIVE_ROUND" };
    }
    if (!Number.isInteger(x) || x < 0 || x >= activeRound.canvas_size) {
        return { ok: false, error: "INVALID_COORDINATE" };
    }
    if (!Number.isInteger(y) || y < 0 || y >= activeRound.canvas_size) {
        return { ok: false, error: "INVALID_COORDINATE" };
    }
    if (!isColorInPalette(color, activeRound.palette)) {
        return { ok: false, error: "COLOR_NOT_IN_PALETTE" };
    }
    return { ok: true };
}

// Валидирует пиксели для импорта в конкретный раунд: координаты и цвета
// проверяются строго по правилам этого раунда (палитра + размер холста).
function normalizeRoundPixelImport(data, round) {
    if (!data || typeof data !== "object" || !Array.isArray(data.pixels)) {
        return { ok: false, error: "Invalid import payload." };
    }

    const maxPixelCount = round.canvas_size * round.canvas_size;
    if (data.pixels.length > maxPixelCount) {
        return { ok: false, error: "Too many pixels for this round's canvas." };
    }

    const coordinates = new Set();
    const pixels = [];

    for (const pixel of data.pixels) {
        if (
            !pixel ||
            typeof pixel !== "object" ||
            !Number.isInteger(pixel.x) || pixel.x < 0 || pixel.x >= round.canvas_size ||
            !Number.isInteger(pixel.y) || pixel.y < 0 || pixel.y >= round.canvas_size ||
            !isColorInPalette(pixel.color, round.palette)
        ) {
            return { ok: false, error: "Invalid pixel in import payload." };
        }

        const userId = typeof pixel.user_id === "string" && pixel.user_id.length > 0 && pixel.user_id.length <= 50
            ? pixel.user_id
            : "imported";
        const key = pixel.x + ":" + pixel.y;

        if (coordinates.has(key)) {
            return { ok: false, error: "Duplicate pixel coordinates in import payload." };
        }

        coordinates.add(key);
        pixels.push({ x: pixel.x, y: pixel.y, color: pixel.color, user_id: userId });
    }

    return { ok: true, value: { pixels } };
}

// Атомарно запускает раунд: гарантирует, что активен только один раунд
// одновременно (плюс подстраховка частичным уникальным индексом в БД).
async function startRoundTx(client, roundId) {
    const activeCheck = await client.query("SELECT id FROM rounds WHERE status = 'active' FOR UPDATE");
    if (activeCheck.rows.length > 0) {
        throw new Error("ANOTHER_ROUND_ACTIVE");
    }
    const res = await client.query(
        "UPDATE rounds SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'draft' RETURNING *",
        [roundId]
    );
    if (res.rows.length === 0) {
        throw new Error("ROUND_NOT_DRAFT");
    }
    return res.rows[0];
}

// Находит самый ранний черновик, готовый к запуску по расписанию
// (starts_at уже наступил, ends_at ещё не прошёл), и атомарно его
// запускает через startRoundTx - значит действует та же защита от
// одновременной активации двух раундов (блокировка активной строки +
// частичный уникальный индекс в БД). Если запускать нечего - вернёт null,
// а не бросит ошибку, чтобы вызывающий код мог просто продолжить работу.
async function autoStartEligibleDraftTx(client, now = new Date()) {
    const eligible = await client.query(
        `SELECT id FROM rounds
         WHERE status = 'draft' AND starts_at <= $1 AND ends_at > $1
         ORDER BY starts_at ASC, id ASC
         LIMIT 1`,
        [now]
    );
    if (eligible.rows.length === 0) {
        return null;
    }
    try {
        return await startRoundTx(client, eligible.rows[0].id);
    } catch (err) {
        if (err.message === "ANOTHER_ROUND_ACTIVE" || err.message === "ROUND_NOT_DRAFT") {
            return null;
        }
        throw err;
    }
}

// Завершает раунд и сохраняет его финальное состояние в архив.
// Пиксели раунда никогда не удаляются - они остаются в таблице pixels
// под своим round_id, поэтому финальный холст не может быть потерян.
async function finishRound(client, { roundId, preview, pixelCount, buildArchive }) {
    // Берём эксклюзивную блокировку до рендера финального PNG. Обычная
    // постановка пикселя берёт FOR SHARE, поэтому завершение ждёт уже
    // начатые записи, а новые после блокировки будут отклонены.
    const locked = await client.query(
        "SELECT * FROM rounds WHERE id = $1 AND status = 'active' FOR UPDATE",
        [roundId]
    );
    if (locked.rows.length === 0) {
        throw new Error("ROUND_NOT_ACTIVE");
    }

    if (typeof buildArchive === "function") {
        const archive = await buildArchive(locked.rows[0], client);
        preview = archive && archive.preview;
        pixelCount = archive && archive.pixelCount;
    }

    if (!preview || !Number.isInteger(pixelCount) || pixelCount < 0) {
        throw new Error("INVALID_ARCHIVE");
    }

    const res = await client.query(
        "UPDATE rounds SET status = 'finished', finished_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'active' RETURNING *",
        [roundId]
    );
    if (res.rows.length === 0) {
        throw new Error("ROUND_NOT_ACTIVE");
    }
    await client.query(
        "INSERT INTO round_archives (round_id, preview, pixel_count) VALUES ($1, $2, $3) " +
        "ON CONFLICT (round_id) DO UPDATE SET preview = EXCLUDED.preview, pixel_count = EXCLUDED.pixel_count, created_at = CURRENT_TIMESTAMP",
        [roundId, preview, pixelCount]
    );
    return res.rows[0];
}

module.exports = {
    STATUSES,
    isValidPalette,
    isColorInPalette,
    normalizeRoundInput,
    assertPixelAllowed,
    normalizeRoundPixelImport,
    startRoundTx,
    autoStartEligibleDraftTx,
    finishRound
};
