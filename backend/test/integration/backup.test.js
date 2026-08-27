"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, adminSession, visitorSession, httpRequest, sleep } = require("./harness");
const { BACKUP_FORMAT, BACKUP_VERSION } = require("../../lib/backup");

async function seedGameData(server, admin) {
    const now = Date.now();
    const createRes = await admin.emit("create_round", {
        name: "Backup round",
        description: "seeded for backup integration test",
        starts_at: new Date(now).toISOString(),
        ends_at: new Date(now + 3600 * 1000).toISOString(),
        canvas_size: 16,
        cooldown: 1,
        bg_color: "#101010",
        grid_enabled: true,
        palette: ["#ff0000", "#00ff00", "#0000ff"]
    });
    if (!createRes.success) console.error("seedGameData create_round failed:", JSON.stringify(createRes));
    assert.equal(createRes.success, true);
    const roundId = createRes.round.id;

    const startRes = await admin.emit("start_round", { id: roundId });
    assert.equal(startRes.success, true);

    await new Promise((resolve) => {
        admin.socket.once("pixel_update", resolve);
        admin.socket.emit("set_pixel", { x: 2, y: 3, color: "#00ff00" });
    });
    await new Promise((resolve) => {
        admin.socket.once("pixel_update", resolve);
        admin.socket.emit("set_pixel", { x: 5, y: 5, color: "#0000ff" });
    });

    const snapshotRes = await admin.emit("create_manual_snapshot", {});
    assert.equal(snapshotRes.success, true);

    const finishRes = await admin.emit("finish_round", { id: roundId });
    assert.equal(finishRes.success, true);

    return roundId;
}

async function dumpGameTables(pool) {
    const [rounds, pixels, pixelHistory, snapshots, roundArchives] = await Promise.all([
        pool.query("SELECT * FROM rounds ORDER BY id"),
        pool.query("SELECT * FROM pixels ORDER BY round_id, x, y"),
        pool.query("SELECT * FROM pixel_history ORDER BY id"),
        pool.query("SELECT id, round_id, encode(data, 'hex') AS data_hex, created_at FROM snapshots ORDER BY id"),
        pool.query("SELECT round_id, encode(preview, 'hex') AS preview_hex, pixel_count, created_at FROM round_archives ORDER BY round_id")
    ]);
    return {
        rounds: rounds.rows,
        pixels: pixels.rows,
        pixelHistory: pixelHistory.rows,
        snapshots: snapshots.rows,
        roundArchives: roundArchives.rows
    };
}

test("game backup: full export/mutate/restore cycle preserves data, PNGs and sequences exactly", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_backup" });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());

    const roundId = await seedGameData(server, admin);
    const before = await dumpGameTables(server.pool);
    assert.equal(before.rounds.length, 1);
    assert.equal(before.pixels.length, 2);
    assert.equal(before.pixelHistory.length, 2);
    assert.equal(before.snapshots.length, 1);
    assert.equal(before.roundArchives.length, 1);
    assert.ok(before.snapshots[0].data_hex.startsWith("89504e470d0a1a0a"), "seeded snapshot is a real PNG");
    assert.ok(before.roundArchives[0].preview_hex.startsWith("89504e470d0a1a0a"), "seeded archive preview is a real PNG");

    // 2. Export via the admin-only HTTP endpoint.
    const exportRes = await httpRequest("GET", `${server.baseUrl}/admin/backup/export`, { headers: { Cookie: admin.cookies } });
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers["content-disposition"], /attachment; filename="yaksit-pixel-battle-game-backup-.*\.json"/);
    const backup = JSON.parse(exportRes.body);
    assert.equal(backup.format, "yaksit-pixel-battle-game-backup");
    assert.equal(backup.version, 1);
    assert.equal(backup.data.rounds.length, 1);
    assert.equal(backup.data.pixels.length, 2);
    assert.equal(backup.data.snapshots.length, 1);
    assert.equal(backup.data.round_archives.length, 1);

    // 3. Mutate the DB: wipe pixels, rename the round, drop the archive.
    await server.pool.query("DELETE FROM pixels WHERE round_id = $1 AND x = 2 AND y = 3", [roundId]);
    await server.pool.query("UPDATE rounds SET name = 'tampered' WHERE id = $1", [roundId]);
    await server.pool.query("DELETE FROM round_archives WHERE round_id = $1", [roundId]);
    const mutated = await dumpGameTables(server.pool);
    assert.equal(mutated.pixels.length, 1, "sanity: mutation actually happened");
    assert.equal(mutated.roundArchives.length, 0);

    // 4. Restore the exported backup.
    const restoreRes = await httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: admin.cookies, "X-CSRF-Token": admin.csrfToken },
        body: backup
    });
    assert.equal(restoreRes.status, 200, restoreRes.body);
    const restoreBody = JSON.parse(restoreRes.body);
    assert.equal(restoreBody.success, true);
    assert.deepEqual(restoreBody.summary, { rounds: 1, pixels: 2, pixelHistory: 2, snapshots: 1, roundArchives: 1 });

    // 5. The DB now matches the pre-mutation snapshot exactly, byte for byte.
    const after = await dumpGameTables(server.pool);
    assert.deepEqual(after.rounds.map(r => ({ ...r, palette: JSON.stringify(r.palette) })), before.rounds.map(r => ({ ...r, palette: JSON.stringify(r.palette) })));
    assert.deepEqual(after.pixels, before.pixels);
    assert.deepEqual(after.pixelHistory, before.pixelHistory);
    assert.deepEqual(after.snapshots, before.snapshots);
    assert.deepEqual(after.roundArchives, before.roundArchives);

    // Sequences were reset correctly: a freshly created round gets an id
    // strictly greater than anything restored, never colliding.
    const newRoundRes = await admin.emit("create_round", {
        name: "After restore",
        starts_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        ends_at: new Date(Date.now() + 70 * 60 * 1000).toISOString(),
        canvas_size: 10, cooldown: 1, bg_color: "#000000", grid_enabled: true, palette: ["#ffffff"]
    });
    assert.equal(newRoundRes.success, true);
    assert.ok(newRoundRes.round.id > roundId, "new round id does not collide with restored ids");
});

