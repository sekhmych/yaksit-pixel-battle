"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, adminSession, visitorSession, httpRequest } = require("./harness");

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
