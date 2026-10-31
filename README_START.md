# Mars Colony: как запустить всё

Инструкция рассчитана на Windows PowerShell. Все команды, кроме явно отмеченных, выполняются из корня репозитория.

## Какой режим выбрать

| Цель | Адрес | Что работает |
| --- | --- | --- |
| Быстро показать 3D-мир | `http://127.0.0.1:5173/?fixture` | Геометрия, движение, две камеры, чанки и счётчик данных |
| Разрабатывать frontend + backend | `http://127.0.0.1:5173` | Авторизация, API, WebSocket/reconnect и чат; Vite проксирует backend |
| Проверить production-сборку | `http://127.0.0.1:8000` | FastAPI раздаёт собранный frontend, API и WebSocket |
| Запустить через Docker/LAN | `http://<IP-сервера>:8000` | Production-сборка и SQLite volume |

Обычные адреса `:5173` и `:8000` получают состояние мира, движение и чанки по WebSocket. Войдите всеми участниками (до четырёх), затем нажмите «Начать экспедицию». После старта доступны переподключения существующих игроков. Подробности: [сетевой контракт](docs/websocket-integration.md).

## 1. Установка

Нужны Python 3.12, Node.js 22 и npm. Docker нужен только для Docker-режима.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r server\requirements.txt -r server\requirements-dev.txt -r tools\requirements-world.txt

Set-Location client
npm ci
Set-Location ..
```

## 2. Визуальное 3D-демо

Сгенерируйте карту. Файл попадёт в `world/generated/` и не будет добавлен в Git.

```powershell
Set-Location client
$env:WORLD_PYTHON = (Resolve-Path ..\.venv\Scripts\python.exe)
npm run world:generate
npm run dev -- --host 127.0.0.1 --port 5173
```

Откройте `http://127.0.0.1:5173/?fixture`. Ожидаемый HUD показывает ненулевые FPS, вызовы отрисовки и загруженные чанки. Backend для этого режима не нужен.

Управление: WASD — движение, мышь или стрелки — взгляд, `Tab` — смена камеры, `Esc` — осводить мышь.

## 3. Frontend + backend для разработки

Первый PowerShell:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir server --host 127.0.0.1 --port 8000 --ws-max-size 4096
```

Второй PowerShell:

```powershell
Set-Location client
npm run dev -- --host 127.0.0.1 --port 5173
```

Откройте `http://127.0.0.1:5173`. При первом запуске выберите «Создать игрока». Vite проксирует `/api` и `/ws` на FastAPI. SQLite создаётся в `data/mars.sqlite3`.

Проверка backend:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

## 4. Production без Docker

Соберите frontend:

```powershell
Set-Location client
npm run build
Set-Location ..
```

Запустите FastAPI из корня репозитория, чтобы путь `client/dist` был найден:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir server --host 127.0.0.1 --port 8000 --ws-max-size 4096
```

Откройте `http://127.0.0.1:8000`.

## 5. Docker и LAN

```powershell
Copy-Item .env.example .env
docker compose up -d --build
docker compose ps
docker compose logs --tail 100
```

Локальный адрес: `http://localhost:8000`. Для других ноутбуков в одной сети:

1. Узнайте IPv4 сервера командой `ipconfig`.
2. Добавьте точный URL в `.env`, например `MARS_ALLOWED_ORIGINS=http://localhost:8000,http://127.0.0.1:8000,http://192.168.1.10:8000`.
3. Повторите `docker compose up -d`.
4. Разрешите TCP-порт 8000 в Windows Firewall для частной сети.
5. Откройте `http://192.168.1.10:8000` на клиентах.

Не используйте `docker compose down -v`, если нужно сохранить SQLite volume. Подробности: [docs/docker.md](docs/docker.md).

## 6. Проверки

```powershell
.\.venv\Scripts\python.exe -m pytest -q

Set-Location client
npm test
npm run build
```

Краткая проверка перед демо:

- `/api/health` возвращает `{"status":"ok"}`;
- на `?fixture` HUD показывает FPS, ненулевые вызовы отрисовки и загруженные чанки;
- на обычном URL регистрация завершается статусом «Подключено»;
- после перезагрузки WebSocket переподключается.

## Остановка

Серверы, запущенные в PowerShell, останавливаются `Ctrl+C`. Docker:

```powershell
docker compose down
```

Команда сохраняет volume с данными.
