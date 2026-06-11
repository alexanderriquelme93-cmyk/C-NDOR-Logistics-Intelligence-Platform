'use strict';

/* ============================================================
   Cotizador de Embarque — Nacional / Internacional
   Internacional: costo desde base histórica (USD/kg), SLA por región.
   Nacional: costo desde tarifario DSV por ruta, SLA local por ciudad.
   ============================================================ */

const fmtInt = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
const fmtDec = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 });
const fmtMoney = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
const fmtUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Factor de peso volumétrico (kg/m³) por vía internacional.
const VOLUMETRIC_FACTOR = { 'Aéreo': 167, 'Courier': 200, 'Marítimo': 1000, _default: 250 };

let DATA = null;
let usdClp = null;
let mode = 'intl';      // 'intl' | 'nac'
let bultos = [];
let nextId = 1;

/* ---------- Init ---------- */
function on(id, evt, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

async function init() {
  try {
    const res = await fetch('data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    showBanner(`No se pudo cargar <strong>data.json</strong>. Verifica que exista, sea JSON válido y que el sitio se sirva por HTTP. Detalle: ${err.message}`, 'error');
    return;
  }

  on('addBulto', 'click', () => { addBulto(); render(); });
  on('modeIntl', 'click', () => setMode('intl'));
  on('modeNac', 'click', () => setMode('nac'));
  on('modeCub', 'click', () => setMode('cub'));
  on('addCubBulto', 'click', () => { addCubBulto(); renderCub(); });
  on('cubUnidad', 'change', () => { onCubUnidadChange(); });
  on('cubRuta', 'change', () => { computeCubicaje(); });

  loadFx();
  try { if (DATA.cubicaje) setupCubicaje(); } catch (e) { console.error('Cubicaje no disponible:', e); }
  setMode('intl');
}

function setMode(m) {
  mode = m;
  const mi = document.getElementById('modeIntl'), mn = document.getElementById('modeNac'), mc = document.getElementById('modeCub');
  if (mi) { mi.classList.toggle('active', m === 'intl'); mi.setAttribute('aria-selected', m === 'intl'); }
  if (mn) { mn.classList.toggle('active', m === 'nac'); mn.setAttribute('aria-selected', m === 'nac'); }
  if (mc) { mc.classList.toggle('active', m === 'cub'); mc.setAttribute('aria-selected', m === 'cub'); }

  const isCub = m === 'cub';
  const qv = document.getElementById('quoterView'), cv = document.getElementById('cubicajeView');
  if (qv) qv.hidden = isCub;
  if (cv) cv.hidden = !isCub;
  if (isCub) { renderCub(); return; }

  document.getElementById('introText').innerHTML = m === 'intl'
    ? 'Carga internacional. Origen, consignante y aduana provienen de la base real. El costo se estima con el <strong>factor logístico 2026</strong> sobre el valor CIF (USD), por vía y país. El tránsito sale del <strong>SLA 2026</strong> según la región de origen. La factorización aplica solo a destino Chile y valor &lt; USD 10.000.'
    : 'Carga nacional (solo transporte terrestre). Ingresa peso y dimensiones: el sistema <strong>sugiere el camión</strong> (entre los que tienen tarifa en la ruta) y el % de ocupación. Tarifas del <strong>tarifario DSV</strong> (Normal, Urgencia o IMO); el tránsito sale del <strong>SLA local 2026</strong> por ciudad destino.';

  buildHead();
  bultos = [];
  nextId = 1;
  addBulto();
  render();
}

/* ---------- Encabezados según modo ---------- */
function buildHead() {
  const head = document.getElementById('bultosHead');
  const cols = mode === 'intl'
    ? ['Vía', 'Origen (país)', 'Consignante', 'Aduana', 'Método', 'Valor CIF (USD)', 'Peso (kg)', 'Dim. L×A×H (cm)', 'Vol. (m³)', 'Cant.', 'Costo est.', 'Tránsito', '']
    : ['Origen', 'Destino', 'Peso (kg)', 'Dim. L×A×H (cm)', 'Vehículo sugerido', 'Servicio', 'Tipo carga', 'Cant.', 'Costo est.', 'Tránsito', ''];
  head.innerHTML = '<tr>' + cols.map((c, i) => {
    const numClass = (mode === 'intl' && [5, 6, 8, 9, 10, 11].includes(i)) || (mode === 'nac' && [2, 7, 8, 9].includes(i)) ? ' class="num"' : '';
    return `<th${numClass}>${c}</th>`;
  }).join('') + '</tr>';
}

/* ---------- Helpers de datos ---------- */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Internacional
function viasIntl() { return DATA.internacional.vias.slice(); }
function paisesDe(via) { return Object.keys(DATA.internacional.tree[via] || {}).sort(); }
function consignantesDe(via, pais) { return (DATA.internacional.tree[via]?.[pais] || []).slice(); }
function aduanas() { return DATA.internacional.aduanas.slice(); }
function factorDe(via, pais) {
  const tabla = DATA.internacional.factores[via] || {};
  return tabla[pais] ?? DATA.internacional.factorGenerico;
}
function slaIntl(via, pais) {
  const region = DATA.internacional.paisRegion[pais] || 'South America';
  const tabla = DATA.sla.internacional[via] || {};
  if (via === 'Courier') return tabla['Any Origin'] ?? null;
  return tabla[region] ?? null;
}

// Nacional (DSV) — base, urgencia o IMO
function tarifarioNac(servicio) {
  if (servicio === 'Urgencia') return DATA.nacionalDSV.urgencia;
  if (servicio === 'IMO') return DATA.nacionalDSV.imo;
  return DATA.nacionalDSV.base;
}
function origenesNac(servicio) { return [...new Set(tarifarioNac(servicio).map(r => r.origen))].sort(); }
function destinosNacDe(origen, servicio) { return [...new Set(tarifarioNac(servicio).filter(r => r.origen === origen).map(r => r.destino))].sort(); }
function rutaNac(origen, destino, servicio) { return tarifarioNac(servicio).find(r => r.origen === origen && r.destino === destino) || null; }
function vehiculosRuta(origen, destino, servicio) { const r = rutaNac(origen, destino, servicio); return r ? Object.keys(r.tarifas) : []; }
function tarifaNac(origen, destino, vehiculo, servicio) { const r = rutaNac(origen, destino, servicio); return r ? (r.tarifas[vehiculo] ?? null) : null; }
function capacidad(veh) { return (DATA.nacionalDSV.capacidades || {})[veh] || null; }
// recomienda el camión más pequeño (con tarifa en la ruta) que alcance para peso y volumen
function recomendarVehiculo(origen, destino, servicio, pesoReal, vol) {
  const disponibles = vehiculosRuta(origen, destino, servicio);
  if (!disponibles.length) return null;
  const orden = DATA.nacionalDSV.vehiculos.filter(v => disponibles.includes(v)); // menor a mayor
  for (const v of orden) {
    const cap = capacidad(v);
    if (!cap) continue;
    if (pesoReal <= cap.kg && vol <= cap.m3) return v;
  }
  return orden[orden.length - 1]; // si nada alcanza, el mayor disponible
}
function slaLocal(tipoCarga, ciudad) {
  const tabla = DATA.sla.local[tipoCarga] || {};
  // mapear destino DSV (puede ser faena minera) a la ciudad del SLA
  const ciudadSla = (DATA.destSlaMap && DATA.destSlaMap[ciudad]) || ciudad;
  if (tabla[ciudadSla] != null) return tabla[ciudadSla];
  for (const c of Object.keys(tabla)) {
    if (ciudadSla.toLowerCase().includes(c.toLowerCase())) return tabla[c];
  }
  return null;
}

/* ---------- Lista de bultos ---------- */
function addBulto() {
  if (mode === 'intl') {
    const via = viasIntl()[0] || '';
    const pais = paisesDe(via)[0] || '';
    const cons = consignantesDe(via, pais)[0] || '';
    bultos.push({ id: nextId++, via, pais, cons, aduana: aduanas()[0] || '', metodo: 'factor', valor: '', peso: '', L: '', W: '', H: '', vol: '', cant: 1 });
  } else {
    const servicio = 'Normal';
    const origen = origenesNac(servicio)[0] || '';
    const destino = destinosNacDe(origen, servicio)[0] || '';
    bultos.push({ id: nextId++, origen, destino, servicio, tipoCarga: 'General', peso: '', L: '', W: '', H: '', vol: '', cant: 1 });
  }
}

function removeBulto(id) {
  bultos = bultos.filter(b => b.id !== id);
  if (bultos.length === 0) addBulto();
  render();
}

function render() {
  const body = document.getElementById('bultosBody');
  body.innerHTML = '';
  bultos.forEach(b => body.appendChild(mode === 'intl' ? rowIntl(b) : rowNac(b)));
  recompute();
}

/* ---------- Fila Internacional ---------- */
function rowIntl(b) {
  const tr = document.createElement('tr');
  tr.dataset.id = b.id;

  // Vía
  const tdVia = td();
  const viaSel = selectInput(viasIntl(), b.via, v => {
    b.via = v;
    const ps = paisesDe(v); if (!ps.includes(b.pais)) b.pais = ps[0] || '';
    const cs = consignantesDe(v, b.pais); if (!cs.includes(b.cons)) b.cons = cs[0] || '';
    render();
  });
  tdVia.appendChild(viaSel);

  // País
  const tdPais = td();
  tdPais.appendChild(selectInput(paisesDe(b.via), b.pais, v => {
    b.pais = v;
    const cs = consignantesDe(b.via, v); if (!cs.includes(b.cons)) b.cons = cs[0] || '';
    render();
  }));

  // Consignante
  const tdCons = td('col-wide');
  tdCons.appendChild(selectInput(consignantesDe(b.via, b.pais), b.cons, v => { b.cons = v; }));

  // Aduana
  const tdAdu = td();
  tdAdu.appendChild(selectInput(aduanas(), b.aduana, v => { b.aduana = v; }));

  // Método de costo: factor (valor CIF) o kilos (USD/kg)
  const tdMet = td();
  tdMet.appendChild(selectInput(['factor', 'kilos'], b.metodo, v => { b.metodo = v; recompute(); }));

  // Valor CIF (USD) — base de la factorización
  const tdValor = td('num');
  const valorInput = numInput(b.valor, '0', v => { b.valor = v; recompute(); });
  tdValor.appendChild(valorInput);

  // Peso
  const tdPeso = td('num');
  tdPeso.appendChild(numInput(b.peso, '0', v => { b.peso = v; recompute(); }));

  // Volumen (auto)
  const tdVol = td('num');
  const volInput = numInput(b.vol, '0', v => { b.vol = v; recompute(); });
  tdVol.appendChild(volInput);
  const syncVol = () => {
    const L = num(b.L), W = num(b.W), H = num(b.H);
    if (L && W && H) { b.vol = +((L * W * H) / 1e6).toFixed(3); volInput.value = b.vol; volInput.readOnly = true; volInput.title = 'Calculado desde dimensiones'; }
    else { volInput.readOnly = false; volInput.title = ''; }
    recompute();
  };

  // Dimensiones
  const tdDims = td();
  const wrap = document.createElement('div'); wrap.className = 'dims-cell';
  wrap.append(numInput(b.L, 'L', v => { b.L = v; syncVol(); }), sep('×'), numInput(b.W, 'A', v => { b.W = v; syncVol(); }), sep('×'), numInput(b.H, 'H', v => { b.H = v; syncVol(); }));
  tdDims.appendChild(wrap);
  if (num(b.L) && num(b.W) && num(b.H)) { volInput.value = b.vol; volInput.readOnly = true; }

  // Cantidad
  const tdCant = td('num col-cant');
  const ci = numInput(b.cant, '1', v => { b.cant = v; recompute(); }); ci.min = '1';
  tdCant.appendChild(ci);

  const tdCost = costCell(), tdTransit = transitCell(), tdDel = delCell(b.id);

  tr.append(tdVia, tdPais, tdCons, tdAdu, tdMet, tdValor, tdPeso, tdDims, tdVol, tdCant, tdCost, tdTransit, tdDel);
  return tr;
}

/* ---------- Fila Nacional ---------- */
function rowNac(b) {
  const tr = document.createElement('tr');
  tr.dataset.id = b.id;

  // Origen
  const tdOri = td('col-wide');
  tdOri.appendChild(selectInput(origenesNac(b.servicio), b.origen, v => {
    b.origen = v;
    const ds = destinosNacDe(v, b.servicio); if (!ds.includes(b.destino)) b.destino = ds[0] || '';
    render();
  }));

  // Destino
  const tdDes = td('col-wide');
  tdDes.appendChild(selectInput(destinosNacDe(b.origen, b.servicio), b.destino, v => {
    b.destino = v;
    render();
  }));

  // Peso
  const tdPeso = td('num');
  tdPeso.appendChild(numInput(b.peso, '0', v => { b.peso = v; recompute(); }));

  // Dimensiones (para recomendar camión)
  const tdDims = td();
  const wrap = document.createElement('div'); wrap.className = 'dims-cell';
  const syncVol = () => {
    const L = num(b.L), W = num(b.W), H = num(b.H);
    b.vol = (L && W && H) ? +((L * W * H) / 1e6).toFixed(3) : 0;
    recompute();
  };
  wrap.append(numInput(b.L, 'L', v => { b.L = v; syncVol(); }), sep('×'), numInput(b.W, 'A', v => { b.W = v; syncVol(); }), sep('×'), numInput(b.H, 'H', v => { b.H = v; syncVol(); }));
  tdDims.appendChild(wrap);

  // Vehículo sugerido (se rellena en recompute)
  const tdVeh = td('col-wide');
  const vehSpan = document.createElement('span');
  vehSpan.dataset.role = 'veh'; vehSpan.className = 'cell-veh'; vehSpan.textContent = '—';
  tdVeh.appendChild(vehSpan);

  // Servicio: Normal / Urgencia / IMO
  const tdServ = td();
  tdServ.appendChild(selectInput(['Normal', 'Urgencia', 'IMO'], b.servicio, v => {
    b.servicio = v;
    const os = origenesNac(v); if (!os.includes(b.origen)) b.origen = os[0] || '';
    const ds = destinosNacDe(b.origen, v); if (!ds.includes(b.destino)) b.destino = ds[0] || '';
    render();
  }));

  // Tipo de carga (afecta SLA local)
  const tdTipo = td();
  tdTipo.appendChild(selectInput(['General', 'Sobredimensionado sin escolta', 'Sobredimensionado con escolta'], b.tipoCarga, v => { b.tipoCarga = v; recompute(); }));

  // Cantidad
  const tdCant = td('num col-cant');
  const ci = numInput(b.cant, '1', v => { b.cant = v; recompute(); }); ci.min = '1';
  tdCant.appendChild(ci);

  const tdCost = costCell(), tdTransit = transitCell(), tdDel = delCell(b.id);

  tr.append(tdOri, tdDes, tdPeso, tdDims, tdVeh, tdServ, tdTipo, tdCant, tdCost, tdTransit, tdDel);
  return tr;
}

/* ---------- Celdas compartidas ---------- */
function costCell() { const c = td('num'); const s = document.createElement('span'); s.className = 'cell-cost'; s.dataset.role = 'cost'; s.textContent = '—'; c.appendChild(s); return c; }
function transitCell() { const c = td('num'); const s = document.createElement('span'); s.className = 'cell-transit'; s.dataset.role = 'transit'; s.textContent = '—'; c.appendChild(s); return c; }
function delCell(id) { const c = td('num'); const b = document.createElement('button'); b.type = 'button'; b.className = 'row-del'; b.textContent = '×'; b.setAttribute('aria-label', 'Eliminar bulto'); b.addEventListener('click', () => removeBulto(id)); c.appendChild(b); return c; }

function td(cls) { const c = document.createElement('td'); if (cls) c.className = cls; return c; }
function sep(t) { const s = document.createElement('span'); s.textContent = t; return s; }
function selectInput(options, selected, onChange) {
  const sel = document.createElement('select');
  (options.length ? options : ['—']).forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; if (v === selected) o.selected = true; sel.appendChild(o); });
  sel.addEventListener('change', e => onChange(e.target.value));
  return sel;
}
function numInput(value, placeholder, onInput) {
  const i = document.createElement('input');
  i.type = 'number'; i.min = '0'; i.step = 'any'; i.value = value; i.placeholder = placeholder; i.inputMode = 'decimal';
  i.addEventListener('input', e => onInput(e.target.value));
  return i;
}

