const test = require("node:test");
const assert = require("node:assert/strict");
const {
    isValidPalette,
    isColorInPalette,
    normalizeRoundInput,
    assertPixelAllowed,
    normalizeRoundPixelImport,
    startRoundTx,
    autoStartEligibleDraftTx,
    finishRound
} = require("../lib/rounds");

const validRoundInput = {
    name: "Первый раунд",
    description: "Тестовый раунд",
    starts_at: "2026-01-01T00:00:00.000Z",
    ends_at: "2026-01-02T00:00:00.000Z",
    canvas_size: 100,
    cooldown: 5,
    bg_color: "#1f2937",
    grid_enabled: true,
    palette: ["#000000", "#FFFFFF", "#ff0000"]
};

test("accepts a valid palette and rejects empty, oversized or invalid ones", () => {
    assert.equal(isValidPalette(["#000000", "#ffffff"]), true);
    assert.equal(isValidPalette([]), false);
    assert.equal(isValidPalette(["red"]), false);
    assert.equal(isValidPalette(["#000000", "#000000"]), false, "duplicate colors are rejected");
    assert.equal(isValidPalette(Array.from({ length: 65 }, () => "#000000")), false);
    assert.equal(isValidPalette(null), false);
});

test("palette membership check is case-insensitive", () => {
    assert.equal(isColorInPalette("#ABCDEF", ["#abcdef"]), true);
    assert.equal(isColorInPalette("#123456", ["#abcdef"]), false);
    assert.equal(isColorInPalette("not-a-color", ["#abcdef"]), false);
});

test("normalizeRoundInput accepts a well-formed round", () => {
    const result = normalizeRoundInput(validRoundInput);
    assert.equal(result.ok, true);
    assert.equal(result.value.name, "Первый раунд");
    assert.deepEqual(result.value.palette, ["#000000", "#ffffff", "#ff0000"]);
});

test("normalizeRoundInput rejects missing name, bad schedule, and bad palette", () => {
    assert.equal(normalizeRoundInput({ ...validRoundInput, name: "" }).ok, false);
    assert.equal(normalizeRoundInput({ ...validRoundInput, ends_at: validRoundInput.starts_at }).ok, false);
    assert.equal(normalizeRoundInput({ ...validRoundInput, starts_at: "not-a-date" }).ok, false);
    assert.equal(normalizeRoundInput({ ...validRoundInput, canvas_size: 5 }).ok, false);
    assert.equal(normalizeRoundInput({ ...validRoundInput, cooldown: -1 }).ok, false);
    assert.equal(normalizeRoundInput({ ...validRoundInput, bg_color: "blue" }).ok, false);
    assert.equal(normalizeRoundInput({ ...validRoundInput, palette: [] }).ok, false);
    assert.equal(normalizeRoundInput({ ...validRoundInput, palette: ["not-a-color"] }).ok, false);
});

