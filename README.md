# qwen-proxy — OpenAI-совместимый прокси для Qwen

**OpenAI-совместимый API для Qwen Web Chat через Termux**

Локальный сервер, который превращает браузерную сессию `chat.qwen.ai` в стандартный OpenAI-совместимый API. Работает с Kai 9000, Open WebUI, Chatbox, SillyTavern, Cline, Continue.dev, OpenAI SDK и другими клиентами.

**Используйте на свой страх и риск.** Проект работает через недокументированный web-API Qwen. Это может нарушать условия использования и привести к блокировке аккаунта. Автор не несёт ответственности за заблокированные аккаунты, неверные ответы модели или любые другие последствия. Используйте одноразовый аккаунт, который не жалко потерять.

---

## ✨ Возможности

* **OpenAI-совместимый API** на `127.0.0.1:5000`
* **5 моделей**: `qwen3.8-max`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-plus`
* **Tool calling** (эмуляция через промпт) — работает с Kai 9000, Cline, Roo Code, Continue.dev
* **SSE-стриминг** — ответ приходит в реальном времени
* **Автообновление токена** — каждые 10 минут + за 5 минут до истечения
* ♻️ **Ротация `refresh_token`** — прокси сам сохраняет новый токен в cookie
* **`fs.watch`** — автоматически подхватывает новый `qwen-auth.json` без перезапуска
* **Защита от «лживых» ответов** — если Qwen говорит «сохранил», но не вызвал tool, прокси синтезирует вызов
* **Retry при пустом ответе** — повторяет запрос с чистым чатом
* **Retry при сетевых сбоях** — undici Agent + экспоненциальный backoff
* **Защита shell** — запрет `rm`, `mv`, `dd`, `mkfs`, `chmod`, `chown`, `sudo` в промпте
* **Минимум зависимостей** — только `undici` (чистый JS)
* **Расширение для снятия дампа** — см. репозиторий [`qwen-dumper`](https://github.com/eldevex/qwen-dumper)

---

## Требования

Компонент | Что нужно
---|---
**Устройство** | Android 8+ / Linux / macOS / Windows
**Терминал** | [Termux из F-Droid](https://f-droid.org/packages/com.termux/) (не из Google Play!)
**Node.js** | 18+ (устанавливается автоматически)
**npm** | идёт в комплекте с Node.js
**Браузер** | Любой Chromium-браузер с поддержкой расширений: [Kiwi Browser](https://play.google.com/store/apps/details?id=com.kiwibrowser.browser) или [Titanium Browser](https://github.com/jqssun/android-titanium-browser)
**Аккаунт** | Qwen (желательно одноразовый, не основной)

---

## Установка

### Способ 1: Клонирование репозитория (классический)

```bash
cd ~
git clone https://github.com/eldevex/qwen-proxy.git
cd qwen-proxy
npm install
chmod +x *.sh *.js
```

### Что дальше — одинаково для обоих способов

**1️⃣ Установите расширение в браузере**

1. Скачайте расширение **Qwen Full Dumper** из [репозитория](https://github.com/eldevex/qwen-dumper).
2. Откройте **Kiwi** или **Titanium Browser**.
3. Включите **Режим разработчика** в разделе расширений.
4. Нажмите **Load unpacked** и выберите папку с расширением.
5. Иконка расширения появится на панели.

**2️⃣ Сделайте дамп auth**

1. Откройте `chat.qwen.ai` в том же браузере.
2. Залогиньтесь в аккаунт.
3. Зайдите в любой чат.
4. Отправьте любое сообщение, дождитесь ответа Qwen.
5. Нажмите иконку расширения → **Снять дамп** → файл `qwen-dump-XXXX.json` сохранится в `~/storage/downloads/`.

**3️⃣ Загрузите дамп в прокси**

```bash
cd ~/qwen-proxy
./update-auth.sh
```

Скрипт сам найдёт свежий дамп в `~/storage/downloads/` и создаст `qwen-auth.json`. В консоли увидите:

```
✅ qwen-auth.json: qwen-auth.json
   token:         eyJhbGciOiJIUzI1NiIs...
   refresh_token: eyJhbGciOiJIUzI1NiIs...
   cookie:        10 cookies, 1095 chars
   bx-ua:         234!tqNeKVT+eePWwjmPww...
   bx-umidtoken:  T2gA_uk3S2VlvBqXK8D8...
   bx-v:          2.5.37
   user_id:       (ПУСТО)
