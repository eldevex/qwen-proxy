#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"

SRC="$1"

# Если аргумент не задан — берём самый свежий дамп из Downloads
if [ -z "$SRC" ]; then
  echo "ℹ️  Аргумент не задан, ищу самый свежий qwen-dump-*.json в ~/storage/downloads/"
  SRC=$(ls -t ~/storage/downloads/qwen-dump-*.json 2>/dev/null | head -1)
  if [ -z "$SRC" ]; then
    echo "❌ Дамп не найден. Usage: $0 <qwen-dump.json>"
    exit 1
  fi
  echo "📂 Нашёл: $SRC"
fi

# Если по прямому пути не нашли — пробуем стандартные места
if [ ! -f "$SRC" ]; then
  for cand in \
    "$HOME/storage/downloads/$SRC" \
    "$HOME/storage/shared/Download/$SRC" \
    "/sdcard/Download/$SRC" \
    "/sdcard/Downloads/$SRC" \
    "$HOME/$SRC" ; do
    if [ -f "$cand" ]; then SRC="$cand"; break; fi
  done
fi

# Если всё ещё не нашли — попробуем подставить как префикс
if [ ! -f "$SRC" ]; then
  base=$(basename "$SRC" .json)
  cand=$(ls -t ~/storage/downloads/${base}*.json 2>/dev/null | head -1)
  if [ -n "$cand" ]; then
    echo "💡 Точного файла нет, но нашёл похожий: $cand"
    SRC="$cand"
  fi
fi

if [ ! -f "$SRC" ]; then
  echo "❌ Файл не найден: $1"
  echo ""
  echo "Доступные дампы:"
  ls -lt ~/storage/downloads/qwen-dump-*.json 2>/dev/null | head -5
  exit 1
fi

echo "📂 Использую: $SRC"
cp "$SRC" ./dump-tmp.json
chmod 644 ./dump-tmp.json
node extract-qwen-auth.js dump-tmp.json
rm -f ./dump-tmp.json
echo ""
echo "ℹ️  Прокси подхватит новый токен автоматически (fs.watch)."