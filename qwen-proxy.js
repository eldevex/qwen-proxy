#!/usr/bin/env node
// Qwen Web Chat → OpenAI-compatible API proxy (v15, retry-on-empty + shell-guard)
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' --dns-result-order=ipv4first';

// Кастомный undici Agent: короткий keep-alive, без pipelining — лечит ECONNRESET
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 500,
    keepAliveMaxTimeout: 3000,
    pipelining: 0,
    connections: 8,
    connect: { timeout: 15000 },
  }));
  console.log('[fetch] custom undici agent installed (keepAlive=500ms, pipelining=off)');
} catch (e) {
  console.warn('[fetch] undici not found — install with: npm i undici');
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_FILE = path.join(__dirname, 'qwen-auth.json');
const DEBUG = process.env.DEBUG !== '0';

const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS) || 10 * 60 * 1000;
const REFRESH_AHEAD_SEC   = Number(process.env.REFRESH_AHEAD_SEC)   || 300;
const DEFAULT_MAX_TOKENS  = Number(process.env.DEFAULT_MAX_TOKENS)  || 32768;
const AUTO_THINKING       = process.env.AUTO_THINKING === '1';
const FETCH_TIMEOUT_MS    = Number(process.env.FETCH_TIMEOUT_MS)    || 90000;
const FETCH_RETRIES       = Number(process.env.FETCH_RETRIES)       || 3;
const MAX_TOOLS           = Number(process.env.MAX_TOOLS)           || 20;
const SYNTHESIZE_MEMORY   = process.env.SYNTHESIZE_MEMORY !== '0';
const SANITIZE_SYSTEM     = process.env.SANITIZE_SYSTEM !== '0';
const EMPTY_RETRY         = process.env.EMPTY_RETRY !== '0';

const DEFAULT_MODEL = 'qwen3.7-plus';
const AVAILABLE_MODELS = [
  'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus',
];

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';

const TOOL_CALL_OPEN  = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';
const TOOL_CALL_RE    = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

// Регулярки для детекции «лживых» ответов
const LIE_SAVED_RE = /(сохран[её]н|запомнил|записал|отметил|saved|stored|noted|remembered|saved to memory)/i;
const LIE_FORGOT_RE = /(забыл|удалил|ст[её]р|forgot|deleted|removed|forgotten)/i;

// Опасные фразы system-промпта Kai, отговаривающие от tool call
const DANGEROUS_SYSTEM_PHRASES = [
  /сначала\s+попробуй\s+понять\s+из\s+контекста[^.]*\./gi,
  /возвращайся\s+с\s+ответами,?\s+а\s+не\s+с\s+вопросами\.?/gi,
  /before\s+asking[^.]*\./gi,
  /come\s+back\s+with\s+answers,?\s+not\s+questions\.?/gi,
  /ask\s+at\s+most\s+one\s+clarifying\s+question[^.]*\./gi,
  /задавай\s+не\s+более\s+одного[^.]*\./gi,
];

let auth = null;
let refreshTimer = null;
let authWatcher = null;
let lastRefresh = { at: null, ok: null, error: null, strategy: null };

// ─────────────────────── FETCH WITH RETRY ───────────────────────

async function fetchWithRetry(url, options = {}, attempts = FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const t0 = Date.now();
    try {
      const opts = { ...options };
      opts.headers = { ...(opts.headers || {}), 'connection': 'close' };
      if (!opts._noTimeout) {
        opts.signal = opts.signal || AbortSignal.timeout(FETCH_TIMEOUT_MS);
      }
      const res = await fetch(url, opts);
      if (DEBUG && i > 0) console.log(`[fetch] OK on attempt ${i + 1} (${Date.now() - t0}ms)`);
      return res;
    } catch (e) {
      lastErr = e;
      const cause = e.cause || {};
      const code = cause.code || e.code || '';
      const cmsg = cause.message || '';
      const detail = [code, cmsg].filter(Boolean).join(' — ');
      console.warn(`[fetch] attempt ${i + 1}/${attempts} failed after ${Date.now() - t0}ms: ${e.message}${detail ? ' | cause: ' + detail : ''}`);
      if (i < attempts - 1) {
        const delay = 500 * Math.pow(2, i) + Math.random() * 200;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  const cause = lastErr?.cause || {};
  const err = new Error('fetch failed: ' + lastErr.message + (cause.code ? ' (' + cause.code + ')' : ''));
  err.cause = lastErr;
  throw err;
}

// ───────────────────────────── AUTH ─────────────────────────────

function loadAuth() {
  auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  if (!auth.token) throw new Error('token missing');
  if (!auth.cookie) throw new Error('cookie missing');
}
function saveAuth() {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
}
function uuid() { return crypto.randomUUID(); }

function decodeJwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return p.exp || 0;
  } catch (e) { return 0; }
}

