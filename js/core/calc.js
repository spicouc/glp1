// Motor de càlcul PUR: sense DOM, sense emmagatzematge, sense càrrecs clínics.
//
// Tres tipus de sortida, sempre visualment diferenciables a la UI:
//   real      -> administració registrada
//   derived   -> càlcul a partir de dades reals (saldo, dosis completes)
//   projected -> projecció futura a partir de la pauta de l'usuari

import { addDays, cmpDates, diffDays, todayISO } from './dates.js';
import { getDrug, intervalDaysFor, mgForClicks, clicksForDose, clicksPerDoseFor, resolveConversion, round, openShelfLifeFor } from './drugs.js';
import { createPlanEntry, nowISO } from './model.js';

export const KIND = { REAL: 'real', DERIVED: 'derived', PROJECTED: 'projected' };

export function treatmentDrug(treatment) {
  return getDrug(treatment && treatment.drugId);
}

/**
 * Tractaments VISIBLES: tots menys les tombes (`deletedAt`). Esborrar un
 * tractament és un esborrat SOFT perquè es sincronitzi i no pugui tornar.
 */
export function visibleTreatments(patient) {
  return (patient?.treatments || []).filter((t) => !t.deletedAt);
}

export function activeTreatment(patient) {
  if (!patient) return null;
  const list = visibleTreatments(patient).filter((t) => t.status === 'active');
  // Data d'inici més recent; si n'hi ha empat, el creat més tard
  return list.sort(
    (a, b) => cmpDates(b.startDate, a.startDate) ||
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  )[0] || null;
}

/**
 * Administracions VISIBLES: totes menys les tombades (`deletedAt`).
 * L'esborrat és SOFT perquè es sincronitzi: un dispositiu vell que no coneix
 * l'esborrat no el pot ressuscitar (el servidor conserva el que ell no envia).
 */
export function allAdministrations(treatment) {
  return [...(treatment?.administrations || [])]
    .filter((a) => !a.deletedAt)
    .sort((a, b) => cmpDates(a.date, b.date) || cmpDates(a.createdAt, b.createdAt));
}

export function penById(treatment, penId) {
  return (treatment?.pens || []).find((p) => p.id === penId) || null;
}

/** Plomes visibles: totes menys les esborrades (tomba `deleted`). */
export function visiblePens(treatment) {
  return (treatment?.pens || []).filter((p) => p.status !== 'deleted');
}

export function activePen(treatment) {
  if (!treatment) return null;
  const active = visiblePens(treatment).filter((p) => p.status === 'active');
  return active.sort((a, b) => cmpDates(b.startDate, a.startDate))[0] || null;
}

export function consumptionOf(admin) {
  return Number(admin?.amount || 0);
}

/** Consum registrat d'una ploma (sense el prèvi). */
export function penRegisteredUsed(treatment, penId) {
  return allAdministrations(treatment)
    .filter((a) => a.penId === penId)
    .reduce((sum, a) => sum + consumptionOf(a), 0);
}

/** Consum total d'una ploma: prèvi (ploma ja començada) + registrat. */
export function penUsed(treatment, penId) {
  const pen = penById(treatment, penId);
  const startUsed = pen ? Number(pen.startUsed) || 0 : 0;
  return startUsed + penRegisteredUsed(treatment, penId);
}

/** saldo = capacitatInicial − consumPrèvi − Σ consum */
export function penBalance(treatment, pen) {
  if (!pen) return null;
  const capacity = Number(pen.initialCapacity || 0);
  return capacity - penUsed(treatment, pen.id);
}

/** Clics per dosi completa de la ploma (null si es desconeixen). */
export function penClicksPerDose(pen) {
  const cpc = Number(pen && pen.clicksPerDose);
  return Number.isFinite(cpc) && cpc > 0 ? Math.round(cpc) : null;
}

/**
 * Una magnitud d'una ploma expressada en una altra unitat (null si no es pot
 * derivar): permet mostrar capacitat/saldo en Clics i en DOIS alhora.
 */
