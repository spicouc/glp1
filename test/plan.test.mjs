// Pla: calendari dissenyat segons les plomes i les seves dosis.

import test from 'node:test';
import assert from 'node:assert/strict';
import { diffDays } from '../js/core/dates.js';
import {
  allAdministrations,
  allPlans,
  generatePlan,
  maxDosesFor,
  planCoverage,
  pendingPlans,
  plansForPen,
  plansByDate,
  suggestNextPenStart,
  planStartDateAfter,
  linkPlanToAdmin,
  unlinkPlanFromAdmin,
  ensurePlanContinuation,
  applyRegisteredDose,
  propagatePlanChanges,
  resequencePlanDates,
  plansOnDate,
  clearPendingPlan,
  clearAdministrations,
  selectPlanTargets,
  standardProposalSettings,
  penBalance,
  buildAlerts,
} from '../js/core/calc.js';
import { createPatient, createTreatment, createPen, createPlanEntry, createAdministration } from '../js/core/model.js';
import { getDrug, clicksAvailable } from '../js/core/drugs.js';
import { migrate, CURRENT_VERSION } from '../js/data/migrations.js';
import { validateBackup, SCHEMA_VERSION } from '../js/core/validate.js';
import { createRepository, memoryAdapter } from '../js/data/repository.js';

/** Pacient amb tractament Mounjaro, ploma de 240 clics i 90 clics ja registrats. */
function base() {
  const patient = createPatient({ code: 'P-001' });
  const treatment = createTreatment({ drugId: 'mounjaro', startDate: '2026-11-01' });
  const pen = createPen({ presentationMg: 10, startDate: '2026-11-01', initialCapacity: 240, capacityUnit: 'clicks' });
  treatment.pens.push(pen);
  for (const date of ['2026-11-01', '2026-11-08']) {
    treatment.administrations.push(
      createAdministration({ date, penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5 })
    );
  }
  patient.treatments.push(treatment);
  return { patient, treatment, pen };
}