test("drawing is rejected when there is no active round", () => {
    const result = assertPixelAllowed({ activeRound: null, x: 1, y: 1, color: "#000000" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "NO_ACTIVE_ROUND");
});

test("drawing is rejected for a draft or finished round", () => {
    const draft = { status: "draft", canvas_size: 10, palette: ["#000000"] };
    const finished = { status: "finished", canvas_size: 10, palette: ["#000000"] };
    assert.equal(assertPixelAllowed({ activeRound: draft, x: 0, y: 0, color: "#000000" }).ok, false);
    assert.equal(assertPixelAllowed({ activeRound: finished, x: 0, y: 0, color: "#000000" }).ok, false);
});

test("drawing is rejected for coordinates outside the round's canvas", () => {
    const round = { status: "active", canvas_size: 10, palette: ["#000000"] };
    assert.equal(assertPixelAllowed({ activeRound: round, x: -1, y: 0, color: "#000000" }).ok, false);
    assert.equal(assertPixelAllowed({ activeRound: round, x: 10, y: 0, color: "#000000" }).ok, false);
    assert.equal(assertPixelAllowed({ activeRound: round, x: 1.5, y: 0, color: "#000000" }).ok, false);
});

test("drawing is rejected for a color outside the round's palette even when handcrafted", () => {
    const round = { status: "active", canvas_size: 10, palette: ["#000000", "#ffffff"] };
    const result = assertPixelAllowed({ activeRound: round, x: 1, y: 1, color: "#ff00ff" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "COLOR_NOT_IN_PALETTE");
});

test("drawing is accepted for a valid pixel inside an active round's palette", () => {
    const round = { status: "active", canvas_size: 10, palette: ["#000000", "#ffffff"] };
    const result = assertPixelAllowed({ activeRound: round, x: 5, y: 5, color: "#FFFFFF" });
    assert.equal(result.ok, true);
});

test("import rejects pixels whose color is outside the target round's palette", () => {
    const round = { canvas_size: 10, palette: ["#000000", "#ffffff"] };
    const result = normalizeRoundPixelImport({
        pixels: [{ x: 0, y: 0, color: "#ff0000" }]
    }, round);
    assert.equal(result.ok, false);
});

test("import accepts palette-valid pixels and defaults missing user_id", () => {
    const round = { canvas_size: 10, palette: ["#000000", "#ffffff"] };
    const result = normalizeRoundPixelImport({
        pixels: [{ x: 0, y: 0, color: "#000000" }]
    }, round);
    assert.equal(result.ok, true);
    assert.equal(result.value.pixels[0].user_id, "imported");
});

test("import rejects duplicate coordinates", () => {
    const round = { canvas_size: 10, palette: ["#000000"] };
    const result = normalizeRoundPixelImport({
        pixels: [{ x: 0, y: 0, color: "#000000" }, { x: 0, y: 0, color: "#000000" }]
    }, round);
    assert.equal(result.ok, false);
});

function makeMockClient(queryImpl) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            return queryImpl(sql, params, calls.length);
        }
    };
}

test("startRoundTx refuses to start a round while another is active", async () => {
    const client = makeMockClient((sql) => {
        if (sql.includes("SELECT id FROM rounds")) return { rows: [{ id: 99 }] };
        return { rows: [] };
    });
    await assert.rejects(startRoundTx(client, 1), /ANOTHER_ROUND_ACTIVE/);
});

test("startRoundTx refuses to start a round that is not a draft", async () => {
    const client = makeMockClient((sql) => {
        if (sql.includes("SELECT id FROM rounds")) return { rows: [] };
        return { rows: [] };
    });
    await assert.rejects(startRoundTx(client, 1), /ROUND_NOT_DRAFT/);
});

test("startRoundTx activates an eligible draft round", async () => {
    const client = makeMockClient((sql) => {
        if (sql.includes("SELECT id FROM rounds")) return { rows: [] };
        return { rows: [{ id: 1, status: "active" }] };
    });
    const round = await startRoundTx(client, 1);
    assert.equal(round.id, 1);
});

test("finishRound archives the round without ever deleting pixel data", async () => {
    const client = makeMockClient((sql) => {
        if (sql.startsWith("SELECT * FROM rounds")) return { rows: [{ id: 7, status: "active" }] };
        if (sql.startsWith("UPDATE rounds")) return { rows: [{ id: 7, status: "finished" }] };
        if (sql.startsWith("INSERT INTO round_archives")) return { rows: [] };
        return { rows: [] };
    });

    const round = await finishRound(client, { roundId: 7, preview: Buffer.from("png"), pixelCount: 42 });
    assert.equal(round.id, 7);

    const sqlStatements = client.calls.map(c => c.sql);
    assert.equal(sqlStatements.length, 3);
    assert.ok(sqlStatements.some(sql => sql.includes("FOR UPDATE")));
    assert.ok(sqlStatements.some(sql => sql.includes("UPDATE rounds SET status = 'finished'")));
    assert.ok(sqlStatements.some(sql => sql.includes("INSERT INTO round_archives")));
    assert.ok(!sqlStatements.some(sql => /DELETE\s+FROM\s+pixels/i.test(sql)), "finishing a round must never delete pixels");
    assert.ok(!sqlStatements.some(sql => /DROP\s+TABLE/i.test(sql)), "finishing a round must never drop tables");
});

