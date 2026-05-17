# Используем легкий образ Node.js
FROM node:20-alpine

# Создаем рабочую директорию
WORKDIR /app

# Копируем файлы манифеста
COPY ./backend/package*.json ./

# Устанавливаем зависимости (теперь без компиляции, так как используем jimp)
RUN npm install --omit=dev

# Копируем исходный код бэкенда
COPY ./backend /app

# Копируем фронтенд в папку public
COPY ./html /app/public

# Явно открываем порт 3000 для проксирования
EXPOSE 3000

# Запускаем сервер
CMD ["node", "server.js"]
