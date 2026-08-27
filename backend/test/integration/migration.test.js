"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./harness");

// Воссоздаёт схему БД такой, какой она была до системы раундов (глобальный
// холст без round_id), и засеивает её данными - чтобы проверить, что
// server.js::initDatabase() безопасно переносит их в архивный раунд.
async function seedLegacySchema(pool) {
    await pool.query(`
        CREATE TABLE pixels (
            x INT, y INT, color VARCHAR(10) NOT NULL, user_id VARCHAR(50) NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (x, y)
        )
    `);
    await pool.query(`
        CREATE TABLE settings (
            id INT PRIMARY KEY, canvas_size INT NOT NULL, cooldown INT NOT NULL,
            grid_enabled BOOLEAN NOT NULL, bg_color VARCHAR(10) DEFAULT '#1f2937'
        )
    `);
    await pool.query(`CREATE TABLE users (user_id VARCHAR(50) PRIMARY KEY, last_placed_at BIGINT NOT NULL)`);
    await pool.query(`
        CREATE TABLE moderators (
            username VARCHAR(50) PRIMARY KEY, password VARCHAR(100) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE admin_logs (
            id SERIAL PRIMARY KEY, action VARCHAR(100) NOT NULL, details JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE pixel_history (
            id SERIAL PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL,
            color VARCHAR(50) NOT NULL, user_id VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE snapshots (
            id SERIAL PRIMARY KEY, data BYTEA NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(
        "INSERT INTO settings (id, canvas_size, cooldown, grid_enabled, bg_color) VALUES (1, 50, 2, true, '#1f2937')"
    );
    await pool.query(`
        INSERT INTO pixels (x, y, color, user_id) VALUES
            (0, 0, '#ff0000', 'u_legacy1'),
            (1, 1, '#00ff00', 'u_legacy2'),
            (49, 49, '#0000ff', 'u_legacy3')
    `);
    await pool.query(`
        INSERT INTO pixel_history (x, y, color, user_id, created_at) VALUES
            (0, 0, '#ff0000', 'u_legacy1', NOW() - INTERVAL '2 days'),
            (1, 1, '#00ff00', 'u_legacy2', NOW() - INTERVAL '1 day'),
            (49, 49, '#0000ff', 'u_legacy3', NOW())
    `);
    await pool.query(
        "INSERT INTO snapshots (data, created_at) VALUES ('\\x89504e470d0a1a0a', NOW() - INTERVAL '1 day')"
    );
}

test("legacy pre-rounds schema is migrated into an archived round without losing data", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_migration",
        beforeStart: seedLegacySchema
    });
    t.after(() => server.stop());

    const roundsRes = await server.pool.query("SELECT * FROM rounds");
    assert.equal(roundsRes.rows.length, 1, "exactly one legacy round was created");
    const legacyRound = roundsRes.rows[0];
    assert.equal(legacyRound.status, "finished", "the legacy round is archived as finished, not left active");
    assert.equal(legacyRound.canvas_size, 50, "canvas size carried over from the old settings table");
    assert.ok(Array.isArray(legacyRound.palette) && legacyRound.palette.length > 0, "a default palette was assigned");

    const pixelsRes = await server.pool.query("SELECT round_id, x, y, color FROM pixels ORDER BY x, y");
    assert.equal(pixelsRes.rows.length, 3, "no pixels were lost");
    for (const pixel of pixelsRes.rows) {
        assert.equal(pixel.round_id, legacyRound.id, "every old pixel is attached to the legacy round");
    }
    assert.deepEqual(
        pixelsRes.rows.map(p => p.color),
        ["#ff0000", "#00ff00", "#0000ff"],
        "pixel colors are preserved exactly"
    );

    const historyRes = await server.pool.query("SELECT COUNT(*)::int AS c FROM pixel_history WHERE round_id = $1", [legacyRound.id]);
    assert.equal(historyRes.rows[0].c, 3, "pixel history rows were preserved and attached to the legacy round");

    const snapshotsRes = await server.pool.query("SELECT COUNT(*)::int AS c FROM snapshots WHERE round_id = $1", [legacyRound.id]);
    assert.equal(snapshotsRes.rows[0].c, 1, "the pre-existing snapshot was preserved and attached to the legacy round");

    const archiveRes = await server.pool.query(
        "SELECT pixel_count, length(preview) AS preview_bytes FROM round_archives WHERE round_id = $1",
        [legacyRound.id]
    );
    assert.equal(archiveRes.rows.length, 1, "a round_archives row (PNG preview) was created for the legacy round");
    assert.equal(archiveRes.rows[0].pixel_count, 3);
    assert.ok(archiveRes.rows[0].preview_bytes > 0, "the preview PNG is non-empty");
});

test("migration is idempotent: restarting the server against the same DB does not duplicate the legacy round", { timeout: 30000 }, async (t) => {
    // Первый запуск: свежая БД с legacy-схемой, сервер должен смигрировать её.
    const first = await startTestServer({
        dbPrefix: "pixelbattle_it_migration_idem",
        beforeStart: seedLegacySchema,
        dropOnStop: false // база нужна для второго запуска ниже
    });
    const dbName = first.dbName;

    const firstRun = await first.pool.query("SELECT id, status FROM rounds");
    assert.equal(firstRun.rows.length, 1, "first run creates exactly one legacy round");
    const legacyRoundId = firstRun.rows[0].id;

    await first.stop();

    // Второй запуск сервера на ТОЙ ЖЕ уже смигрированной БД (без повторного
    // сидирования legacy-схемы) - должен быть чистым no-op для миграции.
    const second = await startTestServer({ dbName, dropOnStop: true });
    t.after(() => second.stop());

    const secondRun = await second.pool.query("SELECT id FROM rounds");
    assert.equal(secondRun.rows.length, 1, "re-running the migration does not create a second legacy round");
    assert.equal(secondRun.rows[0].id, legacyRoundId, "the same legacy round is reused, not recreated");

    const pixelsRes = await second.pool.query("SELECT COUNT(*)::int AS c FROM pixels WHERE round_id = $1", [legacyRoundId]);
    assert.equal(pixelsRes.rows[0].c, 3, "pixels are still intact after the idempotent re-run");
});