/* ---------- Cálculo ---------- */
function computeIntl(b) {
  const cant = Math.max(1, num(b.cant) || 1);
  const pesoReal = num(b.peso);
  let vol = num(b.vol);
  if (!vol && num(b.L) && num(b.W) && num(b.H)) vol = (num(b.L) * num(b.W) * num(b.H)) / 1e6;
  const factorVol = VOLUMETRIC_FACTOR[b.via] ?? VOLUMETRIC_FACTOR._default;
  const billableUnit = Math.max(pesoReal, vol * factorVol);

  let costUsdUnit = 0, aviso = false, vacio = true;
  if (b.metodo === 'kilos') {
    // Costo = peso facturable × USD/kg histórico
    const usdKg = (DATA.internacional.viaCost || {})[b.via] || 0;
    costUsdUnit = billableUnit * usdKg;
    vacio = !pesoReal && !vol;
  } else {
    // Costo = Valor CIF (USD) × factor logístico (por vía + país)
    const valor = num(b.valor);
    const factorLog = factorDe(b.via, b.pais);
    costUsdUnit = valor * factorLog;
    aviso = valor >= (DATA.internacional.valorMax || 10000);
    vacio = !valor;
  }
  const costClpUnit = usdClp ? costUsdUnit * usdClp : null;

  return {
    cant, pesoReal: pesoReal * cant, volumen: vol * cant,
    billable: billableUnit * cant,
    costUsd: costUsdUnit * cant,
    costClp: costClpUnit != null ? costClpUnit * cant : null,
    slaDias: slaIntl(b.via, b.pais),
    aviso,
    empty: vacio
  };
}

