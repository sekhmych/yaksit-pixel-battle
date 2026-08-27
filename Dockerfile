# === Этап 1: сборка статического CSS (Tailwind) ===
FROM node:20-alpine AS assets

WORKDIR /assets

COPY package.json package-lock.json ./
RUN npm ci

COPY html ./html
RUN npm run build:css

# === Этап 2: рантайм бэкенда ===
FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend /app
COPY --from=assets /assets/html /app/public

EXPOSE 3000

CMD ["node", "server.js"]
