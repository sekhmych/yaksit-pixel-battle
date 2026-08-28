"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, waitUntil, sleep } = require("./harness");

const DEFAULT_PALETTE = JSON.stringify(["#000000", "#ffffff"]);

test("SIGTERM during initDatabase() waits for it to settle, never starts the HTTP listener, and exits 0", { timeout: 30000 }, async (t) => {
    // TEST_INIT_DB_DELAY_MS pauses initDatabase() right after it has
    // acquired its PostgreSQL client but before running any migration -
    // this reliably opens a window in which we can send SIGTERM while
    // startup is genuinely still in progress (not just "the process is
    // slow to boot" - it is provably holding a DB client and about to run
    // SQL). waitForStartup: false skips the harness's normal /health poll,
    // since that poll would otherwise just wait out the whole startup.
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_startup_sigterm",
        waitForStartup: false,
        extraEnv: { TEST_INIT_DB_DELAY_MS: "2000" }
    });
    t.after(() => server.stop());

    // Give initDatabase() time to connect and enter the artificial delay.
    await sleep(500);

    const openBeforeSignal = await server.isPortOpen();
    assert.equal(openBeforeSignal, false, "the HTTP listener must not be up yet - otherwise this test would not actually be racing startup");

    server.signal("SIGTERM");

    // Poll for the listener coming up AT ANY POINT while shutdown runs -
    // not just a single before/after snapshot - to prove it never opens,
    // not merely that it happens to be closed at the two instants we check.
    let everListened = false;
    let polling = true;
    (async () => {
        while (polling) {
            if (await server.isPortOpen()) everListened = true;
            await sleep(75);
        }
    })();

    const exitInfo = await server.waitForExit(20000);
    polling = false;

    assert.equal(exitInfo.code, 0, "graceful shutdown that has to wait out an in-progress startup still exits 0");
    assert.equal(exitInfo.signal, null);
    assert.equal(everListened, false, "the HTTP listener must never start once shutdown has begun, even transiently");

    const { stdout, stderr } = server.getLogs();
    const combined = stdout + stderr;
    assert.equal(/Cannot use a pool after calling end/i.test(combined), false, "PostgreSQL pool must never be used after being closed");
    assert.match(combined, /Получен SIGTERM/, "the shutdown handler actually ran");
});

test("a startup failure (initDatabase() throwing) closes the pool, never listens, and exits 1", { timeout: 20000 }, async (t) => {
    // TEST_INIT_DB_FAIL deterministically fails initDatabase() after it has
    // connected - only honored when NODE_ENV=test (always true for the
    // harness's spawned servers), so production never depends on this hook.
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_startup_fail",
        waitForStartup: false,
        extraEnv: { TEST_INIT_DB_FAIL: "1" }
    });
    t.after(() => server.stop());

    const exitInfo = await server.waitForExit(15000);
    assert.equal(exitInfo.code, 1, "a genuine startup failure (no SIGTERM involved) exits with a non-zero code");
    assert.equal(exitInfo.signal, null);

    const stillOpen = await server.isPortOpen();
    assert.equal(stillOpen, false, "the HTTP listener never starts after a failed initialization");

    const { stdout, stderr } = server.getLogs();
    const combined = stdout + stderr;
    assert.match(combined, /TEST_INIT_DB_FAIL/, "the actual failure reason is logged");
    assert.equal(/Cannot use a pool after calling end/i.test(combined), false, "the pool is closed exactly once, cleanly, by the failure path");
});

test("background tasks (round sync) never run before initDatabase() finishes, even with a very short sync interval", { timeout: 45000 }, async (t) => {
    // Bootstrap a throwaway server first just to create the schema (the
    // `rounds` table doesn't exist until initDatabase() runs its
    // migrations) - dropOnStop: false keeps the database alive for the
    // real test below, which reuses it via options.dbName.
    const bootstrap = await startTestServer({ dbPrefix: "pixelbattle_it_bg_tasks", dropOnStop: false });
    const dbName = bootstrap.dbName;
    await bootstrap.stop();

    const now = Date.now();
    const roundName = "Must not auto-start during init";

    // Second boot, against the now-existing schema: seed an eligible draft
    // (starts_at already in the past) via beforeStart - which runs BEFORE
    // this process even spawns - then delay initDatabase() and use an
    // aggressively short ROUND_SYNC_INTERVAL_MS. If startBackgroundTasks()
    // ran even one tick early, this draft would already be 'active' by the
    // time we check - a real DB side effect, not a log/flag guess.
    const server = await startTestServer({
        dbName,
        dropOnStop: true,
        waitForStartup: false,
        roundSyncIntervalMs: 100,
        extraEnv: { TEST_INIT_DB_DELAY_MS: "2000" },
        beforeStart: async (pool) => {
            await pool.query(
                `INSERT INTO rounds (name, description, status, starts_at, ends_at, canvas_size, cooldown, bg_color, grid_enabled, palette)
                 VALUES ($1, NULL, 'draft', $2, $3, $4, $5, '#111111', true, $6::jsonb)`,
                [roundName, new Date(now - 60 * 1000), new Date(now + 3600 * 1000), 20, 1, DEFAULT_PALETTE]
            );
        }
    });
    t.after(() => server.stop());

    // Comfortably inside the 2s init delay - if the 100ms sync interval had
    // wrongly already been ticking, there would have been ~10 chances to
    // wrongly auto-start this draft by now.
    await sleep(1000);
    const midInit = await server.pool.query("SELECT status FROM rounds WHERE name = $1", [roundName]);
    assert.equal(midInit.rows[0].status, "draft", "round sync must not touch the database while initDatabase() is still running");

    // Let startup actually finish and confirm the sync interval really is
    // wired up correctly once the app is ready - otherwise the assertion
    // above would trivially (and uselessly) pass on a permanently broken
    // scheduler.
    await server.waitForReady(15000);
    await waitUntil(async () => {
        const res = await server.pool.query("SELECT status FROM rounds WHERE name = $1", [roundName]);
        return res.rows[0].status === "active";
    }, { timeoutMs: 8000, message: "the draft becomes active once startup has actually completed" });
});