test("game backup: an invalid file is rejected and never changes the database", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_backup_invalid" });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());

    await seedGameData(server, admin);
    const before = await dumpGameTables(server.pool);

    const cases = [
        { format: "not-the-right-format", version: 1, exported_at: new Date().toISOString(), data: { rounds: [], pixels: [], pixel_history: [], snapshots: [], round_archives: [] } },
        { format: "yaksit-pixel-battle-game-backup", version: 999, exported_at: new Date().toISOString(), data: { rounds: [], pixels: [], pixel_history: [], snapshots: [], round_archives: [] } },
        { format: "yaksit-pixel-battle-game-backup", version: 1, exported_at: "not-a-date", data: { rounds: [], pixels: [], pixel_history: [], snapshots: [], round_archives: [] } },
        { format: "yaksit-pixel-battle-game-backup", version: 1, exported_at: new Date().toISOString(), data: { rounds: [{ id: 1, name: "x", description: null, status: "active", starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 1000).toISOString(), canvas_size: 10, cooldown: 1, bg_color: "#000000", grid_enabled: true, palette: ["#fff"], activated_at: null, finished_at: null, created_at: new Date().toISOString() }, { id: 2, name: "y", description: null, status: "active", starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 1000).toISOString(), canvas_size: 10, cooldown: 1, bg_color: "#000000", grid_enabled: true, palette: ["#fff"], activated_at: null, finished_at: null, created_at: new Date().toISOString() }], pixels: [], pixel_history: [], snapshots: [], round_archives: [] } },
        "not even json-shaped: just a raw string wrapped by JSON.stringify"
    ];

    for (const badBackup of cases) {
        const res = await httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
            headers: { Cookie: admin.cookies, "X-CSRF-Token": admin.csrfToken },
            body: badBackup
        });
        assert.equal(res.status, 400, `expected 400 for case, got ${res.status}: ${res.body}`);
        const body = JSON.parse(res.body);
        assert.equal(body.success, false);
        assert.ok(body.error && body.error.length > 0);
    }

    const after = await dumpGameTables(server.pool);
    assert.deepEqual(after, before, "the database is byte-for-byte unchanged after every rejected restore attempt");
});