function timezoneHeader() {
  const d = new Date();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const p = n => String(n).padStart(2, '0');
  return days[d.getDay()] + ' ' + months[d.getMonth()] + ' ' + p(d.getDate()) + ' ' +
         d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' +
         p(d.getSeconds()) + ' GMT' + sign + hh + mm;
}

function buildHeaders(extra = {}) {
  return {
    'accept': 'application/json',
    'accept-language': 'ru-RU,ru;q=0.9',
    'authorization': `Bearer ${auth.token}`,
    'cookie': auth.cookie,
    'content-type': 'application/json',
    'source': 'h5',
    'timezone': timezoneHeader(),
    'version': '0.3.12',
    'x-request-id': uuid(),
    'user-agent': UA,
    ...(auth.bx_ua        ? { 'bx-ua':        auth.bx_ua }        : {}),
    ...(auth.bx_umidtoken ? { 'bx-umidtoken': auth.bx_umidtoken } : {}),
    ...(auth.bx_v         ? { 'bx-v':         auth.bx_v }         : {}),
    ...extra,
  };
}

function buildRefreshHeaders() {
  return {
    'accept': 'application/json',
    'accept-language': 'ru-RU,ru;q=0.9',
    'cookie': auth.cookie,
    'source': 'h5',
    'timezone': timezoneHeader(),
    'version': '0.3.12',
    'x-request-id': uuid(),
    'origin': 'https://chat.qwen.ai',
    'referer': 'https://chat.qwen.ai/',
    'x-request-origin': 'https://chat.qwen.ai',
    'user-agent': UA,
    ...(auth.bx_ua        ? { 'bx-ua':        auth.bx_ua }        : {}),
    ...(auth.bx_umidtoken ? { 'bx-umidtoken': auth.bx_umidtoken } : {}),
    ...(auth.bx_v         ? { 'bx-v':         auth.bx_v }         : {}),
  };
}

function extractTokens(text) {
  try {
    const j = JSON.parse(text);
    const d = j?.data || j;
    const access  = d?.access_token  || d?.token;
    const refresh = d?.refresh_token;
    if (access && access.startsWith('eyJ')) {
      return { access, refresh: (refresh && refresh.startsWith('eyJ')) ? refresh : null };
    }
  } catch (e) {}
  const m = text.match(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g);
  if (m && m.length) return { access: m[0], refresh: m[1] || null };
  return null;
}

function updateCookieRefreshToken(cookieStr, newRefresh) {
  if (!newRefresh) return cookieStr;
  return cookieStr.split(';').map(p => p.trim())
    .map(p => p.startsWith('refresh_token=') ? 'refresh_token=' + newRefresh : p)
    .join('; ');
}

async function refreshToken() {
  if (!auth || !auth.token) return false;
  console.log('[auth] refreshing access token...');
  try {
    const res = await fetchWithRetry('https://auth.qwen.ai/api/v2/auths/refresh', {
      method: 'GET',
      headers: buildRefreshHeaders(),
    });
    const text = await res.text();
    if (DEBUG) console.log('[auth] refresh HTTP', res.status, 'body:', text.slice(0, 400));

    if (res.ok) {
      const t = extractTokens(text);
      if (t && t.access) {
        auth.token = t.access;
        if (t.refresh) {
          auth.refresh_token = t.refresh;
          auth.cookie = updateCookieRefreshToken(auth.cookie, t.refresh);
          console.log('[auth] 🔄 refresh_token rotated, cookie updated');
        }
        saveAuth();
        const exp = decodeJwtExp(auth.token);
        lastRefresh = { at: Date.now(), ok: true, error: null, strategy: 'GET-refresh' };
        console.log(`[auth] ✅ token updated. exp: ${new Date(exp * 1000).toISOString()}`);
        return true;
      }
      console.warn('[auth] ⚠️  refresh OK, но токен не распарсился');
    }
  } catch (e) {
    console.error('[auth] refresh error:', e.message);
  }
  lastRefresh = { at: Date.now(), ok: false, error: 'refresh failed', strategy: null };
  console.warn('[auth] ⚠️  refresh failed, продолжаем со старым токеном');
  return false;
}

