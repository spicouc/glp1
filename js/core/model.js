// Fàbriques i normalització de les entitats del model.
// Arrel: patient -> treatment -> {pens, administrations, schedules, health}
// Totes les dades realment registrades s'immutablet: les administracions es
// creen un cop i només es modifiquen per acció explícita de l'usuari.

import { todayISO } from './dates.js';
import { getDrug, intervalDaysFor, clicksPerDoseFor, dosesPerPenFor } from './drugs.js';

let seq = 0;

export function uid(prefix = 'id') {
  seq += 1;
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${rnd}`;
}

function nowStamp() {
  return new Date().toISOString();
}

export function createPatient(o = {}) {
  const now = nowStamp();
  return {
    id: o.id || uid('pat'),
    code: o.code || '',
    name: o.name || '',
    birthYear: o.birthYear ?? null,
    notes: o.notes || '',
    archived: o.archived ?? false,
    deletedAt: o.deletedAt || null, // tomba: esborrat (no es mostra, es sincronitza)
    createdAt: o.createdAt || now,
    updatedAt: o.updatedAt || now,
    treatments: o.treatments || [],
  };
}

export function createTreatment({ drugId, startDate, notes = '' } = {}) {
  const drug = getDrug(drugId);
  return {
    id: uid('trt'),
    drugId,
    startDate: startDate || todayISO(),
    endDate: null,
    status: 'active', // active | paused | finished
    endReason: '',
    notes,
    pens: [],
    administrations: [],
    plans: [],
    health: [],
    costs: [], // despeses del tractament (compra de plomes, altres)
    autoPlan: true, // continuar la dosi planificada les setmanes següents en registrar
    schedules: [
      createSchedule({
        startDate: startDate || todayISO(),
        mode: 'standard',
        value: drug ? drug.standardDosesMg[0] : null,
        intervalDays: intervalDaysFor(drug),
      }),
    ],
  };
}

export function createPen({
  presentationMg = null,
  startDate = null,
  initialCapacity = null,
  capacityUnit = 'doses',
  conversion = null,
  notes = '',
  clicksPerDose = null,
  dosesPerPen = null,
  startUsed = 0,
  seq = null,
} = {}) {
  return {
    id: uid('pen'),
    // Número visible congelat (#N): no es mou mai en esborrar una altra ploma.
    seq: Number.isFinite(Number(seq)) && Number(seq) > 0 ? Math.round(Number(seq)) : null,
    presentationMg,
    startDate: startDate || todayISO(),
    endDate: null,
    status: 'active', // active | finished | discarded | deleted
    deletedAt: null,
    capacityUnit,
    initialCapacity,
    clicksPerDose: clicksPerDose ?? null, // clics d'una dosi completa (60, 32, 72, 75…)
    dosesPerPen: dosesPerPen ?? null,      // dosis nominals de la ploma (4, 30…)
    startUsed: Math.max(0, Number(startUsed) || 0), // consum prèvi (en capacityUnit)
    conversion,
    // Control de caducitat/obertura (regles per fàrmac al catàleg) i cost
    expiryDate: null,      // caducitat impresa a la ploma (YYYY-MM-DD)
    openedAt: null,        // data d'obertura (inicia el termini de validesa)
    priceCents: null,      // preu de compra en CÈNTIMS enters (mai floats)
    currency: 'EUR',
    notes,
  };
}

/** Següent número de ploma lliure del tractament (el #N es congela a l'alta). */
export function nextPenSeq(treatment) {
  const used = (treatment?.pens || []).map((p) => Number(p.seq) || 0);
  return (used.length ? Math.max(...used) : 0) + 1;
}

/**
 * Capacitat real d'una ploma: si es coneixen els clics per dosi completa, la
 * capacitat es desa en Clics (unitat real: 240, 128, 288, 300…) i les dosis es
 * deriven. És la font única de veritat per a l'alta i per a la vista prèvia.
 */
export function resolvePenCapacity({
  drug = null,
  presentationMg = null,
  capacity = null,
  unit = null,
  clicksPerDose = null,
  dosesPerPen = null,
} = {}) {
  const cpc = Number(clicksPerDose) > 0
    ? Math.round(Number(clicksPerDose))
    : clicksPerDoseFor(drug, presentationMg);
  const dpn = Number(dosesPerPen) > 0 ? Math.round(Number(dosesPerPen)) : dosesPerPenFor(drug);

  let u = unit || (drug ? drug.capacityUnit : 'doses');
  let c = Number(capacity);
  if (!Number.isFinite(c) || c <= 0) c = drug && drug.defaultInitialCapacity != null ? Number(drug.defaultInitialCapacity) : null;

  if (cpc && u === 'doses' && Number(c) > 0) {
    c = Math.round(c * cpc);
    u = 'clicks';
  }
  return { capacity: c, unit: u, clicksPerDose: cpc, dosesPerPen: dpn };
}

/**
 * Administració immutable.
 *  amount/unit -> consum real en la unitat de capacitat de la ploma
 *  mg          -> dosi o equivalència teòrica (mai prescripció)
 *  balance*    -> snapshot desat en el moment de registrar
 */
export function createAdministration({
  date,
  penId,
  mode = 'standard',
  value = null,
  amount = 0,
  unit = 'doses',
  mg = null,
  notes = '',
  balanceBefore = null,
  balanceAfter = null,
  injections = null,
  time = null,
  prescribed = null,
  source = 'manual',
  idempotencyKey = null,
} = {}) {
  const now = nowStamp();
  return {
    id: uid('adm'),
    date,
    // Hora local 'HH:MM' (opcional): traçabilitat de l'administració
    time: time || null,
    penId,
    mode,
    value,
    amount,
    unit,
    mg,
    // Snapshot de la dosi PRESCRITA en el moment de registrar, per poder-la
    // comparar amb la dosi real sense tocar la prescripció.
    prescribed: prescribed || null,
    balanceBefore,
    balanceAfter,
    // >1 quan la dosi supera la dosi completa de la ploma (injeccions partides)
    injections: Number(injections) > 1 ? Math.round(Number(injections)) : null,
    notes,
    // Font del registre: manual (teclat) o import (backup/CSV)
    source,
    revertsId: null,       // administració que revoca/ajusta aquesta
    idempotencyKey: idempotencyKey || newIdempotencyKey(), // mai dos descomptes
    deletedAt: null,       // tomba: esborrat que es sincronitza (mai ressuscita)
    createdAt: now,
    editedAt: null,
  };
}

/**
 * Entrada de pla: una dosi DISSENYADA (prevista) per a una data i una ploma
 * concreta. És una entitat pròpia: es pot generar, moure, editar i esborrar
 * sense tocar ni els registres reals ni la pauta.
 */
export function createPlanEntry({
  date,
  penId,
  mode = 'standard',
  value = null,
  amount = 0,
  unit = 'doses',
  mg = null,
  notes = '',
  registeredAdminId = null,
  status = null,
} = {}) {
  return {
    id: uid('pln'),
    date,
    penId,
    mode,
    value,
    amount,
    unit,
    mg,
    notes,
    registeredAdminId,
    // planned | administered | postponed | omitted | cancelled
    status: status || (registeredAdminId ? 'administered' : 'planned'),
    movedTo: null,   // data nova quan s'ajorna
    originalDate: null, // data original (es conserva en ajornar)
    reason: '',      // motiu d'ajornament / omissió / cancel·lació
    updatedAt: null,
    idempotencyKey: newIdempotencyKey(),
    deletedAt: null,       // tomba: esborrat que es sincronitza
    createdAt: nowStamp(),
  };
}

/**
 * Fase del tractament: tram de pauta amb dosi, inici, durada i fi.
 * (La col·lecció es diu `schedules` per compatibilitat; a la UI es diu FASES.)
 */
export function createSchedule({
  startDate,
  mode = 'standard',
  value = null,
  intervalDays = 7,
  notes = '',
  endDate = null,
  durationDays = null,
  status = 'active',
} = {}) {
  return {
    id: uid('sch'),
    startDate,
    // Fi de la fase: derivada de la durada o fixada a mà (null = fase oberta)
    endDate: endDate || null,
    durationDays: durationDays == null ? null : Math.round(Number(durationDays)),
    mode,
    value,
    intervalDays,
    status, // active | done | cancelled
    notes,
    createdAt: nowStamp(),
    updatedAt: null,
  };
}

export function createHealth({
  date,
  weightKg = null,
  nausea = 0,
  vomiting = 0,
  diarrhea = 0,
  constipation = 0,
  abdominalPain = 0,
  otherEffects = '',
  notes = '',
  source = 'manual',
  validated = false,
} = {}) {
  return {
    id: uid('hlh'),
    date,
    weightKg,
    nausea,
    vomiting,
    diarrhea,
    constipation,
    abdominalPain,
    otherEffects,
    notes,
    // Dada NO validada (auto-reportada / importada): es mostra separada de la
    // lògica posològica i mai altera dosis ni saldos.
    source,
    validated: validated === true,
  };
}

/** Despesa del tractament (cèntims enters; mai floats). */
export function createCost({
  date,
  kind = 'other', // pen | admin | other
  amountCents = null,
  currency = 'EUR',
  penId = null,
  notes = '',
  source = 'manual',
} = {}) {
  return {
    id: uid('cst'),
    date: date || todayISO(),
    kind: ['pen', 'admin', 'other'].includes(kind) ? kind : 'other',
    amountCents: amountCents == null ? null : Math.round(Number(amountCents)),
    currency,
    penId: penId || null,
    notes: notes || '',
    source,
    createdAt: nowStamp(),
  };
}

/** Presentació de ploma corresponent a una dosi (fàrmacs de força fixa). */
export function presentationForDose(drugId, doseMg) {
  const drug = getDrug(drugId);
  if (!drug || !drug.penStrengthsMg) return null;
  const list = drug.penStrengthsMg;
  const d = Number(doseMg);
  if (!Number.isFinite(d)) return list[0];
  if (list.includes(d)) return d;
  // La ploma més petita que admet la dosi (ex. 6,25 mg → ploma de 7,5 mg);
  // si la dosi supera totes, l'última.
  return list.find((s) => s >= d) ?? list[list.length - 1];
}

/** Genera la ploma inicial d'un tractament (dades del catàleg, sobreescrivibles). */
export function createInitialPen(drugId, startDate = null, opts = {}) {
  const drug = getDrug(drugId);
  if (!drug) return null;
  const presentationMg = opts.presentationMg !== undefined
    ? opts.presentationMg
    : (drug.penStrengthsMg ? drug.penStrengthsMg[0] : null);

  const plan = resolvePenCapacity({
    drug,
    presentationMg,
    capacity: opts.initialCapacity ?? drug.defaultInitialCapacity,
    unit: opts.capacityUnit ?? drug.capacityUnit,
    clicksPerDose: opts.clicksPerDose,
    dosesPerPen: opts.dosesPerPen,
  });
  return createPen({
    presentationMg,
    startDate: startDate || todayISO(),
    initialCapacity: plan.capacity,
    capacityUnit: plan.unit,
    clicksPerDose: plan.clicksPerDose,
    dosesPerPen: plan.dosesPerPen,
    startUsed: opts.startUsed ?? 0,
    notes: opts.notes || '',
    conversion: opts.conversion || null,
    seq: opts.seq ?? null,
  });
}

/** Genera el següent codi visible: P-001, P-002, ... */
export function nextPatientCode(patients) {
  let max = 0;
  for (const p of patients) {
    const m = /^P-(\d+)$/.exec(String(p.code || '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `P-${String(max + 1).padStart(3, '0')}`;
}

export function nowISO() {
  return nowStamp();
}

/**
 * Clau d'idempotència: el servidor la fa servir per descartar un reenviament
 * (doble clic, reintent de xarxa) i assegurar que una administració es
 * consumeix UNA SOLA VEZ.
 */
export function newIdempotencyKey() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* entorns sense crypto */ }
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalització defensiva d'un tractament (inclou la migració de plomes). */
function normaliseTreatment(t) {
  const drug = getDrug(t.drugId);

  // Migració: quan es coneixen els clics per dosi completa, la capacitat i els
  // consums de la ploma es passen de DOSES a CLICS (unitat real 240/128/288…),
  // per poder expressar mitges dosis i clics exactes. penId → clics per dosi.
  const toClicks = {};
  const pens = (t.pens || []).map((pen, idx) => {
    const clicksPerDose = clicksPerDoseFor(drug, pen.presentationMg, pen);
    // `...pen` conserva els camps que aquesta versió encara no coneix: una
    // migració mai esborra camps d'una versió nova (compatible cap enrere).
    const out = {
      ...pen,
      id: pen.id || uid('pen'),
      seq: Number.isFinite(Number(pen.seq)) && Number(pen.seq) > 0 ? Math.round(Number(pen.seq)) : idx + 1,
      presentationMg: pen.presentationMg ?? null,
      startDate: pen.startDate || todayISO(),
      endDate: pen.endDate || null,
      status: pen.status || 'active',
      deletedAt: pen.deletedAt || null,
      capacityUnit: pen.capacityUnit || 'doses',
      initialCapacity: pen.initialCapacity ?? null,
      clicksPerDose,
      dosesPerPen: dosesPerPenFor(drug, pen),
      startUsed: Math.max(0, Number(pen.startUsed) || 0),
      conversion: pen.conversion || null,
      expiryDate: pen.expiryDate || null,
      openedAt: pen.openedAt || null,
      priceCents: pen.priceCents == null ? null : Math.round(Number(pen.priceCents)),
      currency: pen.currency || 'EUR',
      notes: pen.notes || '',
    };
    if (clicksPerDose && out.capacityUnit === 'doses' && Number(out.initialCapacity) > 0) {
      toClicks[out.id] = clicksPerDose;
      out.initialCapacity = Math.round(Number(out.initialCapacity) * clicksPerDose);
      out.capacityUnit = 'clicks';
    }
    return out;
  });

  const cpcOf = (penId) => toClicks[penId] || 0;
  /** Consum d'una administració/proposta després de migrar (doses → clics). */
  const convAmount = (a) => {
    const amt = Number(a.amount ?? a.clicks ?? 0);
    const cpc = cpcOf(a.penId);
    if (!cpc) return amt;
    if (a.mode === 'clicks') return Math.round(Number(a.value) || Math.round(amt * cpc));
    return Math.round(amt * cpc);
  };
  /** Snapshot de saldo després de migrar (es desava en l'antiga unitat). */
  const convSnap = (a, v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const cpc = cpcOf(a.penId);
    return cpc ? Math.round(n * cpc) : n;
  };

  return {
    id: t.id || uid('trt'),
    drugId: t.drugId || t.drug || '',
    startDate: t.startDate || todayISO(),
    endDate: t.endDate || null,
    status: t.status || 'active',
    endReason: t.endReason || '',
    notes: t.notes || '',
    pens,
    administrations: (t.administrations || []).map((a) => ({
      ...a,
      id: a.id || uid('adm'),
      date: a.date,
      time: a.time || null,
      penId: a.penId,
      mode: a.mode || 'standard',
      value: a.value ?? null,
      amount: convAmount(a),
      unit: cpcOf(a.penId) ? 'clicks' : (a.unit || 'clicks'),
      mg: a.mg ?? null,
      prescribed: a.prescribed || null,
      source: a.source || 'manual',
      revertsId: a.revertsId || null,
      idempotencyKey: a.idempotencyKey || null,
      deletedAt: a.deletedAt || null,
      // Injeccions per administració (>1 quan la dosi supera la dosi completa)
      injections: Number(a.injections) > 0 ? Math.round(Number(a.injections)) : null,
      balanceBefore: a.balanceBefore == null ? null : convSnap(a, a.balanceBefore),
      balanceAfter: a.balanceAfter == null ? null : convSnap(a, a.balanceAfter),
      notes: a.notes || '',
      createdAt: a.createdAt || nowStamp(),
      editedAt: a.editedAt || null,
    })),
    schedules: (t.schedules || []).map((s) => ({
      ...s,
      id: s.id || uid('sch'),
      startDate: s.startDate,
      endDate: s.endDate || null,
      durationDays: s.durationDays == null ? null : Math.round(Number(s.durationDays)),
      mode: s.mode || 'standard',
      value: s.value ?? null,
      intervalDays: Number(s.intervalDays || 7),
      status: ['active', 'done', 'cancelled'].includes(s.status) ? s.status : 'active',
      notes: s.notes || '',
      createdAt: s.createdAt || nowStamp(),
      updatedAt: s.updatedAt || null,
    })),
    plans: (t.plans || []).map((p) => ({
      ...p,
      id: p.id || uid('pln'),
      date: p.date,
      penId: p.penId,
      mode: p.mode || 'standard',
      value: p.value ?? null,
      amount: convAmount(p),
      unit: cpcOf(p.penId) ? 'clicks' : (p.unit || 'doses'),
      mg: p.mg ?? null,
      notes: p.notes || '',
      registeredAdminId: p.registeredAdminId || null,
      status: planStatusOf(p),
      movedTo: p.movedTo || null,
      originalDate: p.originalDate || null,
      reason: p.reason || '',
      updatedAt: p.updatedAt || null,
      idempotencyKey: p.idempotencyKey || null,
      deletedAt: p.deletedAt || null,
      createdAt: p.createdAt || nowStamp(),
    })),
    health: (t.health || []).map((h) => ({
      ...h,
      id: h.id || uid('hlh'),
      date: h.date,
      weightKg: h.weightKg ?? null,
      nausea: h.nausea ?? 0,
      vomiting: h.vomiting ?? 0,
      diarrhea: h.diarrhea ?? 0,
      constipation: h.constipation ?? 0,
      abdominalPain: h.abdominalPain ?? 0,
      otherEffects: h.otherEffects || '',
      notes: h.notes || '',
      source: h.source || 'manual',
      validated: h.validated === true,
    })),
    // Despeses: cèntims enters, mai floats
    costs: (t.costs || []).map((c) => ({
      ...c,
      id: c.id || uid('cst'),
      date: c.date || todayISO(),
      kind: ['pen', 'admin', 'other'].includes(c.kind) ? c.kind : 'other',
      amountCents: c.amountCents == null ? null : Math.round(Number(c.amountCents)),
      currency: c.currency || 'EUR',
      penId: c.penId || null,
      notes: c.notes || '',
      source: c.source || 'manual',
      createdAt: c.createdAt || nowStamp(),
    })),
    autoPlan: t.autoPlan !== false,
    deletedAt: t.deletedAt || null,
  };
}

/**
 * Estat d'una entrada de pla. Si està vinculada a una administració real,
 * sempre és `administered` (l'estat no pot contradir el registre real).
 */
export function planStatusOf(p) {
  if (p && p.registeredAdminId) return 'administered';
  const st = p && p.status;
  // Sense administració vinculada NO pot estar "administered": si es va
  // desvincular (esborrar el registre), la proposta torna a estar pendent.
  if (st === 'administered') return 'planned';
  return ['planned', 'postponed', 'omitted', 'cancelled'].includes(st) ? st : 'planned';
}

/** Normalització defensiva d'un pacient importat/desat. */
export function normalisePatient(p) {
  const patient = createPatient(p || {});
  patient.treatments = (p && Array.isArray(p.treatments) ? p.treatments : []).map((t) => normaliseTreatment(t));
  patient.updatedAt = p.updatedAt || nowStamp();
  return patient;
}
