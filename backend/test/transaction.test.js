const test = require("node:test");
const assert = require("node:assert/strict");
const { withTransaction } = require("../lib/transaction");

test("uses one checked-out client for a successful transaction", async () => {
    const calls = [];
    const client = {
        async query(sql) {
            calls.push(sql);
        },
        release() {
            calls.push("RELEASE");
        }
    };
    const pool = { connect: async () => client };

    const result = await withTransaction(pool, async (transactionClient) => {
        assert.equal(transactionClient, client);
        await transactionClient.query("WORK");
        return 42;
    });

    assert.equal(result, 42);
    assert.deepEqual(calls, ["BEGIN", "WORK", "COMMIT", "RELEASE"]);
});

test("rolls back on failure and preserves the original error", async () => {
    const calls = [];
    const client = {
        async query(sql) {
            calls.push(sql);
        },
        release() {
            calls.push("RELEASE");
        }
    };
    const pool = { connect: async () => client };

    await assert.rejects(
        withTransaction(pool, async () => {
            throw new Error("boom");
        }),
        /boom/
    );

    assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "RELEASE"]);
});