function computeNac(b) {
  const cant = Math.max(1, num(b.cant) || 1);
  const pesoReal = num(b.peso);
  let vol = num(b.vol);
  if (!vol && num(b.L) && num(b.W) && num(b.H)) vol = (num(b.L) * num(b.W) * num(b.H)) / 1e6;

  const veh = recomendarVehiculo(b.origen, b.destino, b.servicio, pesoReal, vol);
  const tarifa = veh ? tarifaNac(b.origen, b.destino, veh, b.servicio) : null;
  const cap = veh ? capacidad(veh) : null;
  // ocupación = el mayor entre % peso y % volumen
  let ocup = null;
  if (cap) {
    const okg = cap.kg ? (pesoReal / cap.kg) * 100 : 0;
    const om3 = cap.m3 ? (vol / cap.m3) * 100 : 0;
    ocup = Math.max(okg, om3);
  }
  return {
    cant, pesoReal: pesoReal * cant, volumen: vol * cant, billable: pesoReal * cant,
    costUsd: usdClp && tarifa != null ? (tarifa * cant) / usdClp : null,
    costClp: tarifa != null ? tarifa * cant : null,
    slaDias: slaLocal(b.tipoCarga, b.destino),
    veh, ocup,
    aviso: false,
    empty: !pesoReal && !vol
  };
}

