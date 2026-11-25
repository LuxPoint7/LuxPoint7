# Guía paso a paso: poner LuxPoint7 a funcionar

No necesitas saber programar. Solo copiar archivos y hacer clic.

## 1. Qué contiene el proyecto
```
index.html  styles.css  app.js  cart.js      <- la tienda (lo que ve el cliente)
data/products.json                            <- inventario (lo actualiza el robot)
data/config.example.json                      <- ejemplo, NO contiene tu número
scripts/sync-proveedores.js                   <- lee los 4 proveedores
scripts/pricing.js  reglas.json               <- tus márgenes y reglas de precio
scripts/precios-referencia.json               <- precios de mercado para comparar (opcional)
scripts/make-config.js                        <- toma tu WhatsApp desde un Secret
.github/workflows/sync.yml                    <- el robot (GitHub Actions)
.gitignore  .nojekyll  package.json
```
Tu número de WhatsApp NUNCA se escribe en estos archivos: va en un Secret de GitHub.

## 2. Subir los archivos al repositorio
1. Entra a tu repositorio de LuxPoint7 en GitHub.
2. Pulsa **Add file → Upload files** y arrastra TODO el contenido de la carpeta (respeta las carpetas `scripts`, `data` y `.github/workflows`). Si el navegador no sube carpetas ocultas (`.github`), crea el archivo con **Add file → Create new file** escribiendo el nombre `.github/workflows/sync.yml` y pegando su contenido.
3. Pulsa **Commit changes**.

## 3. Guardar tu WhatsApp como Secret
1. Repositorio → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `WHATSAPP_NUMBER`
3. Secret: tu número con indicativo, solo dígitos, por ejemplo `573001234567`.
4. **Add secret**.

## 4. Activar GitHub Pages con Actions
1. **Settings → Pages**.
2. En **Source** elige **GitHub Actions**.

## 5. Activar y ejecutar el robot
1. Pestaña **Actions**. Si aparece un botón verde para habilitar, púlsalo.
2. Elige **Sincronizar proveedores y publicar → Run workflow → Run workflow**.
3. Espera 1–3 minutos. Verde = listo. Tu web queda en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.
4. Desde ahí se actualiza solo cada 6 horas.

## 6. Revisar la primera sincronización (importante)
Los proveedores pueden tener páginas distintas a las que se probaron. Entra a la pestaña Actions, abre la ejecución y mira el registro del paso "Sincronizar inventario":
- Si un proveedor falló, el robot conserva sus productos anteriores y lo indica. Cópiame el mensaje de error y lo ajusto.
- Mientras `data/products.json` tenga `"demo": true`, la web muestra un aviso amarillo de productos de demostración; desaparece con la primera sincronización real.

## 7. Cambiar reglas
- **Márgenes** (+30.000, +50.000, +160.000, escala de accesorios): `scripts/reglas.json`.
- **Envío gratis y fletes**: arriba de `cart.js`, bloque `CONFIG` (Perfumería Original gratis desde $250.000; los demás fletes quedan "por confirmar" por WhatsApp).
- **Precios de mercado** (para el ahorro/comparación en accesorios): `scripts/precios-referencia.json`, en `porId` pon `"123": 60000` (el número del producto). Nunca se inventan precios de mercado.

## 8. Advertencias honestas
- Revisa los términos de uso de cada proveedor y pídeles permiso para leer su catálogo.
- Las imágenes se cargan directamente de los proveedores; si ellos las cambian o bloquean, desaparecen.
- El sitio de D-TECH mostró enlaces de casino ocultos en su pie de página (posible hackeo): avísales.
- Tu número de WhatsApp no está en el repositorio, pero sí será visible para quien use el botón de compra (así funciona wa.me).
- Con varias bodegas, un pedido mixto puede salir en más de 2 envíos; el carrito muestra la cantidad real.
- El umbral de envío gratis se calcula con tus precios web; confirma quién paga el flete con Millennio.
- Los precios del proveedor y su stock pueden cambiar entre sincronizaciones: confirma por WhatsApp antes de cobrar.
