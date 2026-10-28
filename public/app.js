/* Biblioteca IAM — aplicação (corre no navegador; fala com /api/…) */
'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const isoDay = d => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
const today = () => isoDay(new Date());
const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const uid = () => Math.random().toString(36).slice(2, 10);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} }
};

const CDU = {
  '0': 'Generalidades', '1': 'Filosofia e Psicologia', '2': 'Religião', '3': 'Ciências Sociais',
  '5': 'Ciências Exatas e Naturais', '6': 'Ciências Aplicadas', '7': 'Artes e Desporto',
  '8': 'Língua e Literatura', '9': 'História, Geografia e Biografia'
};
const LOAN_DAYS = 30;

const S = {
  books: [], ready: false, q: '', classe: 'all', estado: 'all', sort: 'recent', view: 'grid',
  papel: null, ia: false, nome: store.get('iam-nome') || '', open: null, editing: false, iaOff: false
};

/* ---------- API ---------- */
class ApiError extends Error { constructor(status, codigo, msg) { super(msg); this.status = status; this.codigo = codigo; } }
async function api(method, path, body, opts = {}) {
  let r;
  try {
    r = await fetch('/api/' + path, {
      method,
      headers: body === undefined ? {} : (opts.raw ? { 'content-type': opts.type } : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : (opts.raw ? body : JSON.stringify(body)),
      credentials: 'same-origin'
    });
  } catch { throw new ApiError(0, 'rede', 'Sem ligação à internet. Verifique a rede e tente de novo.'); }
  let data = null;
  try { data = await r.json(); } catch {}
  if (r.status === 401 && path !== 'entrar') { showLogin(); throw new ApiError(401, 'sem_sessao', 'Entre outra vez com o código de acesso.'); }
  if (!r.ok) throw new ApiError(r.status, data?.erro || 'erro', data?.mensagem || 'Não foi possível concluir. Tente de novo.');
  return data;
}
const errMsg = e => e?.message || 'Não foi possível concluir. Tente de novo.';

async function loadBooks() {
  const list = await api('GET', 'livros');
  S.books = list;
  S.ready = true;
  render();
  if (S.open && !$('#ov-book').hidden && !S.editing) {
    const a = document.activeElement;
    const typing = a && $('#ov-book').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName);
    if (!typing) renderBook();
  }
}
function upsertLocal(book) {
  const i = S.books.findIndex(b => b.id === book.id);
  if (i >= 0) S.books[i] = book; else S.books.push(book);
  render();
}

/* ---------- helpers ---------- */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3600);
}
function surname(a) {
  const parts = String(a || '').trim().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}
function code3(b) {
  let s = surname((b.autores || [])[0]);
  if (!s) s = String(b.titulo || '').replace(/^(o|a|os|as|um|uma|the|le|la|les|el|los)\s+/i, '');
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return s.slice(0, 3) || 'XXX';
}
function makeCota(b) {
  const base = String(b.cdu || b.classe || '').trim() || '0';
  return `${base} ${code3(b)}`;
}
function isbnClean(raw) { return String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase(); }
function isbnState(raw) {
  const s = isbnClean(raw);
  if (!s) return 'empty';
  if (s.length === 13 && /^\d{13}$/.test(s)) {
    const sum = [...s].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? 'ok' : 'bad';
  }
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((a, c, i) => a + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? 'ok' : 'bad';
  }
  return 'bad';
}
function avail(b) {
  const ex = Math.max(1, Number(b.exemplares) || 1);
  const loans = Array.isArray(b.emprestimos) ? b.emprestimos : [];
  const t = today();
  const late = loans.filter(l => l.prevista && l.prevista < t).length;
  return { ex, out: loans.length, free: Math.max(0, ex - loans.length), late, loans };
}
const coverSrc = b => b.capa ? '/api/capas/' + encodeURIComponent(b.capa) : '';
function phHTML(b) {
  return `<div class="ph"><span>${esc(b.titulo || 'Sem título')}</span><small>${esc((b.autores || []).join(', '))}</small></div>`;
}
function coverInner(b, withStamp = true) {
  const a = avail(b);
  const src = coverSrc(b);
  const img = src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  let stamp = '';
  if (withStamp && a.late) stamp = `<span class="stamp late">Atrasado</span>`;
  else if (withStamp && a.free === 0) stamp = `<span class="stamp">Emprestado</span>`;
  return `${phHTML(b)}${img}${b.cota ? `<span class="spine">${esc(b.cota)}</span>` : ''}${stamp}`;
}
const coverHTML = (b, withStamp = true) => `<div class="cover">${coverInner(b, withStamp)}</div>`;
function nextReturn(b) {
  const ds = avail(b).loans.map(l => l.prevista).filter(Boolean).sort();
  return ds[0] || '';
}
const cmpPt = (x, y) => String(x).localeCompare(String(y), 'pt', { numeric: true, sensitivity: 'base' });

