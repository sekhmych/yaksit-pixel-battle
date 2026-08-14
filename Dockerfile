# === Этап 1: сборка статического CSS (Tailwind) ===
FROM node:20-alpine AS assets

WORKDIR /assets

COPY package*.json ./
RUN npm install

COPY html ./html
RUN npm run build:css

# === Этап 2: рантайм бэкенда ===
FROM node:20-alpine

# Создаем рабочую директорию
WORKDIR /app

# Копируем файлы манифеста
COPY ./backend/package*.json ./

# Устанавливаем зависимости (теперь без компиляции, так как используем jimp)
RUN npm install --omit=dev

# Копируем исходный код бэкенда
COPY ./backend /app

# Копируем фронтенд (с уже собранным tailwind.css) в папку public
COPY --from=assets /assets/html /app/public

# Явно открываем порт 3000 для проксирования
EXPOSE 3000

# Запускаем сервер
CMD ["node", "server.js"]