test("game backup: export and restore are admin-only, and restore requires CSRF", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_backup_auth" });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());
    await seedGameData(server, admin);

    const exportRes = await httpRequest("GET", `${server.baseUrl}/admin/backup/export`, { headers: { Cookie: admin.cookies } });
    const backup = JSON.parse(exportRes.body);

    const visitor = await visitorSession(server.baseUrl);
    t.after(() => visitor.close());

    // Anonymous visitor: both endpoints must be rejected.
    const visitorExport = await httpRequest("GET", `${server.baseUrl}/admin/backup/export`, { headers: { Cookie: visitor.cookie } });
    assert.equal(visitorExport.status, 403);

    const visitorRestore = await httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: visitor.cookie },
        body: backup
    });
    assert.equal(visitorRestore.status, 403);

    // No cookie at all.
    const noCookieExport = await httpRequest("GET", `${server.baseUrl}/admin/backup/export`, {});
    assert.equal(noCookieExport.status, 403);

    // Admin cookie present but missing/invalid CSRF token on restore.
    const missingCsrf = await httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: admin.cookies },
        body: backup
    });
    assert.equal(missingCsrf.status, 403);

    const badCsrf = await httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: admin.cookies, "X-CSRF-Token": "not-a-real-token" },
        body: backup
    });
    assert.equal(badCsrf.status, 403);

    // The database must be untouched by all of the rejected attempts above.
    const stillThere = await server.pool.query("SELECT COUNT(*)::int AS c FROM pixels");
    assert.equal(stillThere.rows[0].c, 2);

    // A correctly authenticated + CSRF'd request succeeds.
    const goodRestore = await httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: admin.cookies, "X-CSRF-Token": admin.csrfToken },
        body: backup
    });
    assert.equal(goodRestore.status, 200, goodRestore.body);
});

test("game backup: restore never touches sessions, moderators or other access data", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_backup_access" });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());
    await seedGameData(server, admin);

    const createModRes = await admin.emit("create_moderator", { username: "backup_test_mod", password: "supersecretpassword" });
    assert.equal(createModRes.success, true);

    const moderatorsBefore = await server.pool.query("SELECT username, password, created_at FROM moderators ORDER BY username");
    const sessionCountBefore = await server.pool.query("SELECT COUNT(*)::int AS c FROM session");
    const usersBefore = await server.pool.query("SELECT * FROM users ORDER BY user_id");

    const exportRes = await httpRequest("GET", `${server.baseUrl}/admin/backup/export`, { headers: { Cookie: admin.cookies } });
    const backup = JSON.parse(exportRes.body);

    // The exported backup must not contain any access-control data at all.
    assert.equal(JSON.stringify(backup).includes("backup_test_mod"), false, "moderator username must never appear in a game backup");
    assert.equal(Object.prototype.hasOwnProperty.call(backup.data, "moderators"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(backup.data, "session"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(backup.data, "users"), false);

    const restoreRes = await httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: admin.cookies, "X-CSRF-Token": admin.csrfToken },
        body: backup
    });
    assert.equal(restoreRes.status, 200, restoreRes.body);

    const moderatorsAfter = await server.pool.query("SELECT username, password, created_at FROM moderators ORDER BY username");
    const sessionCountAfter = await server.pool.query("SELECT COUNT(*)::int AS c FROM session");
    const usersAfter = await server.pool.query("SELECT * FROM users ORDER BY user_id");

    assert.deepEqual(moderatorsAfter.rows, moderatorsBefore.rows, "moderators (with their bcrypt hashes) are untouched by restore");
    assert.equal(sessionCountAfter.rows[0].c, sessionCountBefore.rows[0].c, "sessions are untouched by restore");
    assert.deepEqual(usersAfter.rows, usersBefore.rows, "per-visitor cooldown state is untouched by restore");

    // The admin's own session must still work after restore - proof that
    // restore did not blow away the caller's own session row.
    const stillLoggedIn = await httpRequest("GET", `${server.baseUrl}/admin`, { headers: { Cookie: admin.cookies } });
    assert.equal(stillLoggedIn.status, 200);
});

