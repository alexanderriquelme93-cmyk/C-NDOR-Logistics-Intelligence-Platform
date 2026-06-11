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
async function init() {
  try {
    const res = await fetch('data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    showBanner(`No se pudo cargar <strong>data.json</strong>. Verifica que exista, sea JSON válido y que el sitio se sirva por HTTP. Detalle: ${err.message}`, 'error');
    return;
  }

  document.getElementById('addBulto').addEventListener('click', () => { addBulto(); render(); });
  document.getElementById('modeIntl').addEventListener('click', () => setMode('intl'));
  document.getElementById('modeNac').addEventListener('click', () => setMode('nac'));
  loadFx();
  setMode('intl');
}

function setMode(m) {
  mode = m;
  document.getElementById('modeIntl').classList.toggle('active', m === 'intl');
  document.getElementById('modeIntl').setAttribute('aria-selected', m === 'intl');
  document.getElementById('modeNac').classList.toggle('active', m === 'nac');
  document.getElementById('modeNac').setAttribute('aria-selected', m === 'nac');

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

document.addEventListener('DOMContentLoaded', init);
