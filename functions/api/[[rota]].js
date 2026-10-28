// Biblioteca IAM — API (Cloudflare Pages Functions)
//
// Ligações (Definições do projeto no Cloudflare → Bindings):
//   DB     → base de dados D1 "biblioteca-iam"
//   CAPAS  → bucket R2 "biblioteca-iam-capas"
// Variáveis e segredos (Definições → Variables and Secrets):
//   CODIGO_EQUIPA      código de acesso da equipa (consultar, registar, emprestar)
//   CODIGO_GESTAO      código de gestão (também elimina livros e importa)
//   SEGREDO            texto longo aleatório, para assinar as sessões
//   ANTHROPIC_API_KEY  (opcional) chave da API do Claude, para ler capas por fotografia
//   MODELO             (opcional) modelo do Claude; por omissão claude-sonnet-5-5

const CAMPOS = ['titulo', 'subtitulo', 'autores', 'editora', 'ano', 'edicao', 'isbn', 'idioma', 'paginas',
  'classe', 'cdu', 'cota', 'localizacao', 'exemplares', 'assuntos', 'sinopse', 'notas', 'capa',
  'emprestimos', 'criadoPor', 'criadoEm', 'atualizadoEm'];
const CDU = {
  '0': 'Generalidades', '1': 'Filosofia e Psicologia', '2': 'Religião', '3': 'Ciências Sociais',
  '5': 'Ciências Exatas e Naturais', '6': 'Ciências Aplicadas', '7': 'Artes e Desporto',
  '8': 'Língua e Literatura', '9': 'História, Geografia e Biografia'
};
const SESSAO_DIAS = 180;
const CAPA_HOSTS = ['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org', 'archive.org'];

/* ---------- utilitários ---------- */
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const erro = (status, codigo, mensagem) => json({ erro: codigo, mensagem }, status);
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlTexto = s => b64url(enc.encode(s));
const deB64url = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));