```

**4️⃣ Запустите прокси**

```bash
./start-qwen.sh
```

Вывод:

```
✅ qwen-proxy запущен, PID 12354
Проверка:        curl http://localhost:5000/v1/health
Ручной refresh:  curl -X POST http://localhost:5000/v1/refresh
Логи:            tail -f ./proxy.log
Стоп:            pkill -f qwen-proxy.js
```

**5️⃣ Проверьте работу**

```bash
# Health check
curl -s http://localhost:5000/v1/health | python3 -m json.tool

# Простой запрос
curl -s http://localhost:5000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"привет"}]}' \
  | python3 -m json.tool

# Тест с инструментом
./test-tools.sh
```

В health должно быть:

* `ok: true`
* `token_expired: false`
* `token_seconds_left` — порядка 600–900
* `has_refresh_token: true`
* `has_bx_ua: true`
* `tool_calling: "emulated v15 (...)"`

---

## Настройка клиента (Kai 9000, Open WebUI, Chatbox)

В настройках клиента укажите:

Параметр | Значение
---|---
**Base URL** | `http://127.0.0.1:5000/v1`
**API Key** | `sk-qwen-local` (любой — прокси не проверяет)
**Model** | `qwen3.7-plus` (или `qwen3.8-max`)

### Доступные модели

ID модели | Описание
---|---
`qwen3.8-max` | Максимальная, лучше держит tool calling
`qwen3.7-max` | Стабильная, быстрая
`qwen3.7-plus` | ⭐ Рекомендуется по умолчанию
`qwen3.6-plus` | Легче
`qwen3.5-plus` | Самая быстрая

> Любое другое имя модели автоматически подменяется на `qwen3.7-plus` — можно оставить в клиенте как есть.

### Доступ с другого устройства

Если клиент на другом устройстве в той же Wi-Fi:

```bash
# Узнать IP телефона
ifconfig wlan0 2>/dev/null | grep "inet " | awk '{print $2}'
# например: 192.168.1.42

# Запустить с HOST=0.0.0.0
cd ~/qwen-proxy
pkill -f qwen-proxy.js; sleep 1
HOST=0.0.0.0 REFRESH_INTERVAL_MS=600000 REFRESH_AHEAD_SEC=300 \
  DEFAULT_MAX_TOKENS=32768 \
  nohup node qwen-proxy.js > proxy.log 2>&1 &
```

В клиенте: **Base URL** = `http://192.168.1.42:5000/v1`.

---

## Управление

```bash
# Запуск
cd ~/qwen-proxy && ./start-qwen.sh

# Остановка
./stop.sh

# Статус + health + последние логи
./status.sh

# Логи в реальном времени
tail -f ~/qwen-proxy/proxy.log

# Ручной refresh токена
curl -X POST http://localhost:5000/v1/refresh

# Список моделей
curl -s http://localhost:5000/v1/models | python3 -m json.tool

# Смоук-тесты (health + чат + tools)
./test-tools.sh
```

---

## ⚙️ Настройки (переменные окружения)

Все параметры передаются при запуске:

```bash
MAX_TOOLS=20 \
AUTO_THINKING=0 \
EMPTY_RETRY=1 \
SYNTHESIZE_MEMORY=1 \
FETCH_RETRIES=3 \
REFRESH_INTERVAL_MS=600000 \
REFRESH_AHEAD_SEC=300 \
DEFAULT_MAX_TOKENS=32768 \
HOST=127.0.0.1 \
  nohup node qwen-proxy.js > proxy.log 2>&1 &
```

