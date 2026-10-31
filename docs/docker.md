# Docker: связанная dev-конфигурация

Из корня репозитория, без установки Python/Node на хост:

```sh
docker compose up -d --build --wait
```

Перед запуском остановите ранее запущенные вручную Uvicorn/Vite из этого проекта. В Docker Desktop + WSL локальный Uvicorn на 8000 может перехватывать localhost даже при успешном запуске контейнеров. На странице dev-клиента должен загружаться `/@vite/client`.

Открыть http://localhost:8000. Работают два контейнера: Vite-клиент и **один** FastAPI backend. Только клиент публикует порт; `/api` и `/ws` проходят через Vite на `http://server:8000` в сети Compose. Cookie и Origin сохраняются. Все игроки подключаются к одному экземпляру мира. Uvicorn reload использует процесс-наблюдатель и один обслуживающий процесс; запускать несколько backend-реплик/workers нельзя.

Исходники клиента, сервера, content и world подключены с хоста. Клиент поддерживает HMR; Python-код перезапускает backend, после чего клиент переподключается и получает новый snapshot. Зависимости находятся в образах: после изменения package-lock.json или requirements пересоберите той же командой. SQLite сохраняется в volume `mars-data`.

`docker compose ps` должен показать оба сервиса healthy. Healthcheck клиента обращается к `/api/health` через Vite, поэтому проверяет связь с backend. `/@vite/client` подтверждает dev-режим.

## Порт и LAN

`.env` необязателен. `MARS_PORT` меняет внешний порт (по умолчанию 8000); localhost Origins автоматически учитывают его. Для LAN скопируйте `.env.example` в `.env` и явно задайте `MARS_ALLOWED_ORIGINS`, включая точный `http://<LAN-IP>:<MARS_PORT>`. После изменения выполните команду запуска снова. На Windows разрешите входящий порт в Firewall. Для обычного HTTP оставьте `MARS_SECURE_COOKIE=false`.

## Проверка полного обмена

Скрипт создаёт игрока и начинает экспедицию, поэтому запускайте его на отдельном тестовом проекте со свежим volume. Нужны локальные Python с `server/requirements-dev.txt` и Node:

```sh
MARS_PORT=18000 docker compose -p mars-colony-check up -d --build --wait
.venv/bin/python tools/check-dev.py http://localhost:18000
MARS_PORT=18000 docker compose -p mars-colony-check down -v
```

Если в `.env` явно задан `MARS_ALLOWED_ORIGINS`, добавьте для проверки `http://localhost:18000`. В PowerShell задавайте порт через `$env:MARS_PORT = "18000"`, Python запускайте через `.\.venv\Scripts\python.exe`.

Проверяются HTTP-прокси, cookie-авторизация, WebSocket, чат с Unicode, snapshot/delta, загрузка чанков, три типа зданий, склад, добыча и передача ресурсов в здания, кислород, движение и reconnect. Полученные сообщения повторно проходят реальные клиентские GameClient/Runtime/WorldCache: проверяются размеры DTO, бюджет памяти и отсутствие resync. Отдельные pytest-тесты проверяют все чанки, видимость объектов, команды и синхронизацию нескольких клиентов.

## Production

Сборка Nginx + FastAPI сохранена отдельно:

```sh
docker compose -f compose.prod.yaml up -d --build --wait
```

Dev и production используют одно имя проекта и volume: переключение заменяет сервисы и сохраняет данные. Production не монтирует исходники.

## Офлайн

Сборка требует интернета для базовых образов и пакетов. До отключения сети собрать и проверить итоговый образ:

```powershell
docker image save -o mars-colony-images.tar mars-colony-client:local mars-colony-server:local
docker compose -f compose.prod.yaml up -d --no-build --pull never
```

На другом серверном ноутбуке предварительно установить Docker, перенести образ, compose.prod.yaml и .env:

```powershell
docker image load -i mars-colony-images.tar
docker compose -f compose.prod.yaml up -d --no-build --pull never
```

Образ содержит ассеты и пакеты, но не данные volume. Игрокам Docker не нужен. Не пересобирать образ в офлайне.

## Данные и резервная копия

`docker compose -f compose.prod.yaml restart` и `docker compose -f compose.prod.yaml down` сохраняют volume. **`docker compose -f compose.prod.yaml down -v` удаляет прогресс.** Не менять имя Compose-проекта без переноса volume.

Для согласованной копии SQLite вместе с WAL сначала остановить сервис, затем скопировать весь `/data` (контейнер не удалять):

```powershell
docker compose -f compose.prod.yaml stop
docker compose -f compose.prod.yaml cp server:/data ./mars-data-backup
docker compose -f compose.prod.yaml start
```

Восстановление на новом, пустом volume: создать контейнер через `docker compose -f compose.prod.yaml create`, затем `docker compose -f compose.prod.yaml cp ./mars-data-backup/. server:/data`. Если копирование сменило владельца, выполнить `docker compose -f compose.prod.yaml run --rm --no-deps --user root server chown -R 10001:10001 /data`, затем `docker compose -f compose.prod.yaml up -d --no-build --pull never`. Сначала проверить восстановление на отдельной копии, не поверх единственного рабочего прогресса.

## Без Docker для разработки

Python 3.12 и Node 22. В корне: `python -m venv .venv`, затем `.venv/Scripts/python -m pip install -r server/requirements.txt`. Запуск: `.venv/Scripts/python -m uvicorn app.main:app --app-dir server --host 0.0.0.0 --port 8000 --ws-max-size 4096`. В другом терминале из client: `npm ci`, `npm run dev`. Vite проксирует `/api` и `/ws`; локальная база создаётся в data/.

Тесты сервера: `.venv/Scripts/python -m pip install -r server/requirements-dev.txt`, затем `.venv/Scripts/python -m pytest -q` из корня. Для LAN без Docker задайте `MARS_ALLOWED_ORIGINS` в окружении процесса сервера. По умолчанию разрешены только адреса localhost и 127.0.0.1 на портах 8000 и 5173.
