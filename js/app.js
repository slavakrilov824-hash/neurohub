import { DEFAULTS } from './config.js';
import { PROVIDERS, ORDER } from './providers.js';
import { renderMarkdown } from './markdown.js';
import { ApiError } from './api.js';

const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};

/* ---------- хранилище ---------- */
function mkStore(n) {
  try { const s = window[n]; s.setItem('hor:t', '1'); s.removeItem('hor:t'); return s; }
  catch { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; }
}
const LS = mkStore('localStorage'), SS = mkStore('sessionStorage');
const jget = (st, k, d) => { try { const v = st.getItem('hor:' + k); return v ? JSON.parse(v) : d; } catch { return d; } };
const jset = (st, k, v) => { try { st.setItem('hor:' + k, JSON.stringify(v)); return true; } catch { return false; } };

let settings = { remember: false, freeOnly: true, ollamaUrl: DEFAULTS.ollamaUrl, customUrl: DEFAULTS.customUrl,
  customName: DEFAULTS.customName, last: { provider: DEFAULTS.defaultProvider, models: {} }, ...jget(LS, 'settings', {}) };
let keys = { ...jget(SS, 'keys', {}), ...jget(LS, 'keys', {}) };
let chats = jget(LS, 'chats', []);
let modelCache = jget(LS, 'models', {});
let currentId = null, busy = null, query = '';

const saveSettings = () => jset(LS, 'settings', settings);
function saveKeys() {
  const [on, off] = settings.remember ? [LS, SS] : [SS, LS];
  off.removeItem('hor:keys');
  if (Object.keys(keys).length) jset(on, 'keys', keys); else on.removeItem('hor:keys');
}
function saveChats() { if (!jset(LS, 'chats', chats)) toast('Не удалось сохранить историю: хранилище браузера заполнено.'); }

/* ---------- утилиты ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Скопировано'); }
  catch {
    const ta = h('textarea', { 'aria-hidden': 'true' }); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Скопировано'); } catch { toast('Не удалось скопировать'); }
    ta.remove();
  }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const cur = () => chats.find((c) => c.id === currentId);
const prov = () => PROVIDERS[cur()?.provider] || PROVIDERS[DEFAULTS.defaultProvider];

function friendly(e, p) {
  if (e instanceof ApiError) {
    const d = e.detail ? `\n\nОтвет провайдера: ${e.detail}` : '';
    switch (e.kind) {
      case 'auth': return `Ключ не принят (${e.status}). Проверьте ключ для «${p.name}» в настройках: он мог быть введён с ошибкой, отозван или не иметь доступа к этой модели.` + d;
      case 'limit': return `Лимит исчерпан или запросов слишком много (429). Подождите или выберите другую модель/провайдера.\n\nЛимиты: ${p.limits}` + d;
      case 'credits': return `Недостаточно средств на аккаунте (402). Пополните баланс или выберите бесплатную модель.` + d;
      case 'model': return `Модель не найдена или недоступна для вашего ключа (404). Обновите список моделей кнопкой ⟳ или выберите другую.` + d;
      case 'bad': return `Провайдер отклонил запрос (${e.status || 400}).` + (e.message ? '\n' + e.message : '') + d;
      case 'server': return `Провайдер временно недоступен (${e.status}). Повторите позже.` + d;
      case 'network': return e.message;
      default: return `Ошибка запроса${e.status ? ' (' + e.status + ')' : ''}.` + (e.message ? '\n' + e.message : '') + d;
    }
  }
  return 'Непредвиденная ошибка: ' + (e?.message || e);
}

/* ---------- чаты ---------- */
function newChat() {
  const pid = settings.last.provider in PROVIDERS ? settings.last.provider : DEFAULTS.defaultProvider;
  const c = { id: uid(), title: 'Новый чат', created: Date.now(), updated: Date.now(), provider: pid,
    model: settings.last.models?.[pid] || '', messages: [] };
  chats.unshift(c); currentId = c.id; saveChats(); renderAll(); $('#input').focus();
  closeSidebar();
}
function openChat(id) { if (busy) stop(); currentId = id; renderAll(); closeSidebar(); }
function delChat(id) {
  const c = chats.find((x) => x.id === id);
  if (!c || !confirm(`Удалить чат «${c.title}»?`)) return;
  if (busy && id === currentId) stop();
  chats = chats.filter((x) => x.id !== id);
  if (id === currentId) currentId = chats[0]?.id || null;
  if (!currentId) return newChat();
  saveChats(); renderAll();
}