test("game backup: restore waits for an in-flight game operation and leaves no stale write behind", { timeout: 30000 }, async (t) => {
    // TEST_GAME_OP_DELAY_MS makes every withGameOp()-protected operation pause
    // for a while right after it has entered the gate (activeGameOps++) but
    // before it does its actual write - this reliably opens a wide window in
    // which we can start a concurrent restore and observe whether it waits.
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_backup_race",
        extraEnv: { TEST_GAME_OP_DELAY_MS: "1500" }
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
    const now = Date.now();

    // Start a game-table write (create_round) that will sit "in flight"
    // inside withGameOp() for ~1.5s before it actually INSERTs.
    const createPromise = admin.emit("create_round", {
        name: "Racy round",
        starts_at: new Date(now + 3600 * 1000).toISOString(),
        ends_at: new Date(now + 7200 * 1000).toISOString(),
        canvas_size: 10,
        cooldown: 1,
        bg_color: "#000000",
        grid_enabled: true,
        palette: ["#ffffff"]
    }).then((res) => { order.push("create_round_ack"); return res; });

    // Give create_round time to pass through the socket.use pre-check and
    // call enterGameOp() (activeGameOps becomes 1), but not enough time to
    // finish its artificial delay - this is exactly the race window the fix
    // must close.
    await sleep(300);

    const restorePromise = httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: admin.cookies, "X-CSRF-Token": admin.csrfToken },
        body: emptyBackup
    }).then((res) => { order.push("restore_response"); return res; });

    const [createResult, restoreResult] = await Promise.all([createPromise, restorePromise]);

    // The in-flight create_round was allowed to actually finish (it started
    // before maintenanceMode was set, so enterGameOp() let it through)...
    assert.equal(createResult.success, true, JSON.stringify(createResult));
    assert.ok(createResult.round && Number.isInteger(createResult.round.id));

    // ...and restore's HTTP response could not have been produced before
    // that in-flight operation actually completed.
    assert.deepEqual(order, ["create_round_ack", "restore_response"], "restore must not finish before the in-flight game operation");

    assert.equal(restoreResult.status, 200, restoreResult.body);
    const restoreBody = JSON.parse(restoreResult.body);
    assert.equal(restoreBody.success, true);
    assert.deepEqual(restoreBody.summary, { rounds: 0, pixels: 0, pixelHistory: 0, snapshots: 0, roundArchives: 0 });

    // Proof there is no stale write: because restore waited for the racy
    // create_round to actually commit before starting its own transaction,
    // that transaction's "DELETE FROM rounds" saw and removed it. The table
    // now matches the (empty) backup exactly - not one leftover row from an
    // operation that "should" have lost the race.
    const roundsAfter = await server.pool.query("SELECT * FROM rounds");
    assert.equal(roundsAfter.rows.length, 0, "no stale round survives restore, even though it was in flight when restore started");
});

test("game backup: restore waits for the FULL lifecycle of an in-flight operation (DB + roundState + broadcast), not just its SQL", { timeout: 30000 }, async (t) => {
    // TEST_GAME_OP_POST_DB_DELAY_MS pauses a game operation AFTER its DB write
    // has already committed but BEFORE it reloads roundState and broadcasts -
    // exactly the gap that used to let a stale operation finish its lifecycle
    // (roundState mutation + io.emit) after restore had already taken over.
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_backup_race_lifecycle",
        extraEnv: { TEST_GAME_OP_POST_DB_DELAY_MS: "1200" }
    });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());

    // Seed one draft round to start_round during the race. Setup itself also
    // pays the artificial delay (this server always adds it), so just await
    // it fully - only the race window below matters for the test.
    // starts_at is intentionally far in the future so the background
    // auto-start scheduler (which polls every ROUND_SYNC_INTERVAL_MS, as
    // fast as 300ms in tests) never races to activate this draft on its own -
    // the test needs to control exactly when start_round fires.
    const now = Date.now();
    const createRes = await admin.emit("create_round", {
        name: "Racy started round",
        starts_at: new Date(now + 3600 * 1000).toISOString(),
        ends_at: new Date(now + 7200 * 1000).toISOString(),
        canvas_size: 10,
        cooldown: 1,
        bg_color: "#000000",
        grid_enabled: true,
        palette: ["#ffffff"]
    });
    assert.equal(createRes.success, true, JSON.stringify(createRes));
    const racyRoundId = createRes.round.id;

    // Collect every init_data broadcast the admin socket receives from this
    // point on (io.emit sends to every connected client, admin included) -
    // this is exactly what a real client would see.
    const receivedInitData = [];
    admin.socket.on("init_data", (payload) => {
        receivedInitData.push({ payload, t: Date.now() });
    });

    const emptyBackup = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        data: { rounds: [], pixels: [], pixel_history: [], snapshots: [], round_archives: [] }
    };

    const order = [];

    // start_round: DB commit happens first, then (only in this test server)
    // an artificial pause, THEN roundState is reloaded and "init_data" is
    // broadcast to everyone, including this ack resolving last.
    const startPromise = admin.emit("start_round", { id: racyRoundId })
        .then((res) => { order.push("start_round_ack"); return res; });

    // Give start_round time to commit its transaction and enter the paused
    // window (activeGameOps stays 1 throughout), but not enough to finish it.
    await sleep(300);

    const restorePromise = httpRequest("POST", `${server.baseUrl}/admin/backup/restore`, {
        headers: { Cookie: admin.cookies, "X-CSRF-Token": admin.csrfToken },
        body: emptyBackup
    }).then((res) => { order.push("restore_response"); return res; });

    const [startResult, restoreResult] = await Promise.all([startPromise, restorePromise]);

    // 1. Restore waited for the ENTIRE lifecycle of the in-flight operation,
    // not just its SQL: start_round's ack (which only resolves after its own
    // roundState reload + broadcast) completed strictly before restore's
    // HTTP response.
    assert.equal(startResult.success, true, JSON.stringify(startResult));
    assert.deepEqual(order, ["start_round_ack", "restore_response"], "restore must wait for the full lifecycle (DB + roundState + broadcast), not just the DB write");

    assert.equal(restoreResult.status, 200, restoreResult.body);
    const restoreBody = JSON.parse(restoreResult.body);
    assert.equal(restoreBody.success, true);
    assert.deepEqual(restoreBody.summary, { rounds: 0, pixels: 0, pixelHistory: 0, snapshots: 0, roundArchives: 0 });

    // A short grace period: if the fix were broken, this is where a stale,
    // late roundState reload / broadcast from the old start_round handler
    // would show up - it no longer exists as a code path once the operation
    // itself is gate-scoped to its full lifecycle, but this also guards
    // against any other route to a delayed event.
    await sleep(400);

    // 2 & 3. After restore, both the events observed by the client AND the
    // server's own roundState must reflect the backup - not the racy round.
    // We expect exactly two init_data broadcasts: the racy start_round's own
    // (round still shows as active, because it legitimately finished before
    // restore started), followed by restore's own (round is null, matching
    // the empty backup).
    assert.equal(receivedInitData.length, 2, `expected exactly 2 init_data broadcasts, got ${receivedInitData.length}: ${JSON.stringify(receivedInitData.map(e => e.payload.round))}`);
    assert.ok(receivedInitData[0].payload.round && receivedInitData[0].payload.round.id === racyRoundId && receivedInitData[0].payload.round.status === "active", "the racy start_round's own broadcast legitimately shows the round as active - it started before restore and was allowed to finish");
    assert.equal(receivedInitData[1].payload.round, null, "restore's own broadcast (the FINAL one the client sees) matches the empty backup exactly");

    // 4. No late/stale event arrives after restore's response - a fresh
    // client connecting right now must see exactly the backup's state, not
    // some in-between or stale value left over from the racy start_round.
    const freshVisitor = await visitorSession(server.baseUrl);
    t.after(() => freshVisitor.close());
    assert.equal(freshVisitor.initData.round, null, "a client connecting after restore sees exactly the backup's state (no active round), never the racy start_round's");

    // And still nothing new arrived on the admin socket in the meantime.
    assert.equal(receivedInitData.length, 2, "no further init_data broadcasts arrived after restore's own");

    // 5. The database matches the backup exactly: no leftover round.
    const roundsAfter = await server.pool.query("SELECT * FROM rounds");
    assert.equal(roundsAfter.rows.length, 0, "the database matches the (empty) backup - no stale round left behind by the racy start_round");
});

