'use strict';

/* ============================================================
   Cotizador de Embarque — multi-bulto
   Estático, sin backend. Estima costo y tránsito por bulto
   usando el costo promedio histórico (historico.json).
   ============================================================ */

const fmtInt = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
const fmtDec = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 });
const fmtMoney = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });

// Factores de peso volumétrico (kg por m³), estándar de la industria.
const VOLUMETRIC_FACTOR = {
  'Aéreo': 167,
  'Courier': 200,
  'Marítimo': 1000,
  'Nacional': 333,
  'Sobredimensionado sin escolta': 333,
  'Sobredimensionado con escolta': 333,
  _default: 250
};

let viaStats = {};      // { via: { costPerKg, costPerM3, n } }
let viaList = [];
let comboTree = {};     // { via: { origen: [destinos...] } }
let slaByVia = {};      // { via: slaDias } desde sla.json (tabla oficial)
let usdClp = null;
let bultos = [];        // estado de la lista
let nextId = 1;

/* ---------- Init ---------- */
async function init() {
  let raw;
  try {
    const res = await fetch('historico.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    showBanner(
      `No se pudo cargar <strong>historico.json</strong>. Verifica que el archivo exista, ` +
      `sea JSON válido y que el sitio se sirva por HTTP (GitHub Pages o servidor local). Detalle: ${err.message}`,
      'error');
    return;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    showBanner('El archivo <strong>historico.json</strong> está vacío o no es una lista válida.', 'error');
    return;
  }

  viaStats = buildViaStats(raw);
  viaList = Object.keys(viaStats).sort();
  comboTree = buildComboTree(raw);

  // Cargar tabla SLA oficial (sla.json). Si falla, el tránsito queda "—".
  try {
    const slaRes = await fetch('sla.json', { cache: 'no-store' });
    if (slaRes.ok) {
      const slaRows = await slaRes.json();
      if (Array.isArray(slaRows)) {
        slaRows.forEach(s => {
          const v = (s.viaTransporte || '').trim();
          const dias = num(s.slaDias);
          if (v && dias > 0) slaByVia[v] = dias;
        });
      }
    }
  } catch { /* sin SLA: tránsito mostrará "—" */ }

  document.getElementById('addBulto').addEventListener('click', () => { addBulto(); recompute(); });
  loadFx();

  // arranca con un bulto
  addBulto();
  recompute();
}

/* ---------- Árbol vía -> origen -> destinos (desde el histórico) ---------- */
function buildComboTree(data) {
  const tree = {};
  data.forEach(r => {
    const v = (r.viaTransporte || '').trim();
    const o = (r.paisOrigen || '').trim();
    const d = (r.puertoDestino || '').trim();
    if (!v) return;
    tree[v] = tree[v] || {};
    if (o) {
      tree[v][o] = tree[v][o] || new Set();
      if (d) tree[v][o].add(d);
    }
  });
  // convertir Sets a arrays ordenados
  const out = {};
  Object.entries(tree).forEach(([v, origenes]) => {
    out[v] = {};
    Object.entries(origenes).forEach(([o, dests]) => { out[v][o] = [...dests].sort(); });
  });
  return out;
}

function origenesDe(via) { return Object.keys(comboTree[via] || {}).sort(); }
function destinosDe(via, origen) { return (comboTree[via]?.[origen] || []).slice(); }