async function hmac(segredo, texto) {
  const k = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(texto)));
}
function igual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function cookie(req, nome) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]+)'));
  return m ? m[1] : null;
}
async function lerSessao(req, env) {
  const c = cookie(req, 'biblioteca');
  if (!c || !env.SEGREDO) return null;
  const [corpo, assinatura] = c.split('.');
  if (!corpo || !assinatura || !igual(await hmac(env.SEGREDO, corpo), assinatura)) return null;
  try {
    const s = JSON.parse(deB64url(corpo));
    if (!s.exp || s.exp < Date.now()) return null;
    return s;
  } catch { return null; }
}
async function novaSessao(env, papel) {
  const corpo = b64urlTexto(JSON.stringify({ papel, exp: Date.now() + SESSAO_DIAS * 864e5 }));
  return `biblioteca=${corpo}.${await hmac(env.SEGREDO, corpo)}; Path=/; Max-Age=${SESSAO_DIAS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

let tabelaPronta = false;
async function prepararDB(env) {
  if (tabelaPronta) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS livros (id TEXT PRIMARY KEY, dados TEXT NOT NULL, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL)').run();
  tabelaPronta = true;
}

const texto = (v, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : (v == null ? '' : String(v).trim().slice(0, max));
const lista = (v, max = 30) => (Array.isArray(v) ? v : (typeof v === 'string' && v ? v.split(/[;,]/) : [])).map(x => texto(x, 200)).filter(Boolean).slice(0, max);
const inteiro = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };

function limpar(d, parcial = false) {
  const o = {};
  const tem = k => Object.prototype.hasOwnProperty.call(d, k);
  for (const k of CAMPOS) {
    if (parcial && !tem(k)) continue;
    const v = d[k];
    switch (k) {
      case 'autores': o[k] = lista(v, 20); break;
      case 'assuntos': o[k] = lista(v, 12); break;
      case 'ano': case 'paginas': o[k] = inteiro(v); break;
      case 'exemplares': o[k] = Math.max(1, inteiro(v) || 1); break;
      case 'classe': o[k] = CDU[texto(v)] ? texto(v) : ''; break;
      case 'isbn': o[k] = texto(v, 20).replace(/[^0-9Xx]/g, '').toUpperCase(); break;
      case 'sinopse': o[k] = texto(v, 3000); break;
      case 'notas': o[k] = texto(v, 3000); break;
      case 'capa': o[k] = /^[a-z0-9-]{8,80}\.(jpg|png|webp)$/.test(texto(v)) ? texto(v) : null; break;
      case 'emprestimos':
        o[k] = (Array.isArray(v) ? v : []).slice(0, 200).map(l => ({
          id: texto(l?.id, 40) || crypto.randomUUID().slice(0, 8),
          pessoa: texto(l?.pessoa, 120),
          desde: /^\d{4}-\d{2}-\d{2}$/.test(l?.desde) ? l.desde : '',
          prevista: /^\d{4}-\d{2}-\d{2}$/.test(l?.prevista) ? l.prevista : ''
        })).filter(l => l.pessoa);
        break;
      case 'criadoEm': case 'atualizadoEm': o[k] = texto(v, 40); break;
      default: o[k] = texto(v, 400);
    }
  }
  return o;
}

/* ---------- catálogos públicos por ISBN ---------- */
const IDIOMAS = {
  por: 'Português', pt: 'Português', eng: 'Inglês', en: 'Inglês', fre: 'Francês', fra: 'Francês', fr: 'Francês',
  spa: 'Espanhol', es: 'Espanhol', ita: 'Italiano', it: 'Italiano', ger: 'Alemão', deu: 'Alemão', de: 'Alemão',
  lat: 'Latim', la: 'Latim', grc: 'Grego antigo', gre: 'Grego', el: 'Grego', cat: 'Catalão', ca: 'Catalão'
};
const idiomaPt = c => IDIOMAS[String(c || '').toLowerCase()] || '';

function isbn13para10(isbn) {
  if (!/^978\d{10}$/.test(isbn)) return null;
  const core = isbn.slice(3, 12);
  const sum = [...core].reduce((a, c, i) => a + Number(c) * (10 - i), 0);
  const chk = (11 - (sum % 11)) % 11;
  return core + (chk === 10 ? 'X' : String(chk));
}
function isbn10para13(isbn) {
  if (!/^\d{9}[\dX]$/.test(isbn)) return null;
  const core = '978' + isbn.slice(0, 9);
  const sum = [...core].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  return core + String((10 - (sum % 10)) % 10);
}
const desXml = s => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
// Limpa marcas de catalogação: carateres de "não ordenar" (<O >mito, ?O ?gene, controlos) e pontuação final ISBD
const limparMarc = s => desXml(s).replace(/[\u0080-\u009f]/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').replace(/\s*[\/:;,=]\s*$/, '').trim();

// Lê um registo UNIMARC em MarcXchange (sem DOMParser, que não existe nos Workers)
function lerMarcxchange(xml) {
  const registos = [];
  for (const m of xml.matchAll(/<(?:\w+:)?record\b[^>]*>([\s\S]*?)<\/(?:\w+:)?record>/g)) {
    const campos = {};
    for (const f of m[1].matchAll(/<(?:\w+:)?datafield\b[^>]*\btag="(\d{3})"[^>]*>([\s\S]*?)<\/(?:\w+:)?datafield>/g)) {
      const sub = {};
      for (const sf of f[2].matchAll(/<(?:\w+:)?subfield\b[^>]*\bcode="(.)"[^>]*>([\s\S]*?)<\/(?:\w+:)?subfield>/g)) (sub[sf[1]] ||= []).push(limparMarc(sf[2]));
      (campos[f[1]] ||= []).push(sub);
    }
    registos.push(campos);
  }
  return registos;
}
function porbaseParaDados(c) {
  const um = (tag, code) => c[tag]?.find(x => x[code]?.[0])?.[code]?.[0] || '';
  const d = {};
  d.titulo = um('200', 'a');
  d.subtitulo = um('200', 'e');
  const nomes = [];
  for (const tag of ['700', '701', '710', '711']) for (const x of c[tag] || []) {
    const apelido = x.a?.[0] || '', nome = x.b?.[0] || '';
    const n = (nome ? nome + ' ' : '') + apelido;
    if (n.trim()) nomes.push(n.replace(/,\s*$/, '').trim());
  }
  d.autores = nomes;
  d.editora = um('210', 'c') || um('214', 'c');
  d.ano = parseInt((um('210', 'd') || um('214', 'd')).match(/\d{4}/)?.[0] || '', 10) || null;
  const ext = um('215', 'a');
  const pags = [...ext.matchAll(/(\d+)\s*p\b/g)].map(x => +x[1]);
  d.paginas = pags.length ? Math.max(...pags) : null;
  d.edicao = um('205', 'a');
  d.idioma = idiomaPt(um('101', 'a'));
  const cdus = (c['675'] || []).map(x => x.a?.[0] || '').filter(v => /^\d/.test(v));
  d.cdu = cdus[0] || '';
  d.classe = CDU[d.cdu.charAt(0)] ? d.cdu.charAt(0) : '';
  d.assuntos = [...new Set((c['606'] || []).map(x => (x.a?.[0] || '').toLowerCase()).filter(Boolean))].slice(0, 6);
  d.sinopse = um('330', 'a');
  return d;
}
async function procurarPorbase(isbn) {
  const tentar = async id => {
    try {
      const r = await fetch(`https://urn.porbase.org/isbn/unimarc/marcxchange?id=${id}`, { cf: { cacheTtl: 86400 } });
      if (!r.ok) return null;
      const xml = await r.text();
      if (!/<(?:\w+:)?record\b/.test(xml)) return null; // não encontrado: vem 200 com um <error>
      const regs = lerMarcxchange(xml).filter(c => c['200']);
      if (!regs.length) return null;
      // vários registos (várias bibliotecas): prefere o que tem CDU, depois o mais completo
      regs.sort((a, b) => (!!b['675'] - !!a['675']) || (Object.keys(b).length - Object.keys(a).length));
      const d = porbaseParaDados(regs[0]);
      if (!d.cdu) { // CDU de outro registo do mesmo ISBN, se houver
        const outro = regs.find(c => c['675']);
        if (outro) { const o = porbaseParaDados(outro); d.cdu = o.cdu; d.classe = o.classe; }
      }
      return d;
    } catch { return null; }
  };
  return (await tentar(isbn)) || (isbn.length === 13 ? await tentar(isbn13para10(isbn)) : await tentar(isbn10para13(isbn)));
}