/* ---------- filtering & rendering ---------- */
function haystack(b) {
  return norm([b.titulo, b.subtitulo, (b.autores || []).join(' '), b.editora, b.isbn, b.cota, b.cdu, (b.assuntos || []).join(' '), b.localizacao, b.ano].join(' '));
}
function filtered() {
  const terms = norm(S.q).split(/\s+/).filter(Boolean);
  const qIsbn = isbnClean(S.q);
  const list = S.books.filter(b => {
    if (S.classe !== 'all' && String(b.classe || '') !== S.classe) return false;
    const a = avail(b);
    if (S.estado === 'disp' && a.free === 0) return false;
    if (S.estado === 'emp' && a.out === 0) return false;
    if (S.estado === 'late' && a.late === 0) return false;
    if (!terms.length) return true;
    if (qIsbn.length >= 10 && isbnClean(b.isbn) === qIsbn) return true;
    const h = haystack(b);
    return terms.every(t => h.includes(t));
  });
  if (S.sort === 'recent') list.sort((a, b) => cmpPt(b.criadoEm || '', a.criadoEm || ''));
  if (S.sort === 'titulo') list.sort((a, b) => cmpPt(a.titulo || '', b.titulo || ''));
  if (S.sort === 'autor') list.sort((a, b) => cmpPt(surname((a.autores || [])[0]) || '~', surname((b.autores || [])[0]) || '~') || cmpPt(a.titulo || '', b.titulo || ''));
  if (S.sort === 'cota') list.sort((a, b) => cmpPt(a.cota || '~', b.cota || '~'));
  return list;
}
function renderCounts() {
  if (!S.ready) { $('#counts').innerHTML = '<span>A abrir o catálogo…</span>'; return; }
  let ex = 0, out = 0, late = 0, novos = 0;
  const week = isoDay(new Date(Date.now() - 7 * 864e5));
  S.books.forEach(b => { const a = avail(b); ex += a.ex; out += a.out; late += a.late; if ((b.criadoEm || '').slice(0, 10) >= week) novos++; });
  const n = S.books.length;
  $('#counts').innerHTML =
    `<span><b>${n}</b> ${n === 1 ? 'título' : 'títulos'}</span>` +
    `<span><b>${ex}</b> ${ex === 1 ? 'exemplar' : 'exemplares'}</span>` +
    `<span><b>${out}</b> ${out === 1 ? 'emprestado' : 'emprestados'}</span>` +
    (late ? `<span class="late"><b>${late}</b> ${late === 1 ? 'atrasado' : 'atrasados'}</span>` : '') +
    `<span><b>${novos}</b> ${novos === 1 ? 'entrada' : 'entradas'} nos últimos 7 dias</span>`;
}
function renderChips() {
  const counts = {};
  S.books.forEach(b => { const k = String(b.classe || ''); counts[k] = (counts[k] || 0) + 1; });
  const keys = Object.keys(CDU).filter(k => counts[k]);
  if (S.classe !== 'all' && !keys.includes(S.classe)) S.classe = 'all';
  let h = `<button type="button" class="chip" data-c="all" aria-pressed="${S.classe === 'all'}">Todas as classes <span class="n">${S.books.length}</span></button>`;
  keys.forEach(k => {
    h += `<button type="button" class="chip" data-c="${k}" aria-pressed="${S.classe === k}"><span class="d">${k}</span>${esc(CDU[k])} <span class="n">${counts[k]}</span></button>`;
  });
  $('#chips').innerHTML = keys.length ? h : '';
}
function render() {
  renderCounts();
  renderChips();
  $('#btn-export').hidden = !S.books.length;
  const list = filtered();
  const empty = $('#empty'), el = $('#list');
  if (S.ready && !S.books.length) { empty.hidden = false; el.innerHTML = ''; return; }
  empty.hidden = true;
  if (!S.ready) { el.innerHTML = ''; return; }
  if (!list.length) {
    el.innerHTML = `<div class="empty"><h2>Nenhum livro corresponde</h2><p>Experimente outra palavra, ou limpe os filtros.</p><button class="btn" type="button" id="btn-clear">Limpar filtros</button></div>`;
    return;
  }
  if (S.view === 'sheet') { renderSheet(list); return; }
  if (S.view === 'grid') {
    el.innerHTML = `<div class="shelf">${list.map(b => `
      <button type="button" class="book" data-id="${esc(b.id)}" aria-label="${esc(b.titulo || 'Sem título')}">
        ${coverHTML(b)}
        <div><h3>${esc(b.titulo || 'Sem título')}</h3><p>${esc((b.autores || []).join(', ') || '—')}</p></div>
      </button>`).join('')}</div>`;
  } else {
    el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>Cota</th><th>Título</th><th>Autor</th><th>Editora</th><th>Ano</th><th>Local</th><th>Estado</th></tr></thead><tbody>${list.map(b => {
      const a = avail(b);
      const st = a.late ? `<span class="pill late">Atrasado</span>` : a.free === 0 ? `<span class="pill out">Emprestado</span>` : a.out ? `<span class="pill ok">${a.free} de ${a.ex} disp.</span>` : `<span class="pill ok">Disponível</span>`;
      return `<tr data-id="${esc(b.id)}" tabindex="0"><td class="mono">${esc(b.cota || '')}</td><td><span class="t">${esc(b.titulo || 'Sem título')}</span>${b.subtitulo ? `<br><small style="color:var(--muted)">${esc(b.subtitulo)}</small>` : ''}</td><td>${esc((b.autores || []).join('; '))}</td><td>${esc(b.editora || '')}</td><td class="num">${esc(b.ano || '')}</td><td>${esc(b.localizacao || '')}</td><td>${st}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
}

/* ---------- spreadsheet view ---------- */
const SHEET_COLS = [
  { k: 'cota', l: 'Cota', w: 120, cls: 'mono c-cota', v: b => b.cota || '' },
  { k: 'titulo', l: 'Título', w: 240, cls: 't', v: b => b.titulo || '' },
  { k: 'subtitulo', l: 'Subtítulo', w: 180, v: b => b.subtitulo || '' },
  { k: 'autores', l: 'Autor(es)', w: 190, v: b => (b.autores || []).join('; '), s: b => surname((b.autores || [])[0]) },
  { k: 'editora', l: 'Editora', w: 140, v: b => b.editora || '' },
  { k: 'ano', l: 'Ano', w: 64, cls: 'n', v: b => b.ano || '', num: true },
  { k: 'edicao', l: 'Edição', w: 80, v: b => b.edicao || '' },
  { k: 'isbn', l: 'ISBN', w: 130, cls: 'mono', v: b => b.isbn || '' },
  { k: 'idioma', l: 'Idioma', w: 100, v: b => b.idioma || '' },
  { k: 'paginas', l: 'Págs.', w: 64, cls: 'n', v: b => b.paginas || '', num: true },
  { k: 'classe', l: 'Classe CDU', w: 190, v: b => b.classe ? `${b.classe} ${CDU[b.classe] || ''}` : '' },
  { k: 'cdu', l: 'Notação CDU', w: 120, cls: 'mono', v: b => b.cdu || '' },
  { k: 'assuntos', l: 'Assuntos', w: 200, v: b => (b.assuntos || []).join(', ') },
  { k: 'localizacao', l: 'Localização', w: 150, v: b => b.localizacao || '' },
  { k: 'ex', l: 'Exempl.', w: 70, cls: 'n', v: b => avail(b).ex, num: true },
  { k: 'out', l: 'Empr.', w: 64, cls: 'n', v: b => avail(b).out, num: true },
  { k: 'free', l: 'Disp.', w: 60, cls: 'n', v: b => avail(b).free, num: true },
  { k: 'prev', l: 'Devolução', w: 104, v: b => fmtDate(nextReturn(b)), s: b => nextReturn(b) || '~' },
  { k: 'criado', l: 'Registado', w: 100, v: b => fmtDate(b.criadoEm), s: b => b.criadoEm || '' }
];
S.sheetSort = null;
S.colW = {};
try { S.colW = JSON.parse(store.get('iam-colw') || '{}') || {}; } catch {}

function renderSheet(list) {
  const el = $('#list');
  let rows = list;
  if (S.sheetSort) {
    const c = SHEET_COLS.find(x => x.k === S.sheetSort.k);
    const key = c.s || c.v;
    const dir = S.sheetSort.dir === 'desc' ? -1 : 1;
    rows = list.slice().sort((a, b) => {
      const x = key(a), y = key(b);
      if (c.num) return ((Number(x) || 0) - (Number(y) || 0)) * dir;
      return cmpPt(x, y) * dir;
    });
  }
  const w = c => S.colW[c.k] || c.w;
  const arrow = c => S.sheetSort && S.sheetSort.k === c.k ? (S.sheetSort.dir === 'asc' ? '▲' : '▼') : '';
  const t = today();
  let ex = 0, out = 0;
  rows.forEach(b => { const a = avail(b); ex += a.ex; out += a.out; });
  el.innerHTML = `<div class="sheetwrap"><table class="xl">
    <colgroup><col style="width:44px">${SHEET_COLS.map(c => `<col data-k="${c.k}" style="width:${w(c)}px">`).join('')}</colgroup>
    <thead><tr><th class="rn" scope="col"></th>${SHEET_COLS.map(c => `<th scope="col" class="${c.k === 'cota' ? 'c-cota' : ''}"><button type="button" class="sh" data-k="${c.k}">${c.l}<span class="arr">${arrow(c)}</span></button><span class="grip" data-k="${c.k}" aria-hidden="true"></span></th>`).join('')}</tr></thead>
    <tbody>${rows.map((b, i) => `<tr data-id="${esc(b.id)}" tabindex="0"><td class="rn">${i + 1}</td>${SHEET_COLS.map(c => {
      const v = c.v(b);
      let cls = c.cls || '';
      if (c.k === 'free' && v === 0) cls += ' zero';
      if (c.k === 'prev' && nextReturn(b) && nextReturn(b) < t) cls += ' late';
      return `<td class="${cls}" title="${esc(v)}">${esc(v)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="xl-status"><span><b>${rows.length}</b> ${rows.length === 1 ? 'linha' : 'linhas'}</span><span>Soma de exemplares <b>${ex}</b></span><span>Emprestados <b>${out}</b></span><span>Disponíveis <b>${ex - out}</b></span><span>Clique num título para abrir a ficha; arraste a margem de uma coluna para a alargar.</span></div>`;
}
function sheetSortBy(k) {
  const s = S.sheetSort;
  if (!s || s.k !== k) S.sheetSort = { k, dir: 'asc' };
  else if (s.dir === 'asc') S.sheetSort = { k, dir: 'desc' };
  else S.sheetSort = null;
  render();
}
function startResize(e, grip) {
  e.preventDefault(); e.stopPropagation();
  const k = grip.dataset.k;
  const col = document.querySelector(`.xl col[data-k="${k}"]`);
  const startX = e.clientX, startW = col.getBoundingClientRect().width || parseInt(col.style.width, 10);
  grip.classList.add('on');
  grip.setPointerCapture?.(e.pointerId);
  const move = ev => { const nw = Math.max(48, Math.round(startW + ev.clientX - startX)); col.style.width = nw + 'px'; S.colW[k] = nw; };
  const up = () => {
    grip.classList.remove('on');
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
    store.set('iam-colw', JSON.stringify(S.colW));
  };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
}

/* ---------- form ---------- */
const FIELDS = [
  ['titulo', 'Título', 'text', 'full'],
  ['subtitulo', 'Subtítulo', 'text', 'full'],
  ['autores', 'Autor(es)', 'text', 'full', 'Vários autores separados por ;'],
  ['editora', 'Editora', 'text'],
  ['ano', 'Ano', 'number'],
  ['edicao', 'Edição', 'text'],
  ['isbn', 'ISBN', 'mono'],
  ['idioma', 'Idioma', 'text'],
  ['paginas', 'Páginas', 'number'],
  ['classe', 'Classe CDU', 'select'],
  ['cdu', 'Notação CDU', 'mono'],
  ['cota', 'Cota', 'mono', '', 'Gerada a partir da CDU e do autor'],
  ['localizacao', 'Localização', 'text', '', 'Ex.: Estante B, prateleira 3'],
  ['exemplares', 'Exemplares', 'number'],
  ['assuntos', 'Assuntos', 'text', 'full', 'Separados por vírgulas'],
  ['sinopse', 'Sinopse', 'textarea', 'full'],
  ['notas', 'Notas internas', 'textarea', 'full']
];
function formHTML(pfx) {
  const locs = [...new Set(S.books.map(b => b.localizacao).filter(Boolean))];
  return `<datalist id="${pfx}-locs">${locs.map(l => `<option value="${esc(l)}">`).join('')}</datalist>` + FIELDS.map(([k, label, type, cls, hint]) => {
    const id = `${pfx}-${k}`;
    let input;
    if (type === 'textarea') input = `<textarea id="${id}" name="${k}" rows="${k === 'sinopse' ? 3 : 2}"></textarea>`;
    else if (type === 'select') input = `<select id="${id}" name="${k}"><option value="">—</option>${Object.entries(CDU).map(([c, n]) => `<option value="${c}">${c} · ${esc(n)}</option>`).join('')}</select>`;
    else if (type === 'number') input = `<input id="${id}" name="${k}" type="number" inputmode="numeric" min="${k === 'exemplares' ? 1 : 0}">`;
    else input = `<input id="${id}" name="${k}" type="text" ${type === 'mono' ? 'class="mono"' : ''} ${k === 'localizacao' ? `list="${pfx}-locs"` : ''} autocomplete="off">`;
    return `<div class="f ${cls || ''}" data-k="${k}"><label for="${id}">${label}<span class="flag"></span></label>${input}${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  }).join('');
}
function setForm(form, b, onlyUntouched = false) {
  FIELDS.forEach(([k]) => {
    const wrap = form.querySelector(`[data-k="${k}"]`);
    if (onlyUntouched && wrap.dataset.touched) return;
    const el = form.elements[k];
    let v = b[k];
    const vazio = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (onlyUntouched && vazio && el.value && k !== 'cota') return;
    if (k === 'autores') v = (v || []).join('; ');
    else if (k === 'assuntos') v = (v || []).join(', ');
    if (k === 'cota' && !v) v = makeCota({ ...readForm(form), ...b });
    el.value = v ?? '';
  });
  if (!form.elements.exemplares.value) form.elements.exemplares.value = 1;
  form.dataset.cotaAuto = b.cota && b.cota !== makeCota(b) ? '' : '1';
  checkIsbn(form);
}
function readForm(form) {
  const v = k => form.elements[k].value.trim();
  const num = k => { const n = parseInt(v(k), 10); return Number.isFinite(n) ? n : null; };
  return {
    titulo: v('titulo'), subtitulo: v('subtitulo'),
    autores: v('autores').split(';').map(s => s.trim()).filter(Boolean),
    editora: v('editora'), ano: num('ano'), edicao: v('edicao'),
    isbn: isbnClean(v('isbn')), idioma: v('idioma'), paginas: num('paginas'),
    classe: v('classe'), cdu: v('cdu'), cota: v('cota'), localizacao: v('localizacao'),
    exemplares: Math.max(1, num('exemplares') || 1),
    assuntos: v('assuntos').split(/[,;]/).map(s => s.trim()).filter(Boolean),
    sinopse: v('sinopse'), notas: v('notas')
  };
}
function markUnsure(form, keys) {
  form.querySelectorAll('.f').forEach(w => {
    const on = keys.includes(w.dataset.k) && !w.dataset.touched;
    w.classList.toggle('unsure', on);
    w.querySelector('.flag').innerHTML = on ? '<span class="tag warn">confirmar</span>' : '';
  });
  checkIsbn(form);
}
function checkIsbn(form) {
  const w = form.querySelector('[data-k="isbn"]');
  if (w.classList.contains('unsure')) return;
  const st = isbnState(form.elements.isbn.value);
  w.querySelector('.flag').innerHTML = st === 'bad' ? '<span class="tag bad">ISBN inválido</span>' : '';
}
function wireForm(form) {
  form.addEventListener('submit', e => e.preventDefault());
  form.addEventListener('input', e => {
    const w = e.target.closest('.f'); if (!w) return;
    w.dataset.touched = '1';
    w.classList.remove('unsure');
    w.querySelector('.flag').innerHTML = '';
    const k = w.dataset.k;
    if (k === 'cota') form.dataset.cotaAuto = form.elements.cota.value.trim() ? '' : '1';
    if (['autores', 'classe', 'cdu', 'titulo'].includes(k) && form.dataset.cotaAuto) form.elements.cota.value = makeCota(readForm(form));
    if (k === 'isbn') checkIsbn(form);
  });
}

/* ---------- images ---------- */
async function shrink(file, max = 1400) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode')); i.src = URL.createObjectURL(file); });
  }
  const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.85));
}
const blobToB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
async function uploadCover(blob) {
  const r = await api('POST', 'capas', blob, { raw: true, type: 'image/jpeg' });
  return r.capa;
}

/* ---------- catalogue lookups ---------- */
function showAiNote() {
  const n = $('#ai-note');
  if (!S.ia || S.iaOff) {
    n.hidden = false;
    n.textContent = 'A ficha preenche-se pelo código de barras (ao vivo ou numa fotografia da contracapa) ou pelo ISBN, com a classe CDU quando o livro está na PORBASE. Fotografias da capa, sem código de barras, ficam só como capa.';
    $('#photo-hint').textContent = 'Fotografe a contracapa, com o código de barras: a ficha preenche-se sozinha.';
  } else {
    n.hidden = true;
    $('#photo-hint').textContent = 'Contracapa com código de barras, ou a capa de livros sem código. Pode escolher várias.';
  }
}
// Se o servidor não encontrar, o próprio telemóvel/computador pergunta ao Google Books e ao Open Library
// (estes catálogos às vezes recusam pedidos vindos do servidor, mas aceitam os do navegador).
async function lookupIsbnNavegador(isbn) {
  const tempo = () => (AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined);
  const [gb, ol] = await Promise.all([
    fetch('https://www.googleapis.com/books/v1/volumes?q=isbn:' + isbn, { signal: tempo() }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('https://openlibrary.org/api/books?bibkeys=ISBN:' + isbn + '&format=json&jscmd=data', { signal: tempo() }).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  const v = gb?.items?.[0]?.volumeInfo, o = ol?.['ISBN:' + isbn];
  if (!v && !o) return null;
  const IDI = { pt: 'Português', en: 'Inglês', fr: 'Francês', es: 'Espanhol', it: 'Italiano', de: 'Alemão', la: 'Latim' };
  const d = {
    titulo: v?.title || o?.title || '', subtitulo: v?.subtitle || o?.subtitle || '',
    autores: v?.authors || (o?.authors || []).map(a => a.name).filter(Boolean),
    editora: v?.publisher || o?.publishers?.[0]?.name || '',
    ano: parseInt(String(v?.publishedDate || o?.publish_date || '').match(/\d{4}/)?.[0] || '', 10) || null,
    paginas: v?.pageCount || o?.number_of_pages || null,
    idioma: IDI[String(v?.language || '').slice(0, 2)] || '',
    sinopse: String(v?.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
    categorias: v?.categories || [], assuntosOL: (o?.subjects || []).slice(0, 10).map(x => x.name)
  };
  let capa = v?.imageLinks?.thumbnail || v?.imageLinks?.smallThumbnail || o?.cover?.large || o?.cover?.medium || null;
  if (capa) capa = capa.replace(/^http:/, 'https:').replace('&edge=curl', '').replace('zoom=1', 'zoom=2');
  return { encontrado: true, dados: d, capaUrl: capa, fontes: [v && 'Google Books', o && 'Open Library'].filter(Boolean) };
}
async function lookupIsbn(isbn) {
  let r = await api('GET', 'isbn/' + isbn);
  if (!r.encontrado) {
    const nav = await lookupIsbnNavegador(isbn).catch(() => null);
    if (nav) r = nav;
  }
  if (!r.encontrado) { lookupIsbn.ultimoDiag = r.diagnostico || {}; return null; }
  const d = r.dados || {};
  return {
    dados: {
      titulo: d.titulo || '', subtitulo: d.subtitulo || '', autores: d.autores || [], editora: d.editora || '',
      ano: d.ano || '', paginas: d.paginas || '', edicao: d.edicao || '', idioma: d.idioma || '', isbn,
      classe: CDU[d.classe] ? d.classe : '', cdu: d.cdu || '', assuntos: d.assuntos || [], sinopse: d.sinopse || ''
    },
    extra: { categorias: d.categorias || [], assuntos: d.assuntosOL || [] },
    capaUrl: r.capaUrl || null,
    fontes: r.fontes || []
  };
}
function fromAi(r) {
  return {
    titulo: r.titulo || '', subtitulo: r.subtitulo || '',
    autores: Array.isArray(r.autores) ? r.autores.map(String).filter(Boolean) : (r.autores ? [String(r.autores)] : []),
    editora: r.editora || '', ano: Number(r.ano) || '', edicao: r.edicao || '',
    isbn: isbnClean(r.isbn), idioma: r.idioma || '', paginas: Number(r.paginas) || '',
    classe: CDU[String(r.classe ?? '').trim()] ? String(r.classe).trim() : '', cdu: r.cdu ? String(r.cdu) : '',
    assuntos: Array.isArray(r.assuntos) ? r.assuntos.map(String) : [], sinopse: r.sinopse || ''
  };
}
function aiErr(e) {
  if (e?.codigo === 'sem_ia') { S.iaOff = true; showAiNote(); }
  return errMsg(e);
}

/* ---------- código de barras numa fotografia ---------- */
async function barcodeFromImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { try { bmp = await createImageBitmap(file); } catch { return null; } }
  if ('BarcodeDetector' in window) {
    try {
      const r = await new BarcodeDetector({ formats: ['ean_13', 'upc_a', 'ean_8'] }).detect(bmp);
      if (r[0]?.rawValue) return r[0].rawValue;
    } catch {}
  }
  if (!window.ZXingBrowser) return null;
  const reader = new ZXingBrowser.BrowserMultiFormatOneDReader(new Map([[3, true]])); // 3 = TRY_HARDER
  for (const max of [1600, 1000, 2400]) {
    for (const rot of [0, 90]) {
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      const c = document.createElement('canvas');
      c.width = rot ? h : w; c.height = rot ? w : h;
      const g = c.getContext('2d');
      if (rot) { g.translate(h, 0); g.rotate(Math.PI / 2); }
      g.drawImage(bmp, 0, 0, w, h);
      try { const res = reader.decodeFromCanvas(c); if (res) return res.getText(); } catch {}
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return null;
}
const isIsbnCode = code => (/^97[89]\d{10}$/.test(code) || code.length === 10) && isbnState(code) === 'ok';
// Se a fotografia tiver o código de barras de um ISBN, a ficha passa a ser preenchida por ele
async function tryPhotoBarcode(d, file) {
  if (d.isbnDone) return false;
  d.status = 'reading'; d.stage = 'A procurar o código de barras na fotografia…'; setStatus(d);
  const code = isbnClean(await barcodeFromImage(file).catch(() => null) || '');
  if (!isIsbnCode(code)) return false;
  if (drafts.some(x => x !== d && x.isbn === code)) { toast('Esse livro já está na lista para registar.'); }
  const dup = S.books.find(b => isbnClean(b.isbn) === code);
  if (dup) toast(`Atenção: «${dup.titulo}» já está no catálogo.`);
  d.isbn = code;
  d.form.elements.isbn.value = code; checkIsbn(d.form);
  return true;
}

/* ---------- drafts ---------- */
const drafts = [];
let pumping = false;
const ICON_SPIN = '<span class="spin" aria-hidden="true"></span>';

function addDraft({ file = null, isbn = null } = {}) {
  const d = { id: uid(), file, isbn, blob: null, extra: [], capaUrl: null, status: 'queued', dup: null };
  drafts.push(d);
  const art = document.createElement('article');
  art.className = 'draft';
  art.id = 'draft-' + d.id;
  art.innerHTML = `
    <div class="draft-media">
      <div class="cover">${phHTML({ titulo: isbn ? 'ISBN ' + isbn : file ? '' : 'Sem fotografia' })}</div>
      <div class="thumbs"></div>
      <label class="btn small ghost foto-btn" title="Tirar uma fotografia à capa do livro"><span>Fotografar capa</span><input type="file" accept="image/*" hidden></label>
    </div>
    <div class="draft-body">
      <p class="status" aria-live="polite"></p>
      <div class="dup" hidden></div>
      <form class="fields" novalidate>${formHTML('d' + d.id)}</form>
      <div class="draft-actions">
        <button type="button" class="btn ghost small" data-act="discard">Descartar</button>
        <button type="button" class="btn small" data-act="reread" hidden>Ler de novo</button>
        <button type="button" class="btn primary small" data-act="save">Guardar no catálogo</button>
      </div>
    </div>`;
  $('#drafts').prepend(art);
  d.el = art;
  d.form = art.querySelector('form');
  wireForm(d.form);
  setForm(d.form, { exemplares: 1, idioma: 'Português', isbn: isbn || '' });
  art.querySelector('[data-act="discard"]').onclick = () => removeDraft(d);
  art.querySelector('[data-act="save"]').onclick = () => saveDraft(d);
  art.querySelector('[data-act="reread"]').onclick = () => { d.isbnDone = false; d.status = 'queued'; setStatus(d); pump(); };
  const more = art.querySelector('input[type=file]');
  more.onchange = async () => {
    const files = [...more.files]; more.value = '';
    let added = false, achou = false;
    for (const f of files) {
      try {
        if (!achou && await tryPhotoBarcode(d, f)) { achou = true; d.isbnDone = false; addThumb(d, await shrink(f, 400)); continue; }
        const b = await shrink(f);
        if (!d.blob) { d.blob = b; setCoverPreview(d, b); } else { d.extra.push(b); addThumb(d, b); }
        added = true;
      } catch { toast('Não foi possível abrir essa imagem (use JPG ou PNG).'); }
    }
    if (achou || (added && S.ia && !S.iaOff)) { d.status = 'queued'; setStatus(d); pump(); }
    else if (d.status === 'reading') { d.status = 'ready'; setStatus(d, 'Não encontrei código de barras nessa fotografia.', 'err'); }
  };
  if (file) {
    shrink(file).then(async b => {
      if (await tryPhotoBarcode(d, file)) {
        // era a contracapa: a capa vem do catálogo; a foto fica como miniatura
        addThumb(d, b);
        art.querySelector('.cover').innerHTML = phHTML({ titulo: 'ISBN ' + d.isbn });
        d.status = 'queued'; setStatus(d); pump();
        return;
      }
      d.blob = b; setCoverPreview(d, b);
      if (S.ia && !S.iaOff) { d.status = 'queued'; setStatus(d); pump(); }
      else { d.status = 'ready'; setStatus(d, 'Não encontrei código de barras nesta fotografia. Tire outra fotografia à contracapa, com o código de barras, ou preencha a ficha à mão.', 'err'); }
    }).catch(() => {
      d.status = 'ready'; d.blob = null;
      art.querySelector('.cover').innerHTML = phHTML({ titulo: 'Imagem ilegível' });
      setStatus(d, 'Não foi possível abrir esta imagem (use JPG ou PNG). Preencha a ficha à mão.', 'err');
    });
    setStatus(d);
  } else if (isbn) {
    setStatus(d); pump();
  } else { d.status = 'ready'; setStatus(d, 'Preencha a ficha. Só o título é obrigatório.'); }
  updateSaveAll();
  return d;
}
function setCoverPreview(d, blob) {
  const cov = d.el.querySelector('.cover');
  cov.querySelector('img')?.remove();
  const img = document.createElement('img'); img.alt = ''; img.src = URL.createObjectURL(blob);
  cov.append(img);
  d.el.querySelector('.foto-btn span').textContent = 'Trocar capa';
}
// Sem fotografia da capa, a capa provisória mostra o título e o autor da ficha
function refreshPlaceholder(d) {
  const cov = d.el.querySelector('.cover');
  if (cov.querySelector('img')) return;
  const f = readForm(d.form);
  cov.innerHTML = phHTML({ titulo: f.titulo || (d.isbn ? 'ISBN ' + d.isbn : 'Sem título'), autores: f.autores });
}
function setCoverUrlPreview(d, url) {
  const cov = d.el.querySelector('.cover');
  if (d.blob) return;
  cov.querySelector('img')?.remove();
  const img = document.createElement('img'); img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = url;
  img.onerror = () => { img.remove(); d.capaUrl = null; };
  cov.append(img);
}
function addThumb(d, blob) {
  const t = document.createElement('img'); t.alt = ''; t.src = URL.createObjectURL(blob);
  d.el.querySelector('.thumbs').append(t);
}
function setStatus(d, msg, kind) {
  const p = d.el.querySelector('.status');
  d.el.classList.toggle('reading', d.status === 'reading');
  d.el.querySelector('[data-act="reread"]').hidden = !(kind === 'err' && (d.blob || d.isbn));
  d.el.querySelector('[data-act="save"]').disabled = d.status === 'reading' || d.status === 'saving';
  p.className = 'status' + (kind ? ' ' + kind : '');
  if (d.status === 'queued') p.innerHTML = ICON_SPIN + 'Na fila…';
  else if (d.status === 'reading') p.innerHTML = ICON_SPIN + (d.stage || 'A ler…');
  else if (d.status === 'saving') p.innerHTML = ICON_SPIN + 'A guardar…';
  else p.textContent = msg || '';
  updateSaveAll();
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const d = drafts.find(x => x.status === 'queued' && (x.blob || x.isbn));
      if (!d) break;
      await readDraft(d);
    }
  } finally { pumping = false; }
}
function fillDraft(d, data, unsure = []) {
  const keep = { localizacao: d.form.elements.localizacao.value, exemplares: d.form.elements.exemplares.value || 1, notas: d.form.elements.notas.value };
  setForm(d.form, { ...data, ...keep }, true);
  markUnsure(d.form, unsure);
  refreshPlaceholder(d);
}
async function readDraft(d) {
  d.status = 'reading';
  let found = null, msgs = [];
  try {
    // 1) ISBN: catálogos públicos (grátis)
    const isbn = d.isbn || isbnClean(d.form.elements.isbn.value);
    if (isbn && isbnState(isbn) === 'ok' && !d.isbnDone) {
      d.stage = 'A procurar o ISBN nos catálogos…'; setStatus(d);
      found = await lookupIsbn(isbn).catch(() => null);
      d.isbnDone = true;
      if (found) {
        fillDraft(d, found.dados);
        if (found.capaUrl && !d.blob) { d.capaUrl = found.capaUrl; setCoverUrlPreview(d, found.capaUrl); }
        msgs.push('Encontrado em ' + found.fontes.join(', ') + (found.dados.cdu ? ', com a CDU da PORBASE' : ''));
      } else {
        const dg = lookupIsbn.ultimoDiag || {};
        const falhas = Object.entries(dg).filter(([, v]) => v !== 'sem registo').map(([k, v]) => `${k}: ${v}`);
        msgs.push('O livro com o ISBN ' + isbn + ' não está nos catálogos públicos' + (S.papel === 'gestao' && falhas.length ? ' (' + falhas.join('; ') + ')' : ''));
      }
    }
    // 2) Claude: lê a fotografia e/ou classifica (CDU, assuntos e sinopse em português)
    if (S.ia && !S.iaOff && (d.blob || found)) {
      d.stage = d.blob ? 'O Claude está a ler a capa…' : 'O Claude está a classificar pela CDU…'; setStatus(d);
      const imagens = [];
      for (const b of [d.blob, ...d.extra].filter(Boolean)) imagens.push(await blobToB64(b));
      const pista = found ? { ...found.dados, ...found.extra } : (isbn ? { isbn } : null);
      try {
        const r = await api('POST', 'catalogar', { imagens, pista });
        if (r && r.livro === false && !found) {
          d.status = 'ready'; setStatus(d, 'Não parece ser a capa de um livro. Confirme a fotografia ou preencha à mão.', 'err'); return;
        }
        const data = fromAi(r || {});
        if (found) { // os dados do catálogo mandam no que é factual; o Claude completa
          // (a CDU da PORBASE foi atribuída por bibliotecários: prevalece sobre a sugestão do Claude)
          for (const k of ['titulo', 'subtitulo', 'editora', 'ano', 'paginas', 'edicao', 'classe', 'cdu']) if (found.dados[k]) delete data[k];
          if (found.dados.autores?.length) delete data.autores;
          if (found.dados.assuntos?.length) delete data.assuntos;
        }
        const unsure = Array.isArray(r?.incertos) ? r.incertos.map(String) : [];
        if (data.isbn && isbnState(data.isbn) === 'bad') unsure.push('isbn');
        fillDraft(d, data, unsure);
        msgs.push(d.blob ? 'capa lida pelo Claude' : 'classificado pelo Claude');
        // se o Claude leu um ISBN na foto e ainda não fomos ao catálogo, vamos
        if (!found && data.isbn && isbnState(data.isbn) === 'ok' && !d.isbnDone) {
          d.isbn = data.isbn;
          const f2 = await lookupIsbn(data.isbn).catch(() => null);
          d.isbnDone = true;
          if (f2) {
            const keepAi = { classe: data.classe, cdu: data.cdu, assuntos: data.assuntos, sinopse: data.sinopse };
            fillDraft(d, { ...f2.dados, ...Object.fromEntries(Object.entries(keepAi).filter(([, v]) => v && (!Array.isArray(v) || v.length))) }, unsure);
            msgs.push('confirmado em ' + f2.fontes.join(', '));
          }
        }
      } catch (e) {
        if (!found) { d.status = 'ready'; setStatus(d, aiErr(e), 'err'); return; }
        msgs.push('sem classificação automática (' + aiErr(e).replace(/\.$/, '') + ')');
      }
    }
    d.status = 'ready';
    const unsureN = d.form.querySelectorAll('.f.unsure').length;
    if (!found && !d.blob && !(S.ia && !S.iaOff)) setStatus(d, msgs.join('; ') + '. Preencha à mão o título, o autor e a editora; o ISBN já está.', 'err');
    else {
      const semClasse = !d.form.elements.classe.value ? ' Falta escolher a classe CDU.' : '';
      setStatus(d, (msgs.join('; ') || 'Ficha preenchida') + (unsureN ? '. Confirme os campos assinalados.' : '. Reveja e guarde.') + semClasse, found || d.blob ? 'ok' : '');
    }
  } catch (e) {
    d.status = 'ready'; setStatus(d, errMsg(e), 'err');
  }
}
function removeDraft(d) {
  const i = drafts.indexOf(d); if (i >= 0) drafts.splice(i, 1);
  d.el.remove(); updateSaveAll();
}
function updateSaveAll() {
  const n = drafts.filter(d => d.status === 'ready').length;
  const b = $('#btn-save-all');
  b.disabled = n < 2;
  b.textContent = n >= 2 ? `Guardar todos (${n})` : 'Guardar todos';
}
function findDup(b) {
  const isbn = b.isbn;
  const t = norm(b.titulo), a = norm((b.autores || [])[0]);
  return S.books.find(x => (isbn && isbnClean(x.isbn) === isbn) || (t && norm(x.titulo) === t && norm((x.autores || [])[0]) === a));
}
async function saveDraft(d, { force = false } = {}) {
  const data = readForm(d.form);
  if (!data.titulo) { setStatus(d, 'Falta o título.', 'err'); d.form.elements.titulo.focus(); return false; }
  if (!data.cota) data.cota = makeCota(data);
  if (!force) { const dup = findDup(data); if (dup) { showDup(d, dup); return false; } }
  d.status = 'saving'; setStatus(d);
  try {
    let capa = null;
    try {
      if (d.blob) capa = await uploadCover(d.blob);
      else if (d.capaUrl) capa = (await api('POST', 'capas/importar', { url: d.capaUrl })).capa;
    } catch { toast('A capa não foi guardada; o livro fica registado sem imagem.'); }
    const book = await api('POST', 'livros', { ...data, capa, emprestimos: [], criadoPor: S.nome });
    upsertLocal(book);
    toast(`«${data.titulo}» registado com a cota ${data.cota}.`);
    removeDraft(d);
    return true;
  } catch (e) {
    d.status = 'ready'; setStatus(d, errMsg(e), 'err'); return false;
  }
}
function showDup(d, dup) {
  const box = d.el.querySelector('.dup');
  const ex = avail(dup).ex;
  box.hidden = false;
  box.innerHTML = `<span>Já existe <b>${esc(dup.titulo)}</b>${dup.cota ? ` (cota <span style="font-family:var(--f-mono)">${esc(dup.cota)}</span>)` : ''} com ${ex} ${ex === 1 ? 'exemplar' : 'exemplares'}.</span>
    <div class="row"><button type="button" class="btn small primary" data-dup="copy">Somar mais um exemplar</button><button type="button" class="btn small" data-dup="new">É outra edição, registar à parte</button></div>`;
  box.querySelector('[data-dup="copy"]').onclick = async () => {
    try {
      const book = await api('PATCH', 'livros/' + dup.id, { exemplares: ex + 1 });
      upsertLocal(book);
      toast(`«${dup.titulo}» passa a ter ${ex + 1} exemplares.`);
      removeDraft(d);
    } catch (e) { toast(errMsg(e)); }
  };
  box.querySelector('[data-dup="new"]').onclick = () => { box.hidden = true; saveDraft(d, { force: true }); };
}
async function saveAll() {
  const ready = drafts.filter(d => d.status === 'ready').slice().reverse();
  let ok = 0;
  for (const d of ready) { if (await saveDraft(d)) ok++; }
  const left = drafts.length;
  if (left) toast(`${ok} ${ok === 1 ? 'livro registado' : 'livros registados'}. ${left} ${left === 1 ? 'ficha precisa' : 'fichas precisam'} de atenção.`);
  else if (ok) toast(`${ok} ${ok === 1 ? 'livro registado' : 'livros registados'}.`);
}
function takeFiles(files) {
  const imgs = [...files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name));
  if (!imgs.length) { toast('Escolha fotografias (JPG ou PNG).'); return; }
  imgs.forEach(f => addDraft({ file: f }));
}
function addIsbn(raw) {
  const isbn = isbnClean(raw);
  if (isbnState(isbn) !== 'ok') { toast('Esse ISBN não é válido. Confirme os algarismos.'); return false; }
  if (drafts.some(d => d.isbn === isbn)) { toast('Esse livro já está na lista para registar.'); return false; }
  const dup = S.books.find(b => isbnClean(b.isbn) === isbn);
  if (dup) toast(`Atenção: «${dup.titulo}» já está no catálogo.`);
  addDraft({ isbn });
  return true;
}

/* ---------- barcode scanner ---------- */
const scan = { on: false, stream: null, controls: null, last: '', lastAt: 0, n: 0 };
async function openScanner() {
  const ov = $('#scan'), video = $('#scan-video'), msg = $('#scan-msg');
  scan.n = 0;
  ov.hidden = false; msg.textContent = 'Aponte ao código de barras da contracapa';
  scan.on = true;
  try {
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats?.() || []).includes('ean_13')) {
      scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
      video.srcObject = scan.stream; await video.play();
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
      const loop = async () => {
        if (!scan.on) return;
        try { const r = await det.detect(video); if (r[0]) onCode(r[0].rawValue); } catch {}
        setTimeout(loop, 180);
      };
      loop();
    } else if (window.ZXingBrowser) {
      const reader = new ZXingBrowser.BrowserMultiFormatOneDReader(new Map([[3, true]])); // 3 = TRY_HARDER
      scan.controls = await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, res => { if (res) onCode(res.getText()); });
    } else throw new Error('sem leitor');
  } catch (e) {
    closeScanner();
    toast(e?.name === 'NotAllowedError' ? 'O navegador não deu acesso à câmara. Use «Fotografar» e tire uma fotografia à contracapa, ou permita a câmara para este site.' : 'Não foi possível abrir a câmara aqui. Use «Fotografar» e tire uma fotografia à contracapa: o código de barras é lido na fotografia.');
  }
}
function onCode(raw) {
  const code = isbnClean(raw);
  const now = Date.now();
  if (code === scan.last && now - scan.lastAt < 4000) return;
  scan.last = code; scan.lastAt = now;
  const msg = $('#scan-msg'), frame = $('#scan-frame');
  if (!/^97[89]\d{10}$/.test(code) && !(code.length === 10 && isbnState(code) === 'ok')) { msg.textContent = 'Esse código não é um ISBN. Procure o código que começa por 978.'; return; }
  if (addIsbn(code)) {
    scan.n++;
    navigator.vibrate?.(80);
    frame.classList.add('hit'); setTimeout(() => frame.classList.remove('hit'), 500);
    msg.textContent = `${scan.n} ${scan.n === 1 ? 'livro lido' : 'livros lidos'}. Pode ler o seguinte.`;
  }
}
function closeScanner() {
  scan.on = false;
  try { scan.controls?.stop(); } catch {}
  scan.controls = null;
  scan.stream?.getTracks().forEach(t => t.stop());
  scan.stream = null;
  $('#scan-video').srcObject = null;
  $('#scan').hidden = true;
}

/* ---------- book sheet ---------- */
function openOverlay(id) { $(id).hidden = false; document.body.classList.add('locked'); }
function closeOverlay(id) {
  $(id).hidden = true;
  if ($('#ov-add').hidden && $('#ov-book').hidden) document.body.classList.remove('locked');
  if (id === '#ov-book') { S.open = null; S.editing = false; }
}
function openBook(id) { S.open = id; S.editing = false; renderBook(); openOverlay('#ov-book'); $('#book-body').scrollTop = 0; }
function curBook() { return S.books.find(b => b.id === S.open); }

async function patchBook(id, patch, okMsg) {
  try {
    const book = await api('PATCH', 'livros/' + id, patch);
    upsertLocal(book);
    if (okMsg) toast(okMsg);
    if (S.open === id && !S.editing) renderBook();
    return book;
  } catch (e) {
    toast(errMsg(e));
    if (e.status === 404) { S.books = S.books.filter(b => b.id !== id); render(); closeOverlay('#ov-book'); }
    return null;
  }
}
function renderBook() {
  const b = curBook();
  if (!b) { closeOverlay('#ov-book'); return; }
  const body = $('#book-body'), foot = $('#book-foot');
  $('#book-title').textContent = S.editing ? 'Editar ficha' : 'Ficha';
  if (S.editing) { renderEdit(b); return; }
  const a = avail(b);
  const row = (k, v, mono) => v || v === 0 ? `<dt>${k}</dt><dd${mono ? ' class="mono"' : ''}>${esc(v)}</dd>` : '';
  body.innerHTML = `
    <div class="ficha">
      ${coverHTML(b, false)}
      <div>
        ${b.classe ? `<p class="cls">${esc(b.classe)} · ${esc(CDU[b.classe] || '')}</p>` : ''}
        <h3>${esc(b.titulo || 'Sem título')}</h3>
        ${b.subtitulo ? `<p class="sub">${esc(b.subtitulo)}</p>` : ''}
        ${(b.autores || []).length ? `<p class="by">${esc(b.autores.join('; '))}</p>` : ''}
        <dl class="card">
          ${row('Cota', b.cota, true)}
          ${row('Localização', b.localizacao)}
          ${row('Editora', b.editora)}
          ${row('Ano', b.ano)}
          ${row('Edição', b.edicao)}
          ${row('ISBN', b.isbn, true)}
          ${row('CDU', b.cdu, true)}
          ${row('Idioma', b.idioma)}
          ${row('Páginas', b.paginas)}
          ${row('Exemplares', a.ex)}
        </dl>
      </div>
    </div>
    ${(b.assuntos || []).length ? `<div class="block"><h4>Assuntos</h4><div class="tags">${b.assuntos.map(t => `<span>${esc(t)}</span>`).join('')}</div></div>` : ''}
    ${b.sinopse ? `<div class="block"><h4>Sinopse</h4><p class="prose">${esc(b.sinopse)}</p></div>` : ''}
    <div class="block">
      <h4>Empréstimos</h4>
      <p class="meta-line">${a.free === a.ex ? (a.ex === 1 ? 'Disponível na estante.' : `Os ${a.ex} exemplares estão na estante.`) : a.free === 0 ? 'Nenhum exemplar disponível.' : `${a.free} de ${a.ex} exemplares disponíveis.`}</p>
      <div class="loans">${a.loans.map(l => {
        const late = l.prevista && l.prevista < today();
        return `<div class="loan ${late ? 'late' : ''}"><div><div class="who">${esc(l.pessoa)}</div><div class="when">Desde ${fmtDate(l.desde)} · ${late ? 'devolução em atraso desde' : 'devolver até'} ${fmtDate(l.prevista)}</div></div><button type="button" class="btn small" data-return="${esc(l.id)}">Registar devolução</button></div>`;
      }).join('')}</div>
      ${a.free > 0 ? `
      <form class="lendform" id="lendform" novalidate>
        <div class="f"><label for="lend-who">Emprestar a</label><input id="lend-who" type="text" placeholder="Nome de quem leva" autocomplete="off"></div>
        <div class="f"><label for="lend-until">Devolver até</label><input id="lend-until" type="date" value="${plusDays(LOAN_DAYS)}"></div>
        <button type="submit" class="btn primary">Emprestar</button>
      </form>` : ''}
    </div>
    ${b.notas ? `<div class="block"><h4>Notas internas</h4><p class="prose">${esc(b.notas)}</p></div>` : ''}
    <p class="meta-line">Registado${b.criadoPor ? ' por ' + esc(b.criadoPor) : ''} em ${fmtDate(b.criadoEm)}${b.atualizadoEm && b.atualizadoEm.slice(0, 10) !== (b.criadoEm || '').slice(0, 10) ? ` · atualizado em ${fmtDate(b.atualizadoEm)}` : ''}</p>`;
  foot.innerHTML = `
    ${S.papel === 'gestao' ? `<div class="confirm" id="del-zone"><button type="button" class="btn ghost danger small" id="btn-del">Eliminar</button></div>` : '<span></span>'}
    <button type="button" class="btn" id="btn-edit">Editar ficha</button>`;
  const lf = $('#lendform');
  if (lf) lf.onsubmit = async e => {
    e.preventDefault();
    const who = $('#lend-who').value.trim(), until = $('#lend-until').value;
    if (!who) { $('#lend-who').focus(); toast('Indique a quem empresta.'); return; }
    const loans = [...a.loans, { id: uid(), pessoa: who, desde: today(), prevista: until || plusDays(LOAN_DAYS) }];
    await patchBook(b.id, { emprestimos: loans }, `Emprestado a ${who}.`);
  };
  body.querySelectorAll('[data-return]').forEach(btn => btn.onclick = () =>
    patchBook(b.id, { emprestimos: a.loans.filter(l => l.id !== btn.dataset.return) }, 'Devolução registada.'));
  $('#btn-edit').onclick = () => { S.editing = true; renderBook(); };
  const del = $('#btn-del');
  if (del) del.onclick = () => {
    $('#del-zone').innerHTML = `<span>Eliminar este registo?</span><button type="button" class="btn small danger" id="del-yes">Sim, eliminar</button><button type="button" class="btn small ghost" id="del-no">Cancelar</button>`;
    $('#del-no').onclick = renderBook;
    $('#del-yes').onclick = async () => {
      try {
        await api('DELETE', 'livros/' + b.id);
        S.books = S.books.filter(x => x.id !== b.id);
        render();
        toast(`«${b.titulo}» eliminado.`);
        closeOverlay('#ov-book');
      } catch (err) { toast(errMsg(err)); }
    };
  };
}
function renderEdit(b) {
  const body = $('#book-body'), foot = $('#book-foot');
  let newCover = null;
  body.innerHTML = `
    <div class="draft" style="background:transparent;border:0;padding:0">
      <div class="draft-media">
        <div class="cover" id="edit-cover">${coverInner(b, false)}</div>
        <label class="btn small ghost">Trocar capa<input type="file" id="edit-file" accept="image/*" hidden></label>
      </div>
      <form class="fields" id="edit-form" novalidate>${formHTML('e')}</form>
    </div>`;
  const form = $('#edit-form');
  wireForm(form);
  setForm(form, b);
  $('#edit-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      newCover = await shrink(f);
      $('#edit-cover').innerHTML = `<img alt="" src="${URL.createObjectURL(newCover)}">`;
    } catch { toast('Não foi possível abrir essa imagem.'); }
  };
  foot.innerHTML = `<button type="button" class="btn ghost" id="edit-cancel">Cancelar</button><button type="button" class="btn primary" id="edit-save">Guardar alterações</button>`;
  $('#edit-cancel').onclick = () => { S.editing = false; renderBook(); };
  $('#edit-save').onclick = async () => {
    const data = readForm(form);
    if (!data.titulo) { toast('Falta o título.'); form.elements.titulo.focus(); return; }
    if (!data.cota) data.cota = makeCota(data);
    if (data.exemplares < (b.emprestimos || []).length) { toast('Há mais livros emprestados do que exemplares. Registe as devoluções primeiro.'); return; }
    const btn = $('#edit-save'); btn.disabled = true; btn.textContent = 'A guardar…';
    const patch = { ...data };
    if (newCover) { try { patch.capa = await uploadCover(newCover); } catch { toast('A nova capa não foi guardada.'); } }
    S.editing = false;
    const ok = await patchBook(b.id, patch, 'Ficha atualizada.');
    if (!ok) { S.editing = true; btn.disabled = false; btn.textContent = 'Guardar alterações'; }
  };
}