async function ensureFreshToken() {
  const exp = decodeJwtExp(auth.token);
  const now = Math.floor(Date.now() / 1000);
  if (exp && (exp - now) < REFRESH_AHEAD_SEC) {
    return await refreshToken();
  }
  return true;
}

function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    try { await refreshToken(); }
    catch (e) { console.error('[auth] periodic refresh error:', e.message); }
  }, REFRESH_INTERVAL_MS);
  if (refreshTimer.unref) refreshTimer.unref();
  console.log(`[auth] periodic refresh every ${Math.round(REFRESH_INTERVAL_MS / 60000)} min (ahead ${REFRESH_AHEAD_SEC}s)`);
}

function watchAuthFile() {
  if (authWatcher) return;
  try {
    authWatcher = fs.watch(AUTH_FILE, { persistent: false }, (eventType) => {
      if (eventType !== 'change') return;
      clearTimeout(watchAuthFile._t);
      watchAuthFile._t = setTimeout(() => {
        try {
          const newAuth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
          if (newAuth.token && newAuth.token !== auth.token) {
            auth = newAuth;
            const exp = decodeJwtExp(auth.token);
            console.log('[auth] 🔄 qwen-auth.json изменён, токен перезагружен. exp:',
              new Date(exp * 1000).toISOString());
          }
        } catch (e) {
          console.error('[auth] failed to reload auth file:', e.message);
        }
      }, 500);
    });
    console.log('[auth] watching qwen-auth.json for changes');
  } catch (e) {
    console.warn('[auth] could not watch auth file:', e.message);
  }
}

// ─────────────────────────── TOOL CALLING ───────────────────────────

function safeJsonParse(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return {}; }
}

// v15: обрезаем инструменты + жёсткие правила + защита shell
function buildToolsSystemPrompt(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;

  const trimmed = tools.slice(0, MAX_TOOLS).map(t => {
    const fn = t.function || t;
    const params = fn.parameters || { type: 'object', properties: {} };
    const props = params.properties || {};
    const required = params.required || [];
    const briefProps = {};
    for (const [k, v] of Object.entries(props)) {
      briefProps[k] = {
        type: v.type || 'string',
        description: (v.description || '').slice(0, 100),
      };
    }
    const firstSentence = (fn.description || '').split('.')[0].trim();
    return {
      name: fn.name,
      description: firstSentence.slice(0, 200),
      parameters: { type: 'object', properties: briefProps, required },
    };
  });

  const toolNames = trimmed.map(t => t.name).join(', ');
  const hasShell = trimmed.some(t => /shell|bash|execute|command/i.test(t.name));

  let shellGuard = '';
  if (hasShell) {
    shellGuard = `

## ⚠️ SHELL SAFETY ⚠️

For execute_shell_command / shell / bash tools:
- NEVER use: rm, mv, dd, mkfs, chmod, chown, sudo, su, kill, pkill, killall, systemctl, shutdown, reboot, format, fdisk.
- Prefer READ-ONLY commands: ls, cat, head, tail, find, grep, wc, file, stat, which, echo, pwd, du, df.
- If you need to modify something, ASK the user first. Do NOT do destructive operations on your own.
- Never use pipes with destructive commands. Never use \`sudo\`. Never use \`rm -rf\`.`;
  }

  return `You are an AI assistant with access to external tools. These tools ARE your access to the user's files, memory, environment, and the internet. NEVER claim you "don't have access" — you DO have access via the tools listed below: ${toolNames}.

# How to call tools

To call a tool, respond ONLY with one or more blocks in this exact format and NOTHING else (no text before or after):

${TOOL_CALL_OPEN}{"name": "tool_name", "arguments": { ...valid json... }}${TOOL_CALL_CLOSE}

You may emit several ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} blocks in a row.

## ⚠️ CRITICAL RULES — READ CAREFULLY ⚠️

- If the user asks about their FILES, FOLDERS, PROJECTS, DEVICE, REPOSITORIES, or environment → you MUST call the matching tool FIRST. Do NOT say "I don't have access". You DO have access via tools.
- If the user asks to remember / save / store / note something → you MUST call \`memory_store\`.
- If the user asks to forget / delete / remove something → you MUST call \`memory_forget\`.
- If the user asks to search, look up, find current info, or check something online → you MUST call \`web_search\`. Do NOT answer time-sensitive facts from memory.
- If the user asks what you know about them or their past context → call the relevant memory/context tool BEFORE answering. Do not invent answers.
- If you are UNSURE which tool fits → pick the closest match and call it. Better to try and report the result than to say "I can't".
- NEVER claim you did something ("saved", "found", "deleted") without emitting the corresponding \`${TOOL_CALL_OPEN}\` block.
- Never fabricate tool outputs. If a tool fails, report the failure.
- Respond in the SAME LANGUAGE the user writes in (Russian → Russian, English → English).
- If no tool is needed, reply with plain text and NO tool_call blocks.${shellGuard}

## Tool definitions

\`\`\`json
${JSON.stringify(trimmed, null, 2)}
\`\`\`

Tool results arrive as user messages like [Tool result: name]. After receiving tool result(s), continue the conversation normally.`;
}

function parseToolCalls(text) {
  if (!text) return [];
  const calls = [];
  let m;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    let obj = null;
    try { obj = JSON.parse(raw); }
    catch (e) {
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenced) { try { obj = JSON.parse(fenced[1]); } catch (_) {} }
    }
    if (obj && obj.name) {
      calls.push({
        id: 'call_' + crypto.randomBytes(12).toString('hex'),
        type: 'function',
        function: {
          name: String(obj.name),
          arguments: typeof obj.arguments === 'string'
            ? obj.arguments
            : JSON.stringify(obj.arguments || {}),
        },
      });
    }
  }
  return calls;
}

function stripToolCalls(text) {
  if (!text) return '';
  return text.replace(TOOL_CALL_RE, '').trim();
}

// v15: детект «лжи» — модель сказала "сохранил/удалил" без tool_call
function synthesizeMemoryCall(fullText, userMessage, availableTools) {
  if (!SYNTHESIZE_MEMORY) return null;
  if (!fullText) return null;

  const toolNames = (availableTools || []).map(t => (t.function || t).name);
  const hasStore = toolNames.includes('memory_store');
  const hasForget = toolNames.includes('memory_forget');

  const saysSaved = LIE_SAVED_RE.test(fullText);
  const saysForgot = LIE_FORGOT_RE.test(fullText);

  if (saysSaved && hasStore) {
    const key = 'user_fact_' + Date.now();
    const content = (userMessage || fullText).slice(0, 2000);
    console.log('[qwen] ⚠️  детект "лжи": сказал "сохранил" без tool_call — синтезирую memory_store');
    return [{
      id: 'call_' + crypto.randomBytes(12).toString('hex'),
      type: 'function',
      function: {
        name: 'memory_store',
        arguments: JSON.stringify({ key, content }),
      },
    }];
  }

  if (saysForgot && hasForget) {
    const keyMatch = (userMessage || '').match(/(?:забудь|удали|forget|delete)\s+([a-zA-Z0-9_\-]+)/i);
    const key = keyMatch ? keyMatch[1] : 'last_memory';
    console.log('[qwen] ⚠️  детект "лжи": сказал "удалил" без tool_call — синтезирую memory_forget');
    return [{
      id: 'call_' + crypto.randomBytes(12).toString('hex'),
      type: 'function',
      function: {
        name: 'memory_forget',
        arguments: JSON.stringify({ key }),
      },
    }];
  }

  return null;
}

// v15: нейтрализуем опасные фразы system-промпта Kai
function sanitizeSystemPrompt(text) {
  if (!SANITIZE_SYSTEM || !text) return text;
  let out = text;
  for (const re of DANGEROUS_SYSTEM_PHRASES) {
    out = out.replace(re, '');
  }
  return out.trim();
}

// ─────────────────────────── MESSAGES ───────────────────────────

