// Каталог провайдеров и адаптеры. Чтобы добавить провайдера — добавьте объект в PROVIDERS
// (для OpenAI-совместимых API достаточно вызвать openaiCompat({...})).
import { ApiError, http, sse } from './api.js';

const json = (key, extra = {}) => ({ 'Content-Type': 'application/json', ...extra });
const bearer = (k) => (k ? { Authorization: 'Bearer ' + k } : {});
const trim = (u) => String(u || '').replace(/\/+$/, '');

function openaiCompat(cfg) {
  const base = (ctx) => trim(typeof cfg.baseUrl === 'function' ? cfg.baseUrl(ctx) : cfg.baseUrl);
  return {
    protocol: 'openai',
    ...cfg,
    async listModels(ctx) {
      const r = await http(base(ctx) + '/models', { headers: bearer(ctx.key), signal: ctx.signal });
      const j = await r.json();
      const list = (j.data || []).map((m) => ({ id: m.id, name: m.name || m.id, raw: m }));
      return cfg.mapModels ? cfg.mapModels(list) : list;
    },
    async *stream(ctx) {
      if (!base(ctx)) throw new ApiError('bad', 'Не указан адрес API. Заполните его в настройках.');
      const r = await http(base(ctx) + '/chat/completions', {
        method: 'POST',
        headers: json(0, bearer(ctx.key)),
        body: JSON.stringify({ model: ctx.model, messages: ctx.messages, stream: true }),
        signal: ctx.signal,
      });
      for await (const d of sse(r)) {
        if (d === '[DONE]') return;
        let j;
        try { j = JSON.parse(d); } catch { continue; }
        if (j.error) throw new ApiError('other', '', j.error.code || 0, j.error.message || JSON.stringify(j.error));
        const t = j.choices?.[0]?.delta?.content;
        if (t) yield t;
      }
    },
  };
}

const gemini = {
  protocol: 'gemini',
  async listModels(ctx) {
    const r = await http('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': ctx.key }, signal: ctx.signal,
    });
    const j = await r.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }))
      .filter((m) => !/embed|aqa|imagen|veo|tts|image|live|audio|robotics|computer-use/i.test(m.id));
  },
  async *stream(ctx) {
    const contents = ctx.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }],
    }));
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(ctx.model) + ':streamGenerateContent?alt=sse';
    const r = await http(url, {
      method: 'POST', headers: json(0, { 'x-goog-api-key': ctx.key }),
      body: JSON.stringify({ contents }), signal: ctx.signal,
    });
    for await (const d of sse(r)) {
      let j;
      try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new ApiError('other', '', j.error.code || 0, j.error.message || '');
      if (j.promptFeedback?.blockReason) {
        throw new ApiError('bad', '', 400, 'Запрос заблокирован фильтрами Gemini: ' + j.promptFeedback.blockReason);
      }
      for (const p of j.candidates?.[0]?.content?.parts || []) if (p.text) yield p.text;
    }
  },
};

const anthropicHeaders = (key) => ({
  'x-api-key': key, 'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
});
const anthropic = {
  protocol: 'anthropic',
  async listModels(ctx) {
    const r = await http('https://api.anthropic.com/v1/models?limit=100', {
      headers: anthropicHeaders(ctx.key), signal: ctx.signal,
    });
    const j = await r.json();
    return (j.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  },
  async *stream(ctx) {
    const r = await http('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: json(0, anthropicHeaders(ctx.key)),
      body: JSON.stringify({ model: ctx.model, max_tokens: 4096, messages: ctx.messages, stream: true }),
      signal: ctx.signal,
    });
    for await (const d of sse(r)) {
      let j;
      try { j = JSON.parse(d); } catch { continue; }
      if (j.type === 'error') throw new ApiError('other', '', 0, j.error?.message || '');
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') yield j.delta.text;
      if (j.type === 'message_stop') return;
    }
  },
};

const ollamaBase = (ctx) => trim(ctx.settings.ollamaUrl || 'http://localhost:11434');
const ollama = {
  ...openaiCompat({ baseUrl: (ctx) => ollamaBase(ctx) + '/v1' }),
  async listModels(ctx) {
    const r = await http(ollamaBase(ctx) + '/api/tags', { signal: ctx.signal });
    const j = await r.json();
    return (j.models || []).map((m) => ({ id: m.name, name: m.name }));
  },
};

const sortFree = (l) => l.sort((a, b) => Number(!!b.free) - Number(!!a.free) || a.id.localeCompare(b.id));

