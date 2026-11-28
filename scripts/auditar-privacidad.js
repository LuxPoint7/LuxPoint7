#!/usr/bin/env node
/**
 * Auditoria de privacidad: revisa que ningun archivo publico mencione a tus proveedores.
 *  node scripts/auditar-privacidad.js [carpeta ...]      (por defecto: la raiz del repositorio)
 * Los dominios se sacan de los Secrets (URL_PERF_11, URL_PERF_ORIG, URL_IPHONE, URL_INNOVACION) via variables de entorno;
 * nunca se escriben aqui ni se imprimen: el informe solo muestra RUTAS de archivo y cantidades.
 * Ademas, data/products.json no puede contener ninguna URL externa (todas las fotos deben ser locales).
 * Sale con codigo 1 si encuentra algo (el workflow no publica en ese caso).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dirs = process.argv.slice(2).length ? process.argv.slice(2).map((d) => path.resolve(d)) : [ROOT];
const TEXTO = /\.(html?|js|mjs|json|ya?ml|md|css|txt|xml|svg)$/i;
const SALTAR = new Set(['.git', 'node_modules', 'img']);

const hosts = new Set();
for (const n of ['URL_PERF_11', 'URL_PERF_ORIG', 'URL_IPHONE', 'URL_INNOVACION']) {
  const v = String(process.env[n] || '').trim();
  if (!v) continue;
  try { const h = new URL(v).hostname.toLowerCase(); hosts.add(h); hosts.add(h.replace(/^www\./, '')); } catch { /* secret invalido */ }
}

function* archivos(dir) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (SALTAR.has(it.name)) continue;
    const f = path.join(dir, it.name);
    if (it.isDirectory()) yield* archivos(f);
    else if (TEXTO.test(it.name)) yield f;
  }
}

const problemas = [];
let revisados = 0;
for (const dir of dirs) {
  for (const f of archivos(dir)) {
    let t;
    try { if (fs.statSync(f).size > 30 * 1024 * 1024) continue; t = fs.readFileSync(f, 'utf8').toLowerCase(); } catch { continue; }
    revisados++;
    const rel = path.relative(process.cwd(), f) || f;
    for (const h of hosts) if (h && t.includes(h)) { problemas.push(`${rel}: menciona un dominio de proveedor`); break; }
    if (/(^|[\\/])data[\\/]products\.json$/.test(f)) {
      const n = (t.match(/https?:\/\//g) || []).length;
      if (n) problemas.push(`${rel}: contiene ${n} URL(s) externas (todas las fotos deben ser locales)`);
    }
  }
}
if (!hosts.size) console.log('(aviso) No hay Secrets de URL en el entorno: solo se revisa que products.json no tenga URLs externas.');
console.log(`Auditoria de privacidad: ${revisados} archivos revisados.`);
if (problemas.length) { console.error('PROBLEMAS:\n - ' + problemas.join('\n - ')); process.exit(1); }
console.log('OK: ningun archivo publico menciona a tus proveedores.');
