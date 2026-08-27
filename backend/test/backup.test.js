const test = require("node:test");
const assert = require("node:assert/strict");
const {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    serializeBackup,
    validateBackup,
    restoreBackupTx,
    looksLikePng
} = require("../lib/backup");

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000", "hex");
const PNG_BASE64 = PNG_BYTES.toString("base64");

function baseRound(overrides = {}) {
    return {
        id: 1,
        name: "Round one",
        description: null,
        status: "finished",
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: "2026-01-02T00:00:00.000Z",
        canvas_size: 10,
        cooldown: 2,
        bg_color: "#111111",
        grid_enabled: true,
        palette: ["#ff0000", "#00ff00"],
        activated_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-02T00:00:00.000Z",
        created_at: "2025-12-31T00:00:00.000Z",
        ...overrides
    };
}

function validBackup(overrides = {}) {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: "2026-01-03T00:00:00.000Z",
        data: {
            rounds: [baseRound()],
            pixels: [{ round_id: 1, x: 1, y: 1, color: "#ff0000", user_id: "u1", updated_at: "2026-01-01T12:00:00.000Z" }],
            pixel_history: [{ id: 9, round_id: 1, x: 1, y: 1, color: "#ff0000", user_id: "u1", created_at: "2026-01-01T12:00:00.000Z" }],
            snapshots: [{ id: 3, round_id: 1, data_base64: PNG_BASE64, created_at: "2026-01-01T13:00:00.000Z" }],
            round_archives: [{ round_id: 1, preview_base64: PNG_BASE64, pixel_count: 1, created_at: "2026-01-02T00:00:00.000Z" }]
        },
        ...overrides
    };
}

test("looksLikePng recognizes the PNG magic number", () => {
    assert.equal(looksLikePng(PNG_BYTES), true);
    assert.equal(looksLikePng(Buffer.from("not a png")), false);
    assert.equal(looksLikePng(Buffer.alloc(0)), false);
});

test("validateBackup accepts a well-formed backup", () => {
    const result = validateBackup(validBackup());
    assert.equal(result.ok, true);
    assert.equal(result.value.rounds.length, 1);
    assert.equal(result.value.pixels.length, 1);
    assert.equal(result.value.snapshots[0].data.equals(PNG_BYTES), true);
    assert.equal(result.value.roundArchives[0].preview.equals(PNG_BYTES), true);
});

test("validateBackup rejects wrong format or version", () => {
    assert.equal(validateBackup(validBackup({ format: "something-else" })).ok, false);
    assert.equal(validateBackup(validBackup({ version: 2 })).ok, false);
    assert.equal(validateBackup(validBackup({ version: "1" })).ok, false, "version must be the number 1, not a string");
});

test("validateBackup rejects a missing or malformed exported_at", () => {
    assert.equal(validateBackup(validBackup({ exported_at: undefined })).ok, false);
    assert.equal(validateBackup(validBackup({ exported_at: "not-a-date" })).ok, false);
});

test("validateBackup rejects non-object input and missing data", () => {
    assert.equal(validateBackup(null).ok, false);
    assert.equal(validateBackup("a string").ok, false);
    assert.equal(validateBackup([]).ok, false);
    const backup = validBackup();
    delete backup.data;
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects data fields that are not arrays", () => {
    const backup = validBackup();
    backup.data.pixels = "not an array";
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects more than one active round", () => {
    const backup = validBackup({
        data: {
            rounds: [
                baseRound({ id: 1, status: "active" }),
                baseRound({ id: 2, status: "active" })
            ],
            pixels: [], pixel_history: [], snapshots: [], round_archives: []
        }
    });
    const result = validateBackup(backup);
    assert.equal(result.ok, false);
    assert.match(result.error, /активн/i);
});

test("validateBackup accepts exactly one active round", () => {
    const backup = validBackup({
        data: {
            rounds: [baseRound({ id: 1, status: "active", finished_at: null })],
            pixels: [], pixel_history: [], snapshots: [], round_archives: []
        }
    });
    assert.equal(validateBackup(backup).ok, true);
});