function recompute() {
  let totalClp = 0, totalUsd = 0, totalBill = 0, totalVol = 0, totalReal = 0, totalPieces = 0;
  let maxSla = null, anyData = false, anyClp = false;

  document.querySelectorAll('#bultosBody tr').forEach(tr => {
    const b = bultos.find(x => x.id === Number(tr.dataset.id));
    const r = mode === 'intl' ? computeIntl(b) : computeNac(b);
    const costEl = tr.querySelector('[data-role="cost"]');
    const trnEl = tr.querySelector('[data-role="transit"]');
    if (!r || r.empty) { costEl.textContent = '—'; trnEl.textContent = '—'; costEl.title = ''; const ve = tr.querySelector('[data-role="veh"]'); if (ve) ve.textContent = '—'; return; }
    anyData = true;
    // vehículo sugerido + % ocupación (modo nacional)
    const vehEl = tr.querySelector('[data-role="veh"]');
    if (vehEl) {
      if (r.veh) {
        const pct = r.ocup != null ? ` · ${fmtInt.format(Math.min(999, Math.round(r.ocup)))}% ocup.` : '';
        vehEl.textContent = r.veh + pct;
        vehEl.classList.toggle('veh-over', r.ocup != null && r.ocup > 100);
        vehEl.title = r.ocup != null && r.ocup > 100 ? 'La carga supera la capacidad de este vehículo; considera dividir el envío.' : '';
      } else { vehEl.textContent = 'sin vehículo'; }
    }
    // mostrar costo: CLP si hay, si no USD
    if (r.costClp != null) { costEl.textContent = fmtMoney.format(Math.round(r.costClp)); anyClp = true; totalClp += r.costClp; }
    else if (r.costUsd != null) { costEl.textContent = fmtUsd.format(Math.round(r.costUsd)); }
    if (r.costUsd != null) totalUsd += r.costUsd;
    // aviso de la regla del PDF (valor >= USD 10.000)
    if (r.aviso) {
      costEl.textContent += ' ⚠';
      costEl.title = 'Valor ≥ USD 10.000: la factorización puede ser imprecisa. Completar el formulario correspondiente.';
      costEl.classList.add('cost-warn');
    } else { costEl.title = ''; costEl.classList.remove('cost-warn'); }
    trnEl.textContent = r.slaDias != null ? `${r.slaDias} d` : '—';
    totalBill += r.billable; totalVol += r.volumen; totalReal += r.pesoReal; totalPieces += r.cant;
    if (r.slaDias != null) maxSla = Math.max(maxSla ?? 0, r.slaDias);
  });

  // Total principal
  if (anyData && anyClp) {
    setText('tCost', fmtMoney.format(Math.round(totalClp)));
    setText('tCostUsd', totalUsd ? `≈ ${fmtUsd.format(Math.round(totalUsd))}` : '');
  } else if (anyData) {
    setText('tCost', fmtUsd.format(Math.round(totalUsd)));
    setText('tCostUsd', usdClp ? '' : 'sin tipo de cambio (USD)');
  } else {
    setText('tCost', '$0'); setText('tCostUsd', '');
  }
  setText('tTransit', maxSla != null ? `${maxSla} d` : '—');
  setText('tBillable', `${fmtInt.format(Math.round(totalBill))} kg`);
  setText('tPieces', `${fmtInt.format(totalPieces)} bulto${totalPieces === 1 ? '' : 's'}`);
  setText('tVolume', `${fmtDec.format(totalVol)} m³`);
  setText('tWeight', `${fmtInt.format(Math.round(totalReal))} kg reales`);
}