/* ---------- Excel ---------- */
function exportXlsx() {
  if (!window.XLSX) { toast('O módulo do Excel ainda não carregou. Tente daqui a um segundo.'); return; }
  const list = filtered().slice().sort((a, b) => cmpPt(a.cota || '~', b.cota || '~') || cmpPt(a.titulo || '', b.titulo || ''));
  const head = ['Cota', 'Título', 'Subtítulo', 'Autor(es)', 'Editora', 'Ano', 'Edição', 'ISBN', 'Idioma', 'Páginas', 'Classe CDU', 'Notação CDU', 'Assuntos', 'Localização', 'Exemplares', 'Emprestados', 'Disponíveis', 'Emprestado a', 'Devolução prevista', 'Registado em', 'Registado por', 'Notas'];
  const rows = list.map(b => {
    const a = avail(b);
    return [b.cota || '', b.titulo || '', b.subtitulo || '', (b.autores || []).join('; '), b.editora || '', b.ano ? String(b.ano) : '', b.edicao || '',
      b.isbn || '', b.idioma || '', b.paginas || '', b.classe ? `${b.classe} ${CDU[b.classe] || ''}` : '', b.cdu || '', (b.assuntos || []).join(', '),
      b.localizacao || '', a.ex, a.out, a.free, a.loans.map(l => l.pessoa).join('; '), fmtDate(nextReturn(b)), fmtDate(b.criadoEm), b.criadoPor || '', b.notas || ''];
  });
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
  ws['!cols'] = [12, 40, 28, 28, 22, 6, 12, 16, 12, 8, 28, 16, 32, 20, 10, 11, 11, 24, 16, 13, 18, 30].map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: `A1:V${rows.length + 1}` };
  for (let r = 1; r <= rows.length; r++) for (const c of ['A', 'F', 'H', 'L']) { const cell = ws[c + (r + 1)]; if (cell) cell.t = 's'; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Catálogo');
  XLSX.writeFile(wb, `Biblioteca IAM ${today()}.xlsx`);
}

