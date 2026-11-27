// Validació d'esquema. S'usa en importar (mai substituïm la base sense
// validar) i com a protecció de càrrega.

import { isValidISO } from './dates.js';
import { getDrug } from './drugs.js';

export const SCHEMA_VERSION = 3;

/** 'HH:MM' (hora local de l'administració) */
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
/** Diners en CÈNTIMS enters (mai floats). `null`/absent = sense cost desat. */
const isMoney = (v) => v == null || (Number.isInteger(Number(v)) && Number(v) >= 0);

/** Data (`YYYY-MM-DD`) o marca de temps ISO: així es desen les tombes. */
function isStamp(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(v);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validatePatient(p, path = 'pacient') {
  const errors = [];
  if (!isObj(p)) return [`${path}: ha de ser un objecte`];
  if (!p.id || typeof p.id !== 'string') errors.push(`${path}.id: obligatori`);
  if (!p.code || typeof p.code !== 'string') errors.push(`${path}.code: obligatori (codi/àlies)`);
  if (p.birthYear != null && (!Number.isInteger(Number(p.birthYear)) || Number(p.birthYear) < 1900 || Number(p.birthYear) > 2200)) {
    errors.push(`${path}.birthYear: any no vàlid`);
  }
  if (!Array.isArray(p.treatments)) {
    errors.push(`${path}.treatments: ha de ser una llista`);
    return errors;
  }
  p.treatments.forEach((t, i) => {
    const tp = `${path}.treatments[${i}]`;
    if (!isObj(t)) return errors.push(`${tp}: ha de ser un objecte`);
    if (!t.id) errors.push(`${tp}.id: obligatori`);
    if (t.deletedAt != null && !isStamp(t.deletedAt)) errors.push(`${tp}.deletedAt: data no vàlida`);
    if (!t.drugId || !getDrug(t.drugId)) errors.push(`${tp}.drugId: fàrmac desconegut (${t.drugId})`);
    if (!isValidISO(t.startDate)) errors.push(`${tp}.startDate: data no vàlida (${t.startDate})`);
    if (t.endDate && !isValidISO(t.endDate)) errors.push(`${tp}.endDate: data no vàlida`);
    if (!['active', 'paused', 'finished'].includes(t.status)) errors.push(`${tp}.status: estat desconegut`);

    const pens = t.pens || [];
    const penIds = new Set();
    pens.forEach((pen, j) => {
      const pp = `${tp}.pens[${j}]`;
      if (!isObj(pen)) return errors.push(`${pp}: ha de ser un objecte`);
      if (!pen.id) errors.push(`${pp}.id: obligatori`);
      if (penIds.has(pen.id)) errors.push(`${pp}.id: duplicat`);
      penIds.add(pen.id);
      if (!isValidISO(pen.startDate)) errors.push(`${pp}.startDate: data no vàlida`);
      if (!['active', 'finished', 'discarded', 'deleted'].includes(pen.status)) errors.push(`${pp}.status: estat desconegut`);
      if (pen.deletedAt != null && !isStamp(pen.deletedAt)) errors.push(`${pp}.deletedAt: data no vàlida`);
      if (pen.initialCapacity != null && !(Number(pen.initialCapacity) >= 0)) errors.push(`${pp}.initialCapacity: ha de ser ≥ 0`);
      if (pen.capacityUnit != null && !['clicks', 'doses'].includes(pen.capacityUnit)) errors.push(`${pp}.capacityUnit: unitat desconeguda`);
      if (pen.seq != null && !(Number(pen.seq) >= 1)) errors.push(`${pp}.seq: ha de ser ≥ 1`);
      if (pen.clicksPerDose != null && !(Number(pen.clicksPerDose) > 0)) errors.push(`${pp}.clicksPerDose: ha de ser > 0`);
      if (pen.dosesPerPen != null && !(Number(pen.dosesPerPen) > 0)) errors.push(`${pp}.dosesPerPen: ha de ser > 0`);
      if (pen.startUsed != null && !(Number(pen.startUsed) >= 0)) errors.push(`${pp}.startUsed: ha de ser ≥ 0`);
      if (pen.expiryDate != null && !isValidISO(pen.expiryDate)) errors.push(`${pp}.expiryDate: data no vàlida`);
      if (pen.openedAt != null && !isValidISO(pen.openedAt)) errors.push(`${pp}.openedAt: data no vàlida`);
      if (!isMoney(pen.priceCents)) errors.push(`${pp}.priceCents: ha de ser un enter ≥ 0 (cèntims)`);
    });

    const schedules = t.schedules || [];
    schedules.forEach((s, j) => {
      const sp = `${tp}.schedules[${j}]`;
      if (!isObj(s)) return errors.push(`${sp}: ha de ser un objecte`);
      if (!isValidISO(s.startDate)) errors.push(`${sp}.startDate: data no vàlida`);
      if (Number(s.intervalDays) <= 0) errors.push(`${sp}.intervalDays: ha de ser > 0`);
      if (s.endDate != null && !isValidISO(s.endDate)) errors.push(`${sp}.endDate: data no vàlida`);
      if (s.durationDays != null && !(Number(s.durationDays) > 0)) errors.push(`${sp}.durationDays: ha de ser > 0`);
      if (s.status != null && !['active', 'done', 'cancelled'].includes(s.status)) errors.push(`${sp}.status: estat desconegut`);
      if (isValidISO(s.startDate) && isValidISO(s.endDate) && s.endDate < s.startDate) {
        errors.push(`${sp}.endDate: anterior a l'inici de la fase`);
      }
    });

    (t.administrations || []).forEach((a, j) => {
      const ap = `${tp}.administrations[${j}]`;
      if (!isObj(a)) return errors.push(`${ap}: ha de ser un objecte`);
      if (!a.id) errors.push(`${ap}.id: obligatori`);
      if (!isValidISO(a.date)) errors.push(`${ap}.date: data no vàlida (${a.date})`);
      if (!a.penId) errors.push(`${ap}.penId: obligatori`);
      else if (!penIds.has(a.penId)) errors.push(`${ap}.penId: la ploma ${a.penId} no existeix en aquest tractament`);
      if (!['standard', 'clicks'].includes(a.mode)) errors.push(`${ap}.mode: mode desconegut`);
      if (!(Number(a.amount) >= 0)) errors.push(`${ap}.amount: ha de ser ≥ 0`);
      if (a.injections != null && !(Number(a.injections) >= 1)) errors.push(`${ap}.injections: ha de ser ≥ 1`);
      if (a.time != null && !isTime(a.time)) errors.push(`${ap}.time: hora no vàlida (${a.time})`);
      if (a.source != null && !['manual', 'import'].includes(a.source)) errors.push(`${ap}.source: font desconeguda`);
      if (a.prescribed != null && (!isObj(a.prescribed) || !['standard', 'clicks'].includes(a.prescribed.mode))) {
        errors.push(`${ap}.prescribed: snapshot de prescripció invàlid`);
      }
      if (a.idempotencyKey != null && typeof a.idempotencyKey !== 'string') errors.push(`${ap}.idempotencyKey: ha de ser text`);
      if (a.deletedAt != null && !isStamp(a.deletedAt)) errors.push(`${ap}.deletedAt: data no vàlida`);
    });

    (t.health || []).forEach((h, j) => {
      const hp = `${tp}.health[${j}]`;
      if (!isObj(h)) return errors.push(`${hp}: ha de ser un objecte`);
      if (!isValidISO(h.date)) errors.push(`${hp}.date: data no vàlida`);
      if (h.source != null && !['manual', 'import'].includes(h.source)) errors.push(`${hp}.source: font desconeguda`);
      if (h.validated != null && typeof h.validated !== 'boolean') errors.push(`${hp}.validated: ha de ser cert/fals`);
    });

    (t.plans || []).forEach((p, j) => {
      const pp = `${tp}.plans[${j}]`;
      if (!isObj(p)) return errors.push(`${pp}: ha de ser un objecte`);
      if (!p.id) errors.push(`${pp}.id: obligatori`);
      if (!isValidISO(p.date)) errors.push(`${pp}.date: data no vàlida (${p.date})`);
      // `penId` pot ser null: pla prescrit en mg sense ploma assignada
      // (l'assignació ve després, en registrar o editant). Si hi és, ha
      // d'existir al tractament.
      if (p.penId && !penIds.has(p.penId)) errors.push(`${pp}.penId: la ploma ${p.penId} no existeix en aquest tractament`);
      if (!['standard', 'clicks'].includes(p.mode)) errors.push(`${pp}.mode: mode desconegut`);
      if (!(Number(p.amount) >= 0)) errors.push(`${pp}.amount: ha de ser ≥ 0`);
      if (p.registeredAdminId && !(t.administrations || []).some((a) => a.id === p.registeredAdminId)) {
        errors.push(`${pp}.registeredAdminId: l'administració ${p.registeredAdminId} no existeix`);
      }
      if (p.status != null && !['planned', 'administered', 'postponed', 'omitted', 'cancelled'].includes(p.status)) {
        errors.push(`${pp}.status: estat desconegut (${p.status})`);
      }
      if (p.movedTo != null && !isValidISO(p.movedTo)) errors.push(`${pp}.movedTo: data no vàlida`);
      if (p.originalDate != null && !isValidISO(p.originalDate)) errors.push(`${pp}.originalDate: data no vàlida`);
      if (p.deletedAt != null && !isStamp(p.deletedAt)) errors.push(`${pp}.deletedAt: data no vàlida`);
      if (p.registeredAdminId && p.status && p.status !== 'administered') {
        errors.push(`${pp}.status: una entrada vinculada a un registre real ha de ser 'administered'`);
      }
    });

    if (t.costs !== undefined && !Array.isArray(t.costs)) errors.push(`${tp}.costs: ha de ser una llista`);
    (t.costs || []).forEach((c, j) => {
      const cp = `${tp}.costs[${j}]`;
      if (!isObj(c)) return errors.push(`${cp}: ha de ser un objecte`);
      if (!c.id) errors.push(`${cp}.id: obligatori`);
      if (!isValidISO(c.date)) errors.push(`${cp}.date: data no vàlida (${c.date})`);
      if (!['pen', 'admin', 'other'].includes(c.kind)) errors.push(`${cp}.kind: tipus desconegut`);
      if (!isMoney(c.amountCents)) errors.push(`${cp}.amountCents: ha de ser un enter ≥ 0 (cèntims)`);
    });
  });
  return errors;
}

/** Valida un backup complet. Retorna {ok, errors, warnings, summary}. */
export function validateBackup(data) {
  const errors = [];
  const warnings = [];

  if (!isObj(data)) return { ok: false, errors: ['El fitxer no conté un objecte JSON vàlid.'], warnings };

  const version = Number(data.schemaVersion || 0);
  if (!version) errors.push('Falta schemaVersion.');
  else if (version > SCHEMA_VERSION) errors.push(`Versió d'esquema no suportada: ${version} (màxima ${SCHEMA_VERSION}).`);
  else if (version < SCHEMA_VERSION) warnings.push(`Es migrarà de la versió ${version} a ${SCHEMA_VERSION}.`);

  if (!Array.isArray(data.patients)) errors.push('Falta el llistat "patients".');
  else if (!data.patients.length) warnings.push('El fitxer no conté cap pacient.');

  const ids = new Set();
  const codes = new Set();
  (data.patients || []).forEach((p, i) => {
    errors.push(...validatePatient(p, `patients[${i}]`));
    if (p && p.id) {
      if (ids.has(p.id)) errors.push(`patients[${i}].id: duplicat (${p.id})`);
      ids.add(p.id);
    }
    if (p && p.code) {
      if (codes.has(p.code)) warnings.push(`patients[${i}].code: codi repetit (${p.code})`);
      codes.add(p.code);
    }
  });

  return { ok: errors.length === 0, errors, warnings, summary: summarise(data) };
}

export function summarise(data) {
  const patients = data && Array.isArray(data.patients) ? data.patients : [];
  let treatments = 0;
  let pens = 0;
  let administrations = 0;
  let health = 0;
  let minDate = null;
  let maxDate = null;
  const bump = (d) => {
    if (!isValidISO(d)) return;
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  };
  for (const p of patients) {
    for (const t of p.treatments || []) {
      if (t.deletedAt) continue; // les tombes no compten
      treatments += 1;
      bump(t.startDate);
      bump(t.endDate);
      pens += (t.pens || []).length;
      for (const a of t.administrations || []) {
        if (a.deletedAt) continue; // les tombes no compten per als recomptes
        administrations += 1;
        bump(a.date);
      }
      health += (t.health || []).length;
      for (const h of t.health || []) bump(h.date);
      for (const s of t.schedules || []) bump(s.startDate);
    }
  }
  return { patients: patients.length, treatments, pens, administrations, health, minDate, maxDate };
}
