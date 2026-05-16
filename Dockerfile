# Используем Node.js
FROM node:20-alpine

# Создаем рабочую директорию
WORKDIR /app

# Устанавливаем зависимости (как у вас было в command)
RUN npm install express socket.io pg cors

# Копируем исходный код бэкенда и HTML внутрь контейнера
COPY ./backend /app
COPY ./html /app/public

# Запускаем сервер
CMD ["node", "server.js"]