function normalizeMessages(messages, toolsPrompt) {
  let msgs = (messages || []).map(m => {
    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const name = m.name || 'tool';
      return { role: 'user', content: `[Tool result: ${name}]\n${content}` };
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map(tc => {
        const name = tc.function?.name || tc.name || 'unknown';
        const args = safeJsonParse(tc.function?.arguments ?? tc.arguments);
        return `${TOOL_CALL_OPEN}${JSON.stringify({ name, arguments: args })}${TOOL_CALL_CLOSE}`;
      }).join('\n');
      const text = [m.content || '', calls].filter(Boolean).join('\n').trim();
      return { role: 'assistant', content: text };
    }
    return {
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
    };
  });

  const sysParts = [];
  msgs = msgs.filter(m => {
    if (m.role === 'system') { sysParts.push(m.content || ''); return false; }
    return true;
  });

  const lastUserIdx = msgs.map(m => m.role).lastIndexOf('user');

  let historyMsgs, currentUser;
  if (lastUserIdx < 0) {
    historyMsgs = msgs;
    currentUser = 'продолжай';
  } else {
    historyMsgs = msgs.slice(0, lastUserIdx);
    currentUser = msgs[lastUserIdx].content || '';
  }

  const blocks = [];

  blocks.push(
`You are an AI assistant. Below is CONTEXT (system instructions, tools, history) and the ACTUAL USER MESSAGE.

CRITICAL RULES:
- Your ONLY job is to respond to <user_message>. Never reply to the context itself.
- If the context contains example phrases or templates, DO NOT echo them. They are for reference only.
- If the user says a greeting like "привет", respond with a greeting. Do NOT mention projects, memory, or missing information unless the user explicitly asks.
- If the user asks about their files, folders, projects, or environment — CALL the matching tool from <available_tools>. Never claim you have no access.
- Respond in the SAME LANGUAGE the user writes in.`
  );

  blocks.push(`<user_message>\n${currentUser}\n</user_message>`);

  if (sysParts.length) {
    const sysText = sanitizeSystemPrompt(sysParts.join('\n\n'));
    if (sysText) {
      blocks.push(`<system_instructions>\n${sysText}\n</system_instructions>`);
    }
  }

  if (toolsPrompt) {
    blocks.push(`<available_tools>\n${toolsPrompt}\n</available_tools>`);
  }

  if (historyMsgs.length) {
    const hist = historyMsgs.map(m => {
      const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : m.role;
      return `<${role}>${txt}</${role}>`;
    }).join('\n');
    blocks.push(`<conversation_history>\n${hist}\n</conversation_history>`);
  }

  blocks.push(`Now respond ONLY to <user_message> above. If tools are available and relevant, CALL them. Do NOT say "I don't have access" — you have tools. Respond in the same language as the user.`);

  return [{ role: 'user', content: blocks.join('\n\n') }];
}

// ─────────────────────── QWEN API ───────────────────────

async function createChat(model) {
  await ensureFreshToken();
  const res = await fetchWithRetry('https://chat.qwen.ai/api/v2/chats/new', {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      chatId: '',
      models: [model],
      project_id: '',
      timestamp: Math.floor(Date.now() / 1000),
      chat_type: 't2t',
      chat_mode: 'normal',
    }),
  });
  const text = await res.text();
  if (DEBUG) console.log('[createChat] HTTP', res.status, text.slice(0, 200));
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  const id = j?.data?.id || j?.id;
  if (!id) throw new Error('createChat: no id in response: ' + text.slice(0, 200));
  return id;
}

async function qwenChat(messages, model, chatId, maxTokens) {
  await ensureFreshToken();
  const now = Math.floor(Date.now() / 1000);
  const childId = uuid();

  const safeMessages = messages.map(m =>
    m.role === 'system' ? { role: 'user', content: '[System]\n' + m.content } : m
  );

  const body = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chatId,
    parentId: '',
    chat_id: chatId,
    chat_mode: 'normal',
    model,
    parent_id: null,
    max_tokens: maxTokens,
    messages: safeMessages.map((m) => ({
      id: null,
      fid: uuid(),
      parentId: null,
      childrenIds: [childId],
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      user_action: m.role === 'user' ? 'chat' : undefined,
      files: [],
      timestamp: now,
      models: [model],
      model: '',
      chat_type: 't2t',
      feature_config: {
        thinking_enabled: AUTO_THINKING,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: AUTO_THINKING,
        thinking_mode: AUTO_THINKING ? 'Auto' : 'Off',
        thinking_format: 'summary',
        auto_search: false,
      },
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
      parent_id: null,
    })),
    timestamp: now,
  };

  const url = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: buildHeaders({ 'x-accel-buffering': 'no' }),
    body: JSON.stringify(body),
    _noTimeout: true,
    signal: AbortSignal.timeout(300000),
  });
}

