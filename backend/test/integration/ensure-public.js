"use strict";

// Интеграционные тесты запускают настоящий server.js отдельным процессом,
// а он отдаёт статику из backend/public - в обычной разработке эта папка
// либо собирается Docker-стадией сборки, либо примонтирована как volume
// (docker-compose.dev.yaml). Для тестов вне Docker просто линкуем её на
// html/, как уже делает dev-окружение. backend/public/ уже в .gitignore.

const fs = require("fs");
const path = require("path");

const publicDir = path.join(__dirname, "..", "..", "public");
const htmlDir = path.join(__dirname, "..", "..", "..", "html");

if (!fs.existsSync(publicDir)) {
    fs.symlinkSync(htmlDir, publicDir, "dir");
    console.log(`[integration-setup] Linked ${publicDir} -> ${htmlDir}`);
}