/* ---------- Tipo de cambio ---------- */
async function loadFx() {
  const note = document.getElementById('fxNote');
  const sources = [
    { url: 'https://api.frankfurter.app/latest?from=USD&to=CLP', pick: d => d?.rates?.CLP },
    { url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', pick: d => d?.usd?.clp }
  ];
  for (const s of sources) {
    try {
      const res = await fetch(s.url);
      if (!res.ok) continue;
      const data = await res.json();
      const rate = s.pick(data);
      if (rate) { usdClp = rate; note.textContent = `1 USD ≈ ${fmtMoney.format(Math.round(rate))} CLP`; recompute(); return; }
    } catch { /* siguiente */ }
  }
  note.textContent = 'tipo de cambio no disponible';
}

/* ---------- UI ---------- */
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function showBanner(html, type) { const b = document.getElementById('banner'); b.innerHTML = html; b.className = 'banner' + (type === 'error' ? ' error' : ''); b.hidden = false; }

/* ============================================================
   Cubicaje 3D
   ============================================================ */
let cubBultos = [];
let cubNextId = 1;
let cubUnidades = {};   // nombre -> {L,W,H,kg} en metros
let three = null;       // { scene, camera, renderer, raf, container }

function setupCubicaje() {
  // unir contenedores (intl) + camiones (nacional)
  const cont = DATA.cubicaje?.contenedores || {};
  const cam = DATA.cubicaje?.camionesDim || {};
  cubUnidades = {};
  Object.entries(cont).forEach(([k, v]) => cubUnidades[k] = { ...v, tipo: 'contenedor' });
  Object.entries(cam).forEach(([k, v]) => cubUnidades[k] = { ...v, tipo: 'camion' });

  const sel = document.getElementById('cubUnidad');
  sel.innerHTML = '';
  Object.keys(cubUnidades).forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });

  addCubBulto();
  onCubUnidadChange();
}

