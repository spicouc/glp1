// Esquema v3: traçabilitat (hora, prescripció, font), estats de pla, fases amb
// fi, inventari físic (caducitat/obertura) i costos. Tot CAMP ADDITIU.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION, validateBackup, validatePatient } from '../js/core/validate.js';
import { migrate, CURRENT_VERSION, freshDb } from '../js/data/migrations.js';
import { createRepository, memoryAdapter } from '../js/data/repository.js';
import { createPlanEntry, createAdministration, createPen, createCost, createTreatment } from '../js/core/model.js';
import { visibleTreatments, activeTreatment } from '../js/core/calc.js';

/** Pacient v2 de referència: sense cap camp de la v3. */
function v2Patient() {
  return {
    id: 'pat_v2', code: 'P-001', name: '', notes: '', archived: false,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    treatments: [{
      id: 'trt_v2', drugId: 'mounjaro', startDate: '2026-11-01', endDate: null,
      status: 'active', endReason: '', notes: '',
      pens: [{
        id: 'pen_v2', seq: 1, presentationMg: 5, startDate: '2026-11-01',
        endDate: null, status: 'active', capacityUnit: 'clicks',
        initialCapacity: 240, clicksPerDose: 60, dosesPerPen: 4, startUsed: 0,
        conversion: null, notes: '',
      }],
      administrations: [{
        id: 'adm_v2', date: '2026-11-01', penId: 'pen_v2', mode: 'clicks',
        value: 30, amount: 30, unit: 'clicks', mg: 2.5,
        balanceBefore: 240, balanceAfter: 210, notes: '',
        createdAt: '2026-11-01T08:00:00.000Z', editedAt: null,
      }],
      schedules: [{ id: 'sch_v2', startDate: '2026-11-01', mode: 'standard', value: 5, intervalDays: 7, notes: '' }],
      plans: [{ id: 'pln_v2', date: '2026-11-08', penId: 'pen_v2', mode: 'clicks', value: 30, amount: 30, unit: 'clicks', mg: 2.5, notes: '', registeredAdminId: null, createdAt: '2026-11-01T08:00:00.000Z' }],
      health: [{ id: 'hlh_v2', date: '2026-11-01', weightKg: 82.4, nausea: 1, vomiting: 0, diarrhea: 0, constipation: 0, abdominalPain: 0, otherEffects: '', notes: '' }],
    }],
  };
}

function backupV2() {
  return { app: 'glp1', schemaVersion: 2, exportedAt: '2026-11-01T00:00:00.000Z', patients: [v2Patient()] };
}

test('la migració 2 → 3 omple els camps nous sense tocar res existent', () => {
  const out = migrate(backupV2());
  assert.equal(out.schemaVersion, 3);
  const t = out.patients[0].treatments[0];
  const [pen] = t.pens;
  const [adm] = t.administrations;
  const [sch] = t.schedules;
  const [pln] = t.plans;
  const [hlh] = t.health;

  assert.equal(pen.expiryDate, null);
  assert.equal(pen.openedAt, null);
  assert.equal(pen.priceCents, null);
  assert.equal(pen.currency, 'EUR');

  assert.equal(adm.time, null);
  assert.equal(adm.prescribed, null);
  assert.equal(adm.source, 'manual');
  assert.equal(adm.idempotencyKey, null, 'la migració no inventa claus');

  assert.equal(sch.endDate, null);
  assert.equal(sch.durationDays, null);
  assert.equal(sch.status, 'active');

  assert.equal(pln.status, 'planned');
  assert.equal(pln.movedTo, null);
  assert.equal(pln.reason, '');

  assert.equal(hlh.source, 'manual');
  assert.equal(hlh.validated, false);

  assert.deepEqual(t.costs, []);

  // res existent es toca
  assert.equal(adm.amount, 30, 'el consum es conserva tal qual');
  assert.equal(adm.balanceAfter, 210, 'el snapshot de saldo es conserva');
  assert.equal(pen.initialCapacity, 240);
  assert.equal(sch.intervalDays, 7);
});

test('la migració és idempotent (migrar dues vegades canvia el mateix)', () => {
  const once = migrate(backupV2());
  const twice = migrate(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once, 'migrar dues vegades dona exactament el mateix');
});

test('els camps d\'una versió més nova NO s\'esborren (spread defensiu)', () => {
  const doc = backupV2();
  const pen = doc.patients[0].treatments[0].pens[0];
  pen.expiryDate = '2027-06-30';       // camp "futur" que aquesta versió no crea
  pen.serialNumber = 'LOT-123';        // camp totalment desconegut
  const out = migrate(doc);
  const after = out.patients[0].treatments[0].pens[0];
  assert.equal(after.expiryDate, '2027-06-30');
  assert.equal(after.serialNumber, 'LOT-123', 'un camp desconegut sobreviu la migració');
});

test('l\'estat deriva del vincle: amb administració → administered', () => {
  const doc = backupV2();
  const pln = doc.patients[0].treatments[0].plans[0];
  pln.registeredAdminId = 'adm_v2';
  const out = migrate(doc);
  assert.equal(out.patients[0].treatments[0].plans[0].status, 'administered');
});

