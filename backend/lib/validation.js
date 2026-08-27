"use strict";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MIN_CANVAS_SIZE = 10;
const MAX_CANVAS_SIZE = 1000;
const MIN_COOLDOWN = 0;
const MAX_COOLDOWN = 3600;
const MAX_ROLLBACK_MINUTES = 48 * 60;

function isValidColor(value) {
    return typeof value === "string" && HEX_COLOR_RE.test(value);
}

function isValidCoordinate(value, canvasSize) {
    return Number.isInteger(value) && value >= 0 && value < canvasSize;
}

function normalizeSettings(input, fallback) {
    const source = input && typeof input === "object" ? input : {};

    const settings = {
        canvas_size: Number.isInteger(source.canvas_size) ? source.canvas_size : fallback.canvas_size,
        cooldown: Number.isInteger(source.cooldown) ? source.cooldown : fallback.cooldown,
        grid_enabled: typeof source.grid_enabled === "boolean" ? source.grid_enabled : fallback.grid_enabled,
        bg_color: isValidColor(source.bg_color) ? source.bg_color : fallback.bg_color
    };

    if (
        settings.canvas_size < MIN_CANVAS_SIZE ||
        settings.canvas_size > MAX_CANVAS_SIZE ||
        settings.cooldown < MIN_COOLDOWN ||
        settings.cooldown > MAX_COOLDOWN
    ) {
        return null;
    }

    return settings;
}

function normalizeImportPayload(data, currentSettings) {
    if (!data || typeof data !== "object" || !Array.isArray(data.pixels)) {
        return { ok: false, error: "Invalid import payload." };
    }

    const settings = normalizeSettings(data.settings, currentSettings);
    if (!settings) {
        return { ok: false, error: "Invalid import settings." };
    }

    const maxPixelCount = settings.canvas_size * settings.canvas_size;
    if (data.pixels.length > maxPixelCount) {
        return { ok: false, error: "Too many pixels for the selected canvas size." };
    }

    const coordinates = new Set();
    const pixels = [];

    for (const pixel of data.pixels) {
        if (
            !pixel ||
            typeof pixel !== "object" ||
            !isValidCoordinate(pixel.x, settings.canvas_size) ||
            !isValidCoordinate(pixel.y, settings.canvas_size) ||
            !isValidColor(pixel.color)
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

    return { ok: true, value: { pixels, settings } };
}

function normalizeRollbackPayload(data, canvasSize) {
    if (!data || typeof data !== "object") return null;

    const { x1, y1, x2, y2, timeAgoMinutes } = data;
    if (
        !isValidCoordinate(x1, canvasSize) ||
        !isValidCoordinate(y1, canvasSize) ||
        !isValidCoordinate(x2, canvasSize) ||
        !isValidCoordinate(y2, canvasSize) ||
        !Number.isInteger(timeAgoMinutes) ||
        timeAgoMinutes < 1 ||
        timeAgoMinutes > MAX_ROLLBACK_MINUTES
    ) {
        return null;
    }

    return {
        x1: Math.min(x1, x2),
        y1: Math.min(y1, y2),
        x2: Math.max(x1, x2),
        y2: Math.max(y1, y2),
        timeAgoMinutes
    };
}

module.exports = {
    HEX_COLOR_RE,
    isValidColor,
    isValidCoordinate,
    normalizeSettings,
    normalizeImportPayload,
    normalizeRollbackPayload
};