test("game backup: export is rejected with 413 (not a partial download) when it would exceed BACKUP_MAX_BYTES", { timeout: 30000 }, async (t) => {
    // A tiny BACKUP_MAX_BYTES guarantees any non-trivial export exceeds it,
    // exercising the symmetric size check on the export side.
    const server = await startTestServer({
        dbPrefix: "pixelbattle_it_backup_export_limit",
        extraEnv: { BACKUP_MAX_BYTES: "200" }
    });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());
    await seedGameData(server, admin);

    const exportRes = await httpRequest("GET", `${server.baseUrl}/admin/backup/export`, { headers: { Cookie: admin.cookies } });
    assert.equal(exportRes.status, 413, exportRes.body);
    assert.equal(exportRes.headers["content-disposition"], undefined, "a rejected export must never start a file download");
    const body = JSON.parse(exportRes.body);
    assert.equal(body.success, false);
    assert.match(body.error, /BACKUP_MAX_BYTES/, "the error must point admins at the env var that controls the limit");

    // A backup small enough to fit the limit still exports successfully -
    // the check rejects only when the size is actually exceeded.
    await server.pool.query("DELETE FROM round_archives; DELETE FROM snapshots; DELETE FROM pixel_history; DELETE FROM pixels; DELETE FROM rounds;");
    const smallExportRes = await httpRequest("GET", `${server.baseUrl}/admin/backup/export`, { headers: { Cookie: admin.cookies } });
    assert.equal(smallExportRes.status, 200, smallExportRes.body);
    assert.match(smallExportRes.headers["content-disposition"], /attachment/);
    assert.equal(smallExportRes.headers["cache-control"], "no-store, no-cache, must-revalidate, proxy-revalidate");
});