test('generatePlan reparteix dates segons interval i detecta si la ploma no arriba', () => {
  const { treatment, pen } = base(); // saldo 210

  const plan = generatePlan(treatment, {
    penId: pen.id, mode: 'clicks', value: 15,
    startDate: '2026-11-15', intervalDays: 7, count: 4,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.amount, 15);
  assert.deepEqual(plan.dates, ['2026-11-15', '2026-11-22', '2026-11-29', '2026-12-06']);
  assert.equal(plan.maxDoses, 14, '210 / 15 = 14 dosis caben a la ploma');
  assert.equal(plan.shortfallAt, null);

  // 4 dosis de 30 clics = 120 → cap (saldo 210)
  const big = generatePlan(treatment, {
    penId: pen.id, mode: 'clicks', value: 30,
    startDate: '2026-11-15', intervalDays: 7, count: 10,
  });
  assert.equal(big.maxDoses, 7, '210 / 30 = 7');
  assert.equal(big.shortfallAt, '2027-01-03', 'la 8a dosi (240) ja no cap a 210');
  assert.equal(big.dates.length, 10, 'genera el nombre demanat malgrat el dèficit');
});

test('generatePlan rebutja entrades invàlides', () => {
  const { treatment, pen } = base();
  assert.equal(generatePlan(treatment, { penId: 'no-existeix', value: 15, startDate: '2026-11-15' }).ok, false);
  assert.equal(generatePlan(treatment, { penId: pen.id, value: 0, startDate: '2026-11-15' }).ok, false);
  assert.equal(generatePlan(treatment, { penId: pen.id, value: 15, startDate: 'data- dolenta' }).ok, false);
});

test('maxDosesFor té en compte el pla pendent de la mateixa ploma', () => {
  const { treatment, pen } = base();
  assert.equal(maxDosesFor(treatment, pen, { mode: 'clicks', value: 15 }), 14);

  treatment.plans.push(createPlanEntry({ date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' }));
  assert.equal(maxDosesFor(treatment, pen, { mode: 'clicks', value: 15 }), 13, 'queda 195 lliures');
});

test('planCoverage: consum del pla per ploma i detecció de dèficit', () => {
  const { treatment, pen } = base();
  treatment.plans = [
    createPlanEntry({ date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' }),
    createPlanEntry({ date: '2026-11-22', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' }),
    createPlanEntry({ date: '2026-11-29', penId: pen.id, mode: 'clicks', value: 100, amount: 100, unit: 'clicks' }),
  ];

  const [row] = planCoverage(treatment).filter((r) => r.pen.id === pen.id);
  assert.equal(row.balance, 210);
  assert.equal(row.pendingAmount, 130);
  assert.equal(row.afterPlan, 80);
  assert.equal(row.insufficient, false);
  assert.equal(row.doses, 3);
  assert.equal(row.from, '2026-11-15');
  assert.equal(row.to, '2026-11-29');

  treatment.plans.push(createPlanEntry({ date: '2026-12-06', penId: pen.id, mode: 'clicks', value: 100, amount: 100, unit: 'clicks' }));
  const [short] = planCoverage(treatment).filter((r) => r.pen.id === pen.id);
  assert.equal(short.insufficient, true);
  assert.equal(short.shortfall, 20, '230 consumits de 210');
  assert.equal(short.firstBad.date, '2026-12-06');
});

test('els plans registrats compten com a consum real, no com a pla pendent', () => {
  const { treatment, pen } = base();
  const entry = createPlanEntry({ date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' });
  treatment.plans = [entry];

  const adm = createAdministration({ date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' });
  treatment.administrations.push(adm);
  const linked = linkPlanToAdmin(treatment, adm);

  assert.equal(linked.id, entry.id, 'el registre real tanca la data prevista');
  assert.equal(pendingPlans(treatment).length, 0, 'no queda cap pla pendent');
  assert.equal(allPlansCount(treatment), 1, 'l\'entrada desapareix de l\'històric');
  assert.equal(planCoverage(treatment).find((r) => r.pen.id === pen.id).pendingAmount, 0);

  // esborrar l'administració torna a deixar la data prevista pendent
  unlinkPlanFromAdmin(treatment, adm.id);
  assert.equal(pendingPlans(treatment).length, 1);
  assert.equal(plansByDate(treatment).get('2026-11-15').length, 1);
});

function allPlansCount(treatment) {
  return (treatment.plans || []).length;
}

test('suggeriment de la ploma següent: última data planificada + interval', () => {
  const { treatment, pen } = base();
  assert.equal(suggestNextPenStart(treatment, pen.id, 7), null, 'sense pla no hi ha suggeriment');

  treatment.plans = [
    createPlanEntry({ date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' }),
    createPlanEntry({ date: '2026-11-22', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' }),
  ];
  assert.equal(suggestNextPenStart(treatment, pen.id, 7), '2026-11-29');
  assert.equal(plansForPen(treatment, pen.id).length, 2);
});

test('alerta quan el pla dissenyat no cap a la ploma', () => {
  const { patient, treatment, pen } = base();
  treatment.plans = [
    createPlanEntry({ date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 100, amount: 100, unit: 'clicks' }),
    createPlanEntry({ date: '2026-11-22', penId: pen.id, mode: 'clicks', value: 100, amount: 100, unit: 'clicks' }),
    createPlanEntry({ date: '2026-11-29', penId: pen.id, mode: 'clicks', value: 100, amount: 100, unit: 'clicks' }),
  ];
  patient.treatments = [treatment];

  const alert = buildAlerts(patient, '2026-11-19').find((a) => a.type === 'plan-pen-short');
  assert.ok(alert, 's\'ha d\'alertar que el pla no cap');
  assert.equal(alert.missing, 90, '300 consumits de 210');
  assert.equal(alert.date, '2026-11-29');
  assert.ok(!/augmenta|baixa|incremente/i.test(JSON.stringify(alert)), 'cap recomanació clínica');
});

test('migració v1 → v2 afegeix la col·lecció de plans', () => {
  const v1 = {
    schemaVersion: 1,
    app: 'glp1',
    patients: [{
      id: 'pat_1', code: 'P-001', name: '', notes: '', archived: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      treatments: [{
        id: 'trt_1', drugId: 'mounjaro', startDate: '2026-11-01', endDate: null,
        status: 'active', endReason: '', notes: '',
        pens: [], administrations: [], schedules: [], health: [],
      }],
    }],
  };

  const migrated = migrate(v1);
  assert.equal(migrated.schemaVersion, CURRENT_VERSION);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.app, 'glp1', 'conserva la resta de camps');
  assert.deepEqual(migrated.patients[0].treatments[0].plans, []);

  const repo = createRepository(memoryAdapter());
  const check = validateBackup(v1);
  assert.equal(check.ok, true, 'un backup v1 continua sent vàlid (es migra)');
  assert.ok(check.warnings.some((w) => w.includes('migrar')));
  assert.equal(repo.importBackup(v1, 'replace').ok, true);
  assert.deepEqual(repo.get('pat_1').treatments[0].plans, []);
});

test('un export amb plans valida i conserva les entrades', () => {
  const { patient, treatment, pen } = base();
  treatment.plans = [createPlanEntry({ date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' })];

  const repo = createRepository(memoryAdapter());
  repo.save(patient);
  const backup = repo.exportAll();
  assert.equal(backup.schemaVersion, SCHEMA_VERSION);
  assert.equal(validateBackup(backup).ok, true);

  const repo2 = createRepository(memoryAdapter());
  assert.equal(repo2.importBackup(backup, 'replace').ok, true);
  const reloaded = repo2.get(patient.id);
  assert.equal(reloaded.treatments[0].plans.length, 1);
  assert.equal(reloaded.treatments[0].plans[0].amount, 15);
  assert.equal(penBalance(reloaded.treatments[0], reloaded.treatments[0].pens[0]), 210);
});

test('un backup amb pla que apunta a una ploma inexistent es rebutja', () => {
  const { patient, treatment } = base();
  treatment.plans = [createPlanEntry({ date: '2026-11-15', penId: 'pen-fantasma', mode: 'clicks', value: 15, amount: 15, unit: 'clicks' })];
  const repo = createRepository(memoryAdapter());
  repo.save(patient);
  const check = validateBackup(repo.exportAll());
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('pen-fantasma')));
});

/* ---------- continuació automàtica i propagació de canvis ---------- */

const TODAY = '2026-11-19';

function plannedWeeks() {
  const { patient, treatment, pen } = base();
  treatment.plans = ['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11'].map((date) =>
    createPlanEntry({ date, penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5 }));
  return { patient, treatment, pen };
}

test('la continuació automàtica només passa amb consentiment explícit i mai reescriu', () => {
  const { treatment, pen } = plannedWeeks();

  // 1) Per defecte (i als tractaments existents) no es toca res del pla
  assert.equal(treatment.autoPlan, false, 'per defecte desactivada');
  assert.equal(ensurePlanContinuation(treatment, { today: TODAY }).created.length, 0, 'sense consentiment no continua');

  // 2) Sense disseny previ no hi ha res a continuar: mai s'infereix una data
  const bare = base();
  bare.treatment.autoPlan = true;
  assert.equal(ensurePlanContinuation(bare.treatment, { today: TODAY }).created.length, 0, 'sense pla no es inventa cap data');

  // 3) Amb consentiment, 4 dates futures → no cal allargar res
  treatment.autoPlan = true;
  assert.equal(ensurePlanContinuation(treatment, { today: TODAY }).created.length, 0, 'ja hi ha 4 futures');

  // 4) Es registra la primera → en queden 3 → se n'afegeix 1 amb la DOSI DEL
  //    DISSENY (15 clics), amb la mateixa ploma i el mateix interval
  const adm = createAdministration({
    date: '2026-11-20', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5,
  });
  treatment.administrations.push(adm);
  assert.ok(linkPlanToAdmin(treatment, adm), 'el registre amb la mateixa dosi tanca el pla d\'aquell dia');

  const cont = ensurePlanContinuation(treatment, { today: TODAY });
  assert.equal(cont.created.length, 1);
  assert.equal(cont.relevelled, 0, 'mai re-nivella el que ja estava escrit');
  assert.equal(cont.created[0].date, '2026-12-18', 'última data planificada + interval');
  assert.equal(cont.created[0].amount, 15, 'dosi del disseny');
  assert.equal(cont.created[0].penId, pen.id, 'mateixa ploma');
  assert.equal(cont.created[0].registeredAdminId, null);

  // en inserir-les, el pla torna a tenir 4 futures
  treatment.plans = [...treatment.plans, ...cont.created];
  assert.equal(ensurePlanContinuation(treatment, { today: TODAY }).created.length, 0);
  assert.ok(planCoverage(treatment).find((r) => r.pen.id === pen.id).doses >= 4);
});

test('registrar una dosi diferent conserva TOTES les dosis futures (P0)', () => {
  const { treatment, pen } = plannedWeeks(); // 4 propostes a 15 clics
  const adm = createAdministration({
    date: '2026-11-20', penId: pen.id, mode: 'clicks', value: 30, amount: 30, unit: 'clicks', mg: 5,
  });
  treatment.administrations.push(adm);

  const res = applyRegisteredDose(treatment, adm, { today: TODAY });
  assert.equal(res.relevelled, 0, 'cap reanivellament');
  assert.ok(res.linked, 'la discrepància no impedeix tancar la proposta d\'aquell dia');
  assert.equal(res.linked.amount, 15, 'la proposta conserva la dosi PRESCRITA (15)');
  assert.equal(res.linked.mg, 2.5, 'i el mg prescrit');
  assert.equal(adm.amount, 30, 'l\'administració conserva la dosi REAL (30)');
  assert.equal(res.created.length, 0, 'sense consentiment no s\'allarga el pla');

  const pending = treatment.plans.filter((p) => !p.registeredAdminId);
  assert.equal(pending.length, 3, 'la del 20/11 queda registrada');
  assert.ok(pending.every((p) => p.amount === 15), 'les futures segueixen a 15: ' + pending.map((p) => p.amount).join(','));
  assert.equal(planCoverage(treatment).find((r) => r.pen.id === pen.id).pendingAmount, 45, '3 × 15');
  assert.equal(treatment.administrations.length, 3, '2 previs + 1 nou');
});

test('sense pla previ, registrar una dosi no s\'inventa cap data futura', () => {
  const { treatment, pen } = base(); // cap entrada de pla
  assert.equal(pendingPlans(treatment).length, 0);

  const adm = createAdministration({
    date: '2026-11-19', penId: pen.id, mode: 'clicks', value: 30, amount: 30, unit: 'clicks', mg: 5,
  });
  treatment.administrations.push(adm);

  treatment.autoPlan = true; // fins i tot amb consentiment: no hi ha disseny
  const res = applyRegisteredDose(treatment, adm, { today: TODAY });
  assert.equal(res.relevelled, 0, 'no hi ha res a re-nivellar');
  assert.equal(res.created.length, 0, 'no es desplega una pauta des d\'un registre solt');
  assert.equal(res.linked, null, 'no hi havia cap proposta per a aquesta data');
  assert.equal(treatment.plans.length, 0, 'el pla segueix buit');
  assert.equal(treatment.administrations.length, 3, 'el registre real hi és (2 previs + 1 nou)');
});

test('mai genera dates passades: la continuació comença a partir d\'avui', () => {
  const { treatment, pen } = base();
  treatment.autoPlan = true;
  // Pla antic: totes les dates del gener i encara pendents
  treatment.plans = ['2026-01-01', '2026-01-08'].map((date) =>
    createPlanEntry({ date, penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5 }));

  const today = '2026-11-27';
  const res = ensurePlanContinuation(treatment, { today });
  assert.ok(res.created.length > 0, 's\'han d\'afegir dates futures');
  assert.ok(res.created.every((p) => p.date >= today),
    'cap data anterior a avui: ' + res.created.map((p) => p.date).join(','));
  // cadència correcta des de la darrera data del disseny, saltant fins a avui
  for (let i = 1; i < res.created.length; i += 1) {
    assert.equal(diffDays(res.created[i - 1].date, res.created[i].date), 7, 'interval setmanal respectat');
  }
  assert.ok(planCoverage(treatment).find((r) => r.pen.id === pen.id).doses >= 0);
});

test('esborrar tot el registre de dosis: saldo a l\'inicial i pla pendent un altre cop', () => {
  const { treatment, pen } = plannedWeeks();
  const adm1 = createAdministration({ date: '2026-11-20', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5 });
  treatment.administrations.push(adm1);
  applyRegisteredDose(treatment, adm1, { today: TODAY });
  assert.equal(pendingPlans(treatment).length, 3, 'una data queda feta');

  const total = treatment.administrations.length; // 2 de base + 1 nova
  assert.ok(total >= 3);
  const res = clearAdministrations(treatment);

  assert.equal(res.removed, total, 'esborra totes les administracions');
  assert.equal(allAdministrations(treatment).length, 0, 'cap registre real restant (les tombes no consumeixen)');
  assert.equal(treatment.administrations.filter((a) => a.deletedAt).length, total, 'es conserven com a tombes per sincronitzar');
  assert.equal(res.reopened, 1, 'la data feta torna a quedar pendent');
  assert.equal(pendingPlans(treatment).length, 4, 'tornen a estar totes pendents');
  assert.equal(penBalance(treatment, pen), 240, 'el saldo torna a la capacitat inicial');
  assert.equal(treatment.plans.length, 4, 'el pla es conserva');
  assert.equal(clearAdministrations(treatment).removed, 0, 'idempotent');
});

test('selectPlanTargets: abast total o a partir d\'una data', () => {
  const { treatment, pen } = plannedWeeks();
  const pending = pendingPlans(treatment);

  assert.equal(selectPlanTargets(pending, { penId: pen.id, scope: 'all' }).length, 4, 'tot el pla');
  assert.deepEqual(
    selectPlanTargets(pending, { penId: pen.id, scope: 'from', fromDate: '2026-12-04' }).map((p) => p.date),
    ['2026-12-04', '2026-12-11'],
    'a partir de la data'
  );
  assert.equal(selectPlanTargets(pending, { penId: 'un-altra-ploma', scope: 'all' }).length, 0, 'filtra per ploma');

  pending[0].registeredAdminId = 'adm_x';
  assert.equal(selectPlanTargets(pending, { penId: pen.id, scope: 'all' }).length, 3, 'les ja registrades mai són objectiu');
});

test('standardProposalSettings: proposa el tractament estàndard del fàrmac', () => {
  const { treatment, pen } = base(); // Mounjaro · ploma 10 mg · 240 clics · 30 clics consumits
  const settings = standardProposalSettings(treatment);
  assert.ok(settings, 'hi ha proposta possible');
  assert.equal(settings.mode, 'standard');
  assert.equal(settings.value, 2.5, 'primera dosi estàndard de Mounjaro');
  assert.equal(settings.penId, pen.id, 'amb la ploma activa');
  assert.equal(settings.startDate, '2026-11-01', 'data de la primera pauta');
  assert.equal(settings.intervalDays, 7, 'setmanal');
  assert.equal(settings.amount, 15, '2,5 mg en ploma de 10 mg = 15 clics');
  assert.equal(settings.count, 14, '180 clics lliures / 15 per dosi');

  const gen = generatePlan(treatment, settings);
  assert.equal(gen.ok, true);
  assert.equal(gen.dates.length, 14, 'proposa tantes dosis com hi capiguin');
  assert.ok(gen.dates.every((d) => d >= '2026-11-01'), 'des de l\'inici de la pauta en endavant');
  assert.equal(gen.shortfallAt, null, 'sense dèficit');
});

test('planStartDateAfter: el disseny es continua després de l\'última data', () => {
  const { treatment, pen } = plannedWeeks();
  assert.equal(planStartDateAfter(treatment, pen.id, 7), '2026-12-18', 'última planificada (11/12) + interval');
  assert.equal(planStartDateAfter(treatment, pen.id, 14), '2026-12-25', 'interval propi del tram');
  assert.equal(planStartDateAfter(treatment, 'pen-inexistent', 7), null);

  // Registrar-ne una no mou l'última data del disseny
  const adm = createAdministration({ date: '2026-11-20', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' });
  treatment.administrations.push(adm);
  linkPlanToAdmin(treatment, adm);
  assert.equal(planStartDateAfter(treatment, pen.id, 7), '2026-12-18');

  // Afegir un tram amb una altra dosi no toca cap entrada existent
  const before = JSON.stringify(treatment.plans);
  const res = generatePlan(treatment, {
    penId: pen.id, mode: 'clicks', value: 30,
    startDate: planStartDateAfter(treatment, pen.id, 7), intervalDays: 7, count: 2,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.dates, ['2026-12-18', '2026-12-25']);
  assert.equal(res.amount, 30, 'el tram pot portar una altra dosi');
  assert.equal(JSON.stringify(treatment.plans), before, 'generatePlan només calcula, no escriu');
});

test('esborrar el pla elimina les dates pendents i conserva les registrades', () => {
  const { treatment, pen } = plannedWeeks();
  const adm = createAdministration({ date: '2026-11-20', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks' });
  treatment.administrations.push(adm);
  linkPlanToAdmin(treatment, adm);

  assert.equal(clearPendingPlan(treatment), 3, 'les 3 dates restants són pendents');
  assert.equal(allPlans(treatment).length, 1, 'es conserva la data ja registrada');
  assert.equal(treatment.plans.filter((p) => p.deletedAt).length, 3, 'les 3 pendents queden com a tombes');
  assert.equal(treatment.plans[0].registeredAdminId, adm.id);
  assert.equal(pendingPlans(treatment).length, 0);
  assert.equal(clearPendingPlan(treatment), 0, 'idempotent');
  assert.equal(treatment.administrations.length, 3, 'els registres reals no es toquen (2 previs + 1 nou)');
});

test('la continuació s\'atura si està desactivada, la ploma no és activa o no hi cap', () => {
  const register1 = (ctx) => ctx.treatment.administrations.push(createAdministration({
    date: '2026-11-20', penId: ctx.pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks',
  }));

  const a = plannedWeeks();
  a.treatment.autoPlan = false;
  register1(a);
  assert.equal(ensurePlanContinuation(a.treatment, { today: TODAY }).created.length, 0, 'autoPlan desactivat');

  const b = plannedWeeks();
  b.treatment.autoPlan = true;
  b.pen.status = 'finished';
  register1(b);
  assert.equal(ensurePlanContinuation(b.treatment, { today: TODAY }).created.length, 0, 'ploma acabada');

  const c = plannedWeeks();
  c.treatment.autoPlan = true;
  c.pen.initialCapacity = 45; // saldo 15 → no caben més dosis de 15
  register1(c);
  assert.equal(ensurePlanContinuation(c.treatment, { today: TODAY }).created.length, 0, 'ploma sense saldo');
});

test('propagar un canvi de dosi a les futures, sense tocar les passades', () => {
  const { treatment, pen } = plannedWeeks();

  const n = propagatePlanChanges(treatment, {
    penId: pen.id, fromDate: '2026-11-27',
    value: 30, mode: 'clicks', amount: 30, unit: 'clicks', mg: 5,
  });
  assert.equal(n, 3, 'les 3 dates a partir del 27/11');
  assert.deepEqual(treatment.plans.map((p) => p.amount), [15, 30, 30, 30]);
  assert.deepEqual(treatment.plans.map((p) => p.date), ['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11']);
});

test('aplicar una dosi a les propostes: pujar i abaixar d\'un cop', () => {
  const { treatment, pen } = plannedWeeks();

  // Puja: totes les propostes passen a l'última dosi triada (30 clics)
  const up = propagatePlanChanges(treatment, {
    penId: pen.id, fromDate: '2026-11-20',
    value: 30, mode: 'clicks', amount: 30, unit: 'clicks', mg: 5,
  });
  assert.equal(up, 4, '4 propostes afectades');
  assert.ok(treatment.plans.every((p) => p.amount === 30), 'totes segueixen la dosi nova');

  // Abaixa: només a partir del 04/12 → les dues últimes tornen a 15 clics
  const down = propagatePlanChanges(treatment, {
    penId: pen.id, fromDate: '2026-12-04',
    value: 15, mode: 'clicks', amount: 15, unit: 'clicks', mg: 2.5,
  });
  assert.equal(down, 2, 'només les propostes a partir del 04/12');
  assert.deepEqual(treatment.plans.map((p) => p.amount), [30, 30, 15, 15]);
  assert.deepEqual(
    treatment.plans.map((p) => p.date),
    ['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11'],
    'sense desplaçar dates (shiftDays 0)'
  );
  assert.equal(treatment.administrations.length, 2, 'els registres reals no es toquen');
  assert.equal(pendingPlans(treatment).length, 4, 'cap proposta desapareix');
});

test('propagatePlanChanges amb ids explícits (abast del formulari)', () => {
  const { treatment, pen } = plannedWeeks();
  const ids = [treatment.plans[2].id, treatment.plans[3].id]; // 04/12 i 11/12
  const n = propagatePlanChanges(treatment, {
    ids,
    value: 45, mode: 'clicks', amount: 45, unit: 'clicks', mg: 7.5,
  });
  assert.equal(n, 2);
  assert.deepEqual(treatment.plans.map((p) => p.amount), [15, 15, 45, 45], 'només els objectius');
  assert.deepEqual(treatment.plans.map((p) => p.date), ['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11']);
  assert.equal(pen.id, pen.id);
});

test('moure una data futures desplaça les posteriors amb el mateix interval', () => {
  const { treatment, pen } = plannedWeeks();

  const shifted = propagatePlanChanges(treatment, {
    penId: pen.id, fromDate: '2026-12-04', excludeId: treatment.plans[2].id, shiftDays: 7,
  });
  assert.equal(shifted, 1, 'només la data posterior');
  assert.deepEqual(
    treatment.plans.map((p) => p.date),
    ['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-18']
  );
});

test('la propagació només toca entrades pendents (mai les registrades ni els registres reals)', () => {
  const { treatment, pen } = plannedWeeks();
  const adm = createAdministration({
    date: '2026-11-27', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks',
  });
  treatment.administrations.push(adm);
  linkPlanToAdmin(treatment, adm); // el 27/11 queda fet

  const n = propagatePlanChanges(treatment, {
    penId: pen.id, fromDate: '2026-11-27',
    value: 30, mode: 'clicks', amount: 30, unit: 'clicks', mg: 5,
  });
  assert.equal(n, 2, 'només les dues futures pendents (04/12 i 11/12)');
  assert.equal(treatment.plans[1].amount, 15, 'l\'entrada ja registrada no canvia');
  assert.equal(treatment.administrations.find((a) => a.id === adm.id).amount, 15, 'el registre real es queda com estava');
});

/* ---------- issue #3: dues plomes, cadència i una dosi per data ---------- */

test('propagar una dosi en mg la recalcula amb la presentació de CADA ploma', () => {
  const { treatment, pen } = base(); // ploma de 10 mg → mgPerClick = 10/60
  const other = createPen({ presentationMg: 5, startDate: '2026-11-01', initialCapacity: 240, capacityUnit: 'clicks' });
  treatment.pens.push(other);

  treatment.plans = [
    createPlanEntry({ date: '2026-11-27', penId: pen.id, mode: 'standard', value: 2.5, amount: 15, unit: 'clicks', mg: 2.5 }),
    createPlanEntry({ date: '2026-12-04', penId: other.id, mode: 'standard', value: 2.5, amount: 30, unit: 'clicks', mg: 2.5 }),
  ];

  const n = propagatePlanChanges(treatment, {
    fromDate: '2026-11-01', value: 5, mode: 'standard', amount: 60, unit: 'clicks', mg: 5,
  });
  assert.equal(n, 2);
  const forPen = (id) => treatment.plans.find((x) => x.penId === id);
  // 10 mg → 5 mg = 30 clics · 5 mg → 5 mg = 60 clics. Abans totes rebien el
  // valor calculat amb la ploma activa (30) i la de 5 mg quedava mal convertida.
  assert.equal(forPen(pen.id).amount, 30, 'ploma de 10 mg');
  assert.equal(forPen(other.id).amount, 60, 'ploma de 5 mg');
  assert.ok(treatment.plans.every((x) => x.unit === 'clicks' && x.mg === 5), 'mateixa dosi en mg per a totes');
});

test('resequencePlanDates: cadència nova dins de la fase, sense tocar res més', () => {
  const { treatment, pen } = base();
  treatment.plans = ['2026-12-06', '2026-12-13', '2026-12-20', '2026-12-27'].map((date) =>
    createPlanEntry({ date, penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5 }));
  treatment.plans[1].status = 'omitted';        // fora dels pendents
  treatment.plans[2].registeredAdminId = 'adm_x'; // ja feta

  const res = resequencePlanDates(treatment, {
    fromDate: '2026-12-01', toDate: '2026-12-31', start: '2026-12-01', interval: 14,
  });
  assert.equal(res.moved, 2, 'les dues pendents es recalculen');
  assert.equal(res.conflicts, 0);
  assert.equal(treatment.plans[0].date, '2026-12-01', 'ancorada a l\'inici de la fase');
  assert.equal(treatment.plans[3].date, '2026-12-15', 'segona de la nova cadència');
  assert.equal(treatment.plans[1].date, '2026-12-13', 'l\'omesa no es mou');
  assert.equal(treatment.plans[2].date, '2026-12-20', 'la ja registrada no es mou');
  assert.equal(treatment.plans[1].status, 'omitted', 'l\'estat es conserva');
});

test('resequencePlanDates: una data ocupada es conserva i es compte com a conflicte', () => {
  const { treatment, pen } = base();
  treatment.plans = ['2026-12-06', '2026-12-13'].map((date) =>
    createPlanEntry({ date, penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5 }));
  treatment.administrations.push(createAdministration({
    date: '2026-12-15', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks',
  }));

  const res = resequencePlanDates(treatment, {
    fromDate: '2026-12-01', toDate: '2026-12-31', start: '2026-12-01', interval: 14,
  });
  assert.equal(res.moved, 1, 'la primera es recalcula (01/12)');
  assert.equal(res.conflicts, 1, 'la segona voldria 15/12, on ja hi ha un registre');
  assert.equal(treatment.plans[0].date, '2026-12-01');
  assert.equal(treatment.plans[1].date, '2026-12-13', 'conserva la data anterior');
  assert.equal(treatment.administrations.length, 3, 'cap registre real es toca (2 de base + 1)');
});

test('plansOnDate: una dosi prevista per data, de qualsevol ploma', () => {
  const { treatment, pen } = base();
  const other = createPen({ presentationMg: 5, startDate: '2026-11-01', initialCapacity: 240, capacityUnit: 'clicks' });
  treatment.pens.push(other);

  treatment.plans = [createPlanEntry({
    date: '2026-12-06', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5,
  })];
  assert.equal(plansOnDate(treatment, '2026-12-06').length, 1);
  assert.equal(plansOnDate(treatment, '2026-12-13').length, 0);

  // dues plomes el mateix dia: la detecció és transversal (la UI ja no en crea)
  treatment.plans.push(createPlanEntry({
    date: '2026-12-06', penId: other.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5,
  }));
  assert.equal(plansOnDate(treatment, '2026-12-06').length, 2, 'les detecta totes');
  const pens = new Set(plansOnDate(treatment, '2026-12-06').map((x) => x.penId));
  assert.deepEqual([...pens].sort(), [pen.id, other.id].sort());
});

test('resequencePlanDates: no treu cap proposta del tram de la fase', () => {
  const { treatment, pen } = base();
  treatment.plans = ['2026-12-06', '2026-12-13'].map((date) =>
    createPlanEntry({ date, penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5 }));

  const res = resequencePlanDates(treatment, {
    fromDate: '2026-12-01', toDate: '2026-12-14', start: '2026-12-01', interval: 14,
  });
  assert.equal(res.moved, 1, 'la primera passa a 01/12 (dins del tram)');
  assert.equal(res.conflicts, 1, 'la segona voldria 15/12, fora de la fase');
  assert.equal(treatment.plans[1].date, '2026-12-13', 'es conserva la data');
});

/* ---------- issue #2: el pla es desacobla de la ploma ---------- */

test('generatePlan sense ploma: pla prescrit en mg, sense saldo ni clics', () => {
  const { treatment } = base();
  const res = generatePlan(treatment, {
    penId: null, mode: 'standard', value: 5, startDate: '2026-12-01', intervalDays: 7, count: 4,
  });
  assert.equal(res.ok, true, 'es pot generar sense ploma');
  assert.equal(res.unit, 'mg');
  assert.equal(res.amount, 5, 'la quantitat és la dosi en mg');
  assert.equal(res.mg, 5);
  assert.equal(res.maxDoses, null, 'sense ploma no hi ha límit de saldo');
  assert.equal(res.balance, null);
  assert.equal(res.shortfallAt, null);
  assert.deepEqual(res.dates, ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22']);

  // els clics necessiten ploma: no es pot generar un pla en clics sense ella
  const clicks = generatePlan(treatment, {
    penId: null, mode: 'clicks', value: 30, startDate: '2026-12-01', intervalDays: 7, count: 2,
  });
  assert.equal(clicks.ok, false);
  assert.equal(clicks.reason, 'needs-pen');
  assert.equal(clicksAvailable(null, getDrug('mounjaro')), false, 'sense ploma no hi ha mode clics');
});

test('generatePlan salta les dates ocupades: una dosi prevista per esdeveniment', () => {
  const { treatment, pen } = base(); // administracions reals el 01/11 i 08/11
  const other = createPen({ presentationMg: 5, startDate: '2026-11-01', initialCapacity: 240, capacityUnit: 'clicks' });
  treatment.pens.push(other);
  // proposta d'UNA ALTRA ploma el 29/11: no es pot duplicar l'esdeveniment
  treatment.plans = [createPlanEntry({
    date: '2026-11-29', penId: other.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5,
  })];

  const opts = { penId: pen.id, mode: 'standard', value: 2.5, startDate: '2026-11-01', intervalDays: 7, count: 4 };
  const res = generatePlan(treatment, opts);
  assert.equal(res.ok, true);
  assert.deepEqual(res.dates, ['2026-11-15', '2026-11-22', '2026-12-06', '2026-12-13'],
    'salta 01/11 i 08/11 (registres reals) i 29/11 (altra ploma)');

  // la proposta de la MATEIXA ploma sí que es substitueix: no ocupa
  treatment.plans.push(createPlanEntry({
    date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5,
  }));
  const res2 = generatePlan(treatment, opts);
  assert.ok(res2.dates.includes('2026-11-15'), 'la proposta de la mateixa ploma no bloqueja');
});

test('un pla pot no tenir ploma (penId null) i exigir que, si hi és, existeixi', () => {
  const { patient, treatment } = base();
  treatment.plans = [createPlanEntry({
    date: '2026-12-01', penId: null, mode: 'standard', value: 5, amount: 5, unit: 'mg', mg: 5,
  })];
  const repo = createRepository(memoryAdapter());
  repo.save(patient);
  const ok = validateBackup(repo.exportAll());
  assert.equal(ok.ok, true, 'penId null és un pla vàlid: ' + (ok.errors || []).join(' | '));

  treatment.plans[0].penId = 'pen-fantasma';
  const repo2 = createRepository(memoryAdapter());
  repo2.save(patient);
  const bad = validateBackup(repo2.exportAll());
  assert.equal(bad.ok, false, 'una ploma inexistent continua sent error');
  assert.ok(bad.errors.some((e) => e.includes('pen-fantasma')));
});

test('linkPlanToAdmin assigna la ploma a un pla prescrit sense ploma', () => {
  const { treatment, pen } = base();
  treatment.plans = [createPlanEntry({
    date: '2026-11-15', penId: null, mode: 'standard', value: 5, amount: 5, unit: 'mg', mg: 5,
  })];
  const adm = createAdministration({
    date: '2026-11-15', penId: pen.id, mode: 'clicks', value: 30, amount: 30, unit: 'clicks', mg: 5,
  });
  treatment.administrations.push(adm);

  const linked = linkPlanToAdmin(treatment, adm);
  assert.ok(linked, 's\'enllaça encara que la proposta no tingui ploma');
  assert.equal(linked.penId, pen.id, 'la ploma s\'assigna en registrar (assignació posterior)');
  assert.equal(linked.registeredAdminId, adm.id);
  assert.equal(linked.amount, 5, 'la dosi prescrita es conserva');
  assert.equal(linked.mg, 5);
});