test("finishRound refuses to archive a round that is not active", async () => {
    const client = makeMockClient((sql) => {
        if (sql.startsWith("SELECT * FROM rounds")) return { rows: [] };
        return { rows: [] };
    });
    await assert.rejects(
        finishRound(client, { roundId: 7, preview: Buffer.from("png"), pixelCount: 0 }),
        /ROUND_NOT_ACTIVE/
    );
});


test("finishRound locks the active round before building the final archive", async () => {
    const client = makeMockClient((sql) => {
        if (sql.startsWith("SELECT * FROM rounds")) return { rows: [{ id: 8, status: "active" }] };
        if (sql.startsWith("UPDATE rounds")) return { rows: [{ id: 8, status: "finished" }] };
        if (sql.startsWith("INSERT INTO round_archives")) return { rows: [] };
        return { rows: [] };
    });

    const result = await finishRound(client, {
        roundId: 8,
        buildArchive: async (round, queryable) => {
            assert.equal(round.id, 8);
            assert.equal(queryable, client);
            assert.equal(client.calls.length, 1, "archive builder runs after the row lock");
            return { preview: Buffer.from("png"), pixelCount: 3 };
        }
    });

    assert.equal(result.status, "finished");
    assert.match(client.calls[0].sql, /FOR UPDATE/);
});

test("autoStartEligibleDraftTx returns null when no draft is due yet", async () => {
    const client = makeMockClient((sql) => {
        if (sql.includes("WHERE status = 'draft' AND starts_at")) return { rows: [] };
        return { rows: [] };
    });
    const result = await autoStartEligibleDraftTx(client, new Date("2026-06-01T12:00:00.000Z"));
    assert.equal(result, null);
    assert.equal(client.calls.length, 1, "does not attempt to start anything when nothing is eligible");
});

test("autoStartEligibleDraftTx starts the earliest eligible draft", async () => {
    const client = makeMockClient((sql) => {
        if (sql.includes("WHERE status = 'draft' AND starts_at")) return { rows: [{ id: 42 }] };
        if (sql.includes("SELECT id FROM rounds WHERE status = 'active'")) return { rows: [] };
        if (sql.startsWith("UPDATE rounds")) return { rows: [{ id: 42, status: "active" }] };
        return { rows: [] };
    });
    const result = await autoStartEligibleDraftTx(client, new Date("2026-06-01T12:00:00.000Z"));
    assert.equal(result.id, 42);
});

test("autoStartEligibleDraftTx yields to an already-active round instead of throwing", async () => {
    const client = makeMockClient((sql) => {
        if (sql.includes("WHERE status = 'draft' AND starts_at")) return { rows: [{ id: 42 }] };
        if (sql.includes("SELECT id FROM rounds WHERE status = 'active'")) return { rows: [{ id: 99 }] };
        return { rows: [] };
    });
    const result = await autoStartEligibleDraftTx(client, new Date("2026-06-01T12:00:00.000Z"));
    assert.equal(result, null, "another active round wins the race without crashing the sync loop");
});

test("autoStartEligibleDraftTx never selects a draft whose ends_at has already passed", async () => {
    // Сам SQL-запрос фильтрует по ends_at > now; этот тест документирует,
    // что функция не делает отдельной ручной фильтрации, которую можно обойти.
    const client = makeMockClient((sql, params) => {
        if (sql.includes("WHERE status = 'draft' AND starts_at")) {
            assert.match(sql, /ends_at > \$1/);
            return { rows: [] };
        }
        return { rows: [] };
    });
    const result = await autoStartEligibleDraftTx(client, new Date());
    assert.equal(result, null);
});