test("validateBackup rejects duplicate round ids", () => {
    const backup = validBackup({
        data: {
            rounds: [baseRound({ id: 1 }), baseRound({ id: 1 })],
            pixels: [], pixel_history: [], snapshots: [], round_archives: []
        }
    });
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects a pixel referencing an unknown round_id", () => {
    const backup = validBackup();
    backup.data.pixels[0].round_id = 999;
    const result = validateBackup(backup);
    assert.equal(result.ok, false);
    assert.match(result.error, /round_id/);
});

test("validateBackup rejects a pixel outside its round's canvas bounds", () => {
    const backup = validBackup();
    backup.data.pixels[0].x = 999;
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects an invalid pixel color", () => {
    const backup = validBackup();
    backup.data.pixels[0].color = "not-a-color";
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects duplicate pixels at the same coordinates within a round", () => {
    const backup = validBackup();
    backup.data.pixels.push({ ...backup.data.pixels[0] });
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects an invalid round palette", () => {
    const backup = validBackup({
        data: {
            rounds: [baseRound({ palette: [] })],
            pixels: [], pixel_history: [], snapshots: [], round_archives: []
        }
    });
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects pixel_history with a non-existent round_id", () => {
    const backup = validBackup();
    backup.data.pixel_history[0].round_id = 42;
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects duplicate pixel_history ids", () => {
    const backup = validBackup();
    backup.data.pixel_history.push({ ...backup.data.pixel_history[0] });
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects malformed base64 in a snapshot", () => {
    const backup = validBackup();
    backup.data.snapshots[0].data_base64 = "not base64 at all!!!";
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup rejects base64 that decodes to bytes without the PNG magic number", () => {
    const backup = validBackup();
    backup.data.snapshots[0].data_base64 = Buffer.from("hello world").toString("base64");
    const result = validateBackup(backup);
    assert.equal(result.ok, false);
    assert.match(result.error, /PNG/);
});

test("validateBackup rejects a round_archives row for a round that isn't finished", () => {
    const backup = validBackup({
        data: {
            rounds: [baseRound({ status: "draft", finished_at: null, activated_at: null })],
            pixels: [], pixel_history: [],
            snapshots: [],
            round_archives: [{ round_id: 1, preview_base64: PNG_BASE64, pixel_count: 0, created_at: "2026-01-01T00:00:00.000Z" }]
        }
    });
    const result = validateBackup(backup);
    assert.equal(result.ok, false);
    assert.match(result.error, /завершён/);
});

test("validateBackup rejects duplicate round_archives for the same round", () => {
    const backup = validBackup();
    backup.data.round_archives.push({ ...backup.data.round_archives[0] });
    assert.equal(validateBackup(backup).ok, false);
});

test("validateBackup enforces the configured byte-size limit", () => {
    const result = validateBackup(validBackup(), { maxBytes: 10, rawByteLength: 999999 });
    assert.equal(result.ok, false);
    assert.match(result.error, /размер/);
});

test("validateBackup accepts a backup with several rounds, well under the row-count cap", () => {
    const fewRounds = Array.from({ length: 5 }, (_, i) => baseRound({ id: i + 1, status: "finished" }));
    const backup = validBackup({ data: { rounds: fewRounds, pixels: [], pixel_history: [], snapshots: [], round_archives: [] } });
    assert.equal(validateBackup(backup).ok, true);
});

function makeMockClient(queryImpl) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            return queryImpl ? queryImpl(sql, params, calls.length) : { rows: [] };
        }
    };
}