Переменная | По умолчанию | Описание
---|---|---
`PORT` | `5000` | Порт сервера
`HOST` | `127.0.0.1` | Адрес. `0.0.0.0` — доступ по сети
`REFRESH_INTERVAL_MS` | `600000` (10 мин) | Как часто обновлять access-токен
`REFRESH_AHEAD_SEC` | `300` (5 мин) | За сколько секунд до истечения обновлять
`DEFAULT_MAX_TOKENS` | `32768` | Максимум токенов ответа
`MAX_TOOLS` | `20` | Максимум инструментов в промпте (Qwen путается при 20+)
`AUTO_THINKING` | `0` | Включить «размышления» Qwen (медленнее, но точнее)
`EMPTY_RETRY` | `1` | Retry при пустом ответе Qwen
`SYNTHESIZE_MEMORY` | `1` | Синтез `memory_store`, если модель соврала «сохранил»
`SANITIZE_SYSTEM` | `1` | Очистка опасных фраз system-промпта Kai
`FETCH_RETRIES` | `3` | Retry при сетевых сбоях
`FETCH_TIMEOUT_MS` | `90000` | Таймаут fetch (90 сек)
`DEBUG` | `1` | Подробные логи (`0` — выключить)

---

## Обновление токена

Access-токен обновляется автоматически. Но `refresh_token` живёт ~7 дней — после этого нужен новый дамп.

**Признаки, что пора обновить:**

```
[auth] refresh failed
[auth] ⚠️  refresh failed, продолжаем со старым токеном
```

**Что делать:**

1. Откройте `chat.qwen.ai` в браузере, залогиньтесь заново.
2. Снимите свежий дамп через расширение.
3. Выполните:

```bash
cd ~/qwen-proxy
./update-auth.sh          # сам найдёт свежий дамп
# Прокси подхватит на лету (fs.watch) — перезапуск НЕ нужен
```

---

## ❓ Частые проблемы

**«У меня нет доступа к файлам / памяти / интернету»**

Qwen не вызвал tool, а ответил текстом. Причины:
- Kai прислал слишком много инструментов (40+) → уменьшите: `MAX_TOOLS=15 ./start-qwen.sh`
- Конфликт фраз в system-промпте Kai → `SANITIZE_SYSTEM=1` (уже включено по умолчанию)
- Модель тупит → смените в клиенте на `qwen3.8-max`

Проверьте лог: `tail -n 50 ~/qwen-proxy/proxy.log`

**Прокси отвечает пустотой (`content: null`, `finish_reason: stop`)**

Qwen вернул пустой стрим. Причины:
- Модерация (Qwen не любит shell-команды в истории)
- Перегрузка (rate-limit)
- Проблема с конкретным tool

Прокси v15 автоматически делает **retry с чистым чатом** — смотрите лог:

```
[qwen] ⚠️  пустой ответ — retry с чистым чатом
[qwen] retry: чистый чат, история отброшена
```

Если retry тоже пустой — подождите 5–10 минут.

**`fetch failed`**

v15 использует `undici` с коротким keep-alive + retry. Если всё равно падает — увеличьте:

```bash
FETCH_RETRIES=5 FETCH_TIMEOUT_MS=180000 ./start-qwen.sh
```

**`kimi-auth.json не найден` / аналог**

Не прогнан `update-auth.sh`, либо в дампе нет токенов. Снять новый дамп.

**`chat_id missing` / пустые ответы на первом запросе**

Дамп снят с пустого чата. Откройте `chat.qwen.ai`, зайдите в непустой чат, отправьте сообщение, дождитесь ответа, снять новый дамп.

**Расширение не устанавливается в браузер**

* Убедитесь, что используете Chromium-браузер с поддержкой расширений (**Kiwi Browser** или **Titanium Browser**) — в обычном Chrome на Android расширения не поддерживаются.
* Включите **Режим разработчика** в настройках расширений.
* При «Load unpacked» выбирайте **папку**, а не файл внутри неё.

**Kai не подключается, запросы не доходят**

