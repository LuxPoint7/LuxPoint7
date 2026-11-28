/* LuxPoint7 - catalogo, filtros y tarjetas (JavaScript puro, sin librerias).
 * Todo texto que viene de proveedores se pinta con textContent (nunca innerHTML),
 * asi un nombre de producto no puede inyectar codigo en la pagina.
 */
(function () {
  'use strict';

  var CFG = window.LP_CONFIG;
  var el = window.LP_el;
  var fmt = window.LP_fmt;
  var PAGE = 24;

  /* ------------------------------ categorias ------------------------------ */
  var CATS = [
    { id: 'all', nav: 'Todo', title: 'Todo LuxPoint7', desc: 'Perfumes, iPhone y tecnología en un solo carrito. Cada categoría se despacha desde su propia bodega.' },
    { id: 'p11', nav: 'Perfumería 1.1 · 100 ml', title: 'Perfumería 1.1 · Frascos de 100 ml', desc: 'Solo frascos de 100 ml. Envío directo desde bodega con remitente LuxPoint7.' },
    { id: 'orig', nav: 'Perfumería Original', title: 'Perfumería Original', desc: '100 % Original Certificado. Árabes, diseñador y nicho, más combos y dúos.' },
    { id: 'iphone', nav: 'iPhone', title: 'iPhone originales · Nuevos y seminuevos', desc: '12 meses de garantía. Despacho controlado: cada equipo pasa por nosotros para revisión antes de llegar a ti.' },
    { id: 'tech', nav: 'Innovación y Accesorios', title: 'Innovación y accesorios de alta calidad', desc: 'Carga rápida, audífonos, smart watch, hogar y gamer a precios competitivos.' }
  ];

  var L = {
    linea: { disenador: 'Diseñador', arabe: 'Árabe', nicho: 'Nicho' },
    gender: { hombre: 'Hombre', mujer: 'Mujer', unisex: 'Unisex' },
    avail: { disp: 'Disponible', agot: 'Agotado' }
  };
  var availDef = { key: 'avail', label: 'Disponibilidad', values: function (p) { return [p.inStock ? 'disp' : 'agot']; }, fmt: function (v) { return L.avail[v]; } };
  function uniq(a) { return a.filter(function (x, i) { return x && a.indexOf(x) === i; }); }
  function sizeNum(s) { var m = /(\d+)\s*(GB|TB)/i.exec(s); return m ? Number(m[1]) * (/TB/i.test(m[2]) ? 1024 : 1) : 0; }

  var FILTERS = {
    all: [availDef],
    p11: [
      { key: 'linea', label: 'Línea', values: function (p) { return [p.linea]; }, fmt: function (v) { return L.linea[v] || v; } },
      { key: 'gender', label: 'Género', values: function (p) { return [p.gender]; }, fmt: function (v) { return L.gender[v] || v; } },
      { key: 'brand', label: 'Marca', scroll: true, values: function (p) { return [p.brand]; } },
      availDef
    ],
    orig: [
      { key: 'tipo', label: 'Tipo', values: function (p) { return [p.tipo]; }, fmt: function (v) { return L.linea[v] || v; } },
      { key: 'gender', label: 'Género', values: function (p) { return [p.gender]; }, fmt: function (v) { return L.gender[v] || v; } },
      { key: 'brand', label: 'Marca', scroll: true, values: function (p) { return [p.brand]; } },
      { key: 'combo', label: 'Combos y dúos', values: function (p) { return [p.combo ? 'si' : 'no']; }, fmt: function (v) { return v === 'si' ? 'Solo combos / estuches / dúos' : 'Perfumes individuales'; } },
      availDef
    ],
    iphone: [
      { key: 'model', label: 'Modelo', scroll: true, numericDesc: true, values: function (p) { return [p.model]; } },
      { key: 'gb', label: 'Capacidad', bySize: true, values: function (p) { return uniq(p.variants.map(function (v) { return v.gb; })); } },
      { key: 'color', label: 'Color', values: function (p) { return uniq(p.variants.map(function (v) { return v.color; })); } },
      { key: 'estado', label: 'Estado', values: function (p) { return uniq(p.variants.map(function (v) { return v.estado; })); } },
      availDef
    ],
    tech: [
      { key: 'subcat', label: 'Subcategoría', values: function (p) { return [p.subcatLabel]; }, order: ['Carga rápida', 'Audífonos', 'Smart Watch', 'Hogar', 'Gamer', 'Otros'] },
      { key: 'oferta', label: 'Ahorro', values: function (p) { return [p.refPrice ? 'si' : 'no']; }, fmt: function (v) { return v === 'si' ? 'Con ahorro vs. precio de referencia' : 'Sin comparación'; } },
      availDef
    ]
  };

  /* -------------------------------- estado -------------------------------- */
  var S = { cat: 'all', q: '', sort: 'rel', sel: {}, shown: PAGE };
  var products = [];
  var ivSel = {}; // seleccion de cada tarjeta iPhone

  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function hay(p) {
    return norm([p.name, p.brand, p.model, p.subcatLabel, p.gender, p.linea, p.tipo].join(' ') + (p.variants ? ' ' + p.variants.map(function (v) { return v.color + ' ' + v.gb; }).join(' ') : ''));
  }

  function selOf(key) { return S.sel[key] || (S.sel[key] = {}); }
  function activeDefs() { return FILTERS[S.cat] || FILTERS.all; }

  function passes(p, skipKey) {
    var defs = activeDefs();
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      if (d.key === skipKey) continue;
      var chosen = Object.keys(selOf(d.key));
      if (!chosen.length) continue;
      var vals = d.values(p);
      if (!vals.some(function (v) { return chosen.indexOf(v) !== -1; })) return false;
    }
    return true;
  }
  function inCat(p) { return S.cat === 'all' || p.cat === S.cat; }
  function matchesQuery(p) {
    if (!S.q) return true;
    var h = p._h || (p._h = hay(p));
    return S.q.split(' ').every(function (t) { return h.indexOf(t) !== -1; });
  }
  function base() { return products.filter(function (p) { return inCat(p) && matchesQuery(p); }); }

  function sorted(list) {
    var a = list.slice();
    if (S.sort === 'asc') a.sort(function (x, y) { return x.price - y.price; });
    else if (S.sort === 'desc') a.sort(function (x, y) { return y.price - x.price; });
    else if (S.sort === 'az') a.sort(function (x, y) { return x.name.localeCompare(y.name, 'es'); });
    else {
      a.sort(function (x, y) { return (y.inStock ? 1 : 0) - (x.inStock ? 1 : 0); });
      if (S.cat === 'all') { // intercala categorias para que "Todo" muestre un poco de cada una
        var buckets = CFG.order.map(function (c) { return a.filter(function (p) { return p.cat === c; }); });
        var out = [];
        for (var i = 0; buckets.some(function (b) { return i < b.length; }); i++) buckets.forEach(function (b) { if (i < b.length) out.push(b[i]); });
        return out;
      }
    }
    return a;
  }

  /* ------------------------------- helpers UI ------------------------------ */
  function imgNode(url, emoji, eager) {
    var ph = function () { return el('span', { class: 'ph', text: emoji }); };
    if (!url || !(/^https:\/\//i.test(url) || /^img\/(?:perfumes|p)\/[a-z0-9._-]+$/i.test(url))) return ph();
    var im = el('img', { src: url, alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    im.addEventListener('error', function () { im.replaceWith(ph()); });
    return im;
  }
  // Si img/logo.png aun no esta subido, se muestra el cuadro "L7" de respaldo
  (function () {
    var lg = document.getElementById('logo-img');
    var fallback = function () { lg.replaceWith(el('span', { class: 'logo-mark', text: 'L7' })); };
    if (lg) { lg.addEventListener('error', fallback); if (lg.complete && lg.naturalWidth === 0) fallback(); }
  })();
  function withBrand(brand, name) { return brand && norm(name).indexOf(norm(brand)) !== 0 ? brand + ' ' + name : name; }
  // Lista que se muestra en cada iPhone. EDÍTALA para que diga exactamente lo que tú revisas.
  var REVISION_IPHONE = [
    'Verificación física y funcional antes del despacho',
  'Registro en video completo del equipo y su empaque protegido',
  'Envío asegurado por Inter Rapidísimo (3 a 6 días hábiles)',
  'Respaldo directo de garantía de 12 meses por fallas internas'
  ];
  var EMOJI = { p11: '🧴', orig: '🧴', iphone: '📱', tech: '🔌' };

  /* ------------------------------- iPhone ---------------------------------- */
  function ivMatchesFilters(v) {
    return ['gb', 'color', 'estado'].every(function (k) {
      var ch = Object.keys(selOf(k));
      return !ch.length || ch.indexOf(v[k]) !== -1;
    });
  }
  function ivState(p) {
    var s = ivSel[p.id];
    if (!s) {
      var pool = p.variants.filter(ivMatchesFilters);
      if (!pool.length) pool = p.variants;
      var v = pool.slice().sort(function (a, b) { return a.price - b.price; })[0];
      s = ivSel[p.id] = { gb: v.gb, color: v.color, estado: v.estado };
    }
    var gbs = uniq(p.variants.map(function (v) { return v.gb; })).sort(function (a, b) { return sizeNum(a) - sizeNum(b); });
    if (gbs.indexOf(s.gb) < 0) s.gb = gbs[0];
    var colors = uniq(p.variants.filter(function (v) { return v.gb === s.gb; }).map(function (v) { return v.color; }));
    if (colors.indexOf(s.color) < 0) s.color = colors[0];
    var estados = uniq(p.variants.filter(function (v) { return v.gb === s.gb && v.color === s.color; }).map(function (v) { return v.estado; }));
    if (estados.indexOf(s.estado) < 0) s.estado = estados[0];
    var v = p.variants.filter(function (x) { return x.gb === s.gb && x.color === s.color && x.estado === s.estado; })
      .sort(function (a, b) { return a.price - b.price; })[0];
    return { s: s, gbs: gbs, colors: colors, estados: estados, v: v };
  }

  /* ------------------- datos de presentacion de un producto ------------------- */
  function view(p) {
    var d = { p: p, name: p.name, brand: p.brand || '', price: p.price, old: null, image: p.image, tags: [], chips: [], cartItem: null, state: null, inStock: p.inStock !== false };
    if (p.cat === 'p11') {
      d.tags.push(['tag-gold', '100 ml']);
      d.chips.push(L.linea[p.linea] || p.linea, L.gender[p.gender]);
      d.cartItem = { key: p.id, cat: p.cat, name: withBrand(d.brand, p.name), variant: '100 ml', price: p.price, image: p.image };
    } else if (p.cat === 'orig') {
      d.tags.push(['tag-green', '100% Original Certificado']);
      if (p.combo) d.tags.push(['tag-gold', 'Combo / Dúo']);
      d.chips.push(L.linea[p.tipo] || p.tipo, L.gender[p.gender]);
      if (p.size) d.chips.push(p.size);
      d.cartItem = { key: p.id, cat: p.cat, name: withBrand(d.brand, p.name), variant: p.size, price: p.price, image: p.image };
    } else if (p.cat === 'iphone') {
      d.state = ivState(p);
      var v = d.state.v;
      d.tags.push(['tag-green', '12 meses de garantía']);
      if (v) {
        d.price = v.price; d.image = v.image || p.image;
        d.cartItem = { key: v.id, cat: p.cat, name: p.model, variant: v.gb + ' · ' + v.color + ' · ' + v.estado + (v.battery ? ' · Batería ' + v.battery + '%' : ''), price: v.price, image: d.image };
      }
    } else if (p.cat === 'tech') {
      d.chips.push(p.subcatLabel);
      if (p.refPrice) { d.old = p.refPrice; d.tags.push(['tag-red', '-' + Math.round((1 - p.price / p.refPrice) * 100) + '%']); }
      d.cartItem = { key: p.id, cat: p.cat, name: p.name, variant: '', price: p.price, image: p.image };
    }
    return d;
  }

  /* -------------------------------- tarjeta -------------------------------- */
  // Tarjeta limpia: foto, marca, nombre y precio. Todo lo demas esta en la vista rapida (al hacer clic).
  function card(p) {
    var d = p.cat === 'iphone' ? { name: p.model, brand: p.brand || 'Apple', price: p.price, image: p.image, tags: [['tag-green', '12 meses de garantía']], old: null } : view(p);
    var node = el('article', { class: 'card' + (p.inStock ? '' : ' soldout'), 'data-id': p.id, tabindex: '0', role: 'button', 'aria-label': 'Ver detalle de ' + d.name });
    var tags = el('div', { class: 'card-tags' });
    d.tags.forEach(function (t) { tags.appendChild(el('span', { class: 'tag ' + t[0], text: t[1] })); });
    if (!p.inStock) tags.appendChild(el('span', { class: 'tag tag-red', text: 'Agotado' }));
    node.appendChild(el('div', { class: 'card-img' }, imgNode(d.image, EMOJI[p.cat]), tags));
    var pr = el('div', { class: 'price-row' });
    if (p.cat === 'iphone' && p.variants.length > 1) pr.appendChild(el('span', { class: 'price-from', text: 'Desde' }));
    pr.appendChild(el('span', { class: 'price', text: fmt(d.price) }));
    if (d.old) pr.appendChild(el('span', { class: 'price-old', title: 'Precio de referencia del mercado', text: fmt(d.old) }));
    node.appendChild(el('div', { class: 'card-body' },
      el('div', { class: 'card-brand', text: p.cat === 'tech' ? '' : d.brand }),
      el('h3', { class: 'card-name', text: d.name }),
      pr));
    node.addEventListener('click', function () { openQuick(p); });
    node.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuick(p); } });
    return node;
  }

  /* ------------------------ vista rapida (ventana) ------------------------ */
  var qv, qvBody, qvProduct = null;
  function shareUrl(id) { return location.origin + location.pathname + '#p=' + encodeURIComponent(id); }
  function restoreHash() {
    try { history.replaceState(null, '', S.cat === 'all' ? location.pathname : '#c=' + S.cat); } catch (e) { /* ignore */ }
  }

  function renderQuick() {
    var p = qvProduct;
    if (!p) return;
    var d = view(p);
    qvBody.textContent = '';
    var tags = el('div', { class: 'card-tags' });
    d.tags.forEach(function (t) { tags.appendChild(el('span', { class: 'tag ' + t[0], text: t[1] })); });
    if (p.cat === 'iphone' && d.state.v) tags.appendChild(el('span', { class: 'tag' + (d.state.v.estado === 'Nuevo' ? ' tag-gold' : ''), text: d.state.v.estado }));
    if (!d.inStock) tags.appendChild(el('span', { class: 'tag tag-red', text: 'Agotado' }));
    var media = el('div', { class: 'qv-media' }, imgNode(d.image, EMOJI[p.cat], true), tags);

    var info = el('div', { class: 'qv-info' });
    if (d.brand && p.cat !== 'tech') info.appendChild(el('div', { class: 'card-brand', text: d.brand }));
    info.appendChild(el('h2', { class: 'qv-title', text: p.cat === 'iphone' ? p.model : p.name }));
    var pr = el('div', { class: 'price-row' }, el('span', { class: 'price', text: fmt(d.price) }));
    if (d.old) {
      pr.appendChild(el('span', { class: 'price-old', title: 'Precio de referencia del mercado', text: fmt(d.old) }));
      pr.appendChild(el('span', { class: 'save', text: 'Ahorras ' + fmt(d.old - d.price) }));
    }
    info.appendChild(pr);

    var chips = el('div', { class: 'badge-row' });
    d.chips.forEach(function (c) { if (c) chips.appendChild(el('span', { class: 'chip', text: c })); });

    if (d.state) { // selectores dinamicos del iPhone
      var s = d.state;
      var make = function (label, key, opts, wide) {
        var sel = el('select', { 'aria-label': label });
        opts.forEach(function (o) { var op = el('option', { value: o, text: o }); if (o === s.s[key]) op.selected = true; sel.appendChild(op); });
        sel.addEventListener('change', function () { ivSel[p.id][key] = sel.value; renderQuick(); });
        return el('label', { class: wide ? 'wide' : '' }, label, sel);
      };
      info.appendChild(el('div', { class: 'selectors' },
        make('Capacidad', 'gb', s.gbs),
        make('Estado', 'estado', uniq(p.variants.filter(function (x) { return x.gb === s.s.gb && x.color === s.s.color; }).map(function (x) { return x.estado; }))),
        make('Color', 'color', s.colors, true)));
      if (s.v) chips.appendChild(el('span', { class: 'chip chip-ok', text: s.v.battery ? 'Batería ' + s.v.battery + '%' : (s.v.estado === 'Nuevo' ? 'Equipo nuevo' : 'Batería: consultar') }));
    }
    if (chips.childNodes.length) info.appendChild(chips);

    // Stock
    var stock;
    if (d.state) {
      var same = p.variants.filter(function (x) { return x.gb === d.state.s.gb && x.color === d.state.s.color && x.estado === d.state.s.estado && x.inStock !== false; }).length;
      stock = same ? '✔ ' + same + (same === 1 ? ' unidad disponible' : ' unidades disponibles') + ' de esta configuración · ' + p.variants.length + ' en total del modelo' : 'Sin unidades de esta configuración';
    } else stock = d.inStock ? '✔ Disponible' : 'Agotado por ahora';
    info.appendChild(el('div', { class: 'qv-stock' + (d.inStock ? '' : ' qv-stock-out'), text: stock }));

    var ship = el('div', { class: 'ship' }, el('span', { text: '🚚 ' + CFG.carrier + ' · ' + CFG.eta }),
      el('span', { text: p.cat === 'iphone' ? 'Despacho controlado: lo revisamos antes de enviártelo' : 'Envío directo desde bodega · remitente LuxPoint7' }));
    if (p.cat === 'orig' && CFG.providers.orig.freeFrom) ship.appendChild(el('span', { text: '🎁 Envío gratis desde ' + fmt(CFG.providers.orig.freeFrom) + ' en Perfumería Original' }));
    info.appendChild(ship);

    if (p.cat === 'iphone') {
      var rev = el('details', { class: 'revision' }, el('summary', { text: '✔ Revisado por LuxPoint7' }));
      var ul = el('ul'); REVISION_IPHONE.forEach(function (t) { ul.appendChild(el('li', { text: t })); });
      rev.appendChild(ul); info.appendChild(rev);
    }

    var disabled = !d.inStock || !d.cartItem;
    info.appendChild(el('div', { class: 'qv-actions' },
      el('button', { type: 'button', class: 'btn btn-primary', disabled: disabled ? true : null,
        onclick: function () { var it = d.cartItem; qv.close(); window.LPCart.add(it); } }, disabled ? 'Agotado' : '🛒 Agregar al carrito'),
      el('button', { type: 'button', class: 'btn btn-wa', onclick: function () {
        var ci = d.cartItem || { name: p.name, variant: '' };
        window.LPCart.ask('Hola LuxPoint7, quiero información de: ' + ci.name + (ci.variant ? ' (' + ci.variant + ')' : '') + ' — ' + fmt(d.price) + '.');
      } }, '💬 Preguntar por este producto')));

    // Compartir
    var url = shareUrl(p.id);
    var inp = el('input', { type: 'text', readonly: 'readonly', value: url, 'aria-label': 'Enlace para compartir este producto' });
    inp.addEventListener('focus', function () { inp.select(); });
    var shareBtn = el('button', { type: 'button', class: 'btn btn-outline' }, navigator.share ? '🔗 Compartir' : '🔗 Copiar enlace');
    shareBtn.addEventListener('click', function () {
      var done = function () { shareBtn.textContent = '¡Enlace copiado!'; setTimeout(function () { shareBtn.textContent = navigator.share ? '🔗 Compartir' : '🔗 Copiar enlace'; }, 1800); };
      if (navigator.share) { navigator.share({ title: 'LuxPoint7 · ' + d.name, url: url }).catch(function () { /* cancelado */ }); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { inp.select(); });
      else { inp.select(); try { document.execCommand('copy'); done(); } catch (e) { /* el usuario copia a mano */ } }
    });
    info.appendChild(el('div', { class: 'qv-share' }, inp, shareBtn));

    qvBody.appendChild(el('div', { class: 'qv-grid' }, media, info));
  }

  function openQuick(p) {
    qvProduct = p;
    renderQuick();
    try { history.replaceState(null, '', '#p=' + encodeURIComponent(p.id)); } catch (e) { /* ignore */ }
    if (!qv.open) qv.showModal();
    qv.scrollTop = 0;
  }
  function openFromHash() {
    var m = /#p=([^&]+)/.exec(location.hash);
    if (!m) return false;
    var id; try { id = decodeURIComponent(m[1]); } catch (e) { return false; }
    var p = products.filter(function (x) { return x.id === id; })[0];
    if (!p) return false;
    if (S.cat !== 'all' && S.cat !== p.cat) setCat(p.cat);
    openQuick(p);
    return true;
  }

  /* ------------------------------ render lista ------------------------------ */
  function renderGrid() {
    var list = sorted(base().filter(function (p) { return passes(p); }));
    var grid = document.getElementById('grid');
    grid.textContent = '';
    var frag = document.createDocumentFragment();
    list.slice(0, S.shown).forEach(function (p) { frag.appendChild(card(p)); });
    grid.appendChild(frag);
    if (!list.length) grid.appendChild(el('p', { class: 'muted', text: 'No encontramos productos con esos filtros. Prueba quitando alguno o cambiando la búsqueda.' }));
    document.getElementById('result-count').textContent = list.length + (list.length === 1 ? ' producto' : ' productos');
    document.getElementById('more').hidden = list.length <= S.shown;
  }

  function renderFilters() {
    var box = document.getElementById('filters-body');
    var focusId = document.activeElement && document.activeElement.id;
    box.textContent = '';
    var pool = base();
    activeDefs().forEach(function (d) {
      var counts = {};
      pool.filter(function (p) { return passes(p, d.key); }).forEach(function (p) { d.values(p).forEach(function (v) { if (v) counts[v] = (counts[v] || 0) + 1; }); });
      var keys = Object.keys(counts);
      if (d.order) keys.sort(function (a, b) { return d.order.indexOf(a) - d.order.indexOf(b); });
      else if (d.bySize) keys.sort(function (a, b) { return sizeNum(a) - sizeNum(b); });
      else if (d.numericDesc) keys.sort(function (a, b) { return b.localeCompare(a, 'es', { numeric: true }); });
      else keys.sort(function (a, b) { return a.localeCompare(b, 'es'); });
      if (!keys.length) return;
      var wrap = el('div', { class: d.scroll ? 'fscroll' : '' });
      keys.forEach(function (k, i) {
        var id = 'f-' + d.key + '-' + i;
        var cb = el('input', { type: 'checkbox', id: id });
        cb.checked = !!selOf(d.key)[k];
        cb.addEventListener('change', function () {
          var s = selOf(d.key);
          if (cb.checked) s[k] = true; else delete s[k];
          S.shown = PAGE; ivSel = {}; renderFilters(); renderGrid();
        });
        wrap.appendChild(el('label', { class: 'fopt', for: id }, cb, el('span', { text: d.fmt ? d.fmt(k) : k }), el('span', { class: 'n', text: String(counts[k]) })));
      });
      box.appendChild(el('div', { class: 'fgroup' }, el('h3', { text: d.label }), wrap));
    });
    if (!box.childNodes.length) box.appendChild(el('p', { class: 'finfo', text: 'No hay filtros para esta búsqueda.' }));
    if (focusId) { var f = document.getElementById(focusId); if (f) f.focus(); }
  }

  function renderNav() {
    var nav = document.getElementById('catnav');
    nav.textContent = '';
    CATS.forEach(function (c) {
      var b = el('button', { type: 'button', text: c.nav, 'aria-current': c.id === S.cat ? 'true' : 'false' });
      b.addEventListener('click', function () { setCat(c.id); });
      nav.appendChild(b);
    });
  }
  function renderInfo() {
    var c = CATS.filter(function (x) { return x.id === S.cat; })[0];
    var box = document.getElementById('catinfo');
    box.textContent = '';
    box.appendChild(el('h1', { text: c.title }));
    box.appendChild(el('p', { text: c.desc }));
  }

  function setCat(id) {
    S.cat = id; S.sel = {}; S.shown = PAGE; ivSel = {};
    if (!(qv && qv.open)) { try { history.replaceState(null, '', id === 'all' ? location.pathname : '#c=' + id); } catch (e) { /* ignore */ } }
    renderNav(); renderInfo(); renderFilters(); renderGrid();
    document.getElementById('filters').classList.remove('open');
  }

  /* --------------------------------- carga ---------------------------------- */
  function load() {
    fetch('data/products.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        products = (d.products || []).filter(function (p) { return p && p.id && p.price > 0; });
        if (d.demo) {
          var b = document.getElementById('demo-banner');
          b.textContent = 'Estás viendo productos de demostración. Cuando se ejecute la sincronización con los proveedores aparecerá el inventario real.';
          b.hidden = false;
        }
        if (d.updatedAt) {
          var dt = new Date(d.updatedAt);
          document.getElementById('updated').textContent = 'Inventario actualizado: ' + dt.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
        }
        // Le dice al carrito los precios/stock vigentes (por clave de item)
        var map = new Map();
        products.forEach(function (p) {
          if (p.variants) p.variants.forEach(function (v) { map.set(v.id, { price: v.price, inStock: v.inStock !== false }); });
          else map.set(p.id, { price: p.price, inStock: p.inStock !== false });
        });
        window.LPCart.reconcile(map);
        // Accesorios sugeridos al comprar un iPhone: los mas baratos (desde $15.000), con foto primero, de 3 subcategorias
        window.LPCart.setSuggester(function () {
          var out = [];
          ['Carga rápida', 'Audífonos', 'Smart Watch'].forEach(function (sc) {
            var c = products.filter(function (p) { return p.cat === 'tech' && p.inStock !== false && p.subcatLabel === sc && p.price >= 15000; })
              .sort(function (x, y) { return (y.image ? 1 : 0) - (x.image ? 1 : 0) || (y.refPrice ? 1 : 0) - (x.refPrice ? 1 : 0) || x.price - y.price; })[0];
            if (c) out.push({ key: c.id, cat: 'tech', name: c.name, variant: '', price: c.price, image: c.image });
          });
          return out;
        });
        var m = /#c=(\w+)/.exec(location.hash);
        var start = m && CATS.some(function (c) { return c.id === m[1]; }) ? m[1] : 'all';
        var pm = /#p=([^&]+)/.exec(location.hash), hashP = pm ? pm[0] : null;
        setCat(start);
        if (hashP) { try { history.replaceState(null, '', hashP); } catch (e) { /* ignore */ } openFromHash(); }
      })
      .catch(function () {
        document.getElementById('grid').appendChild(el('p', { class: 'muted', text: 'No pudimos cargar el catálogo en este momento. Recarga la página en unos minutos.' }));
      });
  }

  function init() {
    var q = document.getElementById('q');
    var t;
    q.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { S.q = norm(q.value).trim().replace(/\s+/g, ' '); S.shown = PAGE; renderFilters(); renderGrid(); }, 150);
    });
    document.getElementById('search-form').addEventListener('submit', function (e) { e.preventDefault(); });
    document.getElementById('sort').addEventListener('change', function (e) { S.sort = e.target.value; S.shown = PAGE; renderGrid(); });
    document.getElementById('more').addEventListener('click', function () { S.shown += PAGE; renderGrid(); });
    document.getElementById('filters-clear').addEventListener('click', function () { S.sel = {}; S.shown = PAGE; ivSel = {}; renderFilters(); renderGrid(); });
    document.getElementById('filters-toggle').addEventListener('click', function () { document.getElementById('filters').classList.toggle('open'); });
    var close = el('button', { type: 'button', class: 'icon-btn filters-close', 'aria-label': 'Cerrar filtros' }, '✕');
    close.addEventListener('click', function () { document.getElementById('filters').classList.remove('open'); });
    document.querySelector('.filters-head').appendChild(close);
    qv = document.getElementById('qv'); qvBody = document.getElementById('qv-body');
    document.getElementById('qv-close').addEventListener('click', function () { qv.close(); });
    qv.addEventListener('click', function (e) { if (e.target === qv) qv.close(); }); // clic fuera de la ventana
    qv.addEventListener('close', function () { qvProduct = null; restoreHash(); });
    window.addEventListener('hashchange', function () { if (!openFromHash() && qv.open && !/#p=/.test(location.hash)) qv.close(); });
    renderNav(); renderInfo();
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
