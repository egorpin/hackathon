# Mars Colony: как запустить всё

Инструкция рассчитана на Windows PowerShell. Все команды, кроме явно отмеченных, выполняются из корня репозитория.

**Проект в WSL, сервер и клиенты Windows 11:** [запуск через единое имя mars.local](docs/windows-lan.md).
Сервер: `lan/start-server.cmd`, клиенты: `start-client.cmd` из подготовленной клиентской папки.
Из WSL: `./lan/start-server.sh -Prepare`, затем `./lan/start-server.sh`; Windows mDNS запускается автоматически.

Для автономной демонстрации по **HTTPS + WSS в LAN** используйте
[отдельную инструкцию](docs/https-lan.md) и `lan/start-https.cmd`.
Сертификаты выпускаются локально для IPv4 или постоянного имени сервера;
на клиентах нужно установить `ca.crt`.

## Запуск одной командой

Установите Docker Desktop, включите режим Linux containers и дождитесь его запуска. Затем из корня проекта выполните:

```powershell
.\start.cmd
```

Готовая игра откроется по адресу `http://localhost:8000`. Скрипт собирает оба образа, удаляет старые контейнеры этого проекта, запускает Nginx и FastAPI и ждёт, пока оба сервиса станут `healthy`. Повторный запуск этой же команды безопасно обновляет контейнеры и сохраняет игровой прогресс в Docker volume.

Для игроков на других компьютерах Docker не нужен. Они открывают `http://<IPv4-сервера>:8000`. WebSocket принимает фактический адрес страницы автоматически; редактировать `.env` для каждого LAN-адреса не требуется. На серверном компьютере должен быть разрешён входящий TCP-порт 8000 в частной сети Windows.

## Какой режим выбрать

| Цель | Адрес | Что работает |
| --- | --- | --- |
| Быстро показать 3D-мир | `http://127.0.0.1:5173/?fixture` | Геометрия, движение, две камеры, чанки и счётчик данных |
| Разрабатывать frontend + backend | `http://127.0.0.1:5173` | Авторизация, API, WebSocket/reconnect и чат; Vite проксирует backend |
| Проверить production-сборку | `http://127.0.0.1:8000` | FastAPI раздаёт собранный frontend, API и WebSocket |
| Запустить dev через Docker/LAN | `http://<IP-сервера>:8000` | Vite + один FastAPI, HMR/reload и SQLite volume |

Обычные адреса `:5173` и `:8000` получают состояние мира, движение и чанки по WebSocket. Войдите и нажмите «Начать экспедицию». Новые участники могут присоединиться после старта, пока в мире меньше четырёх игроков. Подробности: [сетевой контракт](docs/websocket-integration.md).

## 1. Установка

Для запуска через `start.cmd` нужен только Docker Desktop с Compose v2. Python 3.12, Node.js 22 и npm нужны лишь для разработки без Docker.

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
docker compose up -d --build --wait
docker compose ps
docker compose logs --tail 100
```

Dev-клиент и единственный backend связаны через Vite-прокси `/api` и `/ws`. Изменения исходников подхватываются автоматически. Production: `docker compose -f compose.prod.yaml up -d --build --wait`.

Локальный адрес: `http://localhost:8000`. Для других ноутбуков в одной сети:

1. Узнайте IPv4 сервера командой `ipconfig`.
2. Скопируйте `.env.example` в `.env` и добавьте точный URL, например `MARS_ALLOWED_ORIGINS=http://localhost:8000,http://127.0.0.1:8000,http://192.168.1.10:8000`.
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

## ИИ-помощник и обзор планеты

Кнопка «ИИ-помощник» в верхней панели открывает личный диалог с Qwen на Tesla.
Диалог открывается справа и не блокирует игру. Enter включает ввод, повторный
Enter отправляет сообщение и возвращает управление игрой; Shift+Enter добавляет
новую строку. Ответы отображаются в Markdown со списками, ссылками и блоками кода.
Войдите в игру перед отправкой вопроса. История хранится на сервере отдельно для
каждого игрока. Помощник получает текущие ресурсы и рецепты, но не выполняет игровые действия.

Для подключения модели запустите `powershell -File tools/start-game-ai.ps1` в отдельном
терминале и оставьте его открытым. Нужен настроенный SSH-профиль `tesla-server`.
Docker использует `http://host.docker.internal:11435`; при запуске Python без Docker
задайте `MARS_AI_URL=http://127.0.0.1:11435`. Модель можно сменить через `MARS_AI_MODEL`.
Без туннеля игра работает, а помощник сообщает о недоступности модели.

В режиме Tab колёсико приближает и отдаляет камеру, перетаскивание левой кнопкой
мыши и стрелки быстро вращают планету. Камера не меняет положение персонажа.
Повторный Tab возвращает вид от первого лица.

## Остановка

Серверы, запущенные в PowerShell, останавливаются `Ctrl+C`. Docker:

```powershell
docker compose down
```

Команда сохраняет volume с данными.
