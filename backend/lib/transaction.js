"use strict";

async function withTransaction(pool, operation) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {
            // Keep the original operation error.
        }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { withTransaction };
