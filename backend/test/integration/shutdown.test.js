"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, adminSession, httpGet, httpRequest, waitUntil, sleep } = require("./harness");
const { BACKUP_FORMAT, BACKUP_VERSION } = require("../../lib/backup");

test("liveness and readiness report the correct structure while the server is up", { timeout: 15000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_health" });
    t.after(() => server.stop());

    const health = await httpGet(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok" });

    const ready = await httpGet(`${server.baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(JSON.parse(ready.body), { status: "ready" });
});

test("readiness reports 503 when PostgreSQL is unavailable, while liveness stays 200", { timeout: 15000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_ready_db" });
    t.after(() => server.stop());

    const before = await httpGet(`${server.baseUrl}/ready`);
    assert.equal(before.status, 200, "sanity check: ready before the simulated outage");

    // Deterministic fault injection, only reachable because NODE_ENV=test in
    // this harness - production never registers this route at all, so
    // there is nothing for production code to depend on here.
    const toggleOn = await httpRequest("POST", `${server.baseUrl}/__test__/force-db-down`, { body: { down: true } });
    assert.equal(toggleOn.status, 200);

    const ready = await httpGet(`${server.baseUrl}/ready`);
    assert.equal(ready.status, 503);
    const readyBody = JSON.parse(ready.body);
    assert.deepEqual(readyBody, { status: "not_ready" });
    assert.equal(JSON.stringify(readyBody).toLowerCase().includes("select"), false, "no raw PostgreSQL error text leaks to the client");

    // The process itself is still alive - only readiness, not liveness, is
    // affected by a database outage.
    const health = await httpGet(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok" });

    // And it recovers as soon as the simulated outage is lifted.
    const toggleOff = await httpRequest("POST", `${server.baseUrl}/__test__/force-db-down`, { body: { down: false } });
    assert.equal(toggleOff.status, 200);
    const readyAgain = await httpGet(`${server.baseUrl}/ready`);
    assert.equal(readyAgain.status, 200);
    assert.deepEqual(JSON.parse(readyAgain.body), { status: "ready" });
});

test("SIGTERM waits for an in-flight game operation to finish, its write lands in PostgreSQL, then the process exits 0", { timeout: 30000 }, async (t) => {
    // TEST_GAME_OP_DELAY_MS pauses every withGameOp()-protected operation
    // right after it enters the gate but before its actual write - this
    // reliably opens a window in which we can send SIGTERM and observe
    // whether shutdown waits for the operation to truly finish.
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_shutdown_inflight",
        extraEnv: { TEST_GAME_OP_DELAY_MS: "1500" }
    });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());

    const now = Date.now();
    const order = [];
    const createPromise = admin.emit("create_round", {
        name: "Survives shutdown",
        starts_at: new Date(now + 3600 * 1000).toISOString(),
        ends_at: new Date(now + 7200 * 1000).toISOString(),
        canvas_size: 10,
        cooldown: 1,
        bg_color: "#000000",
        grid_enabled: true,
        palette: ["#ffffff"]
    }).then((res) => { order.push("create_ack"); return res; });

    // Give create_round time to pass the socket.use pre-check and call
    // enterGameOp() (activeGameOps becomes 1), but not enough to finish its
    // artificial delay - exactly the race window graceful shutdown must
    // respect.
    await sleep(300);

    server.signal("SIGTERM");

    const createResult = await createPromise;
    const exitInfo = await server.waitForExit(20000).then((info) => { order.push("process_exit"); return info; });

    assert.equal(createResult.success, true, JSON.stringify(createResult));
    assert.ok(order.indexOf("create_ack") < order.indexOf("process_exit"), "the process must not exit before the in-flight operation's own ack fires");
    assert.equal(exitInfo.code, 0, "graceful shutdown exits 0");
    assert.equal(exitInfo.signal, null);

    const rows = await server.pool.query("SELECT * FROM rounds WHERE name = $1", ["Survives shutdown"]);
    assert.equal(rows.rows.length, 1, "the in-flight operation's write actually landed in PostgreSQL, not lost to shutdown");
});

test("after shutdown begins, no new game mutation is accepted and none is ever written to the database", { timeout: 30000 }, async (t) => {
    // Without an in-flight game operation or restore to wait for, shutdown
    // with nothing to drain can finish (and the process can exit) within
    // milliseconds - TEST_SHUTDOWN_DELAY_MS holds it open just long enough,
    // after shuttingDown is already true, for this test to deterministically
    // observe the "shutting_down" state and attempt a mutation against it.
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_shutdown_blocks_new",
        extraEnv: { TEST_SHUTDOWN_DELAY_MS: "1500" }
    });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());

    server.signal("SIGTERM");

    // Step 1 (shuttingDown = true) is synchronous, but we still confirm it
    // deterministically via /health before attempting the racy mutation -
    // otherwise this test would just be measuring arbitrary process timing.
    await waitUntil(async () => {
        const res = await httpGet(`${server.baseUrl}/health`);
        return res.status === 503 && JSON.parse(res.body).status === "shutting_down";
    }, { timeoutMs: 5000, message: "/health to report shutting_down" });

    const roundName = "Must never persist after shutdown";
    // The connection may already be force-closed by the time this arrives
    // (shutdown disconnects sockets once there is nothing left to drain),
    // in which case the ack callback never fires at all - that is just as
    // valid a "rejection" as an explicit error, per the spec: either a clear
    // refusal or an already-closed connection is acceptable. Race all three
    // possible outcomes so the test never hangs on a callback that will
    // never come.
    const attempt = await Promise.race([
        admin.emit("create_round", {
            name: roundName,
            starts_at: new Date(Date.now() + 3600 * 1000).toISOString(),
            ends_at: new Date(Date.now() + 7200 * 1000).toISOString(),
            canvas_size: 10,
            cooldown: 1,
            bg_color: "#000000",
            grid_enabled: true,
            palette: ["#ffffff"]
        }),
        new Promise((resolve) => admin.socket.once("disconnect", () => resolve({ success: false, disconnected: true }))),
        sleep(3000).then(() => ({ success: false, timedOut: true }))
    ]);
    assert.notEqual(attempt.success, true, `a mutation attempted after shutdown began must never succeed: ${JSON.stringify(attempt)}`);

    const exitInfo = await server.waitForExit(20000);
    assert.equal(exitInfo.code, 0);

    const rows = await server.pool.query("SELECT * FROM rounds WHERE name = $1", [roundName]);
    assert.equal(rows.rows.length, 0, "no new round was ever written after shutdown began - this is the authoritative check, independent of how the socket attempt resolved");
});

test("shutdown waits for an in-flight restore to finish and its finally never re-opens the gate", { timeout: 30000 }, async (t) => {
    // TEST_RESTORE_DELAY_MS pauses restore right after it has closed the
    // gate and drained ordinary game ops, but before it starts its own
    // transaction - this lets us send SIGTERM while restoring === true and
    // activeGameOps === 0, exactly the scenario the task describes: shutdown
    // must wait for restore's OWN lifecycle, not just the operation counter.
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_shutdown_restore_race",
        extraEnv: { TEST_RESTORE_DELAY_MS: "1200" }
    });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());

    const emptyBackup = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        data: { rounds: [], pixels: [], pixel_history: [], snapshots: [], round_archives: [] }
    };

    const order = [];
    const restorePromise = httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: admin.cookies, "X-CSRF-Token": admin.csrfToken },
        body: emptyBackup
    }).then((res) => { order.push("restore_response"); return res; });

    // Give restore time to close the gate (restoring = true) and drain the
    // (empty) activeGameOps counter, landing it inside its artificial delay.
    await sleep(300);

    server.signal("SIGTERM");
    order.push("sigterm_sent");

    // While restore is still delayed and shutdown is waiting on it, a fresh
    // mutation attempt must not sneak through either - same race-safe
    // pattern as the previous test.
    const roundName = "Must never persist during restore+shutdown race";
    const mutationAttempt = await Promise.race([
        admin.emit("create_round", {
            name: roundName,
            starts_at: new Date(Date.now() + 3600 * 1000).toISOString(),
            ends_at: new Date(Date.now() + 7200 * 1000).toISOString(),
            canvas_size: 10,
            cooldown: 1,
            bg_color: "#000000",
            grid_enabled: true,
            palette: ["#ffffff"]
        }),
        new Promise((resolve) => admin.socket.once("disconnect", () => resolve({ success: false, disconnected: true }))),
        sleep(3000).then(() => ({ success: false, timedOut: true }))
    ]);
    assert.notEqual(mutationAttempt.success, true, `no mutation may succeed once shutdown has begun, even while restore is still finishing: ${JSON.stringify(mutationAttempt)}`);

    const exitInfo = await server.waitForExit(20000).then((info) => { order.push("process_exit"); return info; });
    const restoreResult = await restorePromise;

    // Restore was not cut off by shutdown - it received its full, successful
    // HTTP response before the process exited.
    assert.equal(restoreResult.status, 200, restoreResult.body);
    const restoreBody = JSON.parse(restoreResult.body);
    assert.equal(restoreBody.success, true);
    assert.deepEqual(restoreBody.summary, { rounds: 0, pixels: 0, pixelHistory: 0, snapshots: 0, roundArchives: 0 });

    assert.ok(order.indexOf("sigterm_sent") < order.indexOf("restore_response"), "SIGTERM arrived while restore was still in flight");
    assert.ok(order.indexOf("restore_response") < order.indexOf("process_exit"), "restore's own finally ran strictly before the process exited - shutdown waited for it");

    assert.equal(exitInfo.code, 0, "graceful shutdown exits 0 even after waiting out an in-flight restore");
    assert.equal(exitInfo.signal, null);

    // The database matches the (empty) backup exactly - restore's
    // transaction was not interrupted by shutdown closing PostgreSQL early,
    // and no stray mutation attempted during the race landed either.
    const roundsAfter = await server.pool.query("SELECT * FROM rounds");
    assert.equal(roundsAfter.rows.length, 0);
});
