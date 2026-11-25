'use strict';
/**
 * Reglas de precio de LuxPoint7. Todo en COP.
 * Este archivo solo calcula; los margenes viven en reglas.json.
 * IMPORTANTE: el costo del proveedor NUNCA se escribe en data/products.json.
 */
const rules = require('./reglas.json');

const redondearArriba = (n, paso) => Math.ceil(n / paso) * paso;

// Categoria 1 - Perfumeria 1.1 (100 ml): proveedor + 30.000
function precioP11(costo) {
  return Math.round(costo + rules.p11.margen);
}

// Categoria 2 - Perfumeria Original: proveedor + 50.000
function precioOriginal(costo) {
  return Math.round(costo + rules.orig.margen);
}

// Categoria 3 - iPhone: proveedor + 160.000
function precioIphone(costo) {
  return Math.round(costo + rules.iphone.margen);
}

/**
 * Categoria 4 - Innovacion y Accesorios: margen adaptable por rangos.
 *  - Hasta $15.000        -> el doble (margen = costo)
 *  - $15.000 a $50.000    -> el margen sube de forma continua: +15.000 -> +24.000 -> +30.000
 *  - Desde $50.000        -> +30.000 o 15 % del costo (lo que sea mayor)
 * Si existe un precio de referencia del mercado (scripts/precios-referencia.json),
 * se intenta quedar 3 % por debajo, sin bajar del margen minimo.
 */
function margenTech(costo) {
  const t = rules.tech;
  if (costo <= t.puntosMargen[0][0]) return costo * (t.multiplicadorBajo - 1);
  const pts = t.puntosMargen;
  for (let i = 0; i < pts.length - 1; i++) {
    const [c0, m0] = pts[i];
    const [c1, m1] = pts[i + 1];
    if (costo <= c1) return m0 + ((costo - c0) / (c1 - c0)) * (m1 - m0);
  }
  return Math.max(t.margenAltoFijo, costo * t.margenAltoPorcentaje);
}

function precioTech(costo, referencia) {
  const t = rules.tech;
  const base = redondearArriba(costo + margenTech(costo), t.redondeoA);
  const piso = redondearArriba(
    costo + Math.max(t.margenMinimoFijo, costo * t.margenMinimoPorcentaje),
    t.redondeoA
  );
  let precio = base;
  if (referencia && referencia > 0) {
    const objetivo = Math.floor((referencia * (1 - t.descuentoSobreReferencia)) / t.redondeoA) * t.redondeoA;
    precio = Math.min(base, objetivo);
  }
  return Math.max(precio, piso);
}

module.exports = { precioP11, precioOriginal, precioIphone, precioTech, margenTech, rules };