test("restoreBackupTx deletes dependents before base tables and inserts rounds before children", async () => {
    const client = makeMockClient();
    const validated = validateBackup(validBackup()).value;
    const summary = await restoreBackupTx(client, validated);

    assert.deepEqual(summary, { rounds: 1, pixels: 1, pixelHistory: 1, snapshots: 1, roundArchives: 1 });

    const sqlList = client.calls.map(c => c.sql);
    const indexOf = (pattern) => sqlList.findIndex(sql => pattern.test(sql));

    assert.equal(indexOf(/^LOCK TABLE/), 0, "acquires the exclusive lock first");

    const deleteArchives = indexOf(/^DELETE FROM round_archives/);
    const deleteSnapshots = indexOf(/^DELETE FROM snapshots/);
    const deleteHistory = indexOf(/^DELETE FROM pixel_history/);
    const deletePixels = indexOf(/^DELETE FROM pixels/);
    const deleteRounds = indexOf(/^DELETE FROM rounds/);
    const insertRounds = indexOf(/^INSERT INTO rounds/);
    const insertPixels = indexOf(/^INSERT INTO pixels/);
    const insertHistory = indexOf(/^INSERT INTO pixel_history/);
    const insertSnapshots = indexOf(/^INSERT INTO snapshots/);
    const insertArchives = indexOf(/^INSERT INTO round_archives/);

    for (const i of [deleteArchives, deleteSnapshots, deleteHistory, deletePixels, deleteRounds, insertRounds, insertPixels, insertHistory, insertSnapshots, insertArchives]) {
        assert.notEqual(i, -1, "expected statement not found");
    }

    // Dependents deleted before the rounds table itself.
    assert.ok(deleteArchives < deleteRounds);
    assert.ok(deleteSnapshots < deleteRounds);
    assert.ok(deleteHistory < deleteRounds);
    assert.ok(deletePixels < deleteRounds);
    // All deletes happen before any inserts.
    assert.ok(deleteRounds < insertRounds);
    // rounds inserted before anything that references round_id.
    assert.ok(insertRounds < insertPixels);
    assert.ok(insertRounds < insertHistory);
    assert.ok(insertRounds < insertSnapshots);
    assert.ok(insertRounds < insertArchives);

    // Sequences are reset only after all inserts.
    const sequenceResets = sqlList.filter(sql => sql.includes("setval"));
    assert.equal(sequenceResets.length, 3, "resets rounds, pixel_history and snapshots sequences");
    const lastInsert = Math.max(insertRounds, insertPixels, insertHistory, insertSnapshots, insertArchives);
    const firstSetval = indexOf(/setval/);
    assert.ok(firstSetval > lastInsert);
});

test("restoreBackupTx never touches session, moderators, users, settings or admin_logs", async () => {
    const client = makeMockClient();
    const validated = validateBackup(validBackup()).value;
    await restoreBackupTx(client, validated);

    const forbiddenTables = ["session", "moderators", "users", "settings", "admin_logs"];
    for (const call of client.calls) {
        for (const table of forbiddenTables) {
            assert.ok(
                !new RegExp(`\\b${table}\\b`, "i").test(call.sql),
                `restoreBackupTx must never reference "${table}", but ran: ${call.sql}`
            );
        }
    }
});

test("restoreBackupTx with empty tables still resets sequences without deleting rows it doesn't have", async () => {
    const client = makeMockClient();
    const emptyBackup = validBackup({ data: { rounds: [], pixels: [], pixel_history: [], snapshots: [], round_archives: [] } });
    const validated = validateBackup(emptyBackup).value;
    const summary = await restoreBackupTx(client, validated);
    assert.deepEqual(summary, { rounds: 0, pixels: 0, pixelHistory: 0, snapshots: 0, roundArchives: 0 });
    // No INSERT statements should have been issued for empty tables.
    assert.equal(client.calls.some(c => c.sql.startsWith("INSERT INTO rounds")), false);
});

test("serializeBackup round-trips binary fields exactly through validateBackup", () => {
    const rows = {
        rounds: [{
            id: 1, name: "R", description: "d", status: "finished",
            starts_at: new Date("2026-01-01T00:00:00Z"), ends_at: new Date("2026-01-02T00:00:00Z"),
            canvas_size: 5, cooldown: 1, bg_color: "#000000", grid_enabled: false, palette: ["#abcdef"],
            activated_at: new Date("2026-01-01T00:00:00Z"), finished_at: new Date("2026-01-02T00:00:00Z"),
            created_at: new Date("2025-12-31T00:00:00Z")
        }],
        pixels: [],
        pixelHistory: [],
        snapshots: [{ id: 1, round_id: 1, data: PNG_BYTES, created_at: new Date() }],
        roundArchives: [{ round_id: 1, preview: PNG_BYTES, pixel_count: 0, created_at: new Date() }]
    };
    const backup = serializeBackup(rows);
    const result = validateBackup(backup);
    assert.equal(result.ok, true);
    assert.equal(result.value.snapshots[0].data.equals(PNG_BYTES), true);
    assert.equal(result.value.roundArchives[0].preview.equals(PNG_BYTES), true);
});
