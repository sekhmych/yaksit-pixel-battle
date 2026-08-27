const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../lib/config");

const validEnv = {
    NODE_ENV: "test",
    PORT: "3000",
    CORS_ORIGINS: "http://localhost:8080",
    DB_USER: "test",
    DB_PASSWORD: "test",
    DB_HOST: "localhost",
    DB_PORT: "5432",
    DB_NAME: "test",
    ADMIN_PASSWORD: "test-password",
    SESSION_SECRET: "test-session-secret"
};

test("loads explicit runtime configuration", () => {
    const config = loadConfig(validEnv);
    assert.equal(config.port, 3000);
    assert.equal(config.database.port, 5432);
    assert.deepEqual(config.allowedOrigins, ["http://localhost:8080"]);
    assert.equal(config.isProduction, false);
});

test("rejects missing secrets and wildcard origins", () => {
    const missingSecret = { ...validEnv };
    delete missingSecret.SESSION_SECRET;
    assert.throws(() => loadConfig(missingSecret), /SESSION_SECRET/);

    const wildcard = { ...validEnv, CORS_ORIGINS: "*" };
    assert.throws(() => loadConfig(wildcard), /Invalid URL/);
});