async function* parseQwenStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstLogged = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (DEBUG && !firstLogged && value && value.length) {
      console.log('[qwen-raw] first chunk: len=' + value.length + ' byte0=' + value[0]);
      firstLogged = true;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload);
        const delta = data?.choices?.[0]?.delta;
        if (delta) yield delta;
      } catch (e) {}
    }
  }
}

// ─────────────────────── RESPONSE HANDLERS ───────────────────────

function sseChunk(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

async function handleNonStream(qres, res, model, hasTools, effectiveTools, userMessage, retryFn = null) {
  let fullText = '';
  let lastPhase = '';
  const phaseStats = {};
  for await (const delta of parseQwenStream(qres)) {
    if (delta.phase) {
      lastPhase = delta.phase;
      phaseStats[delta.phase] = (phaseStats[delta.phase] || 0) + (delta.content?.length || 0);
    }
    if (delta.phase === 'answer' && delta.content) fullText += delta.content;
  }

  if (DEBUG) {
    console.log('[qwen] phaseStats:', JSON.stringify(phaseStats));
    if (hasTools) {
      console.log('[qwen] RAW answer (first 800):', JSON.stringify(fullText.slice(0, 800)));
    }
  }

  // v15: если пусто — retry с чистым чатом
  if (!fullText.trim() && retryFn && EMPTY_RETRY) {
    console.warn('[qwen] ⚠️  пустой ответ — retry с чистым чатом');
    try {
      const qres2 = await retryFn();
      if (qres2 && qres2.ok) {
        return await handleNonStream(qres2, res, model, hasTools, effectiveTools, userMessage, null);
      }
    } catch (e) {
      console.error('[qwen] retry error:', e.message);
    }
  }

  let toolCalls = hasTools ? parseToolCalls(fullText) : [];

  if (hasTools && !toolCalls.length) {
    const synth = synthesizeMemoryCall(fullText, userMessage, effectiveTools);
    if (synth) {
      toolCalls = synth;
      fullText = '';
    }
  }

  let content = toolCalls.length ? stripToolCalls(fullText) : fullText;

  const finishReason = toolCalls.length ? 'tool_calls' : 'stop';
  const message = { role: 'assistant', content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-' + uuid(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }));

  if (toolCalls.length) {
    console.log(`[qwen] ✅ response, ${toolCalls.length} tool_calls (last phase: ${lastPhase})`);
  } else {
    console.log(`[qwen] ✅ response, ${content.length} chars (last phase: ${lastPhase})`);
  }
}

async function handleStreamNoTools(qres, res, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const id = 'chatcmpl-' + uuid();
  const created = Math.floor(Date.now() / 1000);

  sseChunk(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  let chars = 0;
  for await (const delta of parseQwenStream(qres)) {
    const content = delta.content || '';
    if (delta.phase === 'answer' && content) {
      chars += content.length;
      sseChunk(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });
    }
    if (delta.status === 'finished' && delta.phase === 'answer') {
      sseChunk(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
  console.log(`[qwen] ✅ stream done, ${chars} chars`);
}

async function handleStreamWithTools(qres, res, model, effectiveTools, userMessage, retryFn = null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const id = 'chatcmpl-' + uuid();
  const created = Math.floor(Date.now() / 1000);

  let fullText = '';
  const phaseStats = {};
  for await (const delta of parseQwenStream(qres)) {
    if (delta.phase) phaseStats[delta.phase] = (phaseStats[delta.phase] || 0) + (delta.content?.length || 0);
    if (delta.phase === 'answer' && delta.content) fullText += delta.content;
  }

  if (DEBUG) {
    console.log('[qwen] phaseStats:', JSON.stringify(phaseStats));
    console.log('[qwen] RAW answer (first 800):', JSON.stringify(fullText.slice(0, 800)));
  }

  // v15: retry при пустом ответе
  if (!fullText.trim() && retryFn && EMPTY_RETRY) {
    console.warn('[qwen] ⚠️  пустой ответ в стриме — retry с чистым чатом');
    try {
      const qres2 = await retryFn();
      if (qres2 && qres2.ok) {
        // Откатываем headers — они уже отправлены, поэтому продолжаем писать в тот же SSE
        // Просто обрабатываем второй ответ и пишем в тот же канал
        let fullText2 = '';
        for await (const delta of parseQwenStream(qres2)) {
          if (delta.phase === 'answer' && delta.content) fullText2 += delta.content;
        }
        fullText = fullText2;
      }
    } catch (e) {
      console.error('[qwen] retry error:', e.message);
    }
  }

  let toolCalls = parseToolCalls(fullText);

  if (!toolCalls.length) {
    const synth = synthesizeMemoryCall(fullText, userMessage, effectiveTools);
    if (synth) {
      toolCalls = synth;
      fullText = '';
    }
  }

  if (toolCalls.length) {
    sseChunk(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map((tc, i) => ({
            index: i,
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: '' },
          })),
        },
        finish_reason: null,
      }],
    });

    for (let i = 0; i < toolCalls.length; i++) {
      sseChunk(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: i, function: { arguments: toolCalls[i].function.arguments } }] },
          finish_reason: null,
        }],
      });
    }

    sseChunk(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
    console.log(`[qwen] ✅ stream done, ${toolCalls.length} tool_calls`);
    return;
  }

  const text = stripToolCalls(fullText) || fullText;
  sseChunk(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  const CHUNK = 40;
  for (let i = 0; i < text.length; i += CHUNK) {
    sseChunk(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: text.slice(i, i + CHUNK) }, finish_reason: null }],
    });
  }
  sseChunk(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  res.write('data: [DONE]\n\n');
  res.end();
  console.log(`[qwen] ✅ stream done, ${text.length} chars`);
}

