// Note formatting (markdown → HTML) and note math, carried over from the Scriptorium notes app. Loaded by app.js on demand.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);


const NUM_RE = /(?<![\w.])[-−]?\$?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?![\w])/g;

/** Extracts numeric values from free text such as "$1,200.50", "-3", "4.5". Dates and times are skipped. */
export function extractNumbers(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let line of lines) {
    // drop list markers like "1." / "2)" at the start of a line, and dates/times
    line = line.replace(/^\s*\d+[.)]\s+/, ' ')
      .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, ' ');
    for (const m of line.matchAll(NUM_RE)) {
      const raw = m[0];
      if (!/\d/.test(raw) || raw.endsWith('%')) continue;
      const v = parseFloat(raw.replace(/[−]/g, '-').replace(/[$,]/g, ''));
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

export function summarize(nums) {
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  const product = nums.reduce((a, b) => a * b, 1);
  const difference = nums.slice(1).reduce((a, b) => a - b, nums[0]);
  const quotient = nums.slice(1).every((b) => b !== 0) ? nums.slice(1).reduce((a, b) => a / b, nums[0]) : NaN;
  return {
    count: nums.length,
    sum,
    average: sum / nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    difference,
    product,
    quotient,
  };
}

export function formatNumber(v) {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 1e10) / 1e10;
  const abs = Math.abs(r);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return r.toExponential(6).replace(/\.?0+e/, 'e');
  return r.toLocaleString(undefined, { maximumFractionDigits: 6, useGrouping: abs >= 10000 });
}

/* ---- expression evaluator (no eval) ----
   Supports + - * / ^ % (modulo), parentheses, ×, ÷, unary minus, commas in numbers,
   $ signs, and functions sqrt/abs/round/floor/ceil/min/max/sum/avg. */

