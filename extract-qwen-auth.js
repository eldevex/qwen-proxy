#!/usr/bin/env node
// Извлекает qwen-auth.json из дампа Qwen Full Dumper
const fs = require('fs');
const path = require('path');

const dumpFile = process.argv[2];
if (!dumpFile) {
  console.error('Usage: node extract-qwen-auth.js <qwen-dump.json>');
  process.exit(1);
}

const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
const ls = dump.localStorage || {};

const token = ls.token || '';
const cookieParts = [];
let refresh_token = '';
for (const c of (dump.cookies || [])) {
  cookieParts.push(`${c.name}=${c.value}`);
  if (c.name === 'refresh_token') refresh_token = c.value;
}

let bx_ua = '', bx_umidtoken = '', bx_v = '', device_id = '';
const requests = dump.capturedRequests || [];
for (let i = requests.length - 1; i >= 0; i--) {
  const r = requests[i];
  const h = r.headers || {};
  const isChat = r.url && (r.url.includes('/chat/completions') || r.url.includes('/chat_session'));
  if (isChat && h['bx-ua']) {
    bx_ua = h['bx-ua'];
    bx_umidtoken = h['bx-umidtoken'] || '';
    bx_v = h['bx-v'] || '';
    break;
  }
}
if (!bx_ua) {
  for (const r of requests) {
    const h = r.headers || {};
    if (h['bx-ua'] && !bx_ua) bx_ua = h['bx-ua'];
    if (h['bx-umidtoken'] && !bx_umidtoken) bx_umidtoken = h['bx-umidtoken'];
    if (h['bx-v'] && !bx_v) bx_v = h['bx-v'];
    if (h['x-device-id'] && !device_id) device_id = h['x-device-id'];
  }
}

const cnaui = ls.cnaui || '';
const result = {
  token,
  refresh_token,
  cookie: cookieParts.join('; '),
  bx_ua,
  bx_umidtoken,
  bx_v: bx_v || '2.5.37',
  user_id: cnaui,
  device_id,
};

const outFile = path.join(path.dirname(dumpFile), 'qwen-auth.json');
fs.writeFileSync(outFile, JSON.stringify(result, null, 2), { mode: 0o600 });

console.log('✅ qwen-auth.json: ' + outFile);
console.log('   token:         ' + (token ? token.slice(0, 40) + '...' : '(ПУСТО)'));
console.log('   refresh_token: ' + (refresh_token ? refresh_token.slice(0, 40) + '...' : '(ПУСТО)'));
console.log('   cookie:        ' + cookieParts.length + ' cookies, ' + result.cookie.length + ' chars');
console.log('   bx-ua:         ' + (bx_ua ? bx_ua.slice(0, 50) + '...' : '(ПУСТО)'));
console.log('   bx-umidtoken:  ' + (bx_umidtoken ? bx_umidtoken.slice(0, 50) + '...' : '(ПУСТО)'));
console.log('   bx-v:          ' + (bx_v || '(ПУСТО)'));
console.log('   user_id:       ' + (cnaui || '(ПУСТО)'));
