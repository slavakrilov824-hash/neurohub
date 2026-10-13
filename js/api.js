// Общие сетевые утилиты: ошибки, fetch-обёртка, чтение SSE.
export class ApiError extends Error {
  constructor(kind, message = '', status = 0, detail = '') {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;     // auth | credits | model | limit | bad | server | network | other
    this.status = status;
    this.detail = detail;
  }
}

export const kindOf = (s) =>
  s === 401 || s === 403 ? 'auth' : s === 402 ? 'credits' : s === 404 ? 'model' :
  s === 429 ? 'limit' : s === 400 || s === 422 ? 'bad' : s >= 500 ? 'server' : 'other';

export async function http(url, opts = {}) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError('network',
      'Не удалось связаться с провайдером. Проверьте интернет, VPN и блокировщики рекламы, ' +
      'а также разрешает ли провайдер запросы из браузера (CORS).');
  }
  if (!r.ok) {
    let detail = '';
    try {
      const t = await r.text();
      try {
        const j = JSON.parse(t);
        detail = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || t;
      } catch { detail = t; }
    } catch { /* тело недоступно */ }
    throw new ApiError(kindOf(r.status), '', r.status, String(detail).slice(0, 300));
  }
  return r;
}

// Возвращает поле data каждого SSE-события (строкой).
export async function* sse(resp) {
  if (!resp.body) throw new ApiError('other', 'Провайдер не вернул поток данных.');
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const dataOf = (block) => block.split(/\r?\n/)
    .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const d = dataOf(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (d) yield d;
    }
  }
  const tail = dataOf(buf);
  if (tail) yield tail;
}