async function procurarIsbn(isbn, env) {
  const out = { encontrado: false, dados: {}, capaUrl: null, fontes: [] };
  const [pb, gb, ol] = await Promise.all([
    procurarPorbase(isbn),
    fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${env.GOOGLE_BOOKS_KEY ? '&key=' + env.GOOGLE_BOOKS_KEY : ''}`, { cf: { cacheTtl: 86400 } }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, { cf: { cacheTtl: 86400 } }).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  const d = out.dados;
  const juntar = (k, v) => { if ((d[k] === undefined || d[k] === null || d[k] === '' || (Array.isArray(d[k]) && !d[k].length)) && v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) d[k] = v; };

  // 1) PORBASE (Biblioteca Nacional e bibliotecas portuguesas): manda nos dados bibliográficos e traz a CDU
  if (pb) {
    out.encontrado = true; out.fontes.push('PORBASE');
    for (const [k, v] of Object.entries(pb)) juntar(k, v);
  }
  // 2) Google Books: completa e traz capa e sinopse
  const v = gb?.items?.[0]?.volumeInfo;
  if (v) {
    out.encontrado = true; out.fontes.push('Google Books');
    juntar('titulo', v.title); juntar('subtitulo', v.subtitle); juntar('autores', v.authors);
    juntar('editora', v.publisher); juntar('ano', parseInt(String(v.publishedDate || '').slice(0, 4), 10) || null);
    juntar('paginas', v.pageCount || null); juntar('idioma', idiomaPt(v.language));
    juntar('sinopse', (v.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500));
    d.categorias = v.categories || [];
    const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail;
    if (img) out.capaUrl = img.replace(/^http:/, 'https:').replace('&edge=curl', '').replace('zoom=1', 'zoom=2');
  }
  // 3) Open Library: último recurso e capas
  const o = ol?.[`ISBN:${isbn}`];
  if (o) {
    out.encontrado = true; out.fontes.push('Open Library');
    juntar('titulo', o.title); juntar('subtitulo', o.subtitle);
    juntar('autores', (o.authors || []).map(a => a.name).filter(Boolean));
    juntar('editora', (o.publishers || [])[0]?.name); juntar('ano', parseInt(String(o.publish_date || '').match(/\d{4}/)?.[0] || '', 10) || null);
    juntar('paginas', o.number_of_pages || null);
    d.assuntosOL = (o.subjects || []).slice(0, 10).map(s => s.name);
    if (!out.capaUrl) out.capaUrl = o.cover?.large || o.cover?.medium || null;
  }
  d.isbn = isbn;
  return out;
}

/* ---------- leitura por Claude ---------- */
function promptCatalogar(nImgs, pista) {
  const linhas = [
    'És bibliotecário e estás a catalogar um livro que acabou de chegar à biblioteca do Instituto Alberto Magno (IAM), em Portugal.'
  ];
  if (nImgs > 1) linhas.push(`Recebes ${nImgs} fotografias do mesmo livro: a primeira é a capa; as outras podem ser a contracapa, a lombada ou a página de rosto.`);
  else if (nImgs === 1) linhas.push('Recebes uma fotografia da capa do livro.');
  if (pista) linhas.push('Dados encontrados num catálogo público pelo ISBN (podem estar incompletos, em inglês ou com categorias genéricas; confirma-os com as imagens se as houver):\n' + JSON.stringify(pista));
  linhas.push(
    nImgs ? 'Lê o texto das imagens. ' : '',
    'Completa com o teu conhecimento bibliográfico (nome completo do autor, editora, ano, sinopse) apenas quando reconheces a obra com segurança.',
    'Nunca inventes um ISBN: preenche-o só se estiver visível numa imagem ou nos dados do catálogo, sem hífenes nem espaços.',
    'Escreve em português de Portugal (a sinopse e os assuntos sempre em português, mesmo que o livro seja de outra língua; o título fica na língua original).',
    'Classifica pela CDU (Classificação Decimal Universal). "classe" é a classe principal, um destes dígitos: 0 Generalidades, 1 Filosofia e Psicologia, 2 Religião, 3 Ciências Sociais, 5 Ciências Exatas e Naturais, 6 Ciências Aplicadas, 7 Artes e Desporto, 8 Língua e Literatura, 9 História, Geografia e Biografia.',
    '"cdu" é a notação mais específica que consigas dar com segurança (por exemplo "821.134.3-31" para um romance português, "37" para educação, "1" para filosofia); se não tiveres certeza, repete só a classe.',
    'Responde apenas com um objeto JSON nesta forma:',
    '{"livro": true, "titulo": "", "subtitulo": "", "autores": ["Nome Apelido"], "editora": "", "ano": 2020, "edicao": "", "isbn": "", "idioma": "Português", "paginas": null, "classe": "8", "cdu": "821.134.3-31", "assuntos": ["romance"], "sinopse": "Duas ou três frases.", "incertos": ["ano"]}',
    'Usa "" ou null quando não souberes. "assuntos" tem 2 a 6 termos curtos em minúsculas. Em "incertos" lista os campos de que não tens certeza.',
    nImgs ? 'Se as imagens não mostrarem um livro, responde {"livro": false}.' : ''
  );
  return linhas.filter(Boolean).join('\n');
}
async function catalogar(env, imagens, pista) {
  const content = [];
  imagens.forEach((b64, i) => {
    if (imagens.length > 1) content.push({ type: 'text', text: `Imagem ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  });
  content.push({ type: 'text', text: promptCatalogar(imagens.length, pista) });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.MODELO || 'claude-sonnet-5-5', max_tokens: 1500, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const e = new Error('anthropic ' + r.status + ' ' + t.slice(0, 300)); e.status = r.status; throw e;
  }
  const res = await r.json();
  const txt = (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('sem_json');
  return JSON.parse(m[0]);
}

