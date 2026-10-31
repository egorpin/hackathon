# Docker и локальный запуск

## Что уже есть

Многоэтапная сборка: Node собирает Vite, Python запускает FastAPI со статикой. Один Uvicorn worker слушает 0.0.0.0:8000. Процесс работает от непривилегированного пользователя; SQLite с WAL хранится в именованном volume `/data`. `/api/health` проверяет чтение базы. Это каркас: игра, вход, WebSocket и агенты ещё не реализованы.

## Запуск при наличии интернета

Нужен Docker Engine с Compose v2 (на Windows — Docker Desktop в режиме Linux containers). Из корня репозитория:

```powershell
Copy-Item .env.example .env
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail 100
```

Открыть `http://localhost:8000` и `http://localhost:8000/api/health`. На других ноутбуках — `http://<LAN-IP>:8000`; IP посмотреть через `ipconfig`. При необходимости разрешить входящий TCP-порт 8000 в частной сети Windows Firewall. Порт меняется через MARS_PORT в .env; внутри контейнера всегда 8000.

## Офлайн

Сборка требует интернета для базовых образов и пакетов. До отключения сети собрать и проверить итоговый образ:

```powershell
docker image save -o mars-colony-image.tar mars-colony:local
docker compose up -d --no-build --pull never
```

На другом серверном ноутбуке предварительно установить Docker, перенести образ, compose.yaml и .env:

```powershell
docker image load -i mars-colony-image.tar
docker compose up -d --no-build --pull never
```

Образ содержит ассеты и пакеты, но не данные volume. Игрокам Docker не нужен. Не пересобирать образ в офлайне.

## Данные и резервная копия

`docker compose restart` и `docker compose down` сохраняют volume. **`docker compose down -v` удаляет прогресс.** Не менять имя Compose-проекта без переноса volume.

Для согласованной копии SQLite вместе с WAL сначала остановить сервис, затем скопировать весь `/data` (контейнер не удалять):

```powershell
docker compose stop
docker compose cp mars-colony:/data ./mars-data-backup
docker compose start
```

Восстановление на новом, пустом volume: создать контейнер через `docker compose create`, затем `docker compose cp ./mars-data-backup/. mars-colony:/data`. Если копирование сменило владельца, выполнить `docker compose run --rm --no-deps --user root mars-colony chown -R 10001:10001 /data`, затем `docker compose up -d --no-build --pull never`. Сначала проверить восстановление на отдельной копии, не поверх единственного рабочего прогресса.

## Без Docker для разработки

Python 3.12 и Node 22. В корне: `python -m venv .venv`, затем `.venv/Scripts/python -m pip install -r server/requirements.txt`. Запуск: `.venv/Scripts/python -m uvicorn app.main:app --app-dir server --host 0.0.0.0 --port 8000`. В другом терминале из client: `npm ci`, `npm run dev`. Vite проксирует `/api` и `/ws`; локальная база создаётся в data/.

## Приёмка контейнера

После сборки проверить healthy, страницу и API с другого ноутбука, затем restart и повторный health. Проверить наличие файла `/data/mars.sqlite3` и режим WAL. После реализации игры выполнить docs/demo.md; успешный healthcheck сам по себе не подтверждает готовность игры.