function addCubBulto() {
  cubBultos.push({ id: cubNextId++, desc: `Bulto ${cubNextId - 1}`, L: 100, W: 80, H: 80, peso: 200, cant: 1 });
}

function removeCubBulto(id) {
  cubBultos = cubBultos.filter(b => b.id !== id);
  if (!cubBultos.length) addCubBulto();
  renderCub();
}

function renderCub() {
  const body = document.getElementById('cubBody');
  body.innerHTML = '';
  cubBultos.forEach(b => {
    const tr = document.createElement('tr'); tr.dataset.id = b.id;
    const tDesc = td(); const di = document.createElement('input'); di.type = 'text'; di.value = b.desc; di.addEventListener('input', e => { b.desc = e.target.value; }); tDesc.appendChild(di);
    const tL = td('num'); tL.appendChild(numInput(b.L, '0', v => { b.L = v; computeCubicaje(); }));
    const tW = td('num'); tW.appendChild(numInput(b.W, '0', v => { b.W = v; computeCubicaje(); }));
    const tH = td('num'); tH.appendChild(numInput(b.H, '0', v => { b.H = v; computeCubicaje(); }));
    const tP = td('num'); tP.appendChild(numInput(b.peso, '0', v => { b.peso = v; computeCubicaje(); }));
    const tC = td('num col-cant'); const ci = numInput(b.cant, '1', v => { b.cant = v; computeCubicaje(); }); ci.min = '1'; tC.appendChild(ci);
    const tD = delCellCub(b.id);
    tr.append(tDesc, tL, tW, tH, tP, tC, tD);
    body.appendChild(tr);
  });
  computeCubicaje();
}

