"use strict";

const REQUIRED_ENV = [
    "DB_USER",
    "DB_HOST",
    "DB_NAME",
    "DB_PASSWORD",
    "DB_PORT",
    "SESSION_SECRET",
    "ADMIN_PASSWORD",
    "CORS_ORIGINS"
];

function parsePort(value, name) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(name + " must be an integer between 1 and 65535.");
    }
    return parsed;
}

function parseAllowedOrigins(value) {
    const origins = String(value)
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean);

    if (origins.length === 0) {
        throw new Error("CORS_ORIGINS must contain at least one origin.");
    }

    for (const origin of origins) {
        const url = new URL(origin);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("CORS_ORIGINS supports only http(s) origins.");
        }
    }

    return origins;
}

function loadConfig(env = process.env) {
    const missing = REQUIRED_ENV.filter(name => !env[name] || !String(env[name]).trim());
    if (missing.length > 0) {
        throw new Error("Missing required environment variables: " + missing.join(", "));
    }

    const nodeEnv = env.NODE_ENV || "development";

    return {
        nodeEnv,
        isProduction: nodeEnv === "production",
        port: parsePort(env.PORT || 8080, "PORT"),
        allowedOrigins: parseAllowedOrigins(env.CORS_ORIGINS),
        database: {
            user: env.DB_USER,
            host: env.DB_HOST,
            database: env.DB_NAME,
            password: env.DB_PASSWORD,
            port: parsePort(env.DB_PORT, "DB_PORT")
        },
        sessionSecret: env.SESSION_SECRET,
        adminPassword: env.ADMIN_PASSWORD
    };
}

module.exports = { loadConfig };