/* ---------- login ---------- */
function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false;
  $('#login-name').value = S.nome;
  setTimeout(() => $('#login-code').focus(), 50);
}
async function enterApp() {
  const s = await api('GET', 'sessao');
  S.papel = s.papel; S.ia = !!s.ia;
  $('#login').hidden = true; $('#app').hidden = false;
  renderWho();
  render();
  await loadBooks();
}
function renderWho() {
  $('#who').innerHTML = `${S.nome ? `Neste aparelho: <b>${esc(S.nome)}</b>` : 'Sem nome neste aparelho'}${S.papel === 'gestao' ? ' · acesso de gestão' : ''} · <button type="button" id="btn-name">Mudar nome</button>${S.papel === 'gestao' ? ' · <button type="button" id="btn-import">Importar livros</button><input type="file" id="import-in" accept="application/json,.json" hidden>' : ''} · <button type="button" id="btn-logout">Sair</button>`;
  const bi = $('#btn-import');
  if (bi) {
    bi.onclick = () => $('#import-in').click();
    $('#import-in').onchange = async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const livros = Array.isArray(data) ? data : data.livros;
        if (!Array.isArray(livros) || !livros.length) { toast('O ficheiro não tem livros para importar.'); return; }
        toast(`A importar ${livros.length} livros…`);
        const r = await api('POST', 'importar', { livros });
        await loadBooks();
        toast(`${r.importados} ${r.importados === 1 ? 'livro importado' : 'livros importados'}.`);
      } catch (ex) { toast(ex instanceof SyntaxError ? 'Esse ficheiro não é um ficheiro de importação válido.' : errMsg(ex)); }
    };
  }
  $('#btn-name').onclick = () => {
    const box = $('#who');
    box.innerHTML = `<input id="name-in" type="text" value="${esc(S.nome)}" placeholder="O seu nome" style="border:1px solid var(--line);border-radius:6px;padding:6px 8px;background:var(--surface)"> <button type="button" id="name-ok">Guardar</button>`;
    $('#name-in').focus();
    $('#name-ok').onclick = () => { S.nome = $('#name-in').value.trim(); store.set('iam-nome', S.nome); renderWho(); };
  };
  $('#btn-logout').onclick = async () => { try { await api('POST', 'sair', {}); } catch {} S.books = []; S.ready = false; showLogin(); };
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const code = $('#login-code').value.trim(), err = $('#login-err'), btn = $('#login-btn');
  if (!code) { $('#login-code').focus(); return; }
  btn.disabled = true; err.hidden = true;
  try {
    await api('POST', 'entrar', { codigo: code });
    S.nome = $('#login-name').value.trim(); store.set('iam-nome', S.nome);
    $('#login-code').value = '';
    await enterApp();
  } catch (ex) {
    err.textContent = ex.codigo === 'codigo_errado' ? 'Código errado. Confirme com a responsável da biblioteca.' : errMsg(ex);
    err.hidden = false;
  } finally { btn.disabled = false; }
});