// ─────────────────────── HTTP SERVER ───────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: AVAILABLE_MODELS.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'qwen' })),
    }));
    return;
  }

  if (url.pathname === '/v1/health') {
    const exp = decodeJwtExp(auth.token);
    const nowSec = Math.floor(Date.now() / 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      token_expires_at: exp ? new Date(exp * 1000).toISOString() : null,
      token_expired: exp ? (exp < nowSec) : null,
      token_seconds_left: exp ? Math.max(0, exp - nowSec) : null,
      has_refresh_token: !!auth.refresh_token,
      has_bx_ua: !!auth.bx_ua,
      user_id: auth.user_id || null,
      last_refresh: lastRefresh,
      refresh_interval_ms: REFRESH_INTERVAL_MS,
      refresh_ahead_sec: REFRESH_AHEAD_SEC,
      default_max_tokens: DEFAULT_MAX_TOKENS,
      auto_thinking: AUTO_THINKING,
      fetch_timeout_ms: FETCH_TIMEOUT_MS,
      fetch_retries: FETCH_RETRIES,
      max_tools: MAX_TOOLS,
      synthesize_memory: SYNTHESIZE_MEMORY,
      sanitize_system: SANITIZE_SYSTEM,
      empty_retry: EMPTY_RETRY,
      tool_calling: 'emulated v15 (composite + lie-detection + system-sanitize + retry-on-empty)',
    }));
    return;
  }

  if (url.pathname === '/v1/refresh' && req.method === 'POST') {
    const ok = await refreshToken();
    res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, last_refresh: lastRefresh }));
    return;
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        const messages = params.messages || [];
        const model = String(params.model || DEFAULT_MODEL);
        const stream = params.stream === true;
        const maxTokens = Number(params.max_tokens) || DEFAULT_MAX_TOKENS;

        const tools = Array.isArray(params.tools) ? params.tools : [];
        const toolChoice = params.tool_choice;
        const toolsDisabled = toolChoice === 'none';
        const effectiveTools = toolsDisabled ? [] : tools;
        const hasTools = effectiveTools.length > 0;

        if (!messages.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'messages required' } }));
          return;
        }

        console.log(`[qwen] → model=${model} msgs=${messages.length} stream=${stream} max_tokens=${maxTokens} tools=${effectiveTools.length} tool_choice=${toolChoice || 'auto'}`);

        let toolsPrompt = null;
        if (hasTools) {
          toolsPrompt = buildToolsSystemPrompt(effectiveTools);

          if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name) {
            toolsPrompt += `\n\n# FORCED TOOL\nYou MUST call the tool "${toolChoice.function.name}" in your reply.`;
          } else if (toolChoice === 'required') {
            toolsPrompt += `\n\n# REQUIRED\nYou MUST call at least one tool in your reply.`;
          }
        }

        const qwenMessages = normalizeMessages(messages, toolsPrompt);

        if (DEBUG) {
          const preview = qwenMessages
            .map(m => m.role + ':' + (typeof m.content === 'string' ? m.content : ''))
            .join(' | ');
          console.log('[qwen] prompt preview:', preview.slice(0, 2000));
        }

        const chatId = await createChat(model);
        console.log(`[qwen] chat created: ${chatId}`);

        let qres = await qwenChat(qwenMessages, model, chatId, maxTokens);

        if (qres.status === 401) {
          console.warn('[qwen] 401 — refresh и повтор');
          const ok = await refreshToken();
          if (ok) {
            const chatId2 = await createChat(model);
            qres = await qwenChat(qwenMessages, model, chatId2, maxTokens);
          }
        }

        if (!qres.ok) {
          const t = await qres.text();
          console.error(`[qwen] HTTP ${qres.status}:`, t.slice(0, 400));
          res.writeHead(qres.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: t.slice(0, 500) } }));
          return;
        }

        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const userMessage = lastUserMsg
          ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
          : '';

        // v15: retry-функция — новый чат, только system + последний user (без истории)
        const retryFn = async () => {
          console.warn('[qwen] retry: чистый чат, история отброшена');
          const newChatId = await createChat(model);
          const minimalMessages = messages.filter(m => m.role === 'system' || m.role === 'user').slice(-2);
          const retryMessages = normalizeMessages(minimalMessages, toolsPrompt);
          return await qwenChat(retryMessages, model, newChatId, maxTokens);
        };

        if (stream) {
          if (hasTools) await handleStreamWithTools(qres, res, model, effectiveTools, userMessage, retryFn);
          else           await handleStreamNoTools(qres, res, model);
        } else {
          await handleNonStream(qres, res, model, hasTools, effectiveTools, userMessage, retryFn);
        }
      } catch (e) {
        console.error('[err]', e.stack || e.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(e.message || e) } }));
        }
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

