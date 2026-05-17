# Используем Node.js (Debian-based slim)
FROM node:20-slim

# Устанавливаем системные зависимости для сборки модуля 'canvas'
# pkg-config и libpixman необходимы для корректного обнаружения библиотек в Debian
RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Явно указываем путь к Python для node-gyp
ENV PYTHON=/usr/bin/python3

# Создаем рабочую директорию
WORKDIR /app

# Копируем только файлы манифеста для установки зависимостей (используем кэширование слоев)
COPY ./backend/package*.json ./

# Устанавливаем зависимости. Флаг --build-from-source заставляет скомпилировать canvas правильно под Debian
RUN npm install --build-from-source

# Копируем остальной код (папка node_modules будет проигнорирована благодаря .dockerignore)
COPY ./backend /app
COPY ./html /app/public

# Запускаем сервер
CMD ["node", "server.js"]