/* ---------- router ---------- */
export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const rota = (params.rota || []).join('/');
  const metodo = req.method;

  try {
    if (!env.SEGREDO || !env.CODIGO_EQUIPA) return erro(500, 'configuracao', 'Faltam os segredos SEGREDO e CODIGO_EQUIPA nas definições do projeto no Cloudflare.');

    // entrar / sair / sessão
    if (rota === 'entrar' && metodo === 'POST') {
      const { codigo } = await req.json().catch(() => ({}));
      let papel = null;
      if (env.CODIGO_GESTAO && igual(String(codigo || ''), env.CODIGO_GESTAO)) papel = 'gestao';
      else if (igual(String(codigo || ''), env.CODIGO_EQUIPA)) papel = 'equipa';
      if (!papel) { await new Promise(r => setTimeout(r, 800)); return erro(401, 'codigo_errado', 'Código errado.'); }
      return json({ papel }, 200, { 'set-cookie': await novaSessao(env, papel) });
    }
    if (rota === 'sair' && metodo === 'POST') return json({ ok: true }, 200, { 'set-cookie': 'biblioteca=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });

    const sessao = await lerSessao(req, env);
    if (!sessao) return erro(401, 'sem_sessao', 'Entre com o código de acesso.');
    const gestao = sessao.papel === 'gestao';

    if (rota === 'sessao') return json({ papel: sessao.papel, ia: !!env.ANTHROPIC_API_KEY });

    if (!env.DB) return erro(500, 'configuracao', 'Falta ligar a base de dados D1 (variável DB) nas definições do projeto.');
    await prepararDB(env);

    // livros
    if (rota === 'livros' && metodo === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, dados FROM livros').all();
      return json(results.map(r => ({ id: r.id, ...JSON.parse(r.dados) })));
    }
    if (rota === 'livros' && metodo === 'POST') {
      const d = limpar(await req.json());
      if (!d.titulo) return erro(400, 'sem_titulo', 'Falta o título.');
      const id = crypto.randomUUID();
      const agora = new Date().toISOString();
      d.criadoEm = agora; d.atualizadoEm = agora; d.emprestimos = d.emprestimos || [];
      await env.DB.prepare('INSERT INTO livros (id, dados, criado_em, atualizado_em) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(d), agora, agora).run();
      return json({ id, ...d }, 201);
    }
    const mLivro = rota.match(/^livros\/([0-9a-f-]{36})$/);
    if (mLivro) {
      const id = mLivro[1];
      const atual = await env.DB.prepare('SELECT dados FROM livros WHERE id = ?').bind(id).first();
      if (!atual) return erro(404, 'nao_existe', 'Este livro já não existe no catálogo.');
      const dados = JSON.parse(atual.dados);
      if (metodo === 'PATCH') {
        const p = limpar(await req.json(), true);
        delete p.criadoEm; delete p.criadoPor;
        if ('titulo' in p && !p.titulo) return erro(400, 'sem_titulo', 'Falta o título.');
        const novo = { ...dados, ...p, atualizadoEm: new Date().toISOString() };
        if (p.capa && dados.capa && p.capa !== dados.capa && env.CAPAS) await env.CAPAS.delete(dados.capa).catch(() => {});
        await env.DB.prepare('UPDATE livros SET dados = ?, atualizado_em = ? WHERE id = ?').bind(JSON.stringify(novo), novo.atualizadoEm, id).run();
        return json({ id, ...novo });
      }
      if (metodo === 'DELETE') {
        if (!gestao) return erro(403, 'so_gestao', 'Só quem entra com o código de gestão pode eliminar livros.');
        await env.DB.prepare('DELETE FROM livros WHERE id = ?').bind(id).run();
        if (dados.capa && env.CAPAS) await env.CAPAS.delete(dados.capa).catch(() => {});
        return json({ ok: true });
      }
    }

    // capas
    if (rota === 'capas' && metodo === 'POST') {
      if (!env.CAPAS) return erro(500, 'configuracao', 'Falta ligar o bucket R2 (variável CAPAS) nas definições do projeto.');
      const tipo = (req.headers.get('content-type') || '').split(';')[0];
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[tipo];
      if (!ext) return erro(415, 'tipo', 'A capa tem de ser JPG, PNG ou WebP.');
      const corpo = await req.arrayBuffer();
      if (!corpo.byteLength || corpo.byteLength > 5 * 1024 * 1024) return erro(413, 'tamanho', 'A imagem tem de ter menos de 5 MB.');
      const chave = `${crypto.randomUUID()}.${ext}`;
      await env.CAPAS.put(chave, corpo, { httpMetadata: { contentType: tipo } });
      return json({ capa: chave }, 201);
    }
    if (rota === 'capas/importar' && metodo === 'POST') {
      if (!env.CAPAS) return erro(500, 'configuracao', 'Falta ligar o bucket R2 (variável CAPAS).');
      const { url } = await req.json().catch(() => ({}));
      let u; try { u = new URL(url); } catch { return erro(400, 'url', 'Endereço inválido.'); }
      if (u.protocol !== 'https:' || !CAPA_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return erro(400, 'url', 'Endereço de capa não permitido.');
      const r = await fetch(u.toString(), { redirect: 'follow' });
      const tipo = (r.headers.get('content-type') || '').split(';')[0];
      if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(tipo)) return erro(404, 'sem_capa', 'Não foi possível obter a capa.');
      const corpo = await r.arrayBuffer();
      if (corpo.byteLength < 1500 || corpo.byteLength > 5 * 1024 * 1024) return erro(404, 'sem_capa', 'O catálogo não tem uma capa utilizável.');
      const chave = `${crypto.randomUUID()}.${tipo === 'image/png' ? 'png' : tipo === 'image/webp' ? 'webp' : 'jpg'}`;
      await env.CAPAS.put(chave, corpo, { httpMetadata: { contentType: tipo } });
      return json({ capa: chave }, 201);
    }
    const mCapa = rota.match(/^capas\/([a-z0-9-]{8,80}\.(jpg|png|webp))$/);
    if (mCapa && metodo === 'GET') {
      if (!env.CAPAS) return erro(404, 'sem_capa', '');
      const obj = await env.CAPAS.get(mCapa[1]);
      if (!obj) return new Response('', { status: 404 });
      return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
    }

    // ISBN
    const mIsbn = rota.match(/^isbn\/([0-9Xx]{10,13})$/);
    if (mIsbn && metodo === 'GET') return json(await procurarIsbn(mIsbn[1].toUpperCase(), env));

    // leitura por Claude
    if (rota === 'catalogar' && metodo === 'POST') {
      if (!env.ANTHROPIC_API_KEY) return erro(501, 'sem_ia', 'A leitura automática não está ligada (falta a chave ANTHROPIC_API_KEY).');
      const { imagens = [], pista = null } = await req.json().catch(() => ({}));
      const imgs = (Array.isArray(imagens) ? imagens : []).slice(0, 3).filter(s => typeof s === 'string' && s.length < 7_000_000);
      if (!imgs.length && !pista) return erro(400, 'vazio', 'Envie uma fotografia ou dados de um ISBN.');
      try {
        return json(await catalogar(env, imgs, pista));
      } catch (e) {
        if (e.status === 401 || e.status === 403) return erro(502, 'ia_chave', 'A chave da API do Claude foi recusada. Verifique-a nas definições do projeto.');
        if (e.status === 402 || /credit|billing|balance/i.test(e.message)) return erro(502, 'ia_saldo', 'A conta da API do Claude ficou sem saldo. Carregue saldo na Claude Console.');
        if (e.status === 429 || e.status === 529) return erro(503, 'ia_ocupada', 'O Claude está ocupado. Tente daqui a um minuto.');
        return erro(502, 'ia_falhou', 'A leitura falhou. Tente de novo ou preencha à mão.');
      }
    }

    // importar (gestão)
    if (rota === 'importar' && metodo === 'POST') {
      if (!gestao) return erro(403, 'so_gestao', 'Só quem entra com o código de gestão pode importar.');
      const { livros = [] } = await req.json().catch(() => ({}));
      let n = 0;
      for (const l of livros.slice(0, 2000)) {
        const d = limpar(l);
        if (!d.titulo) continue;
        if (l.capaBase64 && env.CAPAS) {
          const tipo = /^image\/(png|webp)$/.test(l.capaTipo) ? l.capaTipo : 'image/jpeg';
          const chave = `${crypto.randomUUID()}.${tipo === 'image/png' ? 'png' : tipo === 'image/webp' ? 'webp' : 'jpg'}`;
          const bytes = Uint8Array.from(atob(l.capaBase64), c => c.charCodeAt(0));
          await env.CAPAS.put(chave, bytes, { httpMetadata: { contentType: tipo } });
          d.capa = chave;
        }
        const id = crypto.randomUUID();
        const criado = d.criadoEm || new Date().toISOString();
        d.criadoEm = criado; d.atualizadoEm = d.atualizadoEm || criado;
        await env.DB.prepare('INSERT INTO livros (id, dados, criado_em, atualizado_em) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(d), criado, d.atualizadoEm).run();
        n++;
      }
      return json({ importados: n });
    }

    return erro(404, 'rota', 'Pedido desconhecido.');
  } catch (e) {
    return erro(500, 'interno', 'Erro no servidor: ' + (e?.message || e));
  }
}
