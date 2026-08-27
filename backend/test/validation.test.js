const test = require("node:test");
const assert = require("node:assert/strict");
const {
    isValidColor,
    normalizeSettings,
    normalizeImportPayload,
    normalizeRollbackPayload
} = require("../lib/validation");

const currentSettings = {
    canvas_size: 50,
    cooldown: 2,
    grid_enabled: true,
    bg_color: "#1f2937"
};

test("accepts only six-digit hex colors", () => {
    assert.equal(isValidColor("#a1B2c3"), true);
    assert.equal(isValidColor("red"), false);
    assert.equal(isValidColor("#123"), false);
});

test("normalizes valid canvas settings and rejects unsafe bounds", () => {
    assert.deepEqual(
        normalizeSettings({ canvas_size: 80, cooldown: 5, grid_enabled: false, bg_color: "#abcdef" }, currentSettings),
        { canvas_size: 80, cooldown: 5, grid_enabled: false, bg_color: "#abcdef" }
    );
    assert.equal(normalizeSettings({ canvas_size: 1001 }, currentSettings), null);
});

test("rejects malformed or duplicate pixels during import", () => {
    const valid = normalizeImportPayload({
        pixels: [{ x: 0, y: 1, color: "#abcdef", user_id: "u_1" }],
        settings: currentSettings
    }, currentSettings);
    assert.equal(valid.ok, true);

    const duplicate = normalizeImportPayload({
        pixels: [
            { x: 0, y: 1, color: "#abcdef" },
            { x: 0, y: 1, color: "#abcdef" }
        ],
        settings: currentSettings
    }, currentSettings);
    assert.equal(duplicate.ok, false);

    const malformed = normalizeImportPayload({
        pixels: [{ x: 0, y: 1, color: "invalid" }],
        settings: currentSettings
    }, currentSettings);
    assert.equal(malformed.ok, false);
});

test("limits rollback to valid coordinates and retained history", () => {
    assert.deepEqual(
        normalizeRollbackPayload({ x1: 10, y1: 9, x2: 2, y2: 3, timeAgoMinutes: 60 }, 50),
        { x1: 2, y1: 3, x2: 10, y2: 9, timeAgoMinutes: 60 }
    );
    assert.equal(normalizeRollbackPayload({ x1: 0, y1: 0, x2: 1, y2: 1, timeAgoMinutes: 3000 }, 50), null);
});