function renderChatList() {
  const q = query.trim().toLowerCase();
  const list = chats.filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
    .sort((a, b) => b.updated - a.updated);
  const box = $('#chatList'); box.replaceChildren();
  if (!list.length) box.append(h('div', { class: 'empty-list', text: q ? 'Ничего не найдено' : 'Пока пусто' }));
  for (const c of list) {
    box.append(h('div', { class: 'chat-item' + (c.id === currentId ? ' on' : '') },
      h('button', { class: 't', type: 'button', title: c.title, text: c.title, onclick: () => openChat(c.id) }),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Удалить чат', title: 'Удалить', text: '✕', onclick: () => delChat(c.id) })));
  }
}

/* ---------- выбор провайдера и модели ---------- */
const accessOrder = [['free', 'Бесплатно'], ['freemium', 'Бесплатный тариф'], ['local', 'Локально'], ['custom', 'Свой'], ['paid', 'Платно']];
function modelsFor(pid) {
  const p = PROVIDERS[pid];
  let list = modelCache[pid]?.length ? modelCache[pid] : p.fallback;
  if (pid === 'openrouter' && settings.freeOnly) list = list.filter((m) => m.free);
  return list;
}
function renderPicker() {
  const c = cur(), p = prov();
  const sel = $('#provider'); sel.replaceChildren();
  for (const [acc, label] of accessOrder) {
    const g = h('optgroup', { label });
    for (const id of ORDER) if (PROVIDERS[id].access === acc) g.append(h('option', { value: id, text: PROVIDERS[id].name }));
    if (g.children.length) sel.append(g);
  }
  sel.value = p.id;
  $('#model').value = c.model || '';
  $('#freeWrap').hidden = p.id !== 'openrouter';
  $('#freeOnly').checked = settings.freeOnly;
  const b = $('#accessBadge'); b.textContent = p.accessLabel; b.dataset.access = p.access;
  $('#refreshModels').hidden = !p.listModels;
  const dl = $('#modelList'); dl.replaceChildren();
  for (const m of modelsFor(p.id)) dl.append(h('option', { value: m.id, label: m.name + (m.free ? ' · бесплатно' : '') }));
}
function setProvider(pid) {
  const c = cur(); c.provider = pid;
  c.model = settings.last.models?.[pid] || modelsFor(pid)[0]?.id || '';
  settings.last.provider = pid; saveSettings(); saveChats(); renderPicker(); renderMessages();
  autoLoad(pid);
}
function setModel(v) {
  const c = cur(); c.model = v.trim();
  settings.last.models = { ...settings.last.models, [c.provider]: c.model }; saveSettings(); saveChats();
}
async function refreshModels(pid, quiet) {
  const p = PROVIDERS[pid];
  if (!p.listModels) return;
  if (p.needsKey && !keys[pid]) { if (!quiet) toast('Для списка моделей нужен ключ: добавьте его в настройках.'); return; }
  if (pid === 'custom' && !settings.customUrl) { if (!quiet) toast('Укажите адрес API в настройках.'); return; }
  const btn = $('#refreshModels'); btn.disabled = true;
  try {
    const list = await p.listModels({ key: keys[pid] || '', settings });
    if (!list.length) throw new ApiError('other', 'Провайдер вернул пустой список моделей.');
    modelCache[pid] = list; jset(LS, 'models', modelCache);
    if (cur()?.provider === pid) {
      if (!cur().model) setModel(modelsFor(pid)[0]?.id || '');
      renderPicker();
    }
    if (!quiet) toast(`Моделей: ${list.length}`);
  } catch (e) { if (!quiet) toast(friendly(e, p).split('\n')[0]); }
  finally { btn.disabled = false; }
}
function autoLoad(pid) {
  const p = PROVIDERS[pid];
  if (!modelCache[pid]?.length && (!p.needsKey || keys[pid]) && pid !== 'custom') refreshModels(pid, true);
}

/* ---------- сообщения ---------- */
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 120;
function bodyOf(m, streaming) {
  const b = h('div', { class: 'body' });
  if (m.role === 'user') { b.textContent = m.content; return b; }
  if (m.content) b.innerHTML = renderMarkdown(m.content);
  else if (streaming) b.append(h('span', { class: 'dots', 'aria-label': 'Нейросеть отвечает' }, h('i'), h('i'), h('i')));
  return b;
}
function msgEl(m, i, last) {
  const streaming = busy && last && m.role === 'assistant';
  const el = h('article', { class: 'msg ' + m.role, 'data-i': i },
    h('div', { class: 'who', text: m.role === 'user' ? 'Вы' : (m.model || 'Нейросеть') }), bodyOf(m, streaming));
  if (m.error) el.append(h('div', { class: 'err', role: 'alert', text: m.error }));
  if (!streaming) {
    const acts = h('div', { class: 'acts' });
    if (m.content) acts.append(h('button', { class: 'mini', type: 'button', 'data-act': 'copy', text: 'Копировать' }));
    if (m.role === 'user' && !busy) acts.append(h('button', { class: 'mini', type: 'button', 'data-act': 'edit', text: 'Изменить' }));
    if (m.role === 'assistant' && last && !busy) acts.append(h('button', { class: 'mini', type: 'button', 'data-act': 'retry', text: 'Повторить' }));
    if (m.error && /ключ|Ключ/.test(m.error) && /настройк/.test(m.error)) acts.append(h('button', { class: 'mini', type: 'button', 'data-act': 'settings', text: 'Открыть настройки' }));
    if (acts.children.length) el.append(acts);
  }
  return el;
}
function renderMessages() {
  const box = $('#messages'), c = cur(); box.replaceChildren();
  if (!c.messages.length) {
    box.append(h('div', { class: 'hero' }, h('h1', { text: 'С какой нейросетью поговорим?' }),
      h('p', { text: 'Выберите провайдера — ключ хранится только в вашем браузере. Бесплатные варианты отмечены зелёным.' }),
      h('div', { class: 'cards' }, ORDER.map((id) => {
        const p = PROVIDERS[id];
        return h('button', { class: 'card' + (p.id === c.provider ? ' on' : ''), type: 'button', 'data-access': p.access, onclick: () => setProvider(id) },
          h('span', { class: 'tag', 'data-access': p.access, text: p.accessLabel }), h('b', { text: p.name }), h('span', { class: 'd', text: p.tagline }));
      }))));
    return;
  }
  c.messages.forEach((m, i) => box.append(msgEl(m, i, i === c.messages.length - 1)));
  box.scrollTop = box.scrollHeight;
}
let raf = 0;
function paintStream() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const c = cur(), box = $('#messages'), el = box.lastElementChild;
    if (!c || !el || !el.classList.contains('assistant')) return;
    const stick = nearBottom(box), m = c.messages[c.messages.length - 1];
    el.querySelector('.body').replaceWith(bodyOf(m, true));
    if (stick) box.scrollTop = box.scrollHeight;
  });
}

