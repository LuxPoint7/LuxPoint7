#!/usr/bin/env node
'use strict';
/**
 * LuxPoint7 - Sincronizacion de inventario con los 4 proveedores.
 *
 *   node scripts/sync-proveedores.js            -> sincroniza todo y escribe data/products.json
 *   node scripts/sync-proveedores.js --dry      -> muestra el resumen sin escribir nada
 *   node scripts/sync-proveedores.js --only=orig  (p11 | orig | iphone | tech)
 *   node scripts/sync-proveedores.js --debug    -> guarda el HTML crudo en /tmp para revisar selectores
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
 * casaphone.co/iphone/inventario lista cada unidad con: estado (Nuevo/SemiNuevo), modelo, GB, color,
 * bateria y precio. Se agrupa por modelo y cada unidad es una "variante" seleccionable en la web.
 */
function parseCasaPhone(html) {
  const units = [];
  const re = /<a\b[^>]*href="([^"]*\/iphone\/([a-z0-9]+)\/([a-z0-9]+))"[^>]*>([^<]{6,80})<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = decode(m[4]).trim();
    const t = text.match(/^iPhone\s+(.+?)\s+(\d+\s?(?:GB|TB))\s+(.+)$/i);
    if (!t) continue;
    const before = stripTags(html.slice(Math.max(0, m.index - 700), m.index));
    // Solo el bloque de esta unidad: termina en el precio "Tarjeta" (asi no se mezcla con la unidad vecina)
    const after = stripTags(html.slice(m.index, m.index + 1800)).split(/Tarjeta/i)[0];
    const pm = after.match(/\$\s?([\d.]{5,})/);
    if (!pm) continue;
    const estados = [...before.matchAll(/Semi\s?Nuevo|Nuevo/gi)];
    const estado = estados.length && /semi/i.test(estados[estados.length - 1][0]) ? 'Seminuevo' : 'Nuevo';
    const bat = after.match(/Bat\.?\s*(\d{2,3})\s?%/i);
    const imgs = [...html.slice(Math.max(0, m.index - 900), m.index).matchAll(/<img[^>]+src="([^"]+)"/gi)];
    let img = imgs.length ? imgs[imgs.length - 1][1] : null;
    if (img && img.startsWith('/')) img = 'https://casaphone.co' + img;
    units.push({
      modelSlug: m[2], unitId: m[3], model: 'iPhone ' + clean(t[1], 40), gb: t[2].toUpperCase().replace(/\s?(GB|TB)/, ' $1'),
      color: titleCase(clean(t[3], 30)), estado, battery: bat ? Number(bat[1]) : null,
      costo: copToInt(pm[1]), image: okUrl(img),
    });
  }
  const byModel = new Map();
  const seen = new Set();
  for (const u of units) {
    if (seen.has(u.unitId)) continue;
    seen.add(u.unitId);
    const id = 'iphone-' + u.modelSlug;
    if (!byModel.has(id)) {
      byModel.set(id, { id, cat: 'iphone', provider: 'casaphone', name: u.model, brand: 'Apple', model: u.model, image: u.image, variants: [], price: 0, inStock: true });
    }
    const p = byModel.get(id);
    if (!p.image && u.image) p.image = u.image;
    p.variants.push({ id: `${id}-${u.unitId}`, gb: u.gb, color: u.color, estado: u.estado, battery: u.battery, price: precioIphone(u.costo), inStock: true });
  }
  return [...byModel.values()].map((p) => {
    p.variants.sort((a, b) => a.price - b.price);
    p.price = p.variants[0].price;
    return p;
  });
}
async function syncIphone() {
  const base = new URL(URLS.iphone).origin;
  const { text } = await http(`${base}/iphone/inventario`);
  dump('iphone', text);
  return parseCasaPhone(text);
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

  result.sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name, 'es'));
  const payload = { updatedAt: now, demo: false, meta, products: result };
  const anyOk = Object.values(meta.providers).some((x) => x.ok);
  if (DRY) { console.log('(--dry) no se escribio nada. Total:', result.length); return; }
  if (!anyOk) { console.error('Ningun proveedor respondio bien; no se modifica data/products.json'); process.exitCode = 1; return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`OK: ${result.length} productos escritos en data/products.json`);
}

module.exports = { parseMayorista, parseMillennio, parseCasaPhone, parseDtech, splitBrand };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
