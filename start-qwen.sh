#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"

pkill -f "qwen-proxy.js" 2>/dev/null
sleep 1

REFRESH_INTERVAL_MS=600000 REFRESH_AHEAD_SEC=300 DEFAULT_MAX_TOKENS=32768 \
  nohup node qwen-proxy.js > proxy.log 2>&1 &

echo "✅ qwen-proxy запущен, PID $!"
echo ""
echo "Проверка:        curl http://localhost:5000/v1/health"
echo "Ручной refresh:  curl -X POST http://localhost:5000/v1/refresh"
echo "Логи:            tail -f $(dirname "$0")/proxy.log"
echo "Стоп:            pkill -f qwen-proxy.js"