async function generate() {
  const c = cur(), p = prov();
  const finish = (err) => { c.messages.push({ role: 'assistant', content: '', model: c.model, error: err }); saveChats(); setBusy(null); renderMessages(); };
  if (!c.model) return finish('Выберите модель: введите ID или нажмите ⟳ и выберите из списка.');
  if (p.needsKey && !keys[p.id]) return finish(`Для «${p.name}» нужен API-ключ. Получить: ${p.keyUrl}\nДобавьте его в настройках — он хранится только в вашем браузере.`);
  if (p.id === 'custom' && !settings.customUrl) return finish('Укажите адрес API своего endpoint в настройках.');
  const ctrl = new AbortController();
  const msg = { role: 'assistant', content: '', model: c.model };
  const history = c.messages.filter((m) => m.content && !m.error).map(({ role, content }) => ({ role, content }));
  c.messages.push(msg); setBusy(ctrl); renderMessages();
  try {
    for await (const t of p.stream({ key: keys[p.id] || '', model: c.model, messages: history, settings, signal: ctrl.signal })) {
      msg.content += t; paintStream();
    }
    if (!msg.content) msg.error = 'Модель вернула пустой ответ. Попробуйте ещё раз или выберите другую модель.';
  } catch (e) {
    if (e?.name !== 'AbortError') msg.error = friendly(e, p);
  }
  if (!msg.content && !msg.error) c.messages.pop();
  c.updated = Date.now(); saveChats(); setBusy(null); renderAll();
}
function setBusy(ctrl) {
  busy = ctrl;
  const b = $('#send'); b.textContent = ctrl ? 'Остановить' : 'Отправить';
  $('#provider').disabled = !!ctrl;
}
function stop() { busy?.abort(); }
function send(text) {
  const c = cur(); text = text.trim();
  if (!text) return;
  if (busy) return stop();
  c.messages.push({ role: 'user', content: text });
  if (c.messages.length === 1) c.title = text.replace(/\s+/g, ' ').slice(0, 48);
  c.updated = Date.now(); saveChats(); renderChatList(); generate();
}
function onSend() {
  if (busy) return stop();
  const ta = $('#input'); const t = ta.value;
  if (!t.trim()) return;
  ta.value = ''; autosize(); send(t);
}
function autosize() { const ta = $('#input'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; }

$('#messages').addEventListener('click', (e) => {
  const cc = e.target.closest('.copy-code');
  if (cc) return copy(cc.closest('.code').querySelector('code').textContent);
  const b = e.target.closest('[data-act]'); if (!b) return;
  const el = b.closest('.msg'), i = Number(el.dataset.i), c = cur(), m = c.messages[i];
  switch (b.dataset.act) {
    case 'copy': return copy(m.content);
    case 'settings': return openSettings();
    case 'retry': c.messages.length = i; return generate();
    case 'edit': {
      const ta = h('textarea', { class: 'edit', 'aria-label': 'Изменить сообщение' }); ta.value = m.content;
      el.querySelector('.body').replaceWith(ta);
      el.querySelector('.acts').replaceChildren(
        h('button', { class: 'primary', type: 'button', text: 'Отправить заново', onclick: () => { const t = ta.value.trim(); if (!t) return; c.messages.length = i; if (i === 0) c.title = t.slice(0, 48); send(t); } }),
        h('button', { class: 'mini', type: 'button', text: 'Отмена', onclick: renderMessages }));
      ta.focus();
    }
  }
});

/* ---------- диалоги ---------- */
function openSettings() {
  const dlg = $('#settingsDlg'); dlg.replaceChildren();
  const inputs = {};
  const keyRow = (p) => {
    const inp = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'вставьте ключ', 'aria-label': 'Ключ ' + p.name });
    inp.value = keys[p.id] || ''; inputs[p.id] = inp;
    const eye = h('button', { class: 'ghost', type: 'button', text: 'Показать', onclick: () => { const s = inp.type === 'password'; inp.type = s ? 'text' : 'password'; eye.textContent = s ? 'Скрыть' : 'Показать'; } });
    return h('div', {}, h('label', { class: 'f', text: p.name + ' ' }, p.keyUrl ? h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: '(получить ключ)' }) : null), h('div', { class: 'row' }, inp, eye));
  };
  const ollamaUrl = h('input', { type: 'text', value: settings.ollamaUrl, 'aria-label': 'Адрес Ollama' });
  const customName = h('input', { type: 'text', value: settings.customName, 'aria-label': 'Название endpoint' });
  const customUrl = h('input', { type: 'text', value: settings.customUrl, placeholder: 'https://api.example.com/v1', 'aria-label': 'Адрес API' });
  const remember = h('input', { type: 'checkbox' }); remember.checked = settings.remember;
  dlg.append(h('h2', { text: 'Настройки и ключи' }),
    h('p', { text: 'Ключи хранятся только в вашем браузере и отправляются только выбранному провайдеру. Не вводите ключи на чужих устройствах.' }),
    ...ORDER.filter((id) => PROVIDERS[id].needsKey).map((id) => keyRow(PROVIDERS[id])),
    h('h3', { text: 'Ollama' }), h('div', { class: 'row' }, ollamaUrl),
    h('h3', { text: 'Свой OpenAI-совместимый endpoint' }),
    h('div', { class: 'row' }, customName), h('div', { class: 'row' }, customUrl), keyRow({ id: 'custom', name: 'Ключ своего endpoint', keyUrl: '' }),
    h('label', { class: 'check' }, remember, ' Запомнить ключи на этом устройстве (иначе — только до закрытия вкладки)'),
    h('div', { class: 'actions' },
      h('button', { class: 'ghost danger', type: 'button', text: 'Удалить все ключи', onclick: () => { keys = {}; saveKeys(); dlg.close(); toast('Ключи удалены'); renderAll(); } }),
      h('button', { class: 'ghost', type: 'button', text: 'Закрыть', onclick: () => dlg.close() }),
      h('button', { class: 'primary', type: 'button', text: 'Сохранить', onclick: () => {
        for (const [id, inp] of Object.entries(inputs)) { const v = inp.value.trim(); if (v) keys[id] = v; else delete keys[id]; }
        settings.remember = remember.checked; settings.ollamaUrl = ollamaUrl.value.trim() || DEFAULTS.ollamaUrl;
        settings.customName = customName.value.trim() || DEFAULTS.customName; settings.customUrl = customUrl.value.trim();
        saveKeys(); saveSettings(); dlg.close(); toast('Сохранено'); renderAll(); autoLoad(cur().provider);
      } })));
  dlg.showModal();
}
function openInfo() {
  const dlg = $('#infoDlg'), p = prov(); dlg.replaceChildren();
  dlg.append(h('h2', {}, p.name + ' ', h('span', { class: 'badge', 'data-access': p.access, text: p.accessLabel })),
    h('dl', { class: 'kv' },
      h('dt', { text: 'Нужен ключ' }), h('dd', { text: p.needsKey ? 'да' : 'нет' + (p.id === 'custom' ? ' (зависит от сервиса)' : '') }),
      h('dt', { text: 'Статус ключа' }), h('dd', { text: keys[p.id] ? 'сохранён в этом браузере' : (p.needsKey ? 'не задан' : '—') }),
      h('dt', { text: 'Лимиты' }), h('dd', { text: p.limits }),
      h('dt', { text: 'Браузер / CORS' }), h('dd', { text: p.cors })),
    h('h3', { text: 'Как получить доступ' }), h('ol', {}, p.howto.map((s) => h('li', { text: s }))),
    p.keyUrl ? h('p', {}, h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: p.keyUrl })) : null,
    h('p', { class: 'empty-list', text: 'Условия провайдеров меняются: сверяйтесь с их официальными страницами. Данные на 13.10.2026, сайт не гарантирует их актуальность.' }),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', text: 'Закрыть', onclick: () => dlg.close() })));
  dlg.showModal();
}

/* ---------- прочее ---------- */
const closeSidebar = () => document.body.classList.remove('open');
function renderAll() { renderChatList(); renderPicker(); renderMessages(); }

$('#newChat').onclick = newChat;
$('#send').onclick = onSend;
$('#openSettings').onclick = openSettings;
$('#openInfo').onclick = openInfo;
$('#menu').onclick = () => document.body.classList.toggle('open');
$('#backdrop').onclick = closeSidebar;
$('#search').oninput = (e) => { query = e.target.value; renderChatList(); };
$('#provider').onchange = (e) => setProvider(e.target.value);
$('#model').onchange = (e) => setModel(e.target.value);
$('#refreshModels').onclick = () => refreshModels(cur().provider, false);
$('#freeOnly').onchange = (e) => { settings.freeOnly = e.target.checked; saveSettings(); renderPicker(); };
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSend(); }
});
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
  else if (e.key === 'Escape') { if (busy) stop(); closeSidebar(); }
});
window.addEventListener('beforeunload', () => { if (chats.length) jset(LS, 'chats', chats); });

if (!chats.length) newChat(); else { currentId = chats.sort((a, b) => b.updated - a.updated)[0].id; renderAll(); autoLoad(cur().provider); }