export function penValueIn(pen, value, unit) {
  if (pen == null || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (pen.capacityUnit === unit) return n;
  const cpc = penClicksPerDose(pen);
  if (!cpc) return null;
  return unit === 'clicks' ? Math.round(n * cpc) : round(n / cpc, 2);
}

/** Capacitat d'una ploma en clics i en dosis (les dues vistes). */
export function penCapacityIn(pen, unit) {
  return pen ? penValueIn(pen, Number(pen.initialCapacity || 0), unit) : null;
}

/** Saldo d'una ploma en clics i en dosis. */
export function penBalanceIn(treatment, pen, unit) {
  const balance = penBalance(treatment, pen);
  return balance == null ? null : penValueIn(pen, balance, unit);
}

/**
 * Resum de la ploma tipus count.click: què queda de la ploma i quantes dosis
 * hi caben. Tot deriva de la capacitat real (clics) de la ploma.
 *   {capacityClicks, balanceClicks, full, partial, remainder}
 */
export function penDoseSummary(treatment, pen) {
  const cpc = penClicksPerDose(pen);
  if (!pen || !cpc) return null;
  const capacityClicks = penCapacityIn(pen, 'clicks');
  const balanceClicks = penBalanceIn(treatment, pen, 'clicks');
  if (capacityClicks == null || balanceClicks == null) return null;
  const full = Math.max(0, Math.floor(balanceClicks / cpc));
  const remainder = Math.max(0, Math.round(balanceClicks - full * cpc));
  return { capacityClicks, balanceClicks, clicksPerDose: cpc, full, remainder, partial: remainder > 0 };
}

/** Saldo després de la data indicada (per a les fitxes del calendari). */
export function balanceAfterDate(treatment, pen, isoDate) {
  if (!pen) return null;
  const capacity = Number(pen.initialCapacity || 0);
  const consumed = allAdministrations(treatment)
    .filter((a) => a.penId === pen.id && cmpDates(a.date, isoDate) <= 0)
    .reduce((s, a) => s + consumptionOf(a), 0);
  return capacity - consumed;
}

export function balanceBeforeAdmin(treatment, pen, admin) {
  if (!pen) return null;
  const capacity = Number(pen.initialCapacity || 0);
  const consumed = allAdministrations(treatment)
    .filter(
      (a) =>
        a.penId === pen.id &&
        (cmpDates(a.date, admin.date) < 0 ||
          (a.date === admin.date && a.createdAt < admin.createdAt))
    )
    .reduce((s, a) => s + consumptionOf(a), 0);
  return capacity - consumed;
}

export function lastAdministration(treatment) {
  const list = allAdministrations(treatment);
  return list.length ? list[list.length - 1] : null;
}

export function firstAdministration(treatment) {
  const list = allAdministrations(treatment);
  return list.length ? list[0] : null;
}

/** Tram de pauta vigent en una data concreta. */
export function scheduleAt(treatment, isoDate) {
  const list = [...(treatment?.schedules || [])].filter(
    (s) => s.startDate && cmpDates(s.startDate, isoDate) <= 0
  );
  if (!list.length) return null;
  return list.sort((a, b) => cmpDates(b.startDate, a.startDate))[0];
}

export function sortedSchedules(treatment) {
  return [...(treatment?.schedules || [])].sort((a, b) => cmpDates(a.startDate, b.startDate));
}

/** Interval entre dues administracions per a la pauta vigent en una data. */
export function intervalAt(treatment, isoDate, drug) {
  const sch = scheduleAt(treatment, isoDate);
  if (sch && sch.intervalDays) return Number(sch.intervalDays);
  return intervalDaysFor(drug);
}

/**
 * Dosi actual: primer el registre real (última administració), sinó la pauta
 * vigent. La UI etiqueta cada cas perquè no es confonguin.
 */
export function currentDose(treatment) {
  const drug = treatmentDrug(treatment);
  const last = lastAdministration(treatment);
  if (last) {
    return {
      kind: KIND.REAL,
      mg: last.mg ?? null,
      mode: last.mode,
      value: last.value,
      amount: last.amount,
      unit: last.unit,
      date: last.date,
      label: 'Última dosi registrada',
    };
  }
  const sch = scheduleAt(treatment, todayISO()) || sortedSchedules(treatment)[0];
  if (sch) {
    return {
      kind: KIND.PROJECTED,
      mg: sch.mode === 'standard' ? sch.value : null,
      mode: sch.mode,
      value: sch.value,
      date: sch.startDate,
      label: 'Pauta vigent',
      drug,
    };
  }
  return null;
}

/**
 * Propera administració prevista segons la pauta.
 * Si la data ja ha passat, es retorna igual (sense rellançar): la UI ha de
 * poder dir "previst el 26/11, encara sense registrar" en lloc d'amagar-ho.
 */
export function nextDueDate(treatment) {
  const drug = treatmentDrug(treatment);
  const last = lastAdministration(treatment);
  if (!last) {
    const first = sortedSchedules(treatment)[0];
    return first ? first.startDate : null;
  }
  return addDays(last.date, intervalAt(treatment, last.date, drug));
}

/** Administracions previstes segons la pauta (mai modifica registres). */
export function projectAdministrations(treatment, { from = todayISO(), horizon = 180, limit = 26 } = {}) {
  const drug = treatmentDrug(treatment);
  const results = [];
  if (!treatment) return results;

  const schedules = sortedSchedules(treatment);
  if (!schedules.length) return results;

  const last = lastAdministration(treatment);
  const anchor = last
    ? last.date
    : addDays(schedules[0].startDate, -intervalAt(treatment, schedules[0].startDate, drug));

  let cursor = addDays(anchor, intervalAt(treatment, anchor, drug));
  let guard = 0;

  while (guard < limit * 4) {
    if (diffDays(from, cursor) > horizon) break;
    const sch = scheduleAt(treatment, cursor);
    if (sch) {
      const value = sch.value;
      results.push({
        kind: KIND.PROJECTED,
        date: cursor,
        mode: sch.mode,
        value,
        scheduleId: sch.id,
        mg: sch.mode === 'standard' ? value : null,
        intervalDays: Number(sch.intervalDays || intervalDaysFor(drug)),
      });
      if (results.length >= limit) break;
    }
    cursor = addDays(cursor, intervalAt(treatment, cursor, drug));
    guard += 1;
  }
  return results;
}

/**
 * Projecció de saldo de la ploma activa segons la pauta.
 * Cada pas {date, dose, balance, insufficient}.
 */
export function projectBalance(treatment, options = {}) {
  const drug = treatmentDrug(treatment);
  const pen = options.pen || activePen(treatment);
  const projected = projectAdministrations(treatment, options);
  const rows = [];

  if (!pen) {
    return projected.map((p) => ({ ...p, balanceBefore: null, balanceAfter: null, insufficient: true, missing: p.value }));
  }

  const conversion = resolveConversion(pen, drug);
  const penAdmins = allAdministrations(treatment).filter((a) => a.penId === pen.id);

  // Base: saldo actual real de la ploma. Totes les administracions registrades
  // són anteriors a la primera data projectada (l'àncora és l'última), per la
  // qual cosa no es poden duplicar; si n'hi hagués alguna en una data
  // projectada, ja està comptada i no es torna a restar.
  let balance = penBalance(treatment, pen);

  for (const p of projected) {
    const sch = scheduleAt(treatment, p.date);
    const registered = penAdmins.filter((a) => a.date === p.date);
    const amount = registered.length ? 0 : amountFor(p, pen, drug, conversion);
    const before = balance;
    const after = balance - amount;
    rows.push({
      ...p,
      amount,
      unit: pen.capacityUnit,
      balanceBefore: before,
      balanceAfter: after,
      insufficient: after < 0,
      missing: after < 0 ? Math.abs(after) : 0,
      scheduledButUnregistered: registered.length === 0,
      scheduleValue: sch ? sch.value : p.value,
    });
    balance = after;
  }
  return rows;
}

function amountFor(projected, pen, drug, conversion) {
  if (!pen) return 0;
  if (pen.capacityUnit === 'doses') return 1;
  if (projected.mode === 'clicks') return Number(projected.value || 0);
  if (conversion && projected.mg != null) return clicksForDose(projected.mg, conversion);
  return Math.round(Number(projected.value || 0));
}

/** dosisCompletes = floor(saldo / dosiPrevista); sobrant = saldo % dosiPrevista */
export function completeDoses(balance, nextDose) {
  const b = Number(balance);
  const d = Number(nextDose);
  if (!Number.isFinite(b) || !Number.isFinite(d) || d <= 0) {
    return { completes: 0, remainder: 0, valid: false };
  }
  return { completes: Math.max(0, Math.floor(b / d)), remainder: Math.max(0, b % d), valid: true };
}

/** Data aproximada d'esgotament de la ploma (segons projecció). */
export function depletionDate(treatment, options = {}) {
  const rows = projectBalance(treatment, options);
  const hit = rows.find((r) => r.balanceAfter <= 0);
  return hit ? hit.date : null;
}

/** Recalcula saldos després d'editar/esborrar una administració (acció explícita). */
export function recomputeBalances(treatment) {
  const admins = allAdministrations(treatment); // les tombades no consumeixen
  const byPen = new Map();
  for (const a of admins) {
    const pen = penById(treatment, a.penId);
    const capacity = pen ? Number(pen.initialCapacity || 0) : 0;
    if (!byPen.has(a.penId)) byPen.set(a.penId, pen ? Number(pen.startUsed) || 0 : 0); // consum prèvi
    const used = (byPen.get(a.penId) || 0) + consumptionOf(a);
    byPen.set(a.penId, used);
    a.balanceBefore = capacity - (used - consumptionOf(a));
    a.balanceAfter = capacity - used;
    if (!a.createdAt) a.createdAt = new Date().toISOString();
    a.editedAt = new Date().toISOString();
  }
  return treatment;
}

/** Quantitats per a la UI del registre ràpid. */
/**
 * Consum que implica administrar `value` amb la ploma donada.
 *
 * `injections` > 1 quan la dosi supera la dosi completa de la ploma (més clics
 * dels que la ploma marca en una injecció): llavors cal dividir-la en diverses
 * injeccions. Mai es pren la decisió clínica: la UI ho mostra com a avís.
 */
export function registerAmount({ mode, value, pen, drug }) {
  const conversion = resolveConversion(pen, drug);
  if (!pen) return { amount: 0, unit: 'doses', mg: null, valid: false, injections: 1 };

  const cpc = penClicksPerDose(pen) || clicksPerDoseFor(drug, pen.presentationMg, pen);
  const injections = (clicks) => (cpc && clicks > cpc ? Math.ceil(clicks / cpc) : 1);

  // Plomes amb capacitat en DOSES: cada administració consumeix 1 dosi.
  // Els clics només serveixen per a la dosi (si hi ha conversió) i queden
  // registrats a `value` amb el mg calculat.
  if (pen.capacityUnit === 'doses') {
    if (mode === 'clicks') {
      const clicks = Math.round(Number(value));
      if (!conversion || !Number.isFinite(clicks) || clicks <= 0) {
        return { amount: 0, unit: 'doses', mg: null, valid: false, injections: 1 };
      }
      return { amount: 1, unit: 'doses', mg: mgForClicks(clicks, conversion), valid: true, injections: injections(clicks) };
    }
    const mg = Number(value);
    return {
      amount: 1,
      unit: 'doses',
      mg: Number.isFinite(mg) ? mg : null,
      valid: Number.isFinite(mg) && mg > 0,
      injections: 1,
    };
  }

  if (mode === 'clicks') {
    const clicks = Math.round(Number(value));
    if (!Number.isFinite(clicks) || clicks <= 0) return { amount: 0, unit: 'clicks', mg: null, valid: false, injections: 1 };
    return { amount: clicks, unit: 'clicks', mg: mgForClicks(clicks, conversion), valid: true, injections: injections(clicks) };
  }
  const mg = Number(value);
  if (!Number.isFinite(mg) || mg <= 0) return { amount: 0, unit: 'clicks', mg: null, valid: false, injections: 1 };
  if (!conversion) return { amount: 1, unit: pen.capacityUnit, mg, valid: true, injections: 1 };
  const clicks = clicksForDose(mg, conversion);
  return { amount: clicks, unit: 'clicks', mg, valid: true, injections: injections(clicks) };
}

/**
 * Caducitat i obertura d'una ploma:
 *  - `expiryDate`: caducitat IMPRESA a la ploma (font: l'usuari)
 *  - `openUntil`: calculada a partir de l'obertura + la validesa del catàleg
 *  - `effective`: la que val per a l'alerta (impresa si hi és)
 * Sense dades, no es inventa cap data (`null`).
 */
export function penExpiry(treatment, pen, today = todayISO()) {
  if (!pen) return null;
  const drug = treatmentDrug(treatment);
  const shelfLife = openShelfLifeFor(drug);
  const openedAt = pen.openedAt || null;
  const openUntil = openedAt && shelfLife ? addDays(openedAt, shelfLife) : null;
  const effective = pen.expiryDate || openUntil;
  const daysLeft = effective ? diffDays(today, effective) : null;
  return {
    expiryDate: pen.expiryDate || null,
    openedAt,
    shelfLifeDays: shelfLife,
    openUntil,
    effective,
    daysLeft,
    expired: daysLeft != null && daysLeft < 0,
    expiringSoon: daysLeft != null && daysLeft >= 0 && daysLeft <= 30,
  };
}

/** Cost d'una ploma i cost per dosi derivat. */
export function penCost(pen) {
  if (!pen || pen.priceCents == null) return null;
  const cents = Math.round(Number(pen.priceCents));
  const doses = pen.dosesPerPen
    || (pen.clicksPerDose && Number(pen.initialCapacity) > 0
      ? Math.round(Number(pen.initialCapacity) / Number(pen.clicksPerDose))
      : null);
  return {
    cents,
    currency: pen.currency || 'EUR',
    doses: doses || null,
    perDoseCents: doses ? Math.round(cents / doses) : null,
  };
}

/**
 * Costos del tractament: preus de les plomes + despeses registrades.
 * Tot en cèntims enters.
 */
export function treatmentCosts(treatment) {
  if (!treatment) return { penCents: 0, otherCents: 0, totalCents: 0, currency: 'EUR' };
  const penCents = visiblePens(treatment)
    .reduce((sum, p) => sum + (p.priceCents == null ? 0 : Math.round(Number(p.priceCents))), 0);
  const otherCents = (treatment.costs || [])
    .reduce((sum, c) => sum + (c.amountCents == null ? 0 : Math.round(Number(c.amountCents))), 0);
  return { penCents, otherCents, totalCents: penCents + otherCents, currency: 'EUR' };
}

/** Setmana de tractament (1-based) a partir de la data d'inici. */
export function treatmentWeek(treatment, today = todayISO()) {
  if (!treatment || !treatment.startDate) return null;
  const days = diffDays(treatment.startDate, today);
  if (days < 0) return null;
  return Math.floor(days / 7) + 1;
}

/** Últim pes registrat (+ variació respecte l'anterior). */
export function latestWeight(treatment) {
  const rows = (treatment?.health || [])
    .filter((h) => !h.deletedAt && h.weightKg != null)
    .sort((a, b) => cmpDates(a.date, b.date));
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return {
    kg: Number(last.weightKg),
    date: last.date,
    delta: prev ? round(Number(last.weightKg) - Number(prev.weightKg), 1) : null,
    validated: last.validated === true,
  };
}

/** Alertes contextuais (informatives, no decisions clíniques). */
export function buildAlerts(patient, today = todayISO()) {
  const alerts = [];
  const treatment = activeTreatment(patient);
  if (!treatment) {
    if (visibleTreatments(patient).length === 0) return alerts;
    alerts.push({ type: 'no-active-treatment', severity: 'info', patientId: patient.id });
    return alerts;
  }

  const pen = activePen(treatment);
  if (!pen) {
    alerts.push({ type: 'no-active-pen', severity: 'warning', patientId: patient.id, treatmentId: treatment.id });
    return alerts;
  }

  const drug = treatmentDrug(treatment);
  const rows = projectBalance(treatment, { pen });
  const next = rows.find((r) => cmpDates(r.date, today) >= 0);

  // Caducitat / obertura (només si hi ha dades: mai s'inventen dates)
  const exp = penExpiry(treatment, pen, today);
  if (exp && exp.expired) {
    alerts.push({
      type: 'pen-expired', severity: 'danger', patientId: patient.id,
      treatmentId: treatment.id, penId: pen.id, date: exp.effective,
      daysLeft: exp.daysLeft,
    });
  } else if (exp && exp.expiringSoon) {
    alerts.push({
      type: 'pen-expiring', severity: 'warning', patientId: patient.id,
      treatmentId: treatment.id, penId: pen.id, date: exp.effective,
      daysLeft: exp.daysLeft,
    });
  }

  // Primera data de projecció que la ploma no pot cobrir (propi o una de posterior).
  const short = rows.find((r) => r.insufficient);
  if (short) {
    alerts.push({
      type: 'insufficient-pen',
      severity: 'danger',
      patientId: patient.id,
      treatmentId: treatment.id,
      penId: pen.id,
      missing: short.missing,
      unit: pen.capacityUnit,
      date: short.date,
      isFirst: !next || next.date === short.date,
    });
  }

  const depletion = depletionDate(treatment, { pen });
  if (depletion) {
    alerts.push({
      type: 'pen-runs-out',
      severity: 'info',
      patientId: patient.id,
      treatmentId: treatment.id,
      date: depletion,
      penId: pen.id,
    });
  }

  // Administració prevista sense registrar (informatiu) / endarrerida (avís).
  const due = nextDueDate(treatment, today);
  if (due && cmpDates(due, today) <= 0) {
    const late = diffDays(due, today);
    const interval = intervalAt(treatment, due, drug);
    if (late >= interval) {
      alerts.push({
        type: 'overdue-administration',
        severity: 'warning',
        patientId: patient.id,
        due,
        treatmentId: treatment.id,
      });
    } else {
      alerts.push({
        type: 'unregistered-scheduled',
        severity: 'info',
        patientId: patient.id,
        due,
        treatmentId: treatment.id,
      });
    }
  }

  // Pla dissenyat que no cap a la ploma assignada
  const planShort = planCoverage(treatment).find((c) => c.insufficient);
  if (planShort) {
    alerts.push({
      type: 'plan-pen-short',
      severity: 'warning',
      patientId: patient.id,
      treatmentId: treatment.id,
      penId: planShort.pen.id,
      missing: planShort.shortfall,
      unit: planShort.pen.capacityUnit,
      date: planShort.firstBad ? planShort.firstBad.date : null,
    });
  }

  return alerts;
}

export function toMg({ mode, value, amount, pen, drug }) {
  if (mode === 'clicks') {
    const conversion = resolveConversion(pen, drug);
    return mgForClicks(amount, conversion);
  }
  if (mode === 'standard') return round(Number(value), 4);
  return null;
}

/* =========================================================
   PLA — calendari dissenyat per plomes
   Les entrades de pla són independents: es generen, es mouen,
   s'editen i s'esborren sense tocar la pauta ni els registres.
   ========================================================= */

/** Propostes VISIBLES: totes menys les tombades (`deletedAt`). */
export function allPlans(treatment) {
  return [...(treatment?.plans || [])]
    .filter((p) => !p.deletedAt)
    .sort((a, b) => cmpDates(a.date, b.date) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/**
 * Estats que NO falten per fer: `omitted` (no es farà) i `cancelled` (treta del
 * pla). Queden a l'historial amb el seu motiu, però no compten com a pendents
 * ni ocupen saldo.
 */
export const PLAN_INACTIVE = ['omitted', 'cancelled'];

/** Propostes VISIBLES encara no registrades (qualsevol estat). */
export function plannedEntries(treatment) {
  return allPlans(treatment).filter((p) => !p.registeredAdminId);
}

/** Pla pendent: el que realment falta per fer (inclou les ajornades). */
export function pendingPlans(treatment) {
  return plannedEntries(treatment).filter((p) => !PLAN_INACTIVE.includes(p.status));
}

export function plansByDate(treatment) {
  const map = new Map();
  // totes les visibles (també les omeses/cancel·lades): la casella del calendari
  // ha d'obrir la fitxa per poder-les restaurar
  for (const p of plannedEntries(treatment)) {
    if (!map.has(p.date)) map.set(p.date, []);
    map.get(p.date).push(p);
  }
  return map;
}

export function plansForPen(treatment, penId) {
  return pendingPlans(treatment).filter((p) => p.penId === penId);
}

/**
 * Cobertura del pla per a cada ploma: quant consumirà el pla, què en quedarà
 * i si la ploma arriba (o sobra) per a totes les dates dissenyades.
 */
export function planCoverage(treatment) {
  const pending = pendingPlans(treatment);
  const byPen = new Map();
  for (const p of pending) {
    if (!byPen.has(p.penId)) byPen.set(p.penId, []);
    byPen.get(p.penId).push(p);
  }

  const rows = [];
  for (const pen of visiblePens(treatment)) {
    const entries = (byPen.get(pen.id) || []).sort((a, b) => cmpDates(a.date, b.date));
    if (!entries.length && pen.status !== 'active') continue;

    const balance = penBalance(treatment, pen);
    let used = 0;
    let firstBad = null;
    for (const e of entries) {
      used += Number(e.amount || 0);
      if (balance - used < 0 && !firstBad) firstBad = e;
    }
    const afterPlan = balance - used;

    rows.push({
      pen,
      entries,
      doses: entries.length,
      balance,
      pendingAmount: used,
      afterPlan,
      insufficient: afterPlan < 0,
      shortfall: afterPlan < 0 ? Math.abs(afterPlan) : 0,
      firstBad,
      from: entries.length ? entries[0].date : null,
      to: entries.length ? entries[entries.length - 1].date : null,
    });
  }
  return rows;
}

/**
 * Recalcula els snapshots de saldo d'UNA ploma (cronològicament), sense tocar
 * la resta: es fa servir en moure administracions d'una ploma a una altra.
 * @returns quantes administracions s'han recalculat
 */
export function recomputePenBalances(treatment, pen) {
  if (!treatment || !pen) return 0;
  const capacity = Number(pen.initialCapacity || 0);
  const startUsed = Number(pen.startUsed) || 0;
  const list = allAdministrations(treatment)
    .filter((a) => a.penId === pen.id)
    .sort((a, b) => cmpDates(a.date, b.date) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  let used = startUsed;
  for (const a of list) {
    a.balanceBefore = capacity - used;
    used += Number(a.amount || 0);
    a.balanceAfter = capacity - used;
  }
  return list.length;
}

/**
 * Esborra una ploma.
 *
 *  - `targetPenId`: les administracions i les propostes passen a una altra
 *    ploma (l'historial es conserva; és l'opció per defecte).
 *  - `removeData`: s'esborren també les administracions i les propostes.
 *
 * La ploma no desapareix: queda com a **tomba** (`status: 'deleted'`) perquè
 * l'esborrat pugui sincronitzar-se als altres dispositius. El seu número `seq`
 * es conserva, de manera que la numeració de les altres no es mou.
 *
 * @returns {{ok, reason?, moved, removed, plansMoved, plansRemoved, promoted}}
 */
export function deletePen(treatment, pen, { targetPenId = null, removeData = false } = {}) {
  if (!treatment || !pen) return { ok: false, reason: 'no-pen', moved: 0, removed: 0, plansMoved: 0, plansRemoved: 0, promoted: null };
  if (pen.status === 'deleted') return { ok: true, moved: 0, removed: 0, plansMoved: 0, plansRemoved: 0, promoted: null };

  const wasActive = pen.status === 'active';
  let moved = 0;
  let removed = 0;
  let plansMoved = 0;
  let plansRemoved = 0;

  if (removeData) {
    // Tombes (mai esborrat físic): així la pèrdua es sincronitza i cap
    // dispositiu vell pot ressuscitar les dades d'una ploma esborrada.
    const stamp = new Date().toISOString();
    removed = allAdministrations(treatment).filter((a) => a.penId === pen.id).length;
    plansRemoved = allPlans(treatment).filter((pl) => pl.penId === pen.id).length;
    for (const a of allAdministrations(treatment)) {
      if (a.penId === pen.id) a.deletedAt = stamp;
    }
    for (const pl of allPlans(treatment)) {
      if (pl.penId === pen.id) pl.deletedAt = stamp;
    }
    recomputeBalances(treatment);
  } else {
    const target = targetPenId ? penById(treatment, targetPenId) : null;
    if (!target || target.id === pen.id || target.status === 'deleted') {
      return { ok: false, reason: 'no-target', moved: 0, removed: 0, plansMoved: 0, plansRemoved: 0, promoted: null };
    }
    for (const a of allAdministrations(treatment)) {
      if (a.penId === pen.id) { a.penId = target.id; moved += 1; }
    }
    for (const pl of allPlans(treatment)) {
      if (pl.penId === pen.id) { pl.penId = target.id; plansMoved += 1; }
    }
    recomputePenBalances(treatment, target);
  }

  pen.status = 'deleted';
  pen.deletedAt = nowISO();

  // Si era la ploma activa, la més recent restant torna a estar activa.
  let promoted = null;
  if (wasActive) {
    const rest = visiblePens(treatment)
      .filter((p) => p.id !== pen.id && p.status !== 'discarded')
      .sort((a, b) => cmpDates(b.startDate, a.startDate));
    promoted = rest[0] || null;
    if (promoted) {
      promoted.status = 'active';
      promoted.endDate = null;
    }
  }

  return { ok: true, moved, removed, plansMoved, plansRemoved, promoted: promoted ? promoted.id : null };
}

/** Restaura una ploma esborrada (tomba → activa si no n'hi ha cap altra). */
export function restorePen(treatment, pen) {
  if (!treatment || !pen || pen.status !== 'deleted') return { ok: false, reason: 'not-deleted' };
  const hasActive = visiblePens(treatment).some((p) => p.id !== pen.id && p.status === 'active');
  pen.status = hasActive ? 'finished' : 'active';
  pen.deletedAt = null;
  if (pen.status === 'active') pen.endDate = null;
  return { ok: true, status: pen.status };
}

/** Data d'inici sugerida per a la ploma següent (última data planificada + interval). */
export function suggestNextPenStart(treatment, penId, intervalDays = 7) {
  const entries = plansForPen(treatment, penId);
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  return addDays(last.date, intervalDays);
}

/**
 * Data de continuació del pla d'una ploma tenint en compte TOTES les entrades
 * (pendents i ja registrades): serveix per a "afegir un tram" al final del
 * disseny sense tocar res del que ja hi ha.
 */
export function planStartDateAfter(treatment, penId, intervalDays = 7) {
  const entries = allPlans(treatment).filter((p) => p.penId === penId);
  if (!entries.length) return null;
  return addDays(entries[entries.length - 1].date, Math.max(1, Math.round(Number(intervalDays) || 7)));
}

/** Quantes dosis més caben a la ploma amb la dosi indicada. */
export function maxDosesFor(treatment, pen, { mode, value }) {
  if (!pen) return 0;
  const drug = treatmentDrug(treatment);
  const { amount, valid } = registerAmount({ mode, value, pen, drug });
  if (!valid || !amount) return 0;
  const balance = penBalance(treatment, pen);
  const pending = plansForPen(treatment, pen.id).reduce((s, p) => s + Number(p.amount || 0), 0);
  return Math.max(0, Math.floor((balance - pending) / amount));
}

/**
 * Genera les dates d'un pla. No escriu res: retorna el càlcul i la vista
 * crea les entrades.
 *
 * @returns {ok, reason, amount, unit, mg, dates, maxDoses, shortfallAt}
 */
export function generatePlan(treatment, { penId, mode = 'standard', value, startDate, intervalDays = 7, count }) {
  const pen = penById(treatment, penId);
  if (!pen) return { ok: false, reason: 'no-pen', dates: [] };

  const drug = treatmentDrug(treatment);
  const { amount, unit, mg, valid } = registerAmount({ mode, value, pen, drug });
  if (!valid || !amount) return { ok: false, reason: 'invalid-value', dates: [], amount: 0 };
  if (!isValidPlanDate(startDate)) return { ok: false, reason: 'invalid-date', dates: [], amount };

  const interval = Math.max(1, Math.round(Number(intervalDays) || 7));
  const maxDoses = maxDosesFor(treatment, pen, { mode, value });
  const wanted = Math.min(Math.max(1, Math.round(Number(count) || 0)), 104);
  const balance = penBalance(treatment, pen);
  const pending = plansForPen(treatment, pen.id).reduce((s, p) => s + Number(p.amount || 0), 0);

  const dates = [];
  let used = pending;
  let shortfallAt = null;
  for (let i = 0; i < wanted; i += 1) {
    const date = addDays(startDate, i * interval);
    used += amount;
    if (balance - used < 0 && shortfallAt === null) shortfallAt = date;
    dates.push(date);
  }

  return { ok: true, amount, unit, mg, interval, dates, maxDoses, balance, pending, shortfallAt, wanted };
}

function isValidPlanDate(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso);
}

/**
 * Enllaça automàticament la dosi prevista d'una data quan es registra de
 * manera real amb la mateixa ploma (el pla queda "complert", no desapareix).
 */
export function linkPlanToAdmin(treatment, admin) {
  if (!treatment || !admin) return null;
  const open = (treatment.plans || []).find(
    (p) => !p.registeredAdminId &&
      p.date === admin.date &&
      p.penId === admin.penId &&
      Number(p.amount) === Number(admin.amount)
  );
  if (open) open.registeredAdminId = admin.id;
  return open || null;
}

/** Si s'elimina l'administració, la data prevista torna a quedar pendent. */
export function unlinkPlanFromAdmin(treatment, adminId) {
  if (!treatment) return false;
  let changed = false;
  for (const p of treatment.plans || []) {
    if (p.registeredAdminId === adminId) {
      p.registeredAdminId = null;
      changed = true;
    }
  }
  return changed;
}

/**
 * Interval real del pla: la diferència més freqüent entre dates consecutives
 * (així un toc fora del ritme no canvia el cadenci de la continuació).
 */
export function planInterval(treatment, entries = allPlans(treatment)) {
  const drug = treatmentDrug(treatment);
  const gaps = [];
  for (let i = 1; i < entries.length; i += 1) {
    const d = Math.abs(diffDays(entries[i - 1].date, entries[i].date));
    if (d > 0) gaps.push(d);
  }
  if (gaps.length) {
    const counts = new Map();
    for (const g of gaps) counts.set(g, (counts.get(g) || 0) + 1);
    let best = gaps[gaps.length - 1];
    let bestN = -1;
    for (const [g, n] of counts) {
      if (n >= bestN) { best = g; bestN = n; }
    }
    return best;
  }
  return intervalDaysFor(drug);
}

export const AUTO_PLAN_MIN_FUTURE = 4;

/**
 * Continuació automàtica del pla.
 *
 * Amb `ref` (la dosi acaben de registrar):
 *   1. re-nivella les propostes PENDENTS d'aquella ploma des de la data del
 *      registre a la dosi registrada (pujar o baixar) — és una proposta, no un
 *      registre;
 *   2. assegura que hi hagi `minFuture` dates proposades al davant, afegint-ne
 *      de noves amb la mateixa dosi i el mateix interval.
 * Sense `ref` (des de l'editor del pla) continua des de l'última data del disseny.
 *
 * S'atura si:
 *   - l'usuari ha desactivat `treatment.autoPlan`
 *   - la ploma de referència ja no és activa
 *   - la ploma no admet més dosis (llavors toca crear la ploma següent)
 *   - ja hi ha prou dates futures proposades
 *
 * No toca cap registre real. Retorna {created, relevelled} sense inserir-les.
 */
export function ensurePlanContinuation(treatment, {
  minFuture = AUTO_PLAN_MIN_FUTURE,
  today = todayISO(),
  maxNew = 52,
  ref = null,
} = {}) {
  const empty = { created: [], relevelled: 0 };
  if (!treatment || treatment.autoPlan === false) return empty;

  let relevelled = 0;

  if (ref && Number(ref.amount) > 0 && ref.penId) {
    // La dosi registrada mana: totes les propostes pendents d'aquesta ploma
    // des de la data del registre passen al seu nivell.
    const target = {
      penId: ref.penId,
      mode: ref.mode,
      value: ref.value,
      amount: Number(ref.amount),
      unit: ref.unit,
      mg: ref.mg ?? null,
    };
    for (const p of pendingPlans(treatment)) {
      if (p.penId !== target.penId || cmpDates(p.date, ref.date) < 0) continue;
      const same = p.mode === target.mode
        && p.value === target.value
        && Number(p.amount) === target.amount
        && p.mg === target.mg;
      if (same) continue;
      p.mode = target.mode;
      p.value = target.value;
      p.amount = target.amount;
      p.unit = target.unit;
      p.mg = target.mg;
      relevelled += 1;
    }
  }

  // Àncora de la continuació: el pla continua on diu el disseny (última data),
  // excepte que no hi hagi pla encara → llavors neix del registre.
  const existing = allPlans(treatment);
  const target = ref && Number(ref.amount) > 0 && ref.penId
    ? { penId: ref.penId, mode: ref.mode, value: ref.value, amount: Number(ref.amount), unit: ref.unit, mg: ref.mg ?? null }
    : null;

  let anchorDate;
  let reference;
  if (existing.length) {
    const last = existing[existing.length - 1];
    anchorDate = last.date;
    reference = target && target.penId === last.penId
      ? target // la dosi registrada mana sobre el valor del disseny
      : {
          penId: last.penId,
          mode: last.mode,
          value: last.value,
          amount: Number(last.amount || 0),
          unit: last.unit,
          mg: last.mg ?? null,
        };
  } else if (target) {
    anchorDate = ref.date;
    reference = target;
  } else {
    return { created: [], relevelled };
  }

  const pen = penById(treatment, reference.penId);
  const amount = Number(reference.amount || 0);
  if (!pen || pen.status !== 'active' || amount <= 0) return { created: [], relevelled };

  const pending = pendingPlans(treatment);
  let future = pending.filter((p) => p.date >= today).length;
  if (future >= minFuture) return { created: [], relevelled };

  const drug = treatmentDrug(treatment);
  const all = allPlans(treatment);
  const interval = all.length >= 2
    ? planInterval(treatment, all)
    : intervalAt(treatment, anchorDate, drug);

  const balance = penBalance(treatment, pen);
  let used = pending
    .filter((p) => p.penId === pen.id)
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  // una data amb administració real o amb una altra proposta ja ocupada es salta
  const occupied = (iso) =>
    allAdministrations(treatment).some((a) => a.date === iso) ||
    pending.some((p) => p.date === iso);

  let cursor = anchorDate;
  const created = [];
  let guard = 0;
  while (future < minFuture && created.length < maxNew && guard < maxNew * 4) {
    guard += 1;
    cursor = addDays(cursor, interval);
    if (occupied(cursor)) continue;
    used += amount;
    if (balance - used < 0) break; // la ploma no arriba: no s'afegix res
    created.push(createPlanEntry({
      date: cursor,
      penId: reference.penId,
      mode: reference.mode,
      value: reference.value,
      amount: reference.amount,
      unit: reference.unit,
      mg: reference.mg ?? null,
    }));
    future += 1;
  }
  return { created, relevelled };
}

/**
 * Converteix un registre real en el nou centre del pla: re-nivella les
 * propostes futures a la dosi registrada, continua el pla i tanca la proposta
 * d'aquella data si n'hi ha.
 */
export function applyRegisteredDose(treatment, admin, opts = {}) {
  if (!treatment || !admin) return { created: [], relevelled: 0, linked: null };
  const ref = {
    penId: admin.penId,
    mode: admin.mode,
    value: admin.value,
    amount: Number(admin.amount || 0),
    unit: admin.unit,
    mg: admin.mg ?? null,
    date: admin.date,
  };
  const result = ensurePlanContinuation(treatment, { ...opts, ref });
  if (result.created.length) {
    treatment.plans = [...(treatment.plans || []), ...result.created];
  }
  const linked = linkPlanToAdmin(treatment, admin);
  return { ...result, linked };
}

/**
 * Esborra TOTES les administracions d'un tractament per tornar-lo a registrar
 * de nou. Conserva plomes, pla i registres de salut:
 *   - els saldos de les plomes tornen a l'inicial (es deriven del consum)
 *   - les dates de pla tornen a quedar PENDENTS (es desenllacen)
 */
export function clearAdministrations(treatment) {
  if (!treatment) return { removed: 0, reopened: 0 };
  const visible = allAdministrations(treatment);
  const removed = visible.length;
  const stamp = new Date().toISOString();
  for (const a of visible) a.deletedAt = a.deletedAt || stamp; // tombes, no esborrat
  recomputeBalances(treatment);
  let reopened = 0;
  for (const p of treatment.plans || []) {
    if (p.registeredAdminId) {
      p.registeredAdminId = null;
      reopened += 1;
    }
  }
  return { removed, reopened };
}

/**
 * Esborrat SOFT d'una administració: es marca la tomba i es recalculen els
 * saldos. La tomba es sincronitza (mai un dispositiu vell la ressuscita).
 * @returns `true` si s'ha tombat (idempotent).
 */
export function tombstoneAdministration(treatment, adminId) {
  const a = (treatment?.administrations || []).find((x) => x.id === adminId);
  if (!a || a.deletedAt) return false;
  a.deletedAt = new Date().toISOString();
  recomputeBalances(treatment);
  return true;
}

/** Desfés una tomba (només des d'una acció explícita de l'usuari). */
export function restoreAdministration(treatment, adminId) {
  const a = (treatment?.administrations || []).find((x) => x.id === adminId);
  if (!a || !a.deletedAt) return false;
  a.deletedAt = null;
  recomputeBalances(treatment);
  return true;
}

/** Tomba d'una proposta de pla (idempotent). */
export function tombstonePlan(treatment, planId) {
  const list = treatment?.plans || [];
  const p = list.find((x) => x.id === planId);
  if (!p || p.deletedAt) return false;
  p.deletedAt = new Date().toISOString();
  return true;
}

/** Desfés la tomba d'una proposta. */
export function restorePlan(treatment, planId) {
  const list = treatment?.plans || [];
  const p = list.find((x) => x.id === planId);
  if (!p || !p.deletedAt) return false;
  p.deletedAt = null;
  return true;
}

function touchPlan(p) {
  p.updatedAt = new Date().toISOString();
  return p;
}

function planById(treatment, planId) {
  const p = (treatment?.plans || []).find((x) => x.id === planId);
  return p && !p.deletedAt ? p : null;
}

/**
 * AJORNA: la proposta passa a una altra data (es conserva l'original a
 * `originalDate`). Continua sent pendent: només canvia quan es farà.
 */
export function postponePlan(treatment, planId, { date = null, reason = '' } = {}) {
  const p = planById(treatment, planId);
  if (!p || p.registeredAdminId) return null;
  if (date && date !== p.date) {
    p.originalDate = p.originalDate || p.date;
    p.date = date;
    p.movedTo = date;
  }
  p.status = 'postponed';
  if (reason) p.reason = reason;
  return touchPlan(p);
}

/** OMES: no es farà (sense substituta). Fora dels pendents, amb traça. */
export function omitPlan(treatment, planId, reason = '') {
  const p = planById(treatment, planId);
  if (!p || p.registeredAdminId) return null;
  p.status = 'omitted';
  if (reason) p.reason = reason;
  return touchPlan(p);
}

/** CANCEL·LA: treta del pla amb motiu (el registre real mai es toca). */
export function cancelPlan(treatment, planId, reason = '') {
  const p = planById(treatment, planId);
  if (!p || p.registeredAdminId) return null;
  p.status = 'cancelled';
  if (reason) p.reason = reason;
  return touchPlan(p);
}

/** TORNA AL PLA: desfer una omissió / cancel·lació / ajornament. */
export function reopenPlan(treatment, planId) {
  const p = planById(treatment, planId);
  if (!p || p.registeredAdminId) return null;
  p.status = 'planned';
  p.reason = '';
  p.originalDate = null;
  p.movedTo = null;
  return touchPlan(p);
}

/**
 * Fase (tram de pauta) que conté una data: {phase, from, to}.
 * `to` és l'últim dia de la fase (fi explicita o abans de la següent).
 */
export function phaseAt(treatment, isoDate) {
  const list = sortedSchedules(treatment);
  if (!list.length) return null;
  let idx = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (cmpDates(list[i].startDate, isoDate) <= 0) idx = i;
  }
  if (idx < 0) idx = 0;
  const phase = list[idx];
  const next = list[idx + 1] || null;
  let to = phase.endDate || null;
  if (next) {
    const before = addDays(next.startDate, -1);
    to = to ? (cmpDates(before, to) < 0 ? before : to) : before;
  }
  return { phase, from: phase.startDate, to };
}

/** Objectius per aplicar una dosi: tot el pla o a partir d'una data. */
export function selectPlanTargets(entries = [], { penId = null, scope = 'all', fromDate = null } = {}) {
  let list = (entries || []).filter((p) => !p.registeredAdminId && !PLAN_INACTIVE.includes(p.status));
  if (penId) list = list.filter((p) => p.penId === penId);
  if (scope === 'from' && fromDate) list = list.filter((p) => cmpDates(p.date, fromDate) >= 0);
  return list;
}

/**
 * Configuració per proposar el tractament ESTÀNDARD del fàrmac (sense que
 * l'usuari hagi de dissenyar res): primera dosi estàndard, cadència del fàrmac
 * i tantes dosis com hi capiguin a la ploma.
 */
export function standardProposalSettings(treatment) {
  const drug = treatmentDrug(treatment);
  const pen = activePen(treatment);
  if (!drug || !pen || !drug.standardDosesMg || !drug.standardDosesMg.length) return null;

  const dose = Number(drug.standardDosesMg[0]);
  const computed = registerAmount({ mode: 'standard', value: dose, pen, drug });
  if (!computed.valid || !computed.amount) return null;

  const max = maxDosesFor(treatment, pen, { mode: 'standard', value: dose });
  if (max <= 0) return null;

  const schedules = sortedSchedules(treatment);
  const startDate = schedules.length ? schedules[0].startDate : todayISO();
  return {
    penId: pen.id,
    mode: 'standard',
    value: dose,
    startDate,
    intervalDays: intervalAt(treatment, startDate, drug),
    count: Math.min(max, 16),
    amount: computed.amount,
    unit: computed.unit,
    mg: computed.mg,
  };
}

/** Esborra totes les dates pendents del pla (les registrades es queden). */
export function clearPendingPlan(treatment) {
  if (!treatment) return 0;
  const pending = pendingPlans(treatment);
  const stamp = new Date().toISOString();
  for (const p of pending) p.deletedAt = p.deletedAt || stamp; // tombes
  return pending.length;
}

/**
 * Propaga un canvi (dosi / ploma / desplaçament de dates) a les entrades de
 * pla PENDENTS a partir de `fromDate`. Els registres reals no es toquen mai.
 *
 * @returns nombre d'entrades modificades
 */
export function propagatePlanChanges(treatment, {
  penId = null,
  fromDate = null,
  toDate = null,
  ids = null,
  excludeId = null,
  value, mode, amount, unit, mg,
  shiftDays = 0,
} = {}) {
  const targets = pendingPlans(treatment).filter((p) => {
    if (Array.isArray(ids)) return ids.includes(p.id); // abast explícit
    if (p.id === excludeId) return false;
    if (penId && p.penId !== penId) return false;
    if (fromDate && cmpDates(p.date, fromDate) < 0) return false;
    if (toDate && cmpDates(p.date, toDate) > 0) return false; // límit de fase
    return Boolean(fromDate || penId);
  });
  for (const p of targets) {
    if (value !== undefined || amount !== undefined) {
      if (mode !== undefined) p.mode = mode;
      if (value !== undefined) p.value = value;
      if (amount !== undefined) p.amount = amount;
      if (unit !== undefined) p.unit = unit;
      if (mg !== undefined) p.mg = mg;
    }
    if (shiftDays) p.date = addDays(p.date, shiftDays);
  }
  return targets.length;
}