function delCellCub(id) { const c = td('num'); const b = document.createElement('button'); b.type = 'button'; b.className = 'row-del'; b.textContent = '×'; b.addEventListener('click', () => removeCubBulto(id)); c.appendChild(b); return c; }

function onCubUnidadChange() {
  const u = cubUnidades[document.getElementById('cubUnidad').value];
  const wrap = document.getElementById('cubRutaWrap');
  const rutaSel = document.getElementById('cubRuta');
  rutaSel.innerHTML = '';
  if (u && u.tipo === 'camion') {
    // poblar rutas DSV base para ese camión
    wrap.hidden = false;
    const rutas = DATA.nacionalDSV.base.filter(r => r.tarifas[document.getElementById('cubUnidad').value] != null);
    rutas.forEach((r, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `${r.origen} → ${r.destino}`; rutaSel.appendChild(o); });
    rutaSel._rutas = rutas;
  } else if (u && u.tipo === 'contenedor') {
    // costo por contenedor: factor sobre valor no aplica; usamos referencia por vía marítima USD/m³ histórica simple
    wrap.hidden = true;
  } else { wrap.hidden = true; }
  computeCubicaje();
}

// Empaquetado simple por capas (shelf/layer packing) — estima cuántos bultos caben y dibuja
function packBultos(unit, bultos) {
  // unit en metros; bultos en cm -> m
  const UL = unit.L, UW = unit.W, UH = unit.H;
  // expandir cantidades
  const items = [];
  bultos.forEach(b => {
    const n = Math.max(1, Math.round(num(b.cant)) || 1);
    for (let i = 0; i < n; i++) items.push({ L: num(b.L) / 100, W: num(b.W) / 100, H: num(b.H) / 100, peso: num(b.peso), desc: b.desc });
  });
  // ordenar por volumen desc
  items.sort((a, b) => (b.L * b.W * b.H) - (a.L * a.W * a.H));

  const placed = [];
  let cursorX = 0, cursorY = 0, cursorZ = 0, rowDepth = 0, layerHeight = 0;
  let fit = 0;
  for (const it of items) {
    // ¿cabe en la fila actual?
    if (cursorX + it.L > UL + 1e-6) { // nueva fila (avanzar en W)
      cursorX = 0; cursorY += rowDepth; rowDepth = 0;
    }
    if (cursorY + it.W > UW + 1e-6) { // nueva capa (avanzar en H)
      cursorX = 0; cursorY = 0; cursorZ += layerHeight; layerHeight = 0; rowDepth = 0;
    }
    if (cursorZ + it.H > UH + 1e-6) { break; } // no caben más
    placed.push({ x: cursorX, y: cursorY, z: cursorZ, L: it.L, W: it.W, H: it.H, desc: it.desc });
    cursorX += it.L;
    rowDepth = Math.max(rowDepth, it.W);
    layerHeight = Math.max(layerHeight, it.H);
    fit++;
  }
  return { placed, fit, total: items.length };
}