1. Прокси запущен? `pgrep -f qwen-proxy.js`
2. Health отвечает? `curl -s http://127.0.0.1:5000/v1/health`
3. URL в клиенте: `http://127.0.0.1:5000/v1` (не `https`, и не забудьте `/v1`)
4. Смотрите лог: `tail -n 50 ~/qwen-proxy/proxy.log`

**Termux убивается Android'ом**

* Дайте Termux разрешение «Автозапуск» в настройках Android.
* Отключите оптимизацию батареи для Termux.
* Заблокируйте Termux в недавних приложениях.

---

## ⚠️ Ограничения

* Прокси работает через **недокументированный web-API Qwen** — может сломаться при изменениях на стороне сервиса.
* Qwen-веб **не принимает `role: "system"`** — прокси вклеивает его в `user`-сообщение с явной разметкой.
* Параметры `temperature`, `top_p`, `top_k`, `stop`, `presence_penalty`, `frequency_penalty` **игнорируются** — Qwen-веб их не принимает.
* `response_format: json_object` / `json_schema` не поддерживается.
* Vision (картинки), `n > 1` (несколько вариантов) не поддерживаются.
* `usage` всегда `{0, 0, 0}` — Qwen не отдаёт реальные токены.
* **Tool calling — эмуляция через промпт**, а не нативный function calling. Qwen может иногда «забыть» формат — особенно на длинных диалогах.
* `refresh_token` живёт ~7 дней. После — нужен новый дамп.
* Интенсивное использование может привести к rate-limit (429) или блокировке аккаунта.
* Требуется Node.js 18+ и `undici`.

---

## 📊 Сравнение с нативными API

| Возможность | qwen-proxy | OpenAI API |
|---|---|---|
| Базовый чат | ✅ | ✅ |
| Стриминг | ✅ | ✅ |
| Tool calling | ⚠️ Эмуляция | ✅ Нативный |
| Vision | ❌ | ✅ |
| `temperature`, `top_p` | ❌ Игнор | ✅ |
| `response_format: json_schema` | ⚠️ Через промпт | ✅ |
| Точный подсчёт токенов | ❌ (0/0/0) | ✅ |
| Стабильность | ⚠️ Зависит от web-API | ✅ SLA |
| Цена | ✅ Бесплатно | 💰 По тарифу |

---

## 🔒 Безопасность

* Токены хранятся **только локально** в `qwen-auth.json`. Никуда не отправляются.
* Расширение работает **без** `chrome.debugger`, не открывает внешних соединений.
* Единственное соединение — **ваш телефон ↔ `chat.qwen.ai`**, как в браузере.
* **Никогда не публикуйте** `qwen-auth.json` и `qwen-dump-*.json` — там живые токены вашего аккаунта.
* Если случайно залили токены в публичный репозиторий — **немедленно отзовите сессию** в браузере (`chat.qwen.ai` → выход из аккаунта) и получите новый дамп.

---

## 📁 Структура репозитория

```
qwen-proxy/
├── qwen-proxy.js              # Сам прокси (Node.js)
├── extract-qwen-auth.js       # Парсер дампа → qwen-auth.json
├── update-auth.sh             # Обновление auth из нового дампа
├── start-qwen.sh              # Запуск прокси
├── stop.sh                    # Остановка
├── status.sh                  # Статус + health + логи
├── test-tools.sh              # Смоук-тесты (health + чат + tools)
├── qwen-auth.json.example     # Шаблон auth-файла
├── package.json               # Зависимости (undici)
├── package-lock.json          # Точные версии
├── .gitignore
├── LICENSE
└── README.md
```

---

## 🛠 Как это работает

1. Клиент (Kai, Open WebUI, Cline) шлёт `POST /v1/chat/completions` с сообщениями и (опционально) массивом `tools`.
2. Прокси **собирает единый композитный промпт**:
   - `<user_message>` — реальный запрос
   - `<system_instructions>` — system-промпт клиента (очищенный от опасных фраз)
   - `<available_tools>` — описания инструментов с инструкцией «отвечай `<tool_call>`»
   - `<conversation_history>` — история (если есть)
