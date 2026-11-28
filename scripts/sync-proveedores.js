#!/usr/bin/env node
'use strict';
/**
 * LuxPoint7 - Sincronizacion de inventario con los 4 proveedores.
 *
 *   node scripts/sync-proveedores.js            -> sincroniza todo y escribe data/products.json
 *   node scripts/sync-proveedores.js --dry      -> muestra el resumen sin escribir nada
 *   node scripts/sync-proveedores.js --only=orig  (p11 | orig | iphone | tech)
 *   node scripts/sync-proveedores.js --debug    -> guarda el HTML crudo en /tmp para revisar selectores
 *   node scripts/sync-proveedores.js --no-browser -> iPhone sin Playwright (solo HTML estatico)
 *
 * SEGURIDAD
 *  - No hay claves, tokens ni correos en este archivo. No se necesita ninguna para leer catalogos publicos.
 *  - Configuracion SOLO por variables de entorno (GitHub Secrets):
 *      SYNC_USER_AGENT        texto con el que te identificas ante los proveedores
 *  - Las URLs de los 4 proveedores NO estan en el codigo; son OBLIGATORIAS y llegan solo por variables de entorno (GitHub Secrets):
 *      URL_PERF_11, URL_PERF_ORIG, URL_IPHONE, URL_INNOVACION   (cada una empieza con https://)
 *    Si falta una, ese proveedor se salta y se conservan sus productos anteriores. Logs y errores nunca muestran direcciones.
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
// Las direcciones de los proveedores NO estan en el codigo: llegan por variables de entorno (GitHub Secrets).
const envUrl = (nombre) => {
  const v = String(process.env[nombre] || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s]+$/i.test(v) ? v : '';
};
const URLS = {
  p11: envUrl('URL_PERF_11'),
  orig: envUrl('URL_PERF_ORIG'),
  iphone: envUrl('URL_IPHONE'),
  tech: envUrl('URL_INNOVACION'),
};
const VAR_DE = { p11: 'URL_PERF_11', orig: 'URL_PERF_ORIG', iphone: 'URL_IPHONE', tech: 'URL_INNOVACION' };
const baseDe = (key) => { if (!URLS[key]) throw new Error(`Falta la variable de entorno ${VAR_DE[key]} (o no empieza con https://)`); return URLS[key]; };
/** Quita de cualquier texto (logs, errores guardados en el JSON publico) toda URL o direccion de proveedor. */
const oculto = (txt) => {
  let t = String(txt).replace(/https?:\/\/[^\s"')]+/gi, '[proveedor]');
  for (const u of Object.values(URLS)) { if (!u) continue; try { t = t.split(new URL(u).hostname).join('[proveedor]'); } catch { /* url invalida */ } }
  return t;
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
      if (!r.ok) throw new Error('HTTP ' + r.status);
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
 * Proveedor 1.1: sitio propio (no Shopify). Se lee el texto de la pagina.
 * Solo se publican frascos de 100 ml de la Linea 1.1. Se descartan los bloques "Single"
 * (30/50/100 ml a $9.000-$20.000) y cualquier presentacion distinta de 100 ml.
 */
function parseP11(html) {
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
        id, cat: 'p11', provider: 'p11', name: clean(full), brand: clean(brand, 60), size: '100 ml',
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
  const { text } = await http(baseDe('p11'));
  dump('p11', text);
  return parseP11(text);
}

/* -------- Fotos de Perfumeria 1.1: tus archivos img/perfumes/perfumeN.jpg + scripts/mapa-fotos.json -------- */
/**
 * El proveedor solo trae iconos genericos y NO se busca ninguna foto en otras tiendas.
 * Las fotos son las tuyas, subidas a img/perfumes/ (perfume1.jpg ... perfume276.jpg), y el mapa dice cual es de cual:
 *   scripts/mapa-fotos.json  ->  { "fotos": { "p11-paco-rabanne-1-million": "perfume262.jpg" } }
 * La clave puede ser el id del perfume o su nombre exacto ("Paco Rabanne 1 Million"). El valor, el archivo (o solo su numero).
 * Perfume sin entrada en el mapa, o cuyo archivo aun no existe en img/perfumes/ -> queda sin foto (icono por defecto).
 */
const MAPA_FOTOS = path.join(__dirname, 'mapa-fotos.json');
const IMG_DIR = path.join(ROOT, 'img', 'perfumes');
const IMG_REL = 'img/perfumes';
const MIN_BYTES = 1024; // menos de 1 KB = archivo roto

function asignarFotosP11(products) {
  const stats = { asignadas: 0, sinMapa: 0, archivoFaltante: 0, claveDesconocida: [], mapaInvalido: false };
  let mapa = {};
  try {
    const raw = JSON.parse(fs.readFileSync(MAPA_FOTOS, 'utf8'));
    mapa = raw && typeof raw.fotos === 'object' && raw.fotos ? raw.fotos : raw;
  } catch (e) { if (fs.existsSync(MAPA_FOTOS)) stats.mapaInvalido = true; }
  const archivos = new Map(); // nombre exacto -> tamano
  try { for (const f of fs.readdirSync(IMG_DIR)) { try { archivos.set(f, fs.statSync(path.join(IMG_DIR, f)).size); } catch { /* ignora */ } } } catch { /* sin carpeta */ }

  const p11 = products.filter((p) => p.cat === 'p11');
  const porId = new Map(p11.map((p) => [p.id, p]));
  const porNombre = new Map(); // slug de "marca nombre" o de "nombre"; solo si no es ambiguo
  const indexar = (k, p) => porNombre.set(k, porNombre.has(k) && porNombre.get(k) !== p ? null : p);
  for (const p of p11) { indexar(slug(`${p.brand} ${p.name}`), p); indexar(slug(p.name), p); }
  const resolver = (clave) => {
    const k = String(clave).trim();
    if (porId.has(k)) return porId.get(k);
    if (porId.has('p11-' + slug(k))) return porId.get('p11-' + slug(k));
    return porNombre.get(slug(k)) || null;
  };
  const normArchivo = (v) => {
    let f = String(v == null ? '' : v).trim();
    if (/^\d{1,4}$/.test(f)) f = `perfume${f}.jpg`;
    f = f.replace(/^\/?img\/perfumes\//i, '');
    return /^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i.test(f) ? f : null;
  };

  for (const p of p11) delete p.image;
  for (const [clave, valor] of Object.entries(mapa)) {
    if (clave.startsWith('_') || typeof valor === 'object') continue; // _ayuda, _ejemplo...
    const p = resolver(clave);
    if (!p) { stats.claveDesconocida.push(clave); continue; }
    const f = normArchivo(valor);
    const opt = f && f.replace(/\.(jpe?g|png)$/i, '.webp'); // version optimizada, si ya existe
    const usar = opt && archivos.get(opt) > MIN_BYTES ? opt : f;
    if (!usar || !(archivos.get(usar) > MIN_BYTES)) { stats.archivoFaltante++; continue; }
    p.image = `${IMG_REL}/${usar}`;
  }
  stats.asignadas = p11.filter((p) => p.image).length;
  stats.sinMapa = p11.length - stats.asignadas;
  return stats;
}

/* ------- Optimizacion a WebP y fotos locales (iPhone e Innovacion) ------- */
/**
 * - Optimiza tus fotos de img/perfumes/ (jpg/png) creando una version .webp de max. 900 px al lado de cada original.
 *   Los originales NO se tocan; la tienda usa el .webp y el despliegue deja de publicar el original.
 * - Descarga las fotos de los productos de iPhone e Innovacion a img/p/<id>.webp, para que la tienda las sirva desde
 *   tu propio sitio (no depende de los proveedores y no expone sus direcciones). Si el archivo ya existe, no se vuelve a pedir.
 * Usa la libreria "sharp" si esta instalada (el workflow la instala). Sin ella, las fotos descargadas se guardan tal cual
 * y no se optimiza nada.
 */
const IMG_P_DIR = path.join(ROOT, 'img', 'p');
const IMG_P_REL = 'img/p';
const MAX_PX = 900;
let _sharp;
const getSharp = () => { if (_sharp === undefined) { try { _sharp = require('sharp'); } catch { _sharp = null; } } return _sharp; };
async function aWebp(buf) {
  const sh = getSharp();
  if (!sh) return null;
  try { return await sh(buf).rotate().resize({ width: MAX_PX, height: MAX_PX, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(); } catch { return null; }
}
const EXT_TIPO = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
async function bajarImagen(url) {
  if (!okUrl(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const tipo = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!EXT_TIPO[tipo]) return null; // no es una imagen (HTML, SVG...)
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length < MIN_BYTES || buf.length > 8 * 1024 * 1024 ? null : { buf, ext: EXT_TIPO[tipo] };
  } catch { return null; } finally { clearTimeout(timer); }
}
const escribir = (dir, name, buf) => { fs.mkdirSync(dir, { recursive: true }); const t = path.join(dir, `.${name}.tmp`); fs.writeFileSync(t, buf); fs.renameSync(t, path.join(dir, name)); };

async function optimizarFotosP11() {
  const st = { creadas: 0, fallidas: 0, sinSharp: false };
  if (!getSharp()) { st.sinSharp = true; return st; }
  let files = [];
  try { files = fs.readdirSync(IMG_DIR); } catch { return st; }
  const set = new Set(files);
  for (const f of files) {
    const m = f.match(/^([A-Za-z0-9._-]+)\.(jpe?g|png)$/i);
    if (!m || set.has(`${m[1]}.webp`)) continue;
    try {
      const w = await aWebp(fs.readFileSync(path.join(IMG_DIR, f)));
      if (w && w.length > MIN_BYTES) { escribir(IMG_DIR, `${m[1]}.webp`, w); st.creadas++; } else st.fallidas++;
    } catch { st.fallidas++; }
  }
  return st;
}

function fotoPLocal(base) {
  for (const ext of ['webp', 'jpg', 'png', 'avif', 'gif']) {
    try { if (fs.statSync(path.join(IMG_P_DIR, `${base}.${ext}`)).size > MIN_BYTES) return `${IMG_P_REL}/${base}.${ext}`; } catch { /* no existe */ }
  }
  return null;
}

async function localizarFotos(products) {
  const st = { descargadas: 0, cache: 0, fallidas: 0, huerfanas: 0 };
  const porUrl = new Map(); // url -> ruta local (misma foto en varias unidades = un solo archivo)
  const tareas = [];
  const resolver = (obj, id) => {
    const url = obj.image;
    if (!url) return;
    if (url.startsWith(IMG_P_REL + '/')) { // ya es local: se conserva si el archivo existe
      if (!(fs.existsSync(path.join(ROOT, url)))) delete obj.image;
      return;
    }
    const base = slug(id);
    tareas.push(async () => {
      const local = fotoPLocal(base);
      if (local) { obj.image = local; st.cache++; return; }
      if (!porUrl.has(url)) { // la misma foto en varias unidades se descarga una sola vez
        porUrl.set(url, (async () => {
          const d = await bajarImagen(url);
          if (!d) return null;
          const w = await aWebp(d.buf);
          const ext = w ? 'webp' : d.ext;
          escribir(IMG_P_DIR, `${base}.${ext}`, w || d.buf);
          st.descargadas++;
          await sleep(150);
          return `${IMG_P_REL}/${base}.${ext}`;
        })());
      }
      const rel = await porUrl.get(url);
      if (rel) obj.image = rel; else { delete obj.image; st.fallidas++; } // sin foto (icono) hasta el proximo intento
    });
  };
  for (const p of products) {
    if (p.cat !== 'iphone' && p.cat !== 'tech') continue;
    resolver(p, p.id);
    for (const v of p.variants || []) resolver(v, v.id);
  }
  // 4 descargas a la vez
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < tareas.length) { const t = tareas[i++]; try { await t(); } catch { st.fallidas++; } } }));
  // limpieza: archivos de img/p que ya no usa ningun producto
  const usados = new Set();
  for (const p of products) { if (p.image) usados.add(p.image); for (const v of p.variants || []) if (v.image) usados.add(v.image); }
  try {
    for (const f of fs.readdirSync(IMG_P_DIR)) {
      if (f.startsWith('.')) continue;
      if (!usados.has(`${IMG_P_REL}/${f}`)) { fs.unlinkSync(path.join(IMG_P_DIR, f)); st.huerfanas++; }
    }
  } catch { /* sin carpeta */ }
  return st;
}

/* ---------------------- 2) Perfumeria Original (Shopify) ------------------ */
function parseOrig(products) {
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
        id: `orig-${p.id}-${v.id}`, cat: 'orig', provider: 'orig',
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
    const { text } = await http(`${baseDe('orig')}/products.json?limit=250&page=${page}`, { json: true });
    const list = JSON.parse(text).products || [];
    if (page === 1) dump('orig', text.slice(0, 200000));
    if (!list.length) break;
    all.push(...list);
    await sleep(600);
  }
  return parseOrig(all);
}

/* ------------------------- 3) iPhone ------------------------- */
/**
 * La pagina de inventario del proveedor carga el inventario y las fotos con JavaScript. Por eso:
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
function parseIphoneCards(records, base) {
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
    if (!byModel.has(id)) byModel.set(id, { id, cat: 'iphone', provider: 'iphone', name: u.model, brand: 'Apple', model: u.model, image: null, variants: [], price: 0, inStock: true });
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
function iphoneRecordsFromHtml(html) {
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
const parseIphone = (html, base) => parseIphoneCards(iphoneRecordsFromHtml(html), base);

async function renderIphone(url) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { throw new Error('Playwright no esta instalado'); }
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'es-CO', viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    if (DEBUG) page.on('response', (r) => { if (/json/i.test(r.headers()['content-type'] || '')) console.log(`\n   [debug] JSON ${r.status()} ${oculto(new URL(r.url()).pathname).slice(0, 120)}`); });
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
  const base = new URL(baseDe('iphone')).origin;
  const url = `${base}/iphone/inventario`;
  let best = [];
  if (!NO_BROWSER) {
    try {
      best = parseIphoneCards(await renderIphone(url), base);
      console.log(`\n   navegador: ${best.length} modelos / ${countUnits(best)} unidades`);
    } catch (e) { console.log(`\n   (sin navegador: ${oculto(String(e.message).split('\n')[0])})`); }
  }
  if (best.length < rules.minimosParaPublicar.iphone) { // plan B: HTML estatico
    const { text } = await http(url);
    dump('iphone', text);
    const alt = parseIphone(text, base);
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
function parseTech(products, refs) {
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
      id: 'tech-' + p.id, cat: 'tech', provider: 'tech', name: clean(p.name), brand: '',
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
    const { text, headers } = await http(`${baseDe('tech')}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, { json: true });
    const list = JSON.parse(text);
    if (page === 1) dump('tech', text.slice(0, 200000));
    if (!Array.isArray(list) || !list.length) break;
    all.push(...list);
    if (page >= Number(headers.get('x-wp-totalpages') || 1)) break;
    await sleep(600);
  }
  return parseTech(all, refs);
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
      if (key === 'p11') { // perfume que ya no aparece en el proveedor: se conserva como Agotado (con su foto) hasta 60 dias
        const vivos = new Set(items.map((p) => p.id));
        for (const viejo of previous.products.filter((p) => p.cat === 'p11' && !vivos.has(p.id))) {
          const desde = viejo.agotadoDesde || now;
          if (Date.parse(now) - Date.parse(desde) < 60 * 864e5) items.push({ ...viejo, inStock: false, agotadoDesde: desde });
        }
      }
      result.push(...items);
      meta.providers[key] = { ok: true, count: items.length, at: now };
      console.log(`${items.length} productos`);
    } catch (e) {
      const kept = previous.products.filter((p) => p.cat === key);
      result.push(...kept);
      meta.providers[key] = { ok: false, count: kept.length, at: (previous.meta?.providers?.[key]?.at) || null, error: oculto(e.message || e).slice(0, 200) };
      console.log(`FALLO (${meta.providers[key].error}). Se conservan ${kept.length} productos anteriores.`);
    }
  }

  if (!DRY) {
    const o = await optimizarFotosP11();
    console.log(o.sinSharp ? '> optimizacion de fotos: omitida (sharp no esta instalado)' : `> fotos 1.1 optimizadas a WebP: ${o.creadas} nuevas${o.fallidas ? `, ${o.fallidas} fallidas` : ''}`);
  }
  const f = asignarFotosP11(result);
  console.log(`> fotos Perfumeria 1.1: ${f.asignadas} con foto, ${f.sinMapa} sin foto (icono)` +
    (f.archivoFaltante ? `; ${f.archivoFaltante} del mapa apuntan a un archivo que no existe en img/perfumes` : '') +
    (f.claveDesconocida.length ? `; ${f.claveDesconocida.length} claves del mapa no coinciden con ningun perfume (${f.claveDesconocida.slice(0, 3).join(', ')}...)` : '') +
    (f.mapaInvalido ? '; OJO: scripts/mapa-fotos.json no es un JSON valido' : ''));

  if (!DRY) {
    const l = await localizarFotos(result);
    console.log(`> fotos iPhone/Innovacion en tu sitio: ${l.descargadas} descargadas, ${l.cache} ya estaban, ${l.fallidas} sin foto (fallaron), ${l.huerfanas} archivos viejos borrados`);
  }
  result.sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name, 'es'));
  const payload = { updatedAt: now, demo: false, meta, products: result };
  const anyOk = Object.values(meta.providers).some((x) => x.ok);
  if (DRY) { console.log('(--dry) no se escribio nada. Total:', result.length); return; }
  if (!anyOk) { console.error('Ningun proveedor respondio bien; no se modifica data/products.json'); process.exitCode = 1; return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`OK: ${result.length} productos escritos en data/products.json`);
}

module.exports = { parseP11, parseOrig, parseIphone, parseIphoneCards, asignarFotosP11, optimizarFotosP11, localizarFotos, syncIphone, parseTech, splitBrand };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
