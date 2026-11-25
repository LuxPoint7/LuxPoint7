#!/usr/bin/env node
'use strict';
/**
 * LuxPoint7 - Sincronizacion de inventario con los 4 proveedores.
 *
 *   node scripts/sync-proveedores.js            -> sincroniza todo y escribe data/products.json
 *   node scripts/sync-proveedores.js --dry      -> muestra el resumen sin escribir nada
 *   node scripts/sync-proveedores.js --only=orig  (p11 | orig | iphone | tech)
 *   node scripts/sync-proveedores.js --debug    -> guarda el HTML crudo en /tmp para revisar selectores
 *   node scripts/sync-proveedores.js --no-browser -> Casa Phone sin Playwright (solo HTML estatico)
 *
 * SEGURIDAD
 *  - No hay claves, tokens ni correos en este archivo. No se necesita ninguna para leer catalogos publicos.
 *  - Configuracion opcional SOLO por variables de entorno (GitHub Variables/Secrets):
 *      SYNC_USER_AGENT        texto con el que te identificas ante los proveedores
 *      URL_P11, URL_ORIG, URL_IPHONE, URL_TECH   para cambiar la URL de un proveedor sin tocar el codigo
 *  - El COSTO del proveedor nunca se guarda en data/products.json (solo el precio final de LuxPoint7).
 *  - Si un proveedor falla o devuelve muy pocos productos, se CONSERVA el inventario anterior de ese proveedor.
 *  - Todo texto externo se limpia (sin HTML) y la web lo pinta con textContent.
 */
const fs = require('node:fs');
const path = require('node:path');
const { precioP11, precioOriginal, precioIphone, precioTech, rules } = require('./pricing');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'products.json');
const REF_FILE = path.join(__dirname, 'precios-referencia.json');
const UA = process.env.SYNC_USER_AGENT || 'LuxPoint7-Sync/1.0 (+catalogo-sincronizacion)';
const URLS = {
  p11: process.env.URL_P11 || 'https://perfumeriamayorista.co',
  orig: process.env.URL_ORIG || 'https://perfumeriamillennio.com',
  iphone: process.env.URL_IPHONE || 'https://casaphone.co/iphone',
  tech: process.env.URL_TECH || 'https://catalogodtech.com',
};

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const DEBUG = argv.includes('--debug');
const NO_BROWSER = argv.includes('--no-browser') || !!process.env.SYNC_NO_BROWSER;
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

/* ------------------------------ utilidades ------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}
function stripTags(html) {
  return decode(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}
const clean = (s, max = 140) => stripTags(String(s || '')).slice(0, max);
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const copToInt = (s) => parseInt(String(s).trim().replace(/,\d{1,2}$/, '').replace(/[^\d]/g, ''), 10);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'&(-])([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
const okUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

async function http(url, { json = false } = {}) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'es-CO,es;q=0.9', accept: json ? 'application/json' : 'text/html,*/*' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' en ' + url);
      return { text: await r.text(), headers: r.headers };
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
function dump(name, text) {
  if (!DEBUG) return;
  const f = path.join(require('node:os').tmpdir(), `luxpoint7-${name}.html`);
  fs.writeFileSync(f, text);
  console.log(`   [debug] HTML crudo guardado en ${f}`);
}

const BRANDS_ALL = [...rules.marcasConocidas, ...rules.marcasArabes, ...rules.marcasNicho]
  .map((b) => b.toUpperCase()).sort((a, b) => b.length - a.length);
const ARABES = new Set(rules.marcasArabes.map((b) => b.toUpperCase()));
const NICHO = new Set(rules.marcasNicho.map((b) => b.toUpperCase()));
const lineaDeMarca = (brand) => (ARABES.has(brand.toUpperCase()) ? 'arabe' : NICHO.has(brand.toUpperCase()) ? 'nicho' : 'disenador');

function splitBrand(text) {
  const up = text.toUpperCase();
  for (const b of BRANDS_ALL) {
    if (up === b || up.startsWith(b + ' ')) return { brand: titleCase(b), name: text.slice(b.length).trim() || text };
  }
  const tokens = text.split(/\s+/);
  let n = 0;
  while (n < tokens.length - 1 && tokens[n] === tokens[n].toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(tokens[n]) && !/\d/.test(tokens[n])) n++;
  if (n === 0) n = 1;
  return { brand: titleCase(tokens.slice(0, n).join(' ')), name: tokens.slice(n).join(' ') || text };
}

/* ----------------------- 1) Perfumeria 1.1 (100 ml) ---------------------- */
/**
 * perfumeriamayorista.co: sitio propio (no Shopify). Se lee el texto de la pagina.
 * Solo se publican frascos de 100 ml de la Linea 1.1. Se descartan los bloques "Single"
 * (30/50/100 ml a $9.000-$20.000) y cualquier presentacion distinta de 100 ml.
 */
function parseMayorista(html) {
  const t = stripTags(html);
  const SEP = 'PM • MATERIAL PROTEGIDO';
  const markers = [...t.matchAll(/PERFUMER[ÍI]A PARA (HOMBRE|MUJER)|PERFUMER[ÍI]A [ÁA]RABE/gi)].map((m) => ({
    i: m.index, g: /HOMBRE/i.test(m[0]) ? 'hombre' : /MUJER/i.test(m[0]) ? 'mujer' : 'unisex',
  }));
  const map = new Map();
  const parts = t.split(SEP);
  let pos = parts[0].length;
  for (let k = 1; k < parts.length; k++) {
    const at = pos;
    pos += parts[k].length + SEP.length;
    let c = parts[k].trim();
    const agotado = /^AGOTADO\b/.test(c);
    c = c.replace(/^AGOTADO\s+/, '');
    const tot = c.indexOf('Total: $0');
    if (tot < 0) continue;
    const head = c.slice(0, tot);
    const rest = c.slice(tot + 9);
    const headName = head.replace(/\s*(Desde\s*)?\$[\s\S]*$/, '').replace(/\s*\b1\.1\b/g, '').trim();
    const pm = head.match(/\$\s?([\d.,]+)/);
    if (!headName || !pm) continue;
    const gender = ([...markers].reverse().find((m) => m.i <= at) || { g: 'unisex' }).g;
    const { brand, name } = splitBrand(headName);

    const opciones = []; // { etiqueta, costo }
    if (/Desde/i.test(head)) {
      const labels = [...rest.matchAll(/([^$×−+]*?)\$\s?([\d.]+(?:,\d{2})?)\s*×\s?1/g)]
        .map((m) => ({ etiqueta: m[1].replace(/[−+]/g, '').trim(), costo: copToInt(m[2]) }))
        .filter((x) => x.etiqueta && x.costo);
      if (!labels.length) continue;
      if (labels.every((x) => /^\d+\s?ml$/i.test(x.etiqueta))) continue; // bloque "Single": 30/50/100 ml -> fuera
      for (const l of labels) if (/100\s*ML/i.test(l.etiqueta)) opciones.push(l); // solo 100 ml
    } else {
      opciones.push({ etiqueta: '', costo: copToInt(pm[1]) }); // Linea 1.1 sencilla = 100 ml
    }
    for (const o of opciones) {
      if (!o.costo || o.costo < 20000) continue; // descarta precios de "Single"
      const tier = (o.etiqueta.match(/ESTUCHE|CAJA|LUJO|SENCILLA|CILINDRO|LATA|COFRE/i) || [''])[0];
      const full = tier && !new RegExp(tier, 'i').test(name) ? `${name} (${titleCase(tier)})` : name;
      const id = 'p11-' + slug(`${brand} ${full}`);
      const prev = map.get(id);
      const prod = prev || {
        id, cat: 'p11', provider: 'mayorista', name: clean(full), brand: clean(brand, 60), size: '100 ml',
        linea: lineaDeMarca(brand), price: precioP11(o.costo), inStock: !agotado, _g: new Set(),
      };
      prod._g.add(gender);
      map.set(id, prod);
    }
  }
  return [...map.values()].map((p) => {
    const g = [...p._g].filter((x) => x !== 'unisex');
    p.gender = g.length === 1 ? g[0] : 'unisex';
    delete p._g;
    return p;
  });
}
async function syncP11() {
  const { text } = await http(URLS.p11);
  dump('p11', text);
  return parseMayorista(text);
}

/* -------- Fotos para Perfumeria 1.1 (el proveedor solo trae iconos genericos) -------- */
/**
 * Orden de prioridad para cada perfume 1.1 sin foto:
 *   0) cache en disco: si ya existe img/perfumes/<id>.* (> 1 KB) se usa directo, sin peticiones externas
 *   1) scripts/imagenes-manuales.json
 *   3) coincidencia flexible con los productos ya extraidos de perfumeriamillennio.com
 *   (toda foto elegida se DESCARGA a img/perfumes/<id>.<ext> y data/products.json guarda esa ruta local)
 *   4) coincidencia flexible en catalogos publicos: disfragancias.com, perfumesarabescolombia.com (Shopify)
 *      y valmara.co (PrestaShop). De ellos SOLO se copia la URL de la foto: no se guarda precio ni texto.
 * Solo empareja con alta confianza (marca + nombre, sin versiones distintas). No usa claves ni cuentas.
 */
const FOTOS_MANUALES = path.join(__dirname, 'imagenes-manuales.json');
const FOTO_URLS = {
  disfragancias: process.env.URL_FOTOS_DISFRAGANCIAS || 'https://disfragancias.com',
  perfumesarabes: process.env.URL_FOTOS_PERFUMESARABES || 'https://perfumesarabescolombia.com',
  valmara: process.env.URL_FOTOS_VALMARA || 'https://valmara.co',
};
const STOP_FOTO = new Set(('perfume perfumes eau de du la le el parfum parfume toilette extrait edp edt cologne ml oz spray vaporizador caja estuche sencilla lujo cilindro lata cofre ' +
  'para hombre hombres mujer mujeres men women man woman unisex for by pour femme homme dama caballero original 100ml 100 1 11').split(' '));
const DISTINTIVAS = new Set('elixir intense intenso extreme extremo absolu absolute noir sport night nuit rouge prive black gold oud legend ultra max mini set kit combo duo'.split(' '));
const EXCLUIR_FOTO = /\b(tester|decant|muestra|miniatura|travel|set|kit|combo|duo|cofre|estuche|body|crema|splash|mist|shampoo|deo|desodorante)\b/i;
const tokensFoto = (s) => slug(s).split('-').filter(Boolean);
const mlDe = (s) => { const m = slug(s).match(/(?:^|-)(\d{2,3})-?ml(?:-|$)/); return m ? Number(m[1]) : null; };

/** Crea un candidato {t, img, ml, inStock, strict} a partir de un titulo; el titulo se descarta despues. */
function candidatoFoto(titulo, img, extra = {}) {
  const im = okUrl(img);
  if (!im || EXCLUIR_FOTO.test(String(titulo).replace(/[-_]/g, ' '))) return null;
  const ml = mlDe(titulo);
  if (extra.strict && ml && (ml < 90 || ml > 110)) return null; // no usar la foto de un frasco de otro tamano
  return { t: new Set(tokensFoto(titulo)), img: im, ml, inStock: true, ...extra };
}

/** Mejor candidato para un perfume (marca + nombre contenidos, sin versiones distintas). */
function matchFoto(p, cands) {
  const brandT = tokensFoto(p.brand);
  const nameT = tokensFoto(p.name).filter((x) => !brandT.includes(x) && !STOP_FOTO.has(x) && !/^\d+(ml|oz)?$/.test(x));
  if (!nameT.length) return null;
  let best = null;
  for (const c of cands) {
    if (!brandT.every((b) => c.t.has(b))) continue;
    if (!nameT.every((n) => c.t.has(n))) continue;
    const extras = [...c.t].filter((x) => !brandT.includes(x) && !nameT.includes(x) && !STOP_FOTO.has(x) && !/^\d+(ml|oz)?$/.test(x));
    if (extras.some((x) => DISTINTIVAS.has(x)) || extras.length > 1) continue; // otra version del perfume
    const score = 10 - extras.length + (c.ml >= 95 && c.ml <= 105 ? 1 : 0) + (c.inStock ? 0.5 : 0);
    if (!best || score > best.score) best = { score, img: c.img };
  }
  return best ? best.img : null;
}

/* --- lectores de catalogos publicos (solo titulo para emparejar + URL de la foto) --- */
async function fotosShopify(base) {
  const out = [];
  for (let page = 1; page <= 12; page++) {
    const { text } = await http(`${base}/products.json?limit=250&page=${page}`, { json: true });
    const list = JSON.parse(text).products || [];
    if (!list.length) break;
    for (const p of list) {
      const img = (p.images && p.images[0] && p.images[0].src) || (p.image && p.image.src);
      const c = candidatoFoto(`${p.vendor || ''} ${p.title || ''}`, img, { strict: true });
      if (c) out.push(c);
    }
    await sleep(600);
  }
  return out;
}
/** PrestaShop (valmara.co): el nombre del producto viaja en el nombre del archivo de la foto. */
function parseValmaraFotos(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    for (const a of ['data-full-size-image-url', 'data-src', 'src']) {
      const u = (m[0].match(new RegExp(`\\s${a}=["']([^"']+)["']`, 'i')) || [])[1];
      const f = u && u.match(/^(?:https?:)?\/\/cdn\.valmara\.co\/\d+-[a-z_]+\/([a-z0-9-]+)\.(?:webp|jpe?g|png)/i);
      if (!f || seen.has(u)) continue;
      seen.add(u);
      const c = candidatoFoto(f[1], u.startsWith('//') ? 'https:' + u : u.replace(/^http:/, 'https:'), { strict: true });
      if (c) out.push(c);
      break;
    }
  }
  return out;
}
async function fotosValmara(query) {
  const { text } = await http(`${FOTO_URLS.valmara}/index.php?controller=search&s=${encodeURIComponent(query)}`);
  return parseValmaraFotos(text);
}
const FUENTES_FOTOS = {
  disfragancias: { catalogo: () => fotosShopify(FOTO_URLS.disfragancias) },
  perfumesarabes: { catalogo: () => fotosShopify(FOTO_URLS.perfumesarabes) },
  valmara: { busqueda: fotosValmara, maxBusquedas: 150 },
};

/* --- almacenamiento local: las fotos 1.1 se guardan en img/perfumes/<id-limpio>.<ext> --- */
const IMG_DIR = path.join(ROOT, 'img', 'perfumes');
const IMG_REL = 'img/perfumes';
const MIN_BYTES = 1024;            // menos de 1 KB = archivo roto
const MAX_BYTES = 5 * 1024 * 1024; // mas de 5 MB = se descarta
const EXT_POR_TIPO = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
const idLimpio = (id) => slug(String(id).replace(/^p11-/, ''));

/** Si ya hay img/perfumes/<id>.* de mas de 1 KB devuelve su ruta relativa; si no, null. */
function fotoLocal(id) {
  const base = idLimpio(id);
  if (!base) return null;
  let files = [];
  try { files = fs.readdirSync(IMG_DIR); } catch { return null; }
  for (const f of files) {
    const m = f.match(/^(.+)\.(jpg|jpeg|png|webp|avif|gif)$/i);
    if (!m || m[1] !== base) continue;
    try { if (fs.statSync(path.join(IMG_DIR, f)).size > MIN_BYTES) return `${IMG_REL}/${f}`; } catch { /* sigue */ }
  }
  return null;
}

/** Descarga una foto https y la guarda en disco. Devuelve la ruta relativa o null si no es una imagen valida. */
async function descargarFoto(url, id) {
  const base = idLimpio(id);
  if (!base || !okUrl(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const tipo = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_POR_TIPO[tipo] || (tipo === 'application/octet-stream' || !tipo ? (new URL(url).pathname.match(/\.(jpe?g|png|webp|avif|gif)$/i) || [])[1] : null);
    if (!ext) return null; // no es una imagen (o es SVG/HTML)
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) return null;
    fs.mkdirSync(IMG_DIR, { recursive: true });
    const name = `${base}.${ext.toLowerCase().replace('jpeg', 'jpg')}`;
    const tmp = path.join(IMG_DIR, `.${name}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(IMG_DIR, name));
    return `${IMG_REL}/${name}`;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function enriquecerFotosP11(products, previous = [], fuentes = FUENTES_FOTOS, bajar = descargarFoto) {
  let manuales = {};
  try { manuales = JSON.parse(fs.readFileSync(FOTOS_MANUALES, 'utf8')).porId || {}; } catch { /* sin archivo */ }
  const previas = new Map(previous.filter((x) => x.cat === 'p11' && okUrl(x.image)).map((x) => [x.id, x.image])); // fotos externas de corridas viejas
  const stats = { disco: 0, manual: 0, millennio: 0, disfragancias: 0, perfumesarabes: 0, valmara: 0, previa: 0, sinDescarga: 0, sin: 0 };
  const guardar = async (p, url, fuente) => {
    const local = await bajar(url, p.id);
    if (local) { p.image = local; stats[fuente]++; await sleep(250); return true; }
    stats.sinDescarga++;
    return false;
  };
  let pend = [];
  for (const p of products) {
    if (p.cat !== 'p11') continue;
    const local = fotoLocal(p.id); // 1) cache en disco: sin ninguna peticion externa
    if (local) { p.image = local; stats.disco++; continue; }
    p.image = null;
    if (okUrl(manuales[p.id]) && (await guardar(p, manuales[p.id], 'manual'))) continue; // 2) manual
    pend.push(p);
  }
  const asignar = async (cands, fuente) => {
    const resto = [];
    const lista = cands.filter(Boolean);
    for (const p of pend) {
      const url = matchFoto(p, lista);
      if (url && (await guardar(p, url, fuente))) continue;
      resto.push(p);
    }
    pend = resto;
  };
  // 3) Millennio
  await asignar(products.filter((p) => p.cat === 'orig' && p.image && !p.combo).map((p) => ({
    t: new Set(tokensFoto(`${p.brand} ${p.name}`)), img: p.image, ml: mlDe(p.size || ''), inStock: !!p.inStock,
  })), 'millennio');
  // 4) catalogos publicos
  for (const [nombre, f] of Object.entries(fuentes)) {
    if (!pend.length) break;
    try {
      if (f.catalogo) await asignar(await f.catalogo(), nombre);
      else if (f.busqueda) {
        let n = 0, fallos = 0;
        for (const p of [...pend]) {
          if (n >= (f.maxBusquedas || 100) || fallos >= 5) break;
          n++;
          try {
            const c = await f.busqueda(`${p.brand} ${p.name}`.replace(/\([^)]*\)/g, ' ').trim());
            fallos = 0;
            const url = matchFoto(p, c.filter(Boolean));
            if (url && (await guardar(p, url, nombre))) pend = pend.filter((x) => x !== p);
          } catch { fallos++; }
          await sleep(700);
        }
      }
    } catch (e) { console.log(`   (fotos ${nombre}: ${String(e.message).slice(0, 80)})`); }
  }
  // 5) ultimo recurso: la URL externa que ya tenia de una corrida anterior (no se pierde la foto)
  for (const p of pend) if (previas.has(p.id)) { p.image = previas.get(p.id); stats.previa++; }
  stats.sin = pend.filter((p) => !p.image).length;
  return stats;
}

/* ---------------------- 2) Perfumeria Original (Shopify) ------------------ */
function parseMillennio(products) {
  const out = [];
  for (const p of products) {
    const blob = `${p.title} ${p.product_type} ${(p.tags || []).join(' ')}`;
    if (/muestra|decant/i.test(blob)) continue; // fuera muestras / decants
    const brand = titleCase(clean(p.vendor || '', 60));
    const variants = (p.variants || []).filter((v) => {
      const m = `${v.title} ${v.option1 || ''}`.match(/(\d+)\s?ml/i);
      return !m || Number(m[1]) >= 50;
    });
    const tags = (p.tags || []).join(' ').toLowerCase() + ' ' + String(p.title).toLowerCase();
    const gender = /mujer|dama|women|femen|pour femme|\bher\b/.test(tags) ? 'mujer' : /hombre|\bmen\b|masculin|homme|\bhim\b/.test(tags) ? 'hombre' : 'unisex';
    const combo = /estuche|\bset\b|\bkit\b|d[uú]o|combo|cofre|pack/i.test(p.title);
    const img = okUrl((p.images && p.images[0] && p.images[0].src) || '');
    for (const v of variants) {
      const costo = Math.round(parseFloat(v.price));
      if (!costo || costo < 30000) continue;
      const sizeM = `${v.title} ${v.option1 || ''}`.match(/(\d+)\s?ml/i);
      const size = sizeM ? `${sizeM[1]} ml` : '';
      const multi = variants.length > 1 && v.title && v.title !== 'Default Title';
      out.push({
        id: `orig-${p.id}-${v.id}`, cat: 'orig', provider: 'millennio',
        name: clean(p.title.replace(/^(PERFUME|ESTUCHE)\s+/i, '')) + (multi ? ` - ${clean(v.title, 30)}` : ''),
        brand, size, tipo: ARABES.has(brand.toUpperCase()) ? 'arabe' : NICHO.has(brand.toUpperCase()) ? 'nicho' : 'disenador',
        gender, combo, image: img, price: precioOriginal(costo), inStock: !!v.available,
      });
    }
  }
  return out;
}
async function syncOrig() {
  const all = [];
  for (let page = 1; page <= 12; page++) {
    const { text } = await http(`${URLS.orig}/products.json?limit=250&page=${page}`, { json: true });
    const list = JSON.parse(text).products || [];
    if (page === 1) dump('orig', text.slice(0, 200000));
    if (!list.length) break;
    all.push(...list);
    await sleep(600);
  }
  return parseMillennio(all);
}

/* ------------------------- 3) iPhone (Casa Phone) ------------------------- */
/**
 * casaphone.co/iphone/inventario carga el inventario y las fotos con JavaScript. Por eso:
 *   1) Se abre con un navegador real (Playwright, instalado en el workflow), se hace scroll hasta cargar
 *      todas las unidades y se leen las tarjetas del DOM (texto + fotos src/data-src/srcset).
 *   2) Si Playwright no esta disponible, se usa el HTML estatico como plan B (menos completo).
 * Cada unidad (estado, GB, color, bateria, precio, foto) es una "variante" seleccionable en la web.
 */
const UNIT_HREF = /\/iphone\/([a-z0-9-]+)\/([a-z0-9-]+)\/?(?:[?#].*)?$/i;

function pickImg(cands, base) {
  const urls = [];
  for (const c of cands || []) {
    if (!c) continue;
    for (const part of String(c).split(/,\s+(?=\S)/)) {
      const u = part.trim().split(/\s+/)[0];
      if (!u || /^data:/i.test(u)) continue;
      try { urls.push(new URL(decode(u), base).href); } catch { /* url rota */ }
    }
  }
  const good = urls.filter((u) => /^https:\/\//i.test(u) && !/\.svg(\?|$)/i.test(u) && !/logo|icon|sprite|placeholder|img-pl/i.test(u));
  const best = good.find((u) => /\/api\/public\/img\//.test(u)) || good[0];
  return best ? best.replace(/([?&])w=\d+/, '$1w=640') : null;
}

/** records: [{ href, text, imgs[] }] -> productos agrupados por modelo */
function parseCasaCards(records, base) {
  const units = [];
  const seen = new Set();
  for (const r of records) {
    const hm = String(r.href || '').match(UNIT_HREF);
    if (!hm) continue;
    const modelSlug = hm[1].toLowerCase();
    const unitId = hm[2].toLowerCase();
    if (/^\d+(gb|tb)$/.test(unitId) || seen.has(modelSlug + '/' + unitId)) continue; // enlaces de filtro por capacidad
    const text = String(r.text || '').replace(/ /g, ' ');
    const flat = text.replace(/\s+/g, ' ').trim().replace(/(Tarjeta\s*\$?\s?[\d.,]+).*$/i, '$1'); // corta lo que venga despues del precio (unidad vecina)
    const TITLE = /iPhone\s+(.+?)\s+(\d+\s?(?:GB|TB))\s+([^$()]+?)(?=\s+(?:Nuevo|Semi\s?-?Nuevo|Usado|Bat\.?|e-?Sim|Sim\b|Desde|\$|Tarjeta)|\s*$)/i;
    let t = null;
    for (const line of text.split(/\n+/)) { // primero por linea (innerText), luego texto plano
      const l = line.trim();
      if (/^iPhone\s+.+\d\s?(GB|TB)\s+\S/i.test(l)) { t = l.match(TITLE); if (t) break; }
    }
    if (!t) t = flat.match(TITLE);
    if (!t) continue;
    const color = titleCase(clean(t[3], 30));
    if (!color || color.split(' ').length > 3) continue;
    const principal = flat.split(/Tarjeta/i)[0];
    const pm = principal.match(/\$\s?([\d.]{5,})/);
    if (!pm) continue;
    const costo = copToInt(pm[1]);
    if (!costo || costo < 300000) continue;
    const bat = flat.match(/Bat\.?\s*(\d{2,3})\s?%/i);
    const estado = /semi\s?-?nuevo|usado/i.test(flat) ? 'Seminuevo' : /nuevo/i.test(flat) ? 'Nuevo' : bat ? 'Seminuevo' : 'Nuevo';
    seen.add(modelSlug + '/' + unitId);
    units.push({
      modelSlug, unitId, model: 'iPhone ' + clean(t[1], 40),
      gb: t[2].toUpperCase().replace(/\s?(GB|TB)/, ' $1'), color, estado,
      battery: bat ? Number(bat[1]) : null, costo, image: okUrl(pickImg(r.imgs, base)),
    });
  }
  const byModel = new Map();
  for (const u of units) {
    const id = 'iphone-' + u.modelSlug;
    if (!byModel.has(id)) byModel.set(id, { id, cat: 'iphone', provider: 'casaphone', name: u.model, brand: 'Apple', model: u.model, image: null, variants: [], price: 0, inStock: true });
    const p = byModel.get(id);
    if (!p.image && u.image) p.image = u.image;
    p.variants.push({ id: `${id}-${u.unitId}`, gb: u.gb, color: u.color, estado: u.estado, battery: u.battery, price: precioIphone(u.costo), image: u.image, inStock: true });
  }
  return [...byModel.values()].map((p) => {
    p.variants.sort((a, b) => a.price - b.price);
    p.price = p.variants[0].price;
    for (const v of p.variants) if (!v.image || v.image === p.image) delete v.image; // solo se guarda si difiere de la del modelo
    return p;
  });
}

/** Plan B sin navegador: saca tarjetas del HTML estatico (si el sitio las trae renderizadas). */
function casaRecordsFromHtml(html) {
  const recs = [];
  const re = /<a\b[^>]*?href=["']([^"']*\/iphone\/[a-z0-9-]+\/[a-z0-9-]+\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const imgAttrs = (frag) => [...frag.matchAll(/<img\b[^>]*>/gi)].flatMap((m) =>
    ['src', 'data-src', 'data-lazy-src', 'srcset', 'data-srcset'].map((a) => (m[0].match(new RegExp(`\\s${a}=["']([^"']+)["']`, 'i')) || [])[1]).filter(Boolean));
  let m;
  while ((m = re.exec(html))) {
    let block = m[2];
    let imgs = imgAttrs(block);
    if (!/\$\s?\d/.test(stripTags(block))) { // el enlace solo envuelve el titulo: se mira alrededor
      const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 1500);
      const cut = tail.search(/<a\b[^>]*href=["'][^"']*\/iphone\/[a-z0-9-]+\/[a-z0-9-]+/i);
      block += ' ' + (cut > 0 ? tail.slice(0, cut) : tail);
      imgs = imgs.concat(imgAttrs(html.slice(Math.max(0, m.index - 900), m.index)).slice(-3));
    }
    recs.push({ href: m[1], text: decode(block.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, '\n')), imgs });
  }
  return recs;
}
const parseCasaPhone = (html, base = 'https://casaphone.co') => parseCasaCards(casaRecordsFromHtml(html), base);

async function renderCasaPhone(url) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { throw new Error('Playwright no esta instalado'); }
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'es-CO', viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    if (DEBUG) page.on('response', (r) => { if (/json/i.test(r.headers()['content-type'] || '')) console.log(`\n   [debug] JSON ${r.status()} ${r.url().slice(0, 160)}`); });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    const countLinks = () => page.evaluate(() => document.querySelectorAll('a[href*="/iphone/"]').length);
    let last = -1, stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      const more = page.getByRole('button', { name: /ver m[aá]s|cargar m[aá]s|mostrar m[aá]s/i }).first();
      if (await more.count()) { try { await more.click({ timeout: 2000 }); } catch { /* sin boton */ } }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(900);
      const n = await countLinks();
      stable = n === last ? stable + 1 : 0;
      last = n;
    }
    await page.evaluate(async () => { // recorrido lento para que carguen las fotos diferidas
      for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 70)); }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1500);
    if (DEBUG) dump('iphone-render', await page.content());
    return await page.evaluate(() => {
      const re = /\/iphone\/[a-z0-9-]+\/[a-z0-9-]+\/?$/i;
      const path = (a) => new URL(a.href, location.href).pathname.replace(/\/$/, '');
      const isUnit = (a) => re.test(new URL(a.href, location.href).pathname);
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        if (!isUnit(a)) continue;
        let card = a;
        while (card.parentElement && card.parentElement !== document.body) { // sube hasta la tarjeta (1 sola unidad)
          const keys = new Set([...card.parentElement.querySelectorAll('a[href]')].filter(isUnit).map(path));
          if (keys.size > 1) break;
          card = card.parentElement;
        }
        const imgs = [...card.querySelectorAll('img')].flatMap((i) => [i.currentSrc, i.src, i.getAttribute('data-src'), i.getAttribute('srcset'), i.getAttribute('data-srcset')]);
        for (const e of card.querySelectorAll('[style*="url("]')) { const m = (e.getAttribute('style') || '').match(/url\(["']?([^"')]+)/); if (m) imgs.push(m[1]); }
        out.push({ href: a.href, text: card.innerText, imgs: imgs.filter(Boolean) });
      }
      return out;
    });
  } finally {
    await browser.close();
  }
}

const countUnits = (ps) => ps.reduce((n, p) => n + p.variants.length, 0);
async function syncIphone() {
  const base = new URL(URLS.iphone).origin;
  const url = `${base}/iphone/inventario`;
  let best = [];
  if (!NO_BROWSER) {
    try {
      best = parseCasaCards(await renderCasaPhone(url), base);
      console.log(`\n   navegador: ${best.length} modelos / ${countUnits(best)} unidades`);
    } catch (e) { console.log(`\n   (sin navegador: ${String(e.message).split('\n')[0]})`); }
  }
  if (best.length < rules.minimosParaPublicar.iphone) { // plan B: HTML estatico
    const { text } = await http(url);
    dump('iphone', text);
    const alt = parseCasaPhone(text, base);
    console.log(`   html estatico: ${alt.length} modelos / ${countUnits(alt)} unidades`);
    if (countUnits(alt) > countUnits(best)) best = alt;
  }
  return best;
}

/* ---------------------- 4) Innovacion (WooCommerce) ---------------------- */
const SUBCATS = [
  ['carga', /cargador|carga|cable|power ?bank|marrana|adaptador|iniciador/i, 'Carga rápida'],
  ['audifonos', /aud[ií]fon|diadema|airpod|earbud|manos libres/i, 'Audífonos'],
  ['smartwatch', /smart ?watch|reloj|watch|manilla/i, 'Smart Watch'],
  ['gamer', /gamer|gaming|joystick|control|mouse|teclado|consola/i, 'Gamer'],
  ['hogar', /hogar|cocina|licuadora|freidora|l[aá]mpara|termo|aspiradora|ventilador|linea blanca/i, 'Hogar'],
];
function subcategoria(name, cats) {
  const blob = `${cats.map((c) => c.slug + ' ' + c.name).join(' ')} ${name}`;
  for (const [key, rx, label] of SUBCATS) if (rx.test(blob)) return { key, label };
  return { key: 'otros', label: 'Otros' };
}
function parseDtech(products, refs) {
  const out = [];
  for (const p of products) {
    const cats = p.categories || [];
    if (cats.some((c) => rules.tech.categoriasExcluidas.includes(c.slug))) continue;
    const pr = p.prices || {};
    const minor = Number(pr.currency_minor_unit || 0);
    const costo = Math.round(Number(pr.price) / 10 ** minor);
    if (!costo || costo < 1000) continue;
    const ref = Number(refs[String(p.id)] || 0) || null;
    const price = precioTech(costo, ref);
    const sub = subcategoria(clean(p.name), cats);
    out.push({
      id: 'tech-' + p.id, cat: 'tech', provider: 'dtech', name: clean(p.name), brand: '',
      subcat: sub.key, subcatLabel: sub.label, image: okUrl(p.images && p.images[0] && p.images[0].src),
      price, refPrice: ref && ref > price ? ref : null, inStock: p.is_in_stock !== false,
    });
  }
  return out;
}
async function syncTech() {
  const refs = JSON.parse(fs.readFileSync(REF_FILE, 'utf8')).porId || {};
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const { text, headers } = await http(`${URLS.tech}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, { json: true });
    const list = JSON.parse(text);
    if (page === 1) dump('tech', text.slice(0, 200000));
    if (!Array.isArray(list) || !list.length) break;
    all.push(...list);
    if (page >= Number(headers.get('x-wp-totalpages') || 1)) break;
    await sleep(600);
  }
  return parseDtech(all, refs);
}