/* ---------- Promedios por vía ---------- */
function buildViaStats(data) {
  const acc = {};
  data.forEach(r => {
    const v = (r.viaTransporte || 'Sin vía').trim();
    const flete = num(r.valorFlete), kg = num(r.pesoKg), m3 = num(r.volumenM3), sla = num(r.slaDias);
    if (!acc[v]) acc[v] = { flete: 0, kg: 0, m3: 0, slaSum: 0, slaN: 0, n: 0 };
    acc[v].flete += flete; acc[v].kg += kg; acc[v].m3 += m3; acc[v].n += 1;
    if (sla > 0) { acc[v].slaSum += sla; acc[v].slaN += 1; }
  });
  const out = {};
  Object.entries(acc).forEach(([v, s]) => {
    out[v] = {
      costPerKg: s.kg ? s.flete / s.kg : 0,
      costPerM3: s.m3 ? s.flete / s.m3 : 0,
      slaDias: s.slaN ? Math.round(s.slaSum / s.slaN) : null,
      n: s.n
    };
  });
  return out;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function uniqueSorted(arr) { return [...new Set(arr.filter(Boolean))].sort(); }

/* ---------- Lista de bultos ---------- */
function addBulto() {
  const via = viaList[0] || '';
  const origen = origenesDe(via)[0] || '';
  const destino = destinosDe(via, origen)[0] || '';
  bultos.push({ id: nextId++, via, origen, destino, peso: '', L: '', W: '', H: '', vol: '', cant: 1 });
  renderBultos();
}

function removeBulto(id) {
  bultos = bultos.filter(b => b.id !== id);
  if (bultos.length === 0) addBulto();
  renderBultos();
  recompute();
}

function renderBultos() {
  const body = document.getElementById('bultosBody');
  body.innerHTML = '';
  bultos.forEach(b => body.appendChild(rowFor(b)));
}

function rowFor(b) {
  const tr = document.createElement('tr');
  tr.dataset.id = b.id;

  // Vía
  const tdVia = td('col-via');
  const viaSel = selectInput(viaList, b.via, v => {
    b.via = v;
    // al cambiar vía, recalcular orígenes válidos y resetear si ya no aplica
    const orig = origenesDe(v);
    if (!orig.includes(b.origen)) b.origen = orig[0] || '';
    const dest = destinosDe(v, b.origen);
    if (!dest.includes(b.destino)) b.destino = dest[0] || '';
    refreshOrigen(); refreshDestino();
    recompute();
  });
  tdVia.appendChild(viaSel);

  // Origen (depende de la vía)
  const tdOrigen = td();
  let origenSel = selectInput(origenesDe(b.via), b.origen, v => {
    b.origen = v;
    const dest = destinosDe(b.via, v);
    if (!dest.includes(b.destino)) b.destino = dest[0] || '';
    refreshDestino();
    recompute();
  });
  tdOrigen.appendChild(origenSel);
  function refreshOrigen() {
    const nuevo = selectInput(origenesDe(b.via), b.origen, v => {
      b.origen = v;
      const dest = destinosDe(b.via, v);
      if (!dest.includes(b.destino)) b.destino = dest[0] || '';
      refreshDestino();
      recompute();
    });
    origenSel.replaceWith(nuevo); origenSel = nuevo;
  }

  // Destino (depende de vía + origen)
  const tdDestino = td();
  let destinoSel = selectInput(destinosDe(b.via, b.origen), b.destino, v => { b.destino = v; });
  tdDestino.appendChild(destinoSel);
  function refreshDestino() {
    const nuevo = selectInput(destinosDe(b.via, b.origen), b.destino, v => { b.destino = v; });
    destinoSel.replaceWith(nuevo); destinoSel = nuevo;
  }

  // Peso
  const tdPeso = td('num');
  tdPeso.appendChild(numInput(b.peso, '0', val => { b.peso = val; recompute(); }));

  // Volumen (auto desde dimensiones) — se define antes para poder actualizarlo
  const tdVol = td('num');
  const volInput = numInput(b.vol, '0', v => { b.vol = v; recompute(); });
  tdVol.appendChild(volInput);

  // Recalcula el volumen desde L×A×H y lo refleja en el campo
  const syncVolume = () => {
    const L = num(b.L), W = num(b.W), H = num(b.H);
    if (L && W && H) {
      b.vol = +((L * W * H) / 1_000_000).toFixed(3); // cm³ -> m³
      volInput.value = b.vol;
      volInput.readOnly = true;
      volInput.title = 'Calculado desde las dimensiones';
    } else {
      volInput.readOnly = false;
      volInput.title = '';
    }
    recompute();
  };

  // Dimensiones
  const tdDims = td();
  const wrap = document.createElement('div');
  wrap.className = 'dims-cell';
  const li = numInput(b.L, 'L', v => { b.L = v; syncVolume(); });
  const wi = numInput(b.W, 'A', v => { b.W = v; syncVolume(); });
  const hi = numInput(b.H, 'H', v => { b.H = v; syncVolume(); });
  wrap.append(li, sep('×'), wi, sep('×'), hi);
  tdDims.appendChild(wrap);

  // estado inicial del volumen (por si el bulto ya trae dimensiones)
  if (num(b.L) && num(b.W) && num(b.H)) {
    volInput.value = b.vol; volInput.readOnly = true; volInput.title = 'Calculado desde las dimensiones';
  }

  // Cantidad
  const tdCant = td('num col-cant');
  const ci = numInput(b.cant, '1', v => { b.cant = v; recompute(); });
  ci.min = '1';
  tdCant.appendChild(ci);

  // Costo
  const tdCost = td('num');
  const cost = document.createElement('span');
  cost.className = 'cell-cost'; cost.dataset.role = 'cost'; cost.textContent = '—';
  tdCost.appendChild(cost);

  // Tránsito
  const tdTransit = td('num');
  const trn = document.createElement('span');
  trn.className = 'cell-transit'; trn.dataset.role = 'transit'; trn.textContent = '—';
  tdTransit.appendChild(trn);

  // Eliminar
  const tdDel = td('num');
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'row-del'; del.textContent = '×';
  del.setAttribute('aria-label', 'Eliminar bulto');
  del.addEventListener('click', () => removeBulto(b.id));
  tdDel.appendChild(del);

  tr.append(tdVia, tdOrigen, tdDestino, tdPeso, tdDims, tdVol, tdCant, tdCost, tdTransit, tdDel);
  return tr;
}

function td(cls) { const c = document.createElement('td'); if (cls) c.className = cls; return c; }
function sep(t) { const s = document.createElement('span'); s.textContent = t; return s; }
function selectInput(options, selected, onChange) {
  const sel = document.createElement('select');
  options.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    if (v === selected) o.selected = true;
    sel.appendChild(o);
  });
  if (options.length === 0) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '—';
    sel.appendChild(o);
  }
  sel.addEventListener('change', e => onChange(e.target.value));
  return sel;
}
function numInput(value, placeholder, onInput) {
  const i = document.createElement('input');
  i.type = 'number'; i.min = '0'; i.step = 'any';
  i.value = value; i.placeholder = placeholder;
  i.inputMode = 'decimal';
  i.addEventListener('input', e => onInput(e.target.value));
  return i;
}