function shutdown() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (authWatcher) authWatcher.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

loadAuth();
startRefreshTimer();
watchAuthFile();

server.listen(PORT, HOST, () => {
  const exp = decodeJwtExp(auth.token);
  console.log(`[qwen-proxy] listening on http://${HOST}:${PORT}`);
  console.log(`[qwen-proxy] models: ${AVAILABLE_MODELS.join(', ')}`);
  console.log(`[qwen-proxy] token exp: ${exp ? new Date(exp * 1000).toISOString() : 'unknown'}${exp && exp * 1000 < Date.now() ? ' (EXPIRED)' : ''}`);
  console.log(`[qwen-proxy] refresh_token: ${auth.refresh_token ? 'yes (' + auth.refresh_token.length + ' chars)' : 'NO'}`);
  console.log(`[qwen-proxy] bx-ua: ${auth.bx_ua ? 'yes' : 'NO'}`);
  console.log(`[qwen-proxy] default max_tokens: ${DEFAULT_MAX_TOKENS}`);
  console.log(`[qwen-proxy] auto_thinking: ${AUTO_THINKING ? 'on' : 'off'}`);
  console.log(`[qwen-proxy] fetch timeout: ${FETCH_TIMEOUT_MS}ms, retries: ${FETCH_RETRIES}`);
  console.log(`[qwen-proxy] max_tools: ${MAX_TOOLS}, synthesize_memory: ${SYNTHESIZE_MEMORY}, sanitize_system: ${SANITIZE_SYSTEM}, empty_retry: ${EMPTY_RETRY}`);
  console.log(`[qwen-proxy] tool calling: emulated v15 (composite + lie-detection + system-sanitize + retry-on-empty)`);
  console.log(`[qwen-proxy] DEBUG: ${DEBUG ? 'on' : 'off'}`);
});