// Запуск: node tests/run.mjs  (Node 18+). Проверяет разбор потоков и ошибок на мок-ответах,
// реальные API НЕ вызываются.
import assert from 'node:assert/strict';
import { renderMarkdown } from '../js/markdown.js';
import { PROVIDERS } from '../js/providers.js';
import { ApiError } from '../js/api.js';

const enc = new TextEncoder();
const streamOf = (chunks, status = 200) => new Response(new ReadableStream({
  start(c) { chunks.forEach((x) => c.enqueue(enc.encode(x))); c.close(); } }), { status });
const collect = async (it) => { let s = ''; for await (const t of it) s += t; return s; };
let n = 0; const ok = (name) => console.log('ok', ++n, name);

// Markdown
const md = renderMarkdown('# Заголовок\n<script>alert(1)</script> **жирный** `a<b`\n\n```js\nconst x = "<b>";\n```\n- один\n- два\n[ссылка](https://example.com)');
assert.ok(!md.includes('<script>')); assert.ok(md.includes('&lt;script&gt;'));
assert.ok(md.includes('<strong>жирный</strong>') && md.includes('<ul><li>один</li>') && md.includes('class="code"'));
assert.ok(md.includes('&lt;b&gt;') && md.includes('rel="noopener noreferrer"'));
assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('<a '));
assert.ok(renderMarkdown('```py\nprint(1)').includes('print(1)'));  // незакрытый блок при стриме
ok('markdown: экранирование, код, списки, ссылки');

const base = { key: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], settings: { ollamaUrl: 'http://localhost:11434', customUrl: 'https://x.test/v1' } };

// OpenAI-совместимый поток (OpenRouter/Groq/...), событие разорвано между чанками
globalThis.fetch = async (url, o) => {
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(o.headers.Authorization, 'Bearer k');
  return streamOf([': PROCESSING\n\ndata: {"choices":[{"delta":{"content":"При"}}]}\n\nda', 'ta: {"choices":[{"delta":{"content":"вет"}}]}\n\ndata: [DONE]\n\n']);
};
assert.equal(await collect(PROVIDERS.openrouter.stream(base)), 'Привет'); ok('openrouter: потоковый ответ');

// список моделей OpenRouter: free первыми
globalThis.fetch = async () => new Response(JSON.stringify({ data: [
  { id: 'a/paid', name: 'Paid', pricing: { prompt: '0.1', completion: '0.2' } },
  { id: 'b/x:free', name: 'Free', pricing: { prompt: '0', completion: '0' } }] }));
const list = await PROVIDERS.openrouter.listModels(base);
assert.equal(list[0].id, 'b/x:free'); assert.ok(list[0].free && !list[1].free); ok('openrouter: список, бесплатные первыми');

// Gemini
globalThis.fetch = async (url, o) => {
  assert.ok(url.includes('/models/gem-1:streamGenerateContent?alt=sse')); assert.equal(o.headers['x-goog-api-key'], 'k');
  assert.equal(JSON.parse(o.body).contents[0].role, 'user');
  return streamOf(['data: {"candidates":[{"content":{"parts":[{"text":"A"}]}}]}\n\n', 'data: {"candidates":[{"content":{"parts":[{"text":"B"}]}}]}\n\n']);
};
assert.equal(await collect(PROVIDERS.gemini.stream({ ...base, model: 'gem-1' })), 'AB'); ok('gemini: поток');

// Anthropic
globalThis.fetch = async (url, o) => {
  assert.equal(o.headers['anthropic-dangerous-direct-browser-access'], 'true');
  return streamOf(['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n', 'data: {"type":"message_stop"}\n\n']);
};
assert.equal(await collect(PROVIDERS.anthropic.stream(base)), 'Hi'); ok('anthropic: поток и заголовок для браузера');

// Ошибки
const fails = async (status, body, kind) => {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
  await assert.rejects(collect(PROVIDERS.groq.stream(base)), (e) => e instanceof ApiError && e.kind === kind && e.status === status);
};
await fails(401, { error: { message: 'bad key' } }, 'auth');
await fails(429, { error: { message: 'slow down' } }, 'limit');
await fails(402, { error: { message: 'no credits' } }, 'credits');
await fails(404, { error: { message: 'no model' } }, 'model');
await fails(503, {}, 'server'); ok('ошибки: 401/429/402/404/503 → понятные типы');

globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(collect(PROVIDERS.groq.stream(base)), (e) => e.kind === 'network'); ok('ошибки: сеть/CORS');

globalThis.fetch = async () => streamOf(['data: {"error":{"message":"overloaded"}}\n\n']);
await assert.rejects(collect(PROVIDERS.openrouter.stream(base)), (e) => e.detail === 'overloaded'); ok('ошибка внутри потока');

// Отмена
const ctrl = new AbortController();
globalThis.fetch = async (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
const p = collect(PROVIDERS.groq.stream({ ...base, signal: ctrl.signal })); ctrl.abort();
await assert.rejects(p, (e) => e.name === 'AbortError'); ok('отмена генерации');

// Ollama и свой endpoint
globalThis.fetch = async (url) => { assert.equal(url, 'http://localhost:11434/api/tags'); return new Response(JSON.stringify({ models: [{ name: 'llama3' }] })); };
assert.equal((await PROVIDERS.ollama.listModels(base))[0].id, 'llama3'); ok('ollama: список моделей');
globalThis.fetch = async (url) => { assert.equal(url, 'https://x.test/v1/chat/completions'); return streamOf(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']); };
assert.equal(await collect(PROVIDERS.custom.stream(base)), 'ok'); ok('свой endpoint');
console.log('\nВсе проверки пройдены:', n);
