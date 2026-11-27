// Cadenes de migració d'esquema. Esquema actual: 3.
// Cada pas converteix una versió a la següent; sempre es conserva el registre
// original (mai s'esborren dades realment registrades).

import { SCHEMA_VERSION } from '../core/validate.js';
import { normalisePatient } from '../core/model.js';

export const CURRENT_VERSION = SCHEMA_VERSION;

const STEPS = {
  // 0 -> 1: estructura inicial (pacient com a arrel)
  0: (db) => {
    const { patients, ...rest } = db || {};
    return {
      ...rest,
      schemaVersion: 1,
      patients: (Array.isArray(patients) ? patients : []).map(normalisePatient),
    };
  },

  // 2 -> 3: traçabilitat i control d'inventari (CAMP ADDITIUS, res esborrat)
  //   fases (schedules): endDate, durationDays, status, updatedAt
  //   plans: status, movedTo, reason, updatedAt, idempotencyKey
  //   administracions: time, prescribed, source, revertsId, idempotencyKey
  //   plomes: expiryDate, openedAt, priceCents, currency
  //   salut: source, validated          ·  tractaments: costs[]
  // `normalisePatient` omple els valors per defecte i `...obj` conserva els
  // camps desconeguts, així que una app v2 segueix llegint-lo (downgrade segur).
  2: (db) => {
    const { patients, ...rest } = db || {};
    return {
      ...rest,
      schemaVersion: 3,
      patients: (Array.isArray(patients) ? patients : []).map(normalisePatient),
    };
  },

  // 1 -> 2: entrades de pla (calendari dissenyat per plomes)
  1: (db) => {
    const { patients, ...rest } = db || {};
    return {
      ...rest,
      schemaVersion: 2,
      patients: (Array.isArray(patients) ? patients : []).map((p) => ({
        ...p,
        treatments: (p.treatments || []).map((t) => ({ ...t, plans: t.plans || [] })),
      })),
    };
  },
};

export function migrate(db) {
  let version = Number(db && db.schemaVersion != null ? db.schemaVersion : 0);
  if (!db || typeof db !== 'object') return freshDb();

  let working = db;
  let guard = 0;
  while (version < CURRENT_VERSION && guard < 20) {
    const step = STEPS[version];
    if (!step) throw new Error(`No hi ha cap migració des de la versió ${version}.`);
    working = step(working);
    version = Number(working.schemaVersion);
    guard += 1;
  }
  if (version > CURRENT_VERSION) {
    throw new Error(`El fitxer és d'una versió més nova (${version}) que l'aplicació (${CURRENT_VERSION}).`);
  }
  working.schemaVersion = CURRENT_VERSION;
  working.patients = (working.patients || []).map(normalisePatient);
  return working;
}

export function freshDb() {
  return { schemaVersion: CURRENT_VERSION, patients: [] };
}