/* ---------- events ---------- */
$('#q').addEventListener('input', e => { S.q = e.target.value; render(); });
$('#f-estado').onchange = e => { S.estado = e.target.value; render(); };
$('#f-sort').onchange = e => { S.sort = e.target.value; store.set('iam-sort', S.sort); render(); };
function setView(v) {
  S.view = v;
  ['grid', 'list', 'sheet'].forEach(x => $('#v-' + x).setAttribute('aria-pressed', v === x));
  $('#f-sort').hidden = v === 'sheet';
  store.set('iam-view', v);
  render();
}
$('#v-grid').onclick = () => setView('grid');
$('#v-list').onclick = () => setView('list');
$('#v-sheet').onclick = () => setView('sheet');
$('#chips').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; S.classe = c.dataset.c; render(); };
$('#list').addEventListener('pointerdown', e => { const g = e.target.closest('.grip'); if (g) startResize(e, g); });
$('#list').addEventListener('click', e => {
  if (e.target.closest('.grip')) return;
  const sh = e.target.closest('.sh'); if (sh) { sheetSortBy(sh.dataset.k); return; }
  if (e.target.closest('#btn-clear')) { S.q = ''; $('#q').value = ''; S.classe = 'all'; S.estado = 'all'; $('#f-estado').value = 'all'; render(); return; }
  const it = e.target.closest('[data-id]'); if (it) openBook(it.dataset.id);
});
$('#list').addEventListener('keydown', e => { if (e.key === 'Enter') { const r = e.target.closest('tr[data-id]'); if (r) openBook(r.dataset.id); } });
$('#btn-add').onclick = () => { showAiNote(); openOverlay('#ov-add'); };
$('#btn-export').onclick = exportXlsx;
$('#btn-manual').onclick = () => { const d = addDraft(); d.form.elements.titulo.focus(); };
$('#btn-save-all').onclick = saveAll;
$('#btn-scan').onclick = openScanner;
$('#scan-close').onclick = closeScanner;
$('#isbn-form').addEventListener('submit', e => { e.preventDefault(); if (addIsbn($('#isbn-in').value)) $('#isbn-in').value = ''; });
$('#file-in').onchange = e => { takeFiles(e.target.files); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) takeFiles(e.dataTransfer.files); });
document.addEventListener('paste', e => {
  if ($('#ov-add').hidden) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); takeFiles(files); }
});
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeOverlay('#' + b.closest('.overlay').id));
document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeOverlay('#' + o.id); }));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#scan').hidden) closeScanner();
  else if (!$('#ov-book').hidden) closeOverlay('#ov-book');
  else if (!$('#ov-add').hidden) closeOverlay('#ov-add');
});
// manter o catálogo em dia quando outra pessoa regista livros
setInterval(() => { if (S.ready && document.visibilityState === 'visible' && !$('#app').hidden) loadBooks().catch(() => {}); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.ready) loadBooks().catch(() => {}); });

/* ---------- boot ---------- */
(function boot() {
  const s = store.get('iam-sort'); if (s) { S.sort = s; $('#f-sort').value = s; }
  const v = store.get('iam-view'); if (v === 'list' || v === 'sheet') setView(v);
  enterApp().catch(e => { if (e.status !== 401) { showLogin(); const err = $('#login-err'); err.textContent = errMsg(e); err.hidden = false; } });
})();