/* -------------------------------- principal ------------------------------ */
const PROVIDERS = { p11: syncP11, orig: syncOrig, iphone: syncIphone, tech: syncTech };

async function main() {
  let previous = { products: [], meta: { providers: {} } };
  try { previous = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* primera vez */ }
  const result = [];
  const meta = { providers: {} };
  const now = new Date().toISOString();

  for (const key of Object.keys(PROVIDERS)) {
    if (ONLY && ONLY !== key) {
      result.push(...previous.products.filter((p) => p.cat === key));
      meta.providers[key] = (previous.meta && previous.meta.providers && previous.meta.providers[key]) || { ok: true, count: 0 };
      continue;
    }
    process.stdout.write(`> ${key}: sincronizando... `);
    try {
      const items = await PROVIDERS[key]();
      const min = rules.minimosParaPublicar[key];
      if (items.length < min) throw new Error(`solo ${items.length} productos (minimo ${min}); posible cambio en el sitio. Prueba --debug`);
      result.push(...items);
      meta.providers[key] = { ok: true, count: items.length, at: now };
      console.log(`${items.length} productos`);
    } catch (e) {
      const kept = previous.products.filter((p) => p.cat === key);
      result.push(...kept);
      meta.providers[key] = { ok: false, count: kept.length, at: (previous.meta?.providers?.[key]?.at) || null, error: String(e.message || e).slice(0, 200) };
      console.log(`FALLO (${meta.providers[key].error}). Se conservan ${kept.length} productos anteriores.`);
    }
  }

  const f = await enriquecerFotosP11(result, previous.products);
  console.log(`> fotos Perfumeria 1.1: descargadas ${f.manual + f.millennio + f.disfragancias + f.perfumesarabes + f.valmara} (manual ${f.manual}, Millennio ${f.millennio}, disfragancias ${f.disfragancias}, perfumesarabes ${f.perfumesarabes}, valmara ${f.valmara}); ya en disco ${f.disco}; enlace externo anterior ${f.previa}; descargas fallidas ${f.sinDescarga}; sin foto ${f.sin}`);

  result.sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name, 'es'));
  const payload = { updatedAt: now, demo: false, meta, products: result };
  const anyOk = Object.values(meta.providers).some((x) => x.ok);
  if (DRY) { console.log('(--dry) no se escribio nada. Total:', result.length); return; }
  if (!anyOk) { console.error('Ningun proveedor respondio bien; no se modifica data/products.json'); process.exitCode = 1; return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`OK: ${result.length} productos escritos en data/products.json`);
}

module.exports = { parseMayorista, parseMillennio, parseCasaPhone, parseCasaCards, enriquecerFotosP11, parseValmaraFotos, fotoLocal, descargarFoto, matchFoto, candidatoFoto, syncIphone, parseDtech, splitBrand };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
