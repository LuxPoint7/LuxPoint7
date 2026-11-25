'use strict';
/**
 * Genera data/config.json con el numero de WhatsApp SOLO durante el despliegue (GitHub Actions),
 * leyendolo del Secret WHATSAPP_NUMBER. Ese archivo esta en .gitignore: nunca se sube al repositorio.
 */
const fs = require('node:fs');
const path = require('node:path');

const raw = String(process.env.WHATSAPP_NUMBER || '').replace(/[^\d]/g, '');
if (raw.length < 10 || raw.length > 15) {
  console.error('Falta el Secret WHATSAPP_NUMBER o no es valido (formato: 573001234567, solo numeros con indicativo de pais).');
  process.exit(1);
}
const dir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ whatsapp: raw }));
console.log('data/config.json generado (no se sube al repositorio).');
