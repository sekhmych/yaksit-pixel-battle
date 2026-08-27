"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Jimp = require("jimp");
const { startTestServer, adminSession, visitorSession, waitUntil, httpGet } = require("./harness");

test("round lifecycle: palette is enforced, and finishing archives the actual canvas state", { timeout: 30000 }, async (t) => {
    const server = await startTestServer({ dbPrefix: "pixelbattle_it_lifecycle" });
    t.after(() => server.stop());

    const admin = await adminSession(server.baseUrl);
    t.after(() => admin.close());

    const now = Date.now();
    const createRes = await admin.emit("create_round", {
        name: "Lifecycle round",
        description: "integration test",
        starts_at: new Date(now).toISOString(),
        ends_at: new Date(now + 60 * 60 * 1000).toISOString(),
        canvas_size: 16,
        cooldown: 1,
        bg_color: "#101010",
        grid_enabled: false,
        palette: ["#ff0000", "#00ff00"]
    });
    assert.equal(createRes.success, true, "round is created");
    const roundId = createRes.round.id;

    const startRes = await admin.emit("start_round", { id: roundId });
    assert.equal(startRes.success, true, "round is started");

    const visitor = await visitorSession(server.baseUrl);
    t.after(() => visitor.close());

    // 1. Разрешённый цвет палитры принимается.
    const acceptedUpdate = await new Promise((resolve) => {
        visitor.socket.once("pixel_update", resolve);
        visitor.socket.emit("set_pixel", { x: 2, y: 3, color: "#00ff00" });
    });
    assert.deepEqual(
        { x: acceptedUpdate.x, y: acceptedUpdate.y, color: acceptedUpdate.color },
        { x: 2, y: 3, color: "#00ff00" }
    );

    // 2. Цвет вне палитры отклоняется сервером - никакого pixel_update не будет.
    let rejectedSeen = false;
    const rejectListener = (p) => { if (p.color === "#123456") rejectedSeen = true; };
    visitor.socket.on("pixel_update", rejectListener);
    visitor.socket.emit("set_pixel", { x: 5, y: 5, color: "#123456" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    visitor.socket.off("pixel_update", rejectListener);
    assert.equal(rejectedSeen, false, "an out-of-palette color is silently rejected server-side");

    const pixelsInDb = await server.pool.query(
        "SELECT x, y, color FROM pixels WHERE round_id = $1 ORDER BY x, y",
        [roundId]
    );
    assert.deepEqual(pixelsInDb.rows, [{ x: 2, y: 3, color: "#00ff00" }], "only the palette-valid pixel was persisted");

    // 3. Завершение раунда создаёт round_archives с PNG-превью.
    const finishRes = await admin.emit("finish_round", { id: roundId });
    assert.equal(finishRes.success, true, "round is finished");

    await waitUntil(
        async () => {
            const res = await server.pool.query("SELECT status FROM rounds WHERE id = $1", [roundId]);
            return res.rows[0].status === "finished";
        },
        { timeoutMs: 5000, message: "round status flips to finished" }
    );

    const archiveRes = await server.pool.query(
        "SELECT pixel_count, preview FROM round_archives WHERE round_id = $1",
        [roundId]
    );
    assert.equal(archiveRes.rows.length, 1, "an archive row exists for the finished round");
    assert.equal(archiveRes.rows[0].pixel_count, 1, "pixel_count matches the actual number of placed pixels");

    // 4. Финальный архив содержит актуальное состояние холста: декодируем
    // сохранённый PNG и проверяем цвет ровно того пикселя, что был поставлен.
    const image = await Jimp.read(archiveRes.rows[0].preview);
    const pixelColor = image.getPixelColor(2, 3);
    const { r, g, b } = Jimp.intToRGBA(pixelColor);
    assert.deepEqual({ r, g, b }, { r: 0, g: 255, b: 0 }, "the archived PNG shows the pixel at its placed color");

    // Фон в незакрашенных местах должен соответствовать bg_color раунда (#101010).
    const bgColor = image.getPixelColor(0, 0);
    const bg = Jimp.intToRGBA(bgColor);
    assert.deepEqual({ r: bg.r, g: bg.g, b: bg.b }, { r: 0x10, g: 0x10, b: 0x10 });

    // Пиксели раунда остаются в основной таблице - ничего не удаляется.
    const pixelsAfterFinish = await server.pool.query(
        "SELECT COUNT(*)::int AS c FROM pixels WHERE round_id = $1",
        [roundId]
    );
    assert.equal(pixelsAfterFinish.rows[0].c, 1, "the finished round's pixel is never deleted");

    // Публичный API архива тоже должен отдавать это превью.
    const previewApi = await httpGet(`${server.baseUrl}/api/rounds/archive/${roundId}/preview.png`);
    assert.equal(previewApi.status, 200);
    assert.equal(previewApi.headers["content-type"], "image/png");

    // 5. После завершения раунда рисование должно быть снова недоступно.
    let postFinishUpdate = false;
    const pfListener = () => { postFinishUpdate = true; };
    visitor.socket.on("pixel_update", pfListener);
    visitor.socket.emit("set_pixel", { x: 7, y: 7, color: "#00ff00" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(postFinishUpdate, false, "drawing is rejected once the round is finished");
});
