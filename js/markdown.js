// Небольшой безопасный Markdown-рендерер: весь исходный текст экранируется,
// HTML из ответа модели никогда не попадает в страницу как разметка.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function inline(src) {
  const codes = [];
  let s = src.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[i]) + '</code>');
}

const isBlockStart = (l) => /^(```|#{1,4}\s|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(l);

export function renderMarkdown(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0, m;
  while (i < lines.length) {
    const l = lines[i];
    if ((m = l.match(/^```([\w+#.-]*)/))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<div class="code"><div class="code-head"><span>' + esc(m[1] || 'код') +
        '</span><button class="copy-code" type="button">Копировать</button></div><pre><code>' +
        esc(buf.join('\n')) + '</code></pre></div>');
    } else if ((m = l.match(/^(#{1,4})\s+(.*)/))) {
      const n = m[1].length + 1;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
    } else if (/^\s*([-*_])\1\1+\s*$/.test(l)) {
      out.push('<hr>'); i++;
    } else if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push('<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>');
    } else if (/^\s*[-*+]\s+/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      out.push('<ul>' + buf.map((x) => '<li>' + inline(x) + '</li>').join('') + '</ul>');
    } else if (/^\s*\d+[.)]\s+/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push('<ol>' + buf.map((x) => '<li>' + inline(x) + '</li>').join('') + '</ol>');
    } else if (!l.trim()) {
      i++;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
      if (!buf.length) buf.push(lines[i++]);
      out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
    }
  }
  return out.join('');
}