function lex(src) {
  const s = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\$/g, '');
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[\d.]/.test(c)) {
      const m = s.slice(i).match(/^(\d{1,3}(,\d{3})+|\d*)(\.\d+)?([eE][-+]?\d+)?/);
      if (!m || m[0] === '' || m[0] === '.') throw new Error('bad number');
      toks.push({ t: 'n', v: parseFloat(m[0].replace(/,/g, '')) });
      i += m[0].length;
      continue;
    }
    if (/[a-z]/i.test(c)) {
      const m = s.slice(i).match(/^[a-z]+/i);
      toks.push({ t: 'f', v: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    if ('+-*/^%(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error(`unexpected ${c}`);
  }
  return toks;
}

const FNS = {
  sqrt: (a) => Math.sqrt(a[0]), abs: (a) => Math.abs(a[0]), round: (a) => (a.length > 1 ? Math.round(a[0] * 10 ** a[1]) / 10 ** a[1] : Math.round(a[0])),
  floor: (a) => Math.floor(a[0]), ceil: (a) => Math.ceil(a[0]), min: (a) => Math.min(...a), max: (a) => Math.max(...a),
  sum: (a) => a.reduce((x, y) => x + y, 0), avg: (a) => a.reduce((x, y) => x + y, 0) / a.length,
  pi: () => Math.PI,
};

export function evaluate(expr) {
  const toks = lex(expr);
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => { if (toks[p]?.t !== t) throw new Error(`expected ${t}`); return toks[p++]; };
  const primary = () => {
    const tk = toks[p++];
    if (!tk) throw new Error('unexpected end');
    if (tk.t === 'n') return tk.v;
    if (tk.t === '-') return -power();
    if (tk.t === '+') return power();
    if (tk.t === '(') { const v = add(); take(')'); return v; }
    if (tk.t === 'f') {
      const fn = FNS[tk.v];
      if (!fn) throw new Error(`unknown ${tk.v}`);
      if (tk.v === 'pi') return Math.PI;
      take('(');
      const args = [add()];
      while (peek()?.t === ',') { p++; args.push(add()); }
      take(')');
      return fn(args);
    }
    throw new Error('syntax');
  };
  const power = () => {
    const b = primary();
    if (peek()?.t === '^') { p++; return b ** unary(); }
    return b;
  };
  const unary = () => {
    if (peek()?.t === '-') { p++; return -unary(); }
    if (peek()?.t === '+') { p++; return unary(); }
    return power();
  };
  const mul = () => {
    let v = unary();
    while (peek() && '*/%'.includes(peek().t) && peek().t.length === 1) {
      const op = toks[p++].t;
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const add = () => {
    let v = mul();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t;
      const r = mul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = add();
  if (p !== toks.length) throw new Error('trailing input');
  return v;
}

/**
 * If `line` ends with "=" after an arithmetic expression, returns { expr, value, text }.
 * Only triggers when the expression contains an operator or function so prose like "x =" is ignored.
 */
export function inlineCalc(line) {
  const m = String(line).match(/([\d$(][\d\s.,$()+\-−*/×÷^%a-z]*?)\s*=\s*$/i);
  if (!m) return null;
  let expr = m[1].trim();
  // take the longest tail that parses
  const startIdx = line.length - m[0].length;
  const candidates = [];
  const head = line.slice(0, startIdx + m[0].length).replace(/\s*=\s*$/, '');
  for (let i = 0; i < head.length; i++) {
    if (i === 0 || /[\s:(]/.test(head[i - 1])) candidates.push(head.slice(i).trim());
  }
  for (const c of candidates) {
    if (!/\d/.test(c) || !/[+\-−*/×÷^%(]|\b(sqrt|abs|round|floor|ceil|min|max|sum|avg)\b/i.test(c.replace(/^-/, ''))) continue;
    if (/[a-z]{2,}/i.test(c.replace(/\b(sqrt|abs|round|floor|ceil|min|max|sum|avg|pi)\b/gi, ''))) continue;
    try {
      const value = evaluate(c);
      if (Number.isFinite(value)) { expr = c; return { expr, value, text: formatNumber(value) }; }
    } catch { /* try a shorter tail */ }
  }
  return null;
}

/**
 * ctx.resolveLink(title) → noteId|null, ctx.resolveEmbed(name) → { att, kind }|null
 */
export function markdownToHtml(md, ctx = {}) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  // strip YAML frontmatter
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  const para = [];
  const flushPara = () => {
    if (para.length) html += `<p>${para.map((l) => mdInline(l, ctx)).join('<br>')}</p>`;
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
      continue;
    }
    if (!line.trim()) { flushPara(); i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      const lv = Math.min(m[1].length, 4);
      html += `<h${lv}>${mdInline(m[2].replace(/\s+#+\s*$/, ''), ctx)}</h${lv}>`;
      i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); html += '<hr>'; i++; continue; }
    if (/^\s*>/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      // Obsidian callouts: > [!note] Title
      if (q[0] && /^\[!\w+\]/.test(q[0])) q[0] = q[0].replace(/^\[!(\w+)\][+-]?\s*/, (_, k) => `**${k[0].toUpperCase() + k.slice(1)}** `);
      html += `<blockquote>${markdownToHtml(q.join('\n'), ctx)}</blockquote>`;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const res = parseList(lines, i, ctx);
      html += res.html;
      i = res.next;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => mdInline(c.trim(), ctx));
      const [head, , ...body] = rows;
      html += `<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    if ((m = line.match(/^<div align="(left|center|right|justify)">\s*$/))) {
      flushPara();
      const inner = [];
      i++;
      while (i < lines.length && !/^<\/div>\s*$/.test(lines[i])) inner.push(lines[i++]);
      i++;
      html += markdownToHtml(inner.join('\n'), ctx).replace(/<(p|h[1-4])>/g, `<$1 style="text-align:${m[1]}">`);
      continue;
    }
    para.push(line.replace(/\s{2,}$/, ''));
    i++;
  }
  flushPara();
  return html;
}

function parseList(lines, start, ctx) {
  const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const baseIndent = indentOf(lines[start]);
  const ordered = /^\s*\d+[.)]\s/.test(lines[start]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      // blank line ends the list unless the next line continues it
      if (i + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1]) && indentOf(lines[i + 1]) >= baseIndent) { i++; continue; }
      break;
    }
    const ind = indentOf(l);
    const m = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (ind < baseIndent) break;
    if (ind > baseIndent && items.length) {
      const sub = parseList(lines, i, ctx);
      items[items.length - 1].sub += sub.html;
      i = sub.next;
      continue;
    }
    if (!m) { if (items.length && ind > baseIndent) { items[items.length - 1].text += ' ' + l.trim(); i++; continue; } break; }
    if (/^\d/.test(m[1]) !== ordered) break;
    let text = m[2];
    let checked = null;
    const cm = text.match(/^\[([ xX])\]\s*(.*)$/);
    if (cm) { checked = cm[1] !== ' '; text = cm[2]; }
    items.push({ text, checked, sub: '' });
    i++;
  }
  const isCheck = items.length && items.every((it) => it.checked !== null);
  const tag = ordered ? 'ol' : 'ul';
  const html = `<${tag}${isCheck ? ' class="checklist"' : ''}>${items.map((it) => `<li${isCheck ? ` data-checked="${it.checked}"` : ''}>${mdInline(it.text, ctx)}${it.sub}</li>`).join('')}</${tag}>`;
  return { html, next: i };
}

export function mdInline(s, ctx = {}) {
  const tokens = [];
  const stash = (h) => `\u0000${tokens.push(h) - 1}\u0000`;
  let t = String(s);
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!=~|<>])/g, (_, c) => stash(esc(c)));
  t = t.replace(/`([^`]+)`/g, (_, c) => stash(`<code>${esc(c)}</code>`));
  // Obsidian embeds ![[file]]
  t = t.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, name) => {
    const r = ctx.resolveEmbed ? ctx.resolveEmbed(name.trim()) : null;
    if (r?.kind === 'audio') return stash(`<audio controls preload="metadata" data-att="${esc(r.att)}"></audio>`);
    if (r) return stash(`<img data-att="${esc(r.att)}" alt="">`);
    return stash(esc(`![[${name}]]`));
  });
  t = t.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, alt, src) => {
    if (!/^(https?:|data:image\/)/i.test(src)) {
      const r = ctx.resolveEmbed ? ctx.resolveEmbed(decodeURIComponent(src.split('/').pop())) : null;
      return r ? stash(`<img data-att="${esc(r.att)}" alt="${esc(alt)}">`) : stash(esc(alt));
    }
    return stash(`<img src="${esc(src)}" alt="${esc(alt)}">`);
  });
  // wikilinks [[Title|alias]]
  t = t.replace(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, title, alias) => {
    const id = ctx.resolveLink ? ctx.resolveLink(title.trim()) : null;
    const label = esc((alias || title).trim());
    return stash(id ? `<a class="note-link" data-note-id="${esc(id)}" href="#/note/${esc(id)}">${label}</a>` : label);
  });
  t = t.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, text, href) => {
    if (!/^(https?:|mailto:|#)/i.test(href)) return text;
    return stash(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">`) + text + stash('</a>');
  });
  t = t.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => stash(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`));
  // allow a few raw inline tags through
  t = t.replace(/<(\/?)(u|sub|sup|mark|b|i|em|strong|s|br)\s*\/?>/gi, (_, sl, tg) => stash(`<${sl}${tg.toLowerCase()}>`));
  t = esc(t);
  t = t.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/==(?=\S)(.+?)(?<=\S)==/g, '<mark>$1</mark>');
  // bare URLs
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  return t.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[+n]);
}

/* ---------- HTML → Markdown (what the editor saves) ---------- */
/**
 * Note HTML → Markdown.
 * ctx.attFile(id) → filename for an attachment, ctx.noteTitle(id) → title for note links.
 */
export function htmlToMarkdown(html, ctx = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const out = blocks(tpl.content, ctx, 0).replace(/\n{3,}/g, '\n\n').trim();
  return out + '\n';
}

function blocks(parent, ctx, depth) {
  let out = '';
  let inlineBuf = '';
  const flush = () => { if (inlineBuf.trim()) out += inlineBuf.trim() + '\n\n'; inlineBuf = ''; };
  for (const n of Array.from(parent.childNodes)) {
    if (n.nodeType === 3) { inlineBuf += inlineText(n.nodeValue); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    const align = n.style?.textAlign;
    const wrapAlign = (md) => (align && align !== 'left' && align !== 'start' ? `<div align="${align}">\n\n${md.trim()}\n\n</div>\n\n` : md);
    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4':
        flush(); out += wrapAlign(`${'#'.repeat(+tag[1])} ${inline(n, ctx).trim()}\n\n`); break;
      case 'P':
        flush(); { const t = inline(n, ctx).trim(); out += wrapAlign(t ? t + '\n\n' : '\n'); } break;
      case 'DIV':
        flush();
        if (n.classList.contains('audio-block')) { out += embed(n.dataset.att, ctx) + '\n\n'; break; }
        if (hasBlockChild(n)) out += wrapAlign(blocks(n, ctx, depth));
        else { const t = inline(n, ctx).trim(); out += wrapAlign(t ? t + '\n\n' : '\n'); }
        break;
      case 'UL': case 'OL':
        flush(); out += list(n, ctx, 0) + '\n'; break;
      case 'BLOCKQUOTE':
        flush(); out += blocks(n, ctx, depth).trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n') + '\n\n'; break;
      case 'PRE':
        flush(); out += '```\n' + n.textContent.replace(/\n$/, '') + '\n```\n\n'; break;
      case 'HR':
        flush(); out += '---\n\n'; break;
      case 'FIGURE':
        flush(); out += inline(n, ctx).trim() + '\n\n'; break;
      case 'TABLE':
        flush(); out += table(n, ctx) + '\n\n'; break;
      case 'BR':
        inlineBuf += '\n'; break;
      default:
        inlineBuf += inline(n, ctx, true);
    }
  }
  flush();
  return out;
}

const BLOCK_TAGS = /^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|PRE|HR|FIGURE|TABLE)$/;
function hasBlockChild(el) { return Array.from(el.children).some((c) => BLOCK_TAGS.test(c.tagName)); }

function inlineText(s) {
  s = s.replace(/\u200b/g, '').replace(/([`\\])/g, '\\$1').replace(/\s+/g, ' ');
  // Only escape characters that could pair up into formatting, so "12*4" stays readable in the file.
  for (const ch of ['*', '_', '~']) if (s.split(ch).length > 2) s = s.split(ch).join(`\\${ch}`);
  s = s.replace(/==/g, '\\=\\=');
  if (/\[[^\]]*\]/.test(s)) s = s.replace(/([[\]])/g, '\\$1');
  return s;
}