test('validateBackup: la v2 es migra amb avís, la v3 passa neta', () => {
  const v2 = validateBackup(backupV2());
  assert.equal(v2.ok, true, 'un backup v2 continua sent vàlid');
  assert.ok(v2.warnings.some((w) => w.includes('migrar')), `avisos: ${v2.warnings}`);

  const repo = createRepository(memoryAdapter());
  assert.equal(repo.importBackup(backupV2(), 'replace').ok, true);
  assert.equal(repo.get('pat_v2').schemaVersion, undefined); // el pacient no porta versió
  const exported = repo.exportAll();
  assert.equal(exported.schemaVersion, SCHEMA_VERSION);
  assert.equal(validateBackup(exported).ok, true);
});

test('validatePatient: rebutja estats de pla desconeguts i hores invàlides', () => {
  const doc = migrate(backupV2());
  const p = doc.patients[0];
  const t = p.treatments[0];

  t.plans[0].status = 'regalada';
  assert.ok(validatePatient(p).some((e) => e.includes('.status: estat desconegut')), 'estat de pla');
  t.plans[0].status = 'planned';

  t.administrations[0].time = '25:99';
  assert.ok(validatePatient(p).some((e) => e.includes('.time: hora no vàlida')), 'hora');
  t.administrations[0].time = '08:30';
  assert.equal(validatePatient(p).length, 0, 'un document v3 ben format passa la validació');
});

test('validatePatient: una entrada vinculada no pot estar "planned"', () => {
  const doc = migrate(backupV2());
  const t = doc.patients[0].treatments[0];
  t.plans[0].registeredAdminId = 'adm_v2';
  t.plans[0].status = 'planned';
  assert.ok(validatePatient(doc.patients[0]).some((e) => e.includes("ha de ser 'administered'")));
});

test('validatePatient: costos en cèntims enters (mai floats)', () => {
  const doc = migrate(backupV2());
  const t = doc.patients[0].treatments[0];
  t.costs = [createCost({ date: '2026-11-01', kind: 'pen', amountCents: 12900 })];
  assert.equal(validatePatient(doc.patients[0]).length, 0);

  t.costs = [{ id: 'cst_bad', date: '2026-11-01', kind: 'pen', amountCents: 129.5 }];
  assert.ok(validatePatient(doc.patients[0]).some((e) => e.includes('amountCents')), 'centims');
});

test('fases: la data de fi no pot ser anterior a l\'inici', () => {
  const doc = migrate(backupV2());
  const t = doc.patients[0].treatments[0];
  t.schedules[0].endDate = '2026-10-01';
  t.schedules[0].durationDays = 28;
  assert.ok(validatePatient(doc.patients[0]).some((e) => e.includes('endDate: anterior a l\'inici')));
});

test('les fabriques de la v3 generen els camps nous', () => {
  const adm = createAdministration({ date: '2026-11-01', penId: 'pen_x', mode: 'clicks', value: 30, amount: 30, unit: 'clicks', time: '08:30' });
  assert.equal(adm.time, '08:30');
  assert.equal(adm.source, 'manual');
  assert.ok(adm.idempotencyKey, 'cada administració neix amb clau d\'idempotència');
  assert.equal(adm.deletedAt, null);
  const adm2 = createAdministration({ date: '2026-11-02', penId: 'pen_x' });
  assert.notEqual(adm2.idempotencyKey, adm.idempotencyKey, 'claus úniques');

  const pend = createPlanEntry({ date: '2026-11-08', penId: 'pen_x' });
  assert.equal(pend.status, 'planned');
  assert.equal(pend.deletedAt, null);
  const linked = createPlanEntry({ date: '2026-11-01', penId: 'pen_x', registeredAdminId: 'adm_1' });
  assert.equal(linked.status, 'administered', 'l\'estat no pot contradir el registre real');

  const pen = createPen({ presentationMg: 5 });
  assert.equal(pen.expiryDate, null);
  assert.equal(pen.priceCents, null);
  assert.equal(pen.currency, 'EUR');

  const cost = createCost({ date: '2026-11-01', kind: 'pen', amountCents: 129.9 });
  assert.equal(cost.amountCents, 130, 'els cèntims es redondegen a enters');
});

test('CURRENT_VERSION i SCHEMA_VERSION van junts', () => {
  assert.equal(CURRENT_VERSION, SCHEMA_VERSION);
  assert.equal(freshDb().schemaVersion, SCHEMA_VERSION);
});

test('esborrar un tractament és una tomba (i no es ressuscita en sincronitzar)', () => {
  const patient = { id: 'pat_x', code: 'P-X', treatments: [createTreatment({ drugId: 'mounjaro', startDate: '2026-11-01' })] };
  const treatment = patient.treatments[0];

  assert.equal(activeTreatment(patient), treatment, 'abans d\'esborrar, és l\'actiu');

  treatment.deletedAt = new Date().toISOString();
  assert.equal(activeTreatment(patient), null, 'esborrat → cap tractament actiu');
  assert.deepEqual(visibleTreatments(patient), [], 'no es llista');
  assert.equal(patient.treatments.length, 1, 'la tomba es conserva per sincronitzar');

  // la validació accepta la tomba
  assert.equal(validatePatient(patient).length, 0);
});