export const PROVIDERS = {
  openrouter: {
    id: 'openrouter', name: 'OpenRouter', access: 'free', accessLabel: 'Бесплатные модели :free',
    tagline: 'Агрегатор: десятки моделей, часть — бесплатно',
    needsKey: true, keyUrl: 'https://openrouter.ai/keys', fallback: [],
    limits: 'Модели с суффиксом :free — 20 запросов/мин и 50 запросов/день; после разовой покупки кредитов на $10 — 1000/день. При отрицательном балансе даже :free отвечает 402. Список бесплатных моделей часто меняется.',
    howto: ['Зарегистрируйтесь на openrouter.ai и создайте ключ на странице Keys.', 'Вставьте ключ в «Настройки».', 'Нажмите «⟳» рядом с моделью и выберите модель с пометкой «бесплатно».'],
    cors: 'Запросы из браузера разрешены.',
    ...openaiCompat({
      baseUrl: 'https://openrouter.ai/api/v1',
      mapModels: (l) => sortFree(l.map((m) => {
        const p = m.raw.pricing || {};
        const free = m.id.endsWith(':free') || (Number(p.prompt) === 0 && Number(p.completion) === 0 && p.prompt != null);
        return { id: m.id, name: m.name, free };
      }).filter((m) => !(m.id.includes('embed')))),
    }),
  },
  groq: {
    id: 'groq', name: 'Groq', access: 'free', accessLabel: 'Бесплатный тариф',
    tagline: 'Очень быстрые открытые модели, без банковской карты',
    needsKey: true, keyUrl: 'https://console.groq.com/keys',
    fallback: [{ id: 'openai/gpt-oss-120b', name: 'gpt-oss-120b' }, { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' }],
    limits: 'Лимиты задаются для каждой модели отдельно (запросы и токены в минуту/день). Для gpt-oss-120b по обзору от 18.08.2026 действовало 30 запросов/мин и 1000/день; точные цифры — в консоли Groq.',
    howto: ['Войдите в console.groq.com и создайте API-ключ.', 'Вставьте ключ в «Настройки».', 'Нажмите «⟳», чтобы загрузить актуальный список моделей.'],
    cors: 'Запросы из браузера работают с ключом пользователя (проверьте в своей сети).',
    ...openaiCompat({
      baseUrl: 'https://api.groq.com/openai/v1',
      mapModels: (l) => l.filter((m) => !/whisper|tts|guard|playai|orpheus/i.test(m.id)).map(({ id, name }) => ({ id, name, free: true })),
    }),
  },
  gemini: {
    id: 'gemini', name: 'Google Gemini', access: 'freemium', accessLabel: 'Бесплатный тариф (Flash)',
    tagline: 'Ключ из Google AI Studio, бесплатно для части моделей',
    needsKey: true, keyUrl: 'https://aistudio.google.com/apikey',
    fallback: [{ id: 'gemini-flash-latest', name: 'Gemini Flash (latest)' }],
    limits: 'Бесплатно доступны не все модели (Pro и модели для картинок/видео могут быть платными). Лимиты на проект смотрите на aistudio.google.com/rate-limit; в разных источниках цифры расходятся. На бесплатном тарифе Google может использовать запросы для улучшения продуктов.',
    howto: ['Откройте aistudio.google.com/apikey и создайте ключ (карта не нужна).', 'Вставьте ключ в «Настройки».', 'Нажмите «⟳» и выберите Flash-модель; при ошибке 429/403 смените модель.'],
    cors: 'Запросы из браузера разрешены (ключ передаётся в заголовке).',
    ...gemini,
  },
  openai: {
    id: 'openai', name: 'OpenAI', access: 'paid', accessLabel: 'Платно (по токенам)',
    tagline: 'GPT-модели через API, нужен баланс на аккаунте API',
    needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', fallback: [],
    limits: 'Бесплатного тарифа API нет. Подписка ChatGPT не даёт доступа к API — это отдельный биллинг. Открытые модели gpt-oss бесплатно доступны через Groq и OpenRouter.',
    howto: ['Создайте ключ на platform.openai.com и пополните баланс API.', 'Вставьте ключ в «Настройки».', 'Нажмите «⟳» для списка моделей.'],
    cors: 'Запросы из браузера принимаются; ключ виден в сети браузера — используйте ключ с лимитом расходов.',
    ...openaiCompat({
      baseUrl: 'https://api.openai.com/v1',
      mapModels: (l) => l.filter((m) => /^(gpt|o\d|chatgpt)/.test(m.id) && !/audio|realtime|transcribe|tts|image|embed|moderation|search/.test(m.id)).map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
    }),
  },
  anthropic: {
    id: 'anthropic', name: 'Anthropic Claude', access: 'paid', accessLabel: 'Платно (по токенам)',
    tagline: 'Claude через API, отдельный биллинг от подписки Claude',
    needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', fallback: [],
    limits: 'Бесплатного тарифа API нет. Подписка на веб-чат Claude не включает API — нужен отдельный ключ и баланс.',
    howto: ['Создайте ключ в консоли Anthropic и пополните баланс.', 'Вставьте ключ в «Настройки».', 'Нажмите «⟳» для списка моделей.'],
    cors: 'Для прямых запросов из браузера отправляется заголовок anthropic-dangerous-direct-browser-access; ключ виден в браузере — используйте ключ с лимитом расходов.',
    ...anthropic,
  },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', access: 'paid', accessLabel: 'Платно (дёшево)',
    tagline: 'Недорогие модели DeepSeek по токенам',
    needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys',
    fallback: [{ id: 'deepseek-chat', name: 'deepseek-chat' }, { id: 'deepseek-reasoner', name: 'deepseek-reasoner' }],
    limits: 'Постоплата/предоплата по токенам; бесплатного постоянного тарифа не подтверждено. Условия смотрите на platform.deepseek.com.',
    howto: ['Создайте ключ на platform.deepseek.com и пополните баланс.', 'Вставьте ключ в «Настройки».'],
    cors: 'Разрешает ли DeepSeek CORS из браузера, не проверено; при ошибке сети используйте OpenRouter/Groq.',
    ...openaiCompat({ baseUrl: 'https://api.deepseek.com/v1' }),
  },
  qwen: {
    id: 'qwen', name: 'Qwen (Alibaba Cloud)', access: 'paid', accessLabel: 'Платно / пробная квота',
    tagline: 'Qwen через Alibaba Cloud Model Studio',
    needsKey: true, keyUrl: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    fallback: [{ id: 'qwen-plus', name: 'qwen-plus' }, { id: 'qwen-turbo', name: 'qwen-turbo' }],
    limits: 'Может быть пробная квота для новых аккаунтов — условия уточняйте у Alibaba Cloud. Открытые Qwen-модели иногда доступны бесплатно через OpenRouter/Groq.',
    howto: ['Получите ключ Model Studio (международный регион).', 'Вставьте ключ в «Настройки».'],
    cors: 'CORS для браузера не проверен; при ошибке сети используйте другой путь к Qwen (OpenRouter).',
    ...openaiCompat({ baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }),
  },
  ollama: {
    id: 'ollama', name: 'Ollama (локально)', access: 'local', accessLabel: 'Локально, бесплатно',
    tagline: 'Модели на вашем компьютере, без ключа',
    needsKey: false, keyUrl: 'https://ollama.com/download', fallback: [],
    limits: 'Без лимитов, но зависит от вашего железа. Работает только с устройства, где запущена Ollama.',
    howto: ['Установите Ollama и скачайте модель: ollama pull <модель>.', 'Разрешите сайту доступ: задайте OLLAMA_ORIGINS на адрес этого сайта и перезапустите Ollama.', 'Нажмите «⟳», чтобы увидеть установленные модели.'],
    cors: 'Нужна переменная OLLAMA_ORIGINS. Safari и некоторые браузеры блокируют запросы с https-страницы на http://localhost.',
    ...ollama,
  },
  custom: {
    id: 'custom', name: 'Свой endpoint', access: 'custom', accessLabel: 'OpenAI-совместимый API',
    tagline: 'Любой сервис с /chat/completions: Mistral, Cerebras, LM Studio…',
    needsKey: false, keyUrl: '', fallback: [],
    limits: 'Определяются выбранным сервисом.',
    howto: ['В «Настройках» укажите адрес API, например https://api.mistral.ai/v1.', 'Вставьте ключ (если нужен).', 'Нажмите «⟳» или введите ID модели вручную.'],
    cors: 'Сервис должен разрешать CORS для браузера.',
    ...openaiCompat({ baseUrl: (ctx) => ctx.settings.customUrl }),
  },
};
export const ORDER = ['openrouter', 'groq', 'gemini', 'ollama', 'custom', 'deepseek', 'qwen', 'openai', 'anthropic'];