function embed(id, ctx) {
  const f = ctx.attFile ? ctx.attFile(id) : id;
  return `![[${f}]]`;
}

function inline(el, ctx, self = false) {
  const parts = [];
  const nodes = self ? [el] : Array.from(el.childNodes);
  for (const n of nodes) {
    if (n.nodeType === 3) { parts.push(inlineText(n.nodeValue)); continue; }
    if (n.nodeType !== 1) continue;
    const inner = () => inline(n, ctx);
    switch (n.tagName) {
      case 'B': case 'STRONG': parts.push(wrapMark('**', inner())); break;
      case 'I': case 'EM': parts.push(wrapMark('*', inner())); break;
      case 'U': parts.push(`<u>${inner()}</u>`); break;
      case 'S': case 'DEL': case 'STRIKE': parts.push(wrapMark('~~', inner())); break;
      case 'MARK': parts.push(wrapMark('==', inner())); break;
      case 'CODE': parts.push('`' + n.textContent + '`'); break;
      case 'SUB': parts.push(`<sub>${inner()}</sub>`); break;
      case 'SUP': parts.push(`<sup>${inner()}</sup>`); break;
      case 'BR': parts.push('  \n'); break;
      case 'A': {
        const text = inner().trim();
        if (n.dataset.noteId) {
          const title = ctx.noteTitle ? ctx.noteTitle(n.dataset.noteId) : null;
          const t = (title || n.textContent).replace(/[[\]|#^]/g, '');
          parts.push(t === n.textContent.trim() || !n.textContent.trim() ? `[[${t}]]` : `[[${t}|${n.textContent.replace(/[[\]|]/g, '')}]]`);
        } else {
          const href = n.getAttribute('href') || '';
          parts.push(!text || text === href ? `<${href}>` : `[${text}](${href.replace(/\)/g, '%29')})`);
        }
        break;
      }
      case 'IMG':
        if (n.dataset.att) parts.push(embed(n.dataset.att, ctx));
        else parts.push(`![${(n.alt || '').replace(/[[\]]/g, '')}](${n.getAttribute('src')})`);
        break;
      case 'AUDIO': if (n.dataset.att) parts.push(embed(n.dataset.att, ctx)); break;
      case 'DIV':
        if (n.classList.contains('audio-block')) { parts.push(embed(n.dataset.att, ctx)); break; }
        parts.push(inner()); break;
      default: parts.push(inner());
    }
  }
  return parts.join('');
}

function wrapMark(m, s) {
  if (!s.trim()) return s;
  const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
  return `${lead}${m}${s.trim()}${m}${trail}`;
}

function list(el, ctx, level) {
  const ordered = el.tagName === 'OL';
  const check = el.classList.contains('checklist');
  let i = 1, out = '';
  for (const li of Array.from(el.children)) {
    if (li.tagName !== 'LI') { if (/^(UL|OL)$/.test(li.tagName)) out += list(li, ctx, level + 1); continue; }
    const nested = Array.from(li.children).filter((c) => /^(UL|OL)$/.test(c.tagName));
    const clone = li.cloneNode(true);
    clone.querySelectorAll(':scope > ul, :scope > ol').forEach((x) => x.remove());
    const marker = ordered ? `${i++}.` : check ? `- [${li.dataset.checked === 'true' ? 'x' : ' '}]` : '-';
    const text = blocksInline(clone, ctx);
    out += `${'    '.repeat(level)}${marker} ${text}\n`;
    for (const sub of nested) out += list(sub, ctx, level + 1);
  }
  return out;
}

function blocksInline(el, ctx) {
  return inline(el, ctx).replace(/\s*\n\s*/g, ' ').trim();
}

function table(el, ctx) {
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => blocksInline(c, ctx).replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const w = Math.max(...rows.map((r) => r.length));
  const fmt = (r) => `| ${Array.from({ length: w }, (_, i) => r[i] || '').join(' | ')} |`;
  return [fmt(rows[0]), `| ${Array(w).fill('---').join(' | ')} |`, ...rows.slice(1).map(fmt)].join('\n');
}

