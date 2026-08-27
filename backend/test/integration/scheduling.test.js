"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withTransaction } = require("../../lib/transaction");
const { autoStartEligibleDraftTx } = require("../../lib/rounds");
const { startTestServer, waitUntil } = require("./harness");

const DEFAULT_PALETTE = JSON.stringify(["#000000", "#ffffff"]);

async function insertDraft(pool, { name, startsAt, endsAt, canvasSize = 20, cooldown = 1 }) {
    const res = await pool.query(
        `INSERT INTO rounds (name, description, status, starts_at, ends_at, canvas_size, cooldown, bg_color, grid_enabled, palette)
         VALUES ($1, NULL, 'draft', $2, $3, $4, $5, '#111111', true, $6::jsonb)
         RETURNING id`,
        [name, startsAt, endsAt, canvasSize, cooldown, DEFAULT_PALETTE]
    );
    return res.rows[0].id;
}

async function roundStatus(pool, id) {
    const res = await pool.query("SELECT status FROM rounds WHERE id = $1", [id]);
    return res.rows[0] && res.rows[0].status;
}

test("clean database: auto-start activates a draft whose time has come", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_clean" });
    t.after(() => server.stop());

    const now = Date.now();
    const draftId = await insertDraft(server.pool, {
        name: "Due draft",
        startsAt: new Date(now - 60 * 1000),
        endsAt: new Date(now + 60 * 60 * 1000)
    });

    await waitUntil(
        async () => (await roundStatus(server.pool, draftId)) === "active",
        { timeoutMs: 8000, message: "draft becomes active" }
    );

    const activeRes = await server.pool.query("SELECT COUNT(*)::int AS c FROM rounds WHERE status = 'active'");
    assert.equal(activeRes.rows[0].c, 1, "exactly one round is active");

    const logsRes = await server.pool.query(
        "SELECT action, details FROM admin_logs WHERE action = 'AUTO_START_ROUND' ORDER BY id DESC LIMIT 1"
    );
    assert.equal(logsRes.rows.length, 1, "AUTO_START_ROUND is logged");
    assert.equal(logsRes.rows[0].details.roundId, draftId);
});

test("competing drafts: only the earliest eligible draft is activated", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_compete" });
    t.after(() => server.stop());

    const now = Date.now();
    const earlierId = await insertDraft(server.pool, {
        name: "Earlier draft",
        startsAt: new Date(now - 5 * 60 * 1000),
        endsAt: new Date(now + 60 * 60 * 1000)
    });
    const laterId = await insertDraft(server.pool, {
        name: "Later draft",
        startsAt: new Date(now - 1 * 60 * 1000),
        endsAt: new Date(now + 60 * 60 * 1000)
    });

    await waitUntil(
        async () => (await roundStatus(server.pool, earlierId)) === "active",
        { timeoutMs: 8000, message: "the earlier-starting draft becomes active" }
    );

    // Даём синхронизации ещё пару циклов, чтобы убедиться, что второй
    // черновик не будет тоже активирован следом.
    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.equal(await roundStatus(server.pool, laterId), "draft", "the later draft is left alone");

    const activeRes = await server.pool.query("SELECT COUNT(*)::int AS c FROM rounds WHERE status = 'active'");
    assert.equal(activeRes.rows[0].c, 1, "the single-active-round invariant holds");
});

test("expired draft: a draft whose ends_at already passed is never auto-started", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_expired" });
    t.after(() => server.stop());

    const now = Date.now();
    const expiredId = await insertDraft(server.pool, {
        name: "Expired draft",
        startsAt: new Date(now - 2 * 60 * 60 * 1000),
        endsAt: new Date(now - 60 * 1000)
    });

    // Ждём несколько циклов синхронизации - статус должен остаться draft.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(await roundStatus(server.pool, expiredId), "draft", "an expired draft stays a draft, not active or finished");

    const activeRes = await server.pool.query("SELECT COUNT(*)::int AS c FROM rounds WHERE status = 'active'");
    assert.equal(activeRes.rows[0].c, 0, "nothing was activated");
});

test("concurrent auto-start attempts against the same due draft activate it exactly once", { timeout: 30000 }, async (t) => {
    // Раунды с фоновой синхронизацией сервера здесь не нужны - тест бьёт
    // напрямую по транзакционной функции с двух параллельных соединений,
    // чтобы проверить настоящую защиту от гонки на уровне PostgreSQL
    // (блокировка строки + WHERE status = 'draft'), а не только то, что
    // единственный процесс не запускает два раунда подряд.
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_race", roundSyncIntervalMs: 3600000 });
    t.after(() => server.stop());

    const now = Date.now();
    const dueId = await insertDraft(server.pool, {
        name: "Contested draft",
        startsAt: new Date(now - 60 * 1000),
        endsAt: new Date(now + 60 * 60 * 1000)
    });

    const attempt = () => withTransaction(server.pool, (client) => autoStartEligibleDraftTx(client));
    const [resultA, resultB] = await Promise.all([attempt(), attempt()]);

    const winners = [resultA, resultB].filter(Boolean);
    assert.equal(winners.length, 1, "exactly one of the two concurrent attempts wins");
    assert.equal(winners[0].id, dueId);

    const activeRes = await server.pool.query("SELECT COUNT(*)::int AS c FROM rounds WHERE status = 'active'");
    assert.equal(activeRes.rows[0].c, 1, "the single-active-round invariant holds under real concurrency");
});