function computeCubicaje() {
  const unitName = document.getElementById('cubUnidad').value;
  const unit = cubUnidades[unitName];
  if (!unit) return;

  // totales de carga
  let totVol = 0, totKg = 0, totBultos = 0;
  cubBultos.forEach(b => {
    const n = Math.max(1, Math.round(num(b.cant)) || 1);
    totVol += (num(b.L) * num(b.W) * num(b.H) / 1e6) * n;
    totKg += num(b.peso) * n;
    totBultos += n;
  });

  const unitVol = unit.L * unit.W * unit.H;
  const unitKg = unit.kg;

  // unidades necesarias: por volumen y por peso, tomamos el mayor
  const porVol = unitVol ? Math.ceil(totVol / (unitVol * 0.85)) : 1; // 85% factor de estiba realista
  const porKg = unitKg ? Math.ceil(totKg / unitKg) : 1;
  const unidades = Math.max(1, porVol, porKg);

  // packing visual de UNA unidad (lo que cabe en la primera)
  const pack = packBultos(unit, cubBultos);

  // ocupación de la primera unidad
  const volPct = unitVol ? Math.min(999, (totVol / unidades) / unitVol * 100) : 0;
  const kgPct = unitKg ? Math.min(999, (totKg / unidades) / unitKg * 100) : 0;

  setText('cubUnits', fmtInt.format(unidades));
  setText('cubUnitName', unitName);
  setText('cubVolPct', `${fmtInt.format(volPct)}%`);
  setText('cubVolDet', `${fmtDec.format(totVol)} / ${fmtDec.format(unitVol * unidades)} m³`);
  setText('cubKgPct', `${fmtInt.format(kgPct)}%`);
  setText('cubKgDet', `${fmtInt.format(totKg)} / ${fmtInt.format(unitKg * unidades)} kg`);
  setText('cubFit', `${pack.fit} / ${pack.total}`);

  // costo
  let costo = null;
  if (unit.tipo === 'camion') {
    const rutaSel = document.getElementById('cubRuta');
    const rutas = rutaSel._rutas || [];
    const ruta = rutas[Number(rutaSel.value)] || null;
    const tarifa = ruta ? ruta.tarifas[unitName] : null;
    if (tarifa != null) { costo = tarifa * unidades; setText('cubCost', fmtMoney.format(costo)); setText('cubCostFoot', `${unidades} × ${fmtMoney.format(tarifa)}`); }
    else { setText('cubCost', '—'); setText('cubCostFoot', 'elige ruta'); }
  } else {
    // contenedor: referencia por m³ marítimo (USD/kg ya lo tenemos; aquí estimamos por volumen llenando)
    setText('cubCost', `${unidades} ud.`);
    setText('cubCostFoot', 'costo se calcula en Internacional');
  }

  draw3D(unit, pack.placed);
}

/* ---------- Vista de cubicaje (2D canvas, sin WebGL) ---------- */
function draw3D(unit, placed) {
  const container = document.getElementById('cub3d');
  if (!container) return;

  // Crear/obtener canvas 2D
  let canvas = container.querySelector('canvas.cub2d');
  if (!canvas) {
    container.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.className = 'cub2d';
    container.appendChild(canvas);
  }
  const W = container.clientWidth || 600;
  const H = container.clientHeight || 460;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Dos vistas: planta (arriba) y alzado lateral (abajo)
  const pad = 24;
  const half = (H - pad * 3) / 2;
  drawView(ctx, 'PLANTA (vista superior)', pad, pad, W - pad * 2, half, unit, placed, 'top');
  drawView(ctx, 'ALZADO (vista lateral)', pad, pad * 2 + half, W - pad * 2, half, unit, placed, 'side');
}

function drawView(ctx, titulo, ox, oy, vw, vh, unit, placed, modo) {
  // dimensiones del contenedor en el plano (m)
  const cw = unit.L;                          // ancho dibujado = largo del contenedor
  const ch = (modo === 'top') ? unit.W : unit.H;
  const scale = Math.min((vw) / cw, (vh - 18) / ch) * 0.92;
  const dw = cw * scale, dh = ch * scale;
  const x0 = ox + (vw - dw) / 2;
  const y0 = oy + 18 + (vh - 18 - dh) / 2;

  // título
  ctx.fillStyle = '#667f98'; ctx.font = '600 11px Inter, sans-serif'; ctx.textBaseline = 'top';
  ctx.fillText(titulo.toUpperCase(), ox, oy);

  // contenedor
  ctx.strokeStyle = '#002a54'; ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, dw, dh);
  ctx.fillStyle = 'rgba(199,210,224,0.25)';
  ctx.fillRect(x0, y0, dw, dh);

  // bultos
  const colors = ['#004fff', '#36d1b7', '#82afbe', '#ce9048', '#7b335f', '#0fc580'];
  placed.forEach((p, i) => {
    let bx, by, bw, bh;
    if (modo === 'top') {        // plano X (largo) × Y (ancho)
      bx = x0 + p.x * scale; by = y0 + p.y * scale; bw = p.L * scale; bh = p.W * scale;
    } else {                      // plano X (largo) × Z (alto)
      bx = x0 + p.x * scale; by = y0 + dh - (p.z + p.H) * scale; bw = p.L * scale; bh = p.H * scale;
    }
    ctx.fillStyle = colors[i % colors.length];
    ctx.globalAlpha = 0.78;
    ctx.fillRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  });
}

document.addEventListener('DOMContentLoaded', init);