3. Прокси шлёт запрос в **Qwen web-API** (`chat.qwen.ai/api/v2/chat/completions`).
4. Qwen отвечает SSE-стримом. Прокси парсит чанки:
   - Если в ответе есть `<tool_call>{...}</tool_call>` → возвращает `tool_calls` в формате OpenAI.
   - Иначе — обычный текст в `content`.
5. Клиент выполняет инструмент и шлёт результат обратно как `role: "tool"`. Прокси превращает его в `[Tool result: name] ...` и снова передаёт Qwen.
6. Цикл повторяется до `finish_reason: "stop"`.

**Секретный соус:**
- **Композитный промпт** — Qwen web не принимает `role: "system"`, поэтому все инструкции идут одним user-сообщением с XML-разметкой.
- **Lie-detection** — если Qwen говорит «сохранил», но не вызвал `memory_store`, прокси синтезирует вызов.
- **Retry-on-empty** — если Qwen вернул пустоту, прокси повторяет запрос с чистым чатом.
- **Undici Agent** — короткий keep-alive (500 мс) решает `ECONNRESET` от Qwen.

---

## 🤝 Совместимость

Протестировано с:

* ✅ **Kai 9000** — работает, включая memory, web_search, filesystem, shell
* ✅ **Open WebUI**
* ✅ **Chatbox**
* ✅ **Cline** (VSCode)
* ✅ **Continue.dev**
* ✅ **OpenAI Python / Node SDK**

Должно работать с любым клиентом, поддерживающим **OpenAI Chat Completions API**.

Не подходит для:

* ❌ Claude Code (нужен Anthropic-формат)
* ❌ Клиентов с обязательным Vision
* ❌ Продакшена с жёстким SLA

---

## 📝 Changelog

| Версия | Что добавилось |
|---|---|
| v1–v7 | Базовый прокси без tools |
| v8 | Первая попытка tool calling через `role: system` (не работала) |
| v9 | Tools вклеены в первое user-сообщение |
| v10 | Композитный промпт с секциями `# ...` |
| v11 | Undici retry, IPv4 first |
| v12 | Undici Agent (короткий keep-alive), lie-detection |
| v13 | Trimming tools, строгие правила «не ври» |
| v14 | System-sanitize, файлы/папки → MUST call tool |
| **v15** | **Retry при пустом ответе, shell-guard** |

---

## ⚠️ Отказ от ответственности

Проект предоставляется **«как есть»**, без каких-либо гарантий.

* Автор **не несёт ответственности** за любые последствия использования: блокировки аккаунта, потерю данных, нарушение условий сервиса Qwen, финансовые потери, утечку токенов.
* Проект **не аффилирован** с Alibaba Cloud / Qwen. Все товарные знаки принадлежат их владельцам.
* Использование прокси может нарушать пользовательское соглашение `chat.qwen.ai`. **Вы используете на свой риск.**
* Автор не отвечает за действия третьих лиц, использующих этот код.
* Перед использованием ознакомьтесь с ToS `chat.qwen.ai` и убедитесь, что ваш сценарий не нарушает их.
* Для коммерческого использования — согласуйте с правообладателем сервиса.

Если не согласны с этими условиями — **не используйте проект**.

---

## Вклад

Нашли баг или есть идея? Открывайте [Issue](https://github.com/eldevex/qwen-proxy/issues) или присылайте Pull Request.

Особенно приветствуются:

* Проброс `temperature`, `top_p`, `stop` (если найдёте их в Qwen API)
* Обработка `response_format: json_object`
* Поддержка Vision (image_url → текст)
* Поддержка `n > 1`
* Оценка реальных токенов в `usage`

---

## Лицензия

MIT — используйте, модифицируйте, распространяйте. Ответственность за последствия — на вас.

---

**Сделано для личного использования. Используйте ответственно.**

⭐ Если проект оказался полезен — поставьте звезду!
