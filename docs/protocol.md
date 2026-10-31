# Контракт интеграции — стартовый проект

Владелец: участник 2. Это проект контракта для согласования в первые 20 минут, **не описание реализованного API**. Сейчас работает только `GET /api/health` и раздача статики.

## Общие соглашения

- Координаты: центр планеты `(0,0,0)`, правая система, метры; позиция `[x,y,z]`. Радиус и параметры движения задаёт сервер. Вертикаль — нормализованная позиция; формат ориентации согласовать участникам 1 и 3 до реализации.
- `cell_id`, `chunk_id`, `world_id`, `team_id`, `building_id` — непрозрачные строки; клетка и чанк различаются.
- Клиент → сервер: `{ "type": "building.place", "request_id": "UUID", "payload": { "cell_id": "...", "building_type": "drill" } }`.
- Сервер → клиент: `{ "type": "action.result", "request_id": "UUID", "revision": 1, "payload": { "ok": false, "code": "OUT_OF_RANGE" } }`.
- Для значимых команд request_id обязателен; хранить результат и отпечаток payload вместе с транзакцией, ключ — пользователь/мир/request_id. Тот же ID с иным payload отклонять. `player.input` использует возрастающий `seq` и ограниченный ввод, а не доверенную позицию.
- Snapshot содержит tick/revision и только доступное получателю состояние. После reconnect сначала snapshot, затем delta; пропуск revision требует повторной синхронизации.
- user_id и team_id не принимаются как доверенная идентичность из payload; сервер получает их из сессии и членства.

## Сообщения, обязательные для демо

| Намерение | Поля payload для согласования | Ответ |
| --- | --- | --- |
| player.input | seq, оси движения, направление взгляда | world.snapshot / world.delta |
| building.place | cell_id, building_type | action.result, world.delta |
| resource.pickup / resource.deposit | building_id, resource, amount | action.result, inventory.updated |
| resource.give | recipient_player_id, resource, amount | action.result, inventory.updated |
| chat.send | text | chat.message только членам команды |
| agent.ask | agent_id, question | agent.reply только автору |
| chunk.request | chunk_id | chunk.load только в разрешённой области |

Длины строк, максимумы количеств, скорость команд и точные DTO фиксирует участник 2 с владельцами до подключения UI. Сервер проверяет дистанцию, права, наличие и вместимость. Коды отказа: INVALID_ARGUMENT, UNAUTHORIZED, FORBIDDEN, OUT_OF_RANGE, CELL_OCCUPIED, INSUFFICIENT_RESOURCES, INVENTORY_FULL, REQUEST_CONFLICT.

## Границы модулей

Предлагаемые интерфейсы (реализацию согласовать до первого слияния):

```python
apply_command(context, command, unit_of_work) -> CommandResult
step(world, dt_seconds) -> list[WorldEvent]
await answer(context, agent_id, question, game_context) -> AgentReply
```

`context` содержит проверенные world_id/user_id/team_id. Участник 2 владеет unit_of_work и транзакцией, участник 3 — проверками/изменениями мира, участник 4 — AgentService. Мутация памяти мира не должна переживать откат транзакции. Ответ агента не исполняется внутри игрового шага.

## Поток данных мира

Версия карты и манифест определяют общий объём уникальных сериализованных данных в UTF-8 и byte_size каждого чанка/оболочки. Зафиксировать единое представление байтов до реализации счётчика; не использовать размер сжатого HTTP-ответа. Динамические данные и их обновления должны учитываться согласованно с знаменателем, без повторного счёта одного объекта.

Сервер определяет область интереса по позиции игрока, не камеры. Клиент резервирует место до загрузки и подтверждает освобождение; активные данные + кеш + входящая очередь + оболочка ≤10%, целевой бюджет 5%. Чанк, который не помещается, не загружается целиком с последующей очисткой: изменить разбиение/уменьшить набор. Ответы мира — `Cache-Control: no-store`.

Авторизация, Origin allowlist, WebSocket и поток чанков в каркасе пока отсутствуют.
