/* LuxPoint7 - Carrito unificado + cierre por WhatsApp (JavaScript puro, sin librerias).
 * SEGURIDAD: aqui no hay claves, correos ni telefonos. El numero de WhatsApp se lee en tiempo de
 * ejecucion desde data/config.json, que lo genera GitHub Actions a partir del Secret WHATSAPP_NUMBER
 * (ese archivo esta en .gitignore y no vive en el repositorio). Los datos del cliente solo van en el
 * mensaje de WhatsApp: no se guardan en ningun sitio.
 */
(function () {
  'use strict';

  /* ----------------------------- configuracion ----------------------------- */
  var CONFIG = {
    brand: 'LuxPoint7',
    carrier: 'Inter Rapidísimo',
    eta: '3 a 6 días hábiles',
    payments: ['Nequi', 'Bancolombia'],
    // Un "paquete" por proveedor/bodega. freeFrom = monto del subtotal (en precios LuxPoint7) desde el cual
    // ESE proveedor envia gratis. flete = costo de envio conocido si no es gratis (null = se confirma por WhatsApp).
    providers: {
      p11: { label: 'Perfumería 1.1 (100 ml)', short: 'Perfumes 1.1', dispatch: 'directo', freeFrom: null, flete: null },
      orig: { label: 'Perfumería Original', short: 'Perfumes Originales', dispatch: 'directo', freeFrom: 250000, flete: null },
      iphone: { label: 'iPhone', short: 'iPhone', dispatch: 'controlado', freeFrom: null, flete: null },
      tech: { label: 'Innovación y Accesorios', short: 'Innovación', dispatch: 'directo', freeFrom: null, flete: null }
    },
    order: ['p11', 'orig', 'iphone', 'tech'],
    storageKey: 'lp_cart_v1'
  };
  window.LP_CONFIG = CONFIG;

  var money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  var fmt = function (n) { return money.format(n); };
  window.LP_fmt = fmt;

  /* ----------------------------- helpers de DOM ---------------------------- */
  function el(tag, props) {
    var node = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  window.LP_el = el;

  /* -------------------------------- estado --------------------------------- */
  var items = []; // { key, cat, name, variant, price, qty, image }
  var catalog = null; // Map id -> {price, inStock}
  var publicConfig = { whatsapp: '', pedidos: '' };

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(CONFIG.storageKey) || '[]');
      if (Array.isArray(raw)) {
        items = raw.filter(function (i) {
          return i && typeof i.key === 'string' && CONFIG.providers[i.cat] && i.price > 0 && i.qty > 0;
        }).map(function (i) {
          return { key: String(i.key), cat: i.cat, name: String(i.name).slice(0, 140), variant: String(i.variant || '').slice(0, 140), price: Number(i.price), qty: Math.min(20, Math.floor(i.qty)), image: (typeof i.image === 'string' && (/^https:\/\//i.test(i.image) || /^img\/(?:perfumes|p)\/[a-z0-9._-]+$/i.test(i.image))) ? i.image : null };
        });
      }
    } catch (e) { items = []; }
  }
  function save() {
    try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(items)); } catch (e) { /* modo privado */ }
  }

  /* --------------------------- reglas de envio ----------------------------- */
  function analyze() {
    var groups = CONFIG.order.map(function (cat) {
      var gi = items.filter(function (i) { return i.cat === cat; });
      if (!gi.length) return null;
      var p = CONFIG.providers[cat];
      var subtotal = gi.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
      var qty = gi.reduce(function (s, i) { return s + i.qty; }, 0);
      var free = p.freeFrom != null && subtotal >= p.freeFrom;
      return {
        cat: cat, info: p, items: gi, subtotal: subtotal, qty: qty, free: free,
        missing: p.freeFrom != null && !free ? p.freeFrom - subtotal : 0,
        flete: free ? 0 : p.flete
      };
    }).filter(Boolean);

    var hasIphone = groups.some(function (g) { return g.cat === 'iphone'; });
    var others = groups.filter(function (g) { return g.cat !== 'iphone'; });
    var productsTotal = groups.reduce(function (s, g) { return s + g.subtotal; }, 0);
    var fleteKnown = groups.reduce(function (s, g) { return s + (g.flete || 0); }, 0);
    var fleteUnknown = groups.some(function (g) { return !g.free && g.flete == null; });
    return {
      groups: groups, shipments: groups.length, hasIphone: hasIphone, mixedIphone: hasIphone && others.length > 0,
      multi: groups.length > 1, productsTotal: productsTotal, fleteKnown: fleteKnown, fleteUnknown: fleteUnknown,
      total: productsTotal + fleteKnown, anyFree: groups.some(function (g) { return g.free; }),
      count: groups.reduce(function (s, g) { return s + g.qty; }, 0)
    };
  }

  /* --------------------------------- API ----------------------------------- */
  function add(item) {
    var found = items.filter(function (i) { return i.key === item.key; })[0];
    if (found) { found.qty = Math.min(20, found.qty + 1); found.price = item.price; }
    else items.push({ key: item.key, cat: item.cat, name: item.name, variant: item.variant || '', price: item.price, qty: 1, image: item.image || null });
    save(); render(); open();
  }
  function setQty(key, q) {
    items = items.map(function (i) { return i.key === key ? Object.assign({}, i, { qty: q }) : i; }).filter(function (i) { return i.qty > 0; });
    items.forEach(function (i) { i.qty = Math.min(20, i.qty); });
    save(); render();
  }
  function clear() { items = []; save(); render(); }

  // Sincroniza precios/stock con el catalogo recien cargado (por si cambiaron desde que se agrego al carrito)
  function reconcile(map) {
    catalog = map;
    var changed = [];
    items = items.filter(function (i) {
      var live = map.get(i.key);
      if (!live) { changed.push(i.name + ' ya no está disponible y se quitó del carrito.'); return false; }
      if (!live.inStock) { changed.push(i.name + ' está agotado y se quitó del carrito.'); return false; }
      if (live.price !== i.price) { changed.push('Actualizamos el precio de ' + i.name + ' a ' + fmt(live.price) + '.'); i.price = live.price; }
      return true;
    });
    save(); render();
    if (changed.length) notice(changed.join(' '));
  }

  /* ---------------------------------- UI ----------------------------------- */
  var drawer, overlay, body, footer, badge, noticeBox, suggester = null;

  function notice(text) {
    if (!noticeBox) return;
    noticeBox.textContent = text;
    noticeBox.hidden = false;
    setTimeout(function () { noticeBox.hidden = true; }, 9000);
  }

  function open() { drawer.classList.add('open'); overlay.hidden = false; drawer.setAttribute('aria-hidden', 'false'); document.body.classList.add('no-scroll'); }
  function close() { drawer.classList.remove('open'); overlay.hidden = true; drawer.setAttribute('aria-hidden', 'true'); document.body.classList.remove('no-scroll'); }

  function alertBox(kind, title, text) {
    return el('div', { class: 'alert alert-' + kind, role: 'note' }, el('strong', { text: title }), el('span', { text: ' ' + text }));
  }

  function render() {
    if (!drawer) return;
    var a = analyze();
    badge.textContent = String(a.count);
    badge.hidden = a.count === 0;
    body.textContent = '';
    footer.textContent = '';

    if (!a.count) {
      body.appendChild(el('div', { class: 'cart-empty' },
        el('div', { class: 'cart-empty-ico', text: '🛒' }),
        el('p', { text: 'Tu carrito está vacío.' }),
        el('p', { class: 'muted', text: 'Agrega perfumes, iPhone o accesorios y finaliza por WhatsApp.' })));
      return;
    }

    // Info de transportadora (siempre visible en el resumen)
    body.appendChild(el('div', { class: 'ship-info' },
      el('span', { text: '🚚 Envío nacional por ' + CONFIG.carrier }),
      el('span', { text: '⏱ ' + CONFIG.eta })));

    // Alertas
    if (a.mixedIphone) {
      var list = a.groups.map(function (g) { return g.cat === 'iphone' ? 'el iPhone verificado' : g.info.short; }).join(', ');
      body.appendChild(alertBox('warn', 'Pedido mixto: ' + a.shipments + ' envíos independientes.',
        'El iPhone pasa primero por nosotros para revisión y se despacha aparte; lo demás sale directo desde bodega (' + list + '). Recibirás cada paquete por separado.'));
    } else if (a.multi) {
      body.appendChild(alertBox('info', 'Se despacha en ' + a.shipments + ' paquetes.',
        'Cada categoría sale desde una bodega distinta, así que recibirás paquetes independientes.'));
    }
    a.groups.forEach(function (g) {
      if (g.info.freeFrom != null) {
        if (g.free && a.multi) {
          body.appendChild(alertBox('ok', '¡Envío gratis en ' + g.info.short + '!',
            'Aplica solo al paquete de ese proveedor. Los productos de otros proveedores se despachan por separado y su envío se confirma aparte.'));
        } else if (!g.free) {
          var prog = el('div', { class: 'ship-progress', role: 'note' },
            el('strong', { text: 'Te faltan ' + fmt(g.missing) + ' para envío gratis en ' + g.info.short + '.' }),
            el('span', { text: ' Se cuenta solo con productos de esa categoría' + (a.multi ? ' (no se suma con otras).' : '.') }),
            el('progress', { max: String(g.info.freeFrom), value: String(Math.min(g.subtotal, g.info.freeFrom)), 'aria-label': 'Progreso hacia el envío gratis' }));
          body.appendChild(prog);
        }
      }
    });
    if (a.multi && !a.anyFree) {
      body.appendChild(alertBox('info', 'Envío por paquete.', 'En pedidos combinados el flete se calcula por cada paquete; lo confirmamos por WhatsApp antes de que pagues.'));
    }

    // Grupos por bodega
    a.groups.forEach(function (g, idx) {
      var head = el('div', { class: 'cart-group-head' },
        el('div', null,
          el('div', { class: 'cart-group-title', text: 'Paquete ' + (idx + 1) + ' · ' + g.info.label }),
          el('div', { class: 'cart-group-sub', text: g.info.dispatch === 'controlado' ? 'Despacho controlado: revisado por LuxPoint7 antes de enviarte' : 'Envío directo desde bodega del proveedor · remitente LuxPoint7' })),
        el('span', { class: 'pill ' + (g.free ? 'pill-ok' : 'pill-muted'), text: g.free ? 'Envío gratis' : (g.flete != null ? 'Flete ' + fmt(g.flete) : 'Flete por confirmar') }));
      var group = el('section', { class: 'cart-group' }, head);
      g.items.forEach(function (it) {
        var emo = it.cat === 'iphone' ? '📱' : it.cat === 'tech' ? '🔌' : '🧴';
        var img = it.image ? el('img', { src: it.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('span', { class: 'ph', text: emo });
        if (img.tagName === 'IMG') img.addEventListener('error', function () { img.replaceWith(el('span', { class: 'ph', text: emo })); });
        group.appendChild(el('div', { class: 'cart-item' },
          el('div', { class: 'cart-thumb' }, img),
          el('div', { class: 'cart-item-main' },
            el('div', { class: 'cart-item-name', text: it.name }),
            it.variant ? el('div', { class: 'cart-item-var', text: it.variant }) : null,
            el('div', { class: 'cart-item-row' },
              el('div', { class: 'qty' },
                el('button', { type: 'button', 'aria-label': 'Quitar una unidad', onclick: function () { setQty(it.key, it.qty - 1); } }, '−'),
                el('span', { text: String(it.qty), 'aria-live': 'polite' }),
                el('button', { type: 'button', 'aria-label': 'Agregar una unidad', disabled: it.cat === 'iphone' ? true : null, onclick: function () { setQty(it.key, it.qty + 1); } }, '+')),
              el('strong', { text: fmt(it.price * it.qty) })))));
      });
      group.appendChild(el('div', { class: 'cart-group-sub-total' }, el('span', { text: 'Subtotal paquete' }), el('strong', { text: fmt(g.subtotal) })));
      body.appendChild(group);
    });

    // Sugerencias para completar un iPhone (accesorios), solo si aun no hay accesorios en el carrito
    var hasIphone = a.groups.some(function (g) { return g.cat === 'iphone'; });
    var hasTech = a.groups.some(function (g) { return g.cat === 'tech'; });
    if (hasIphone && !hasTech && suggester) {
      var sug = [];
      try { sug = suggester() || []; } catch (e) { sug = []; }
      if (sug.length) {
        var box = el('section', { class: 'suggest' },
          el('h4', { text: 'Completa tu iPhone' }),
          el('div', { class: 'muted small', text: 'Accesorios de alta calidad. Se despachan en un paquete aparte (el flete se confirma por WhatsApp).' }));
        sug.forEach(function (it) {
          var th = it.image ? el('img', { src: it.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('span', { class: 'ph', text: '🔌' });
          if (th.tagName === 'IMG') th.addEventListener('error', function () { th.replaceWith(el('span', { class: 'ph', text: '🔌' })); });
          box.appendChild(el('div', { class: 'suggest-row' }, th,
            el('div', { class: 'sg-main' }, el('div', { class: 'sg-name', text: it.name }), el('div', { text: fmt(it.price) })),
            el('button', { type: 'button', class: 'btn btn-outline', onclick: function () { add(it); } }, 'Agregar')));
        });
        body.appendChild(box);
      }
    }

    // Pie: totales y boton
    footer.appendChild(el('div', { class: 'totals' },
      el('div', null, el('span', { text: 'Productos' }), el('span', { text: fmt(a.productsTotal) })),
      el('div', null, el('span', { text: 'Envío (' + CONFIG.carrier + ')' }),
        el('span', { text: a.fleteUnknown ? (a.fleteKnown ? fmt(a.fleteKnown) + ' + por confirmar' : 'Gratis / por confirmar') : (a.fleteKnown ? fmt(a.fleteKnown) : 'Gratis') })),
      el('div', { class: 'grand' }, el('span', { text: 'Total a pagar' }), el('span', { text: fmt(a.total) + (a.fleteUnknown ? ' + flete' : '') }))));
    footer.appendChild(el('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: openCheckout }, 'Finalizar compra / Pagar'));
    footer.appendChild(el('button', { type: 'button', class: 'btn btn-link', onclick: function () { if (confirm('¿Vaciar el carrito?')) clear(); } }, 'Vaciar carrito'));
  }

  /* --------------------------- checkout + WhatsApp -------------------------- */
  var dlg, form, formError, successBox;

  // Hora de Colombia (no depende de la zona del celular del cliente)
  function bogota() {
    var o = {};
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).forEach(function (p) { o[p.type] = p.value; });
    } catch (e) {
      var d = new Date(Date.now() - 5 * 3600 * 1000), z = function (n) { return String(n).padStart(2, '0'); };
      o = { year: d.getUTCFullYear(), month: z(d.getUTCMonth() + 1), day: z(d.getUTCDate()), hour: z(d.getUTCHours()), minute: z(d.getUTCMinutes()), second: z(d.getUTCSeconds()) };
    }
    return { ymd: o.year + o.month + o.day, text: o.year + '-' + o.month + '-' + o.day + ' ' + o.hour + ':' + o.minute + ':' + o.second };
  }

  // Codigo unico: LP7-AAAAMMDD-NNN (ej. LP7-20261128-482)
  function orderCode(ymd) {
    var used = [];
    try { used = JSON.parse(localStorage.getItem('lp_orders') || '[]'); } catch (e) { used = []; }
    var code, n = 0;
    do {
      var buf = new Uint32Array(1);
      (window.crypto || window.msCrypto).getRandomValues(buf);
      code = 'LP7-' + ymd + '-' + String(100 + (buf[0] % 900));
      n++;
    } while (used.indexOf(code) !== -1 && n < 50);
    try { used.push(code); localStorage.setItem('lp_orders', JSON.stringify(used.slice(-100))); } catch (e) { /* ignore */ }
    return code;
  }

  /* ----------- registro privado del pedido (Google Apps Script -> Google Sheets) ----------- */
  // La URL del script llega en data/config.json (la genera el despliegue desde un Secret). Si no hay URL, no se envia nada.
  var SHEET_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  function pendingGet() { try { var r = JSON.parse(localStorage.getItem('lp_pending') || '[]'); return Array.isArray(r) ? r : []; } catch (e) { return []; } }
  function pendingSet(r) { try { localStorage.setItem('lp_pending', JSON.stringify(r.slice(-5))); } catch (e) { /* ignore */ } }
  function postOrder(rec) {
    // text/plain + no-cors = peticion simple (sin preflight); keepalive la deja terminar aunque el cliente cambie a WhatsApp
    return fetch(publicConfig.pedidos, { method: 'POST', mode: 'no-cors', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(rec) });
  }
  function sendOrder(rec) {
    if (!SHEET_RE.test(publicConfig.pedidos)) return;
    try { postOrder(rec).catch(function () { pendingSet(pendingGet().concat([rec])); }); }
    catch (e) { pendingSet(pendingGet().concat([rec])); }
  }
  // Si un envio fallo (sin senal), se reintenta en la siguiente visita; el script ignora repetidos.
  function flushPending() {
    if (!SHEET_RE.test(publicConfig.pedidos)) return;
    var q = pendingGet(); if (!q.length) return;
    pendingSet([]);
    q.forEach(function (rec) { try { postOrder(rec).catch(function () { pendingSet(pendingGet().concat([rec])); }); } catch (e) { /* ignore */ } });
  }
  function orderRecord(code, when, c, a) {
    var detalle = [];
    a.groups.forEach(function (g) {
      g.items.forEach(function (it) {
        detalle.push(it.qty + ' x ' + it.name + (it.variant ? ' (' + it.variant + ')' : '') + ' — ' + fmt(it.price * it.qty));
      });
    });
    if (a.fleteUnknown) detalle.push('(flete por confirmar)');
    return { codigo: code, fecha: when, nombre: c.nombre, telefono: c.celular, direccion: c.ciudad + ' — ' + c.direccion, detalle: detalle.join('\n'), total: a.total };
  }

  function buildMessage(code, c, a) {
    var L = [];
    L.push('*Pedido #' + code + '* — ' + CONFIG.brand);
    L.push('');
    L.push('*DATOS DE ENVÍO*');
    L.push('Nombre: ' + c.nombre);
    L.push('Celular: ' + c.celular);
    L.push('Ciudad/Depto: ' + c.ciudad);
    L.push('Dirección: ' + c.direccion);
    L.push('Medio de pago preferido: ' + c.pago);
    L.push('Transportadora: ' + CONFIG.carrier + ' (' + CONFIG.eta + ')');
    L.push('');

    var directos = a.groups.filter(function (g) { return g.info.dispatch === 'directo'; });
    var controlados = a.groups.filter(function (g) { return g.info.dispatch === 'controlado'; });
    function block(title, groups) {
      if (!groups.length) return;
      L.push('*' + title + '*');
      groups.forEach(function (g) {
        L.push('📦 ' + g.info.label);
        g.items.forEach(function (it) {
          L.push('  • ' + it.qty + ' x ' + it.name + (it.variant ? ' (' + it.variant + ')' : '') + ' — ' + fmt(it.price * it.qty));
        });
        L.push('  Subtotal: ' + fmt(g.subtotal) + ' · ' + (g.free ? 'ENVÍO GRATIS' : (g.flete != null ? 'Flete: ' + fmt(g.flete) : 'Flete por confirmar')));
      });
      L.push('');
    }
    block('ENVÍO DIRECTO BODEGA', directos);
    block('DESPACHO CONTROLADO IPHONE (pasa por revisión antes de enviarse)', controlados);

    L.push('*CONDICIÓN DE ENVÍO*');
    a.groups.forEach(function (g) {
      if (g.free) L.push('• ' + g.info.short + ': envío gratis (superó ' + fmt(g.info.freeFrom) + '; aplica solo a ese paquete).');
      else L.push('• ' + g.info.short + ': ' + (g.flete != null ? 'flete ' + fmt(g.flete) : 'flete por confirmar según ciudad') + '.');
    });
    if (a.mixedIphone) L.push('⚠ Pedido mixto: se entrega en ' + a.shipments + ' envíos independientes (el iPhone verificado va aparte).');
    else if (a.multi) L.push('⚠ Pedido combinado: ' + a.shipments + ' paquetes independientes; el flete aplica por cada paquete sin envío gratis.');
    L.push('');
    L.push('*Total productos: ' + fmt(a.productsTotal) + '*');
    if (a.fleteKnown) L.push('Fletes conocidos: ' + fmt(a.fleteKnown));
    L.push('*TOTAL A PAGAR: ' + fmt(a.total) + (a.fleteUnknown ? ' + flete por confirmar' : '') + '*');
    L.push('');
    L.push('Hola LuxPoint7, quiero pagar con ' + c.pago + '. Por favor envíenme las cuentas bancarias y les mando el comprobante de pago. ¡Gracias!');
    return L.join('\n').replace(/\u00a0/g, ' ');
  }

  function openCheckout() {
    if (!items.length) return;
    formError.textContent = '';
    successBox.hidden = true;
    form.hidden = false;
    var a = analyze();
    var sum = document.getElementById('co-summary');
    sum.textContent = a.count + ' producto(s) · ' + a.shipments + ' paquete(s) · Total ' + fmt(a.total) + (a.fleteUnknown ? ' + flete' : '');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var fd = new FormData(form);
    var c = {
      nombre: String(fd.get('nombre') || '').trim().replace(/\s+/g, ' '),
      celular: String(fd.get('celular') || '').replace(/[^\d]/g, ''),
      ciudad: String(fd.get('ciudad') || '').trim().replace(/\s+/g, ' '),
      direccion: String(fd.get('direccion') || '').trim().replace(/\s+/g, ' '),
      pago: String(fd.get('pago') || '')
    };
    var err = '';
    if (c.nombre.length < 5 || c.nombre.indexOf(' ') < 0) err = 'Escribe tu nombre completo (nombre y apellido).';
    else if (!/^3\d{9}$/.test(c.celular)) err = 'Escribe un celular colombiano de 10 dígitos (empieza por 3).';
    else if (c.ciudad.length < 4) err = 'Indica ciudad y departamento (ej. Neiva, Huila).';
    else if (c.direccion.length < 8) err = 'Escribe la dirección de entrega completa (con barrio o conjunto).';
    else if (CONFIG.payments.indexOf(c.pago) < 0) err = 'Elige un medio de pago.';
    else if (!/^\d{10,15}$/.test(publicConfig.whatsapp)) err = 'La tienda aún no tiene WhatsApp configurado. Intenta más tarde.';
    if (err) { formError.textContent = err; return; }

    var a = analyze();
    var t = bogota();
    var code = orderCode(t.ymd);
    var url = 'https://wa.me/' + publicConfig.whatsapp + '?text=' + encodeURIComponent(buildMessage(code, c, a));
    var win = window.open(url, '_blank', 'noopener');
    sendOrder(orderRecord(code, t.text, c, a)); // registro silencioso en tu hoja privada
    form.hidden = true;
    successBox.hidden = false;
    document.getElementById('co-code').textContent = '#' + code;
    var link = document.getElementById('co-link');
    link.href = url;
    if (!win) link.focus();
  }

  /* ----------------------- WhatsApp: consultas y boton flotante ---------------- */
  function waUrl(text) { return publicConfig.whatsapp ? 'https://wa.me/' + publicConfig.whatsapp + '?text=' + encodeURIComponent(text) : null; }
  function ask(text) {
    var u = waUrl(text);
    if (u) window.open(u, '_blank', 'noopener');
    else notice('El WhatsApp aún no está disponible. Inténtalo en unos segundos.');
  }
  function showWhatsApp() {
    var fl = document.getElementById('wa-float'), ct = document.getElementById('wa-contact');
    var u = waUrl('Hola LuxPoint7, tengo una pregunta sobre la tienda.');
    if (!u) return;
    if (fl) { fl.href = u; fl.hidden = false; }
    if (ct) { ct.href = u; ct.hidden = false; }
  }

  /* --------------------------------- init ---------------------------------- */
  function init() {
    drawer = document.getElementById('cart');
    overlay = document.getElementById('cart-overlay');
    body = document.getElementById('cart-body');
    footer = document.getElementById('cart-footer');
    badge = document.getElementById('cart-count');
    noticeBox = document.getElementById('cart-notice');
    dlg = document.getElementById('checkout');
    form = document.getElementById('checkout-form');
    formError = document.getElementById('co-error');
    successBox = document.getElementById('co-success');
    var sel = document.getElementById('co-pago');
    CONFIG.payments.forEach(function (p) { sel.appendChild(el('option', { value: p, text: p })); });

    document.getElementById('open-cart').addEventListener('click', open);
    document.getElementById('close-cart').addEventListener('click', close);
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.getElementById('co-cancel').addEventListener('click', function () { dlg.close(); });
    document.getElementById('co-done').addEventListener('click', function () { clear(); dlg.close(); close(); });
    document.getElementById('co-back').addEventListener('click', function () { dlg.close(); });
    form.addEventListener('submit', onSubmit);

    load();
    render();

    // Numero de WhatsApp (lo genera el despliegue desde un Secret; no esta en el repositorio)
    fetch('data/config.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (!j) return; if (j.pedidos && SHEET_RE.test(String(j.pedidos))) { publicConfig.pedidos = String(j.pedidos); flushPending(); } if (j.whatsapp) { publicConfig.whatsapp = String(j.whatsapp).replace(/[^\d]/g, ''); showWhatsApp(); } })
      .catch(function () { /* sin config: el checkout avisara */ });
  }

  window.LPCart = { add: add, ask: ask, setSuggester: function (fn) { suggester = fn; render(); }, reconcile: reconcile, open: open, analyze: analyze, count: function () { return analyze().count; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