/* ---------- Cálculo ---------- */
function computeBulto(b) {
  const stat = viaStats[b.via];
  if (!stat) return null;
  const cant = Math.max(1, num(b.cant) || 1);
  const pesoReal = num(b.peso);

  let volUnit = num(b.vol);
  const L = num(b.L), W = num(b.W), H = num(b.H);
  if (!volUnit && L && W && H) volUnit = (L * W * H) / 1_000_000; // cm³ -> m³

  const factor = VOLUMETRIC_FACTOR[b.via] ?? VOLUMETRIC_FACTOR._default;
  const pesoVol = volUnit * factor;
  const billableUnit = Math.max(pesoReal, pesoVol);

  const costByKg = billableUnit * stat.costPerKg;
  const costByM3 = volUnit * stat.costPerM3;
  const costUnit = Math.max(costByKg, costByM3);

  return {
    cant,
    pesoReal: pesoReal * cant,
    volumen: volUnit * cant,
    billable: billableUnit * cant,
    cost: costUnit * cant,
    slaDias: slaByVia[b.via] ?? null,
    empty: !pesoReal && !volUnit
  };
}

function recompute() {
  let totalCost = 0, totalBillable = 0, totalVol = 0, totalReal = 0, totalPieces = 0;
  let maxSla = null, anyData = false;

  document.querySelectorAll('#bultosBody tr').forEach(tr => {
    const b = bultos.find(x => x.id === Number(tr.dataset.id));
    const r = computeBulto(b);
    const costEl = tr.querySelector('[data-role="cost"]');
    const trnEl = tr.querySelector('[data-role="transit"]');
    if (!r || r.empty) { costEl.textContent = '—'; trnEl.textContent = '—'; return; }
    anyData = true;
    costEl.textContent = fmtMoney.format(Math.round(r.cost));
    trnEl.textContent = r.slaDias != null ? `${r.slaDias} d` : '—';
    totalCost += r.cost; totalBillable += r.billable; totalVol += r.volumen;
    totalReal += r.pesoReal; totalPieces += r.cant;
    if (r.slaDias != null) maxSla = Math.max(maxSla ?? 0, r.slaDias);
  });

  setText('tCost', anyData ? fmtMoney.format(Math.round(totalCost)) : '$0');
  setText('tCostUsd', anyData && usdClp ? `≈ USD ${fmtInt.format(Math.round(totalCost / usdClp))}` : '');
  setText('tTransit', maxSla != null ? `${maxSla} d` : '—');
  setText('tBillable', `${fmtInt.format(Math.round(totalBillable))} kg`);
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
      if (rate) {
        usdClp = rate;
        note.textContent = `1 USD ≈ ${fmtMoney.format(Math.round(rate))} CLP`;
        recompute();
        return;
      }
    } catch { /* siguiente fuente */ }
  }
  note.textContent = 'tipo de cambio no disponible (solo CLP)';
}

/* ---------- UI helpers ---------- */
function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function showBanner(html, type) {
  const b = document.getElementById('banner');
  b.innerHTML = html;
  b.className = 'banner' + (type === 'error' ? ' error' : '');
  b.hidden = false;
}

document.addEventListener('DOMContentLoaded', init);
