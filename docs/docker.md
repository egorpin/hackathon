# Docker и локальный запуск

## Что уже есть

Compose собирает два образа: клиент на Nginx и сервер на FastAPI. Клиент обращается к `/api` и `/ws` на том же адресе, с которого открыта страница; Nginx передаёт запросы серверу по внутренней сети Compose. Наружу публикуется только порт клиента. Сервер слушает `0.0.0.0:8000` внутри контейнера, поэтому Compose может обслуживать браузеры на этом компьютере и позднее в LAN.

**Ограничение приложения:** сервер пока выдаёт авторизацию и чат, но не игровой snapshot, движение и чанки. Docker-конфигурация соединяет сервисы, однако обычный игровой процесс не заработает до подключения игрового ядра к WebSocket. Dev preview запускается отдельно через Vite `?fixture` по [goldberg.md](goldberg.md). Состояние разработки описано в [status.md](status.md).

Node собирает Vite, а Nginx обслуживает статические файлы и проксирует API/WebSocket. Один Uvicorn worker работает от непривилегированного пользователя; SQLite с WAL хранится в именованном volume `/data`. `/api/health` проверяет чтение базы. Клиент стартует после успешной проверки здоровья сервера.

## Запуск при наличии интернета

Нужен Docker Engine с Compose v2 (на Windows — Docker Desktop в режиме Linux containers). Из корня репозитория:

```powershell
Copy-Item .env.example .env
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail 100
```

Перед запуском с других ноутбуков добавьте в `MARS_ALLOWED_ORIGINS` в `.env` точный адрес страницы, например `http://192.168.1.10:8000`, сохранив нужные адреса localhost. После изменения выполнить `docker compose up -d`. Для HTTPS установите `MARS_SECURE_COOKIE=true`; при обычном HTTP в LAN оставьте `false`.

Открыть `http://localhost:8000` и `http://localhost:8000/api/health`. На других ноутбуках — `http://<LAN-IP>:8000`; IP посмотреть через `ipconfig`. При необходимости разрешить входящий TCP-порт 8000 в частной сети Windows Firewall. Порт меняется через MARS_PORT в .env; внутри контейнера всегда 8000.

## Офлайн

Сборка требует интернета для базовых образов и пакетов. До отключения сети собрать и проверить итоговый образ:

```powershell
docker image save -o mars-colony-images.tar mars-colony-client:local mars-colony-server:local
docker compose up -d --no-build --pull never
```

На другом серверном ноутбуке предварительно установить Docker, перенести образ, compose.yaml и .env:

```powershell
docker image load -i mars-colony-images.tar
docker compose up -d --no-build --pull never
```

Образ содержит ассеты и пакеты, но не данные volume. Игрокам Docker не нужен. Не пересобирать образ в офлайне.

## Данные и резервная копия

`docker compose restart` и `docker compose down` сохраняют volume. **`docker compose down -v` удаляет прогресс.** Не менять имя Compose-проекта без переноса volume.

Для согласованной копии SQLite вместе с WAL сначала остановить сервис, затем скопировать весь `/data` (контейнер не удалять):

```powershell
docker compose stop
docker compose cp server:/data ./mars-data-backup
docker compose start
```

Восстановление на новом, пустом volume: создать контейнер через `docker compose create`, затем `docker compose cp ./mars-data-backup/. server:/data`. Если копирование сменило владельца, выполнить `docker compose run --rm --no-deps --user root server chown -R 10001:10001 /data`, затем `docker compose up -d --no-build --pull never`. Сначала проверить восстановление на отдельной копии, не поверх единственного рабочего прогресса.

## Без Docker для разработки

Python 3.12 и Node 22. В корне: `python -m venv .venv`, затем `.venv/Scripts/python -m pip install -r server/requirements.txt`. Запуск: `.venv/Scripts/python -m uvicorn app.main:app --app-dir server --host 0.0.0.0 --port 8000 --ws-max-size 4096`. В другом терминале из client: `npm ci`, `npm run dev`. Vite проксирует `/api` и `/ws`; локальная база создаётся в data/.

Тесты сервера: `.venv/Scripts/python -m pip install -r server/requirements-dev.txt`, затем `.venv/Scripts/python -m pytest -q` из корня. Для LAN без Docker задайте `MARS_ALLOWED_ORIGINS` в окружении процесса сервера. По умолчанию разрешены только адреса localhost и 127.0.0.1 на портах 8000 и 5173.

## Приёмка контейнера

Проверки исходников после слияния: из корня `.venv/Scripts/python -m pytest -q`; из `client` — `npm test` и `npm run build`. Это отдельные проверки, не замена сборке контейнера, LAN и восстановлению volume.

31 октября 2026 года проверены `docker compose build --pull`, запуск, healthcheck, раздача HTML/JS/CSS и работа от UID 10001. Тестовый пользователь и его cookie-сессия сохранились после `docker compose restart`; `/data/mars.sqlite3` осталась в режиме WAL. Compose-файл задаёт имя проекта `mars-colony`, поэтому команды работают и из каталога с кириллическим именем.

После сборки проверить healthy, страницу и API с другого ноутбука, затем restart и повторный health. Проверить наличие файла `/data/mars.sqlite3` и режим WAL. После реализации игры выполнить docs/demo.md; успешный healthcheck сам по себе не подтверждает готовность игры.
