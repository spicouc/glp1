// Estats de pla, fases, inventari (caducitat/costos) i indicadors del dashboard.
// Tota la lògica és pura: cap DOM, cap xarxa.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPatient, createTreatment, createPen, createPlanEntry, createHealth, createCost, createSchedule, planStatusOf } from '../js/core/model.js';
import {
  pendingPlans,
  plannedEntries,
  plansByDate,
  postponePlan,
  omitPlan,
  cancelPlan,
  reopenPlan,
  phaseAt,
  propagatePlanChanges,
  selectPlanTargets,
  penExpiry,
  penCost,
  treatmentCosts,
  treatmentWeek,
  latestWeight,
} from '../js/core/calc.js';
import { openShelfLifeFor, setDrugCatalog, DRUGS } from '../js/core/drugs.js';
import { addDays, todayISO } from '../js/core/dates.js';

/** Base: tractament amb una ploma de 240 clics i 4 propostes setmanals. */
function base() {
  const pen = createPen({
    presentationMg: 5, startDate: '2026-11-01', initialCapacity: 240,
    capacityUnit: 'clicks', clicksPerDose: 60, dosesPerPen: 4, seq: 1,
  });
  const treatment = createTreatment({ drugId: 'mounjaro', startDate: '2026-11-01' });
  treatment.pens = [pen];
  treatment.schedules = [createSchedule({ startDate: '2026-11-01', mode: 'standard', value: 5, intervalDays: 7 })];
  treatment.plans = ['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'].map((date) =>
    createPlanEntry({ date, penId: pen.id, mode: 'clicks', value: 30, amount: 30, unit: 'clicks', mg: 5 }));
  const patient = createPatient({ code: 'P-001' });
  patient.treatments = [treatment];
  return { patient, treatment, pen };
}

/* --------------------------------------------------- estats de la proposta */

test('els estats omesos/cancel·lats surten dels pendents, les ajornades hi són', () => {
  const { treatment } = base();
  const [first, second, third] = treatment.plans;

  assert.equal(pendingPlans(treatment).length, 4);

  postponePlan(treatment, first.id, { date: '2026-11-09', reason: 'viatge' });
  assert.equal(pendingPlans(treatment).length, 4, 'ajornada segueix sent pendent');

  omitPlan(treatment, second.id, 'oblidada');
  cancelPlan(treatment, third.id, 'no cal');
  assert.equal(pendingPlans(treatment).length, 2, 'omesa i cancel·lada no falten per fer');
  assert.equal(plannedEntries(treatment).length, 4, 'però continuen sent visibles');
  assert.equal(plansByDate(treatment).get('2026-11-15')[0].status, 'omitted',
    'el calendari les ha de poder mostrar per restaurar-les');
});

test('ajornar conserva la data original i mou la proposta', () => {
  const { treatment } = base();
  const entry = treatment.plans[0];
  const moved = postponePlan(treatment, entry.id, { date: '2026-11-16', reason: 'endarrerida' });

  assert.equal(moved.status, 'postponed');
  assert.equal(moved.date, '2026-11-16', 'la data efectiva canvia');
  assert.equal(moved.originalDate, '2026-11-08', 'l\'original es conserva');
  assert.equal(moved.movedTo, '2026-11-16');
  assert.equal(moved.reason, 'endarrerida');
  assert.ok(moved.updatedAt, 'queda marcat quan es va canviar');

  const reopened = reopenPlan(treatment, entry.id);
  assert.equal(reopened.status, 'planned');
  assert.equal(reopened.reason, '');
  assert.equal(reopened.originalDate, null);
});

test('una proposta amb administració vinculada no canvia d\'estat', () => {
  const { treatment } = base();
  treatment.plans[0].registeredAdminId = 'adm_x';
  assert.equal(postponePlan(treatment, treatment.plans[0].id, { date: '2026-12-01' }), null);
  assert.equal(omitPlan(treatment, treatment.plans[0].id), null);
  assert.equal(planStatusOf(treatment.plans[0]), 'administered', 'el registre real mana');
});

test('una proposta esborrada (tomba) no es toca', () => {
  const { treatment } = base();
  treatment.plans[0].deletedAt = new Date().toISOString();
  assert.equal(postponePlan(treatment, treatment.plans[0].id, { date: '2026-12-01' }), null);
  assert.equal(pendingPlans(treatment).length, 3);
});

test('selectPlanTargets no inclou les omeses ni les cancel·lades', () => {
  const { treatment } = base();
  omitPlan(treatment, treatment.plans[1].id);
  cancelPlan(treatment, treatment.plans[2].id);
  const targets = selectPlanTargets(plannedEntries(treatment));
  assert.equal(targets.length, 2);
  assert.ok(!targets.some((p) => ['omitted', 'cancelled'].includes(p.status)));
});

/* ------------------------------------------------------------------- fases */

test('phaseAt calcula el tram: fi explícita o abans de la fase següent', () => {
  const { treatment } = base();
  treatment.schedules = [
    createSchedule({ startDate: '2026-11-01', mode: 'standard', value: 5, intervalDays: 7 }),
    createSchedule({ startDate: '2026-12-01', mode: 'standard', value: 7.5, intervalDays: 7 }),
  ];

  const inside = phaseAt(treatment, '2026-11-20');
  assert.equal(inside.phase.startDate, '2026-11-01');
  assert.equal(inside.to, '2026-11-30', 'acaba el dia abans de la fase següent');

  const second = phaseAt(treatment, '2026-12-15');
  assert.equal(second.phase.startDate, '2026-12-01');
  assert.equal(second.to, null, 'última fase: oberta');

  // data anterior a la primera fase → cau a la primera
  assert.equal(phaseAt(treatment, '2026-10-15').phase.startDate, '2026-11-01');
});

test('propagatePlanChanges respecta el límit de la fase (toDate)', () => {
  const { treatment } = base();
  const n = propagatePlanChanges(treatment, {
    fromDate: '2026-11-01',
    toDate: '2026-11-15',
    value: 45, mode: 'clicks', amount: 45, unit: 'clicks', mg: 7.5,
  });
  assert.equal(n, 2, 'només les dues dates dins la fase');
  assert.equal(treatment.plans[0].amount, 45);
  assert.equal(treatment.plans[1].amount, 45);
  assert.equal(treatment.plans[2].amount, 30, 'fora de la fase no es toca');
});

/* ------------------------------------------------- inventari i dashboard */

test('penExpiry: caducitat impresa, calculada per obertura i estats', () => {
  const { treatment, pen } = base();

  // sense dades → no s'inventa res
  const empty = penExpiry(treatment, pen, '2026-11-10');
  assert.equal(empty.effective, null);
  assert.equal(empty.daysLeft, null);
  assert.equal(empty.expired, false);

  // caducitat impresa
  pen.expiryDate = '2026-11-20';
  const printed = penExpiry(treatment, pen, '2026-11-10');
  assert.equal(printed.effective, '2026-11-20');
  assert.equal(printed.daysLeft, 10);
  assert.equal(printed.expiringSoon, true, '≤30 dies → avís');
  assert.equal(printed.expired, false);

  pen.expiryDate = '2026-11-01';
  assert.equal(penExpiry(treatment, pen, '2026-11-10').expired, true);

  // calculada a partir de l'obertura + la validesa del catàleg
  pen.expiryDate = null;
  pen.openedAt = '2026-11-01';
  const opened = penExpiry(treatment, pen, '2026-11-05');
  assert.equal(opened.shelfLifeDays, null, 'el catàleg no en porta per defecte');
  assert.equal(opened.openUntil, null, 'sense validesa coneguda, no es calcula');
});

test('penExpiry usa la validesa del catàleg quan l\'admin l\'ha entrat', () => {
  const { treatment, pen } = base();
  pen.openedAt = '2026-11-01';
  pen.expiryDate = null;

  // abans d\'entrar-la: el catàleg no en té → no es calcula res
  assert.equal(penExpiry(treatment, pen, '2026-11-05').openUntil, null);

  // l\'admin entra la validesa de la fitxa tècnica (per fàrmac)
  setDrugCatalog([
    ...Object.values(DRUGS).map((d) => (d.id === 'mounjaro'
      ? { ...d, openShelfLifeDays: 28, openShelfLifeSource: 'RCP' }
      : d)),
  ]);
  try {
    const exp = penExpiry(treatment, pen, '2026-11-05');
    assert.equal(exp.shelfLifeDays, 28);
    assert.equal(exp.openUntil, '2026-11-29', 'obertura (01/11) + 28 dies');
    assert.equal(exp.effective, '2026-11-29', 'sense caducitat impresa, val aquesta');
    assert.equal(exp.daysLeft, 24);
    assert.equal(exp.expiringSoon, true);
  } finally {
    // setDrugCatalog MUTA els objectes base → es neteja explícitament
    delete DRUGS.mounjaro.openShelfLifeDays;
    delete DRUGS.mounjaro.openShelfLifeSource;
    setDrugCatalog(Object.values(DRUGS));
  }

  // validesa del catàleg: només enters positius
  assert.equal(openShelfLifeFor({ id: 'x' }), null, 'sense dada → null');
  assert.equal(openShelfLifeFor(null), null);
  assert.equal(openShelfLifeFor({ openShelfLifeDays: 0 }), null, '0 no és un valor vàlid');
  assert.equal(openShelfLifeFor({ openShelfLifeDays: -5 }), null);
  assert.equal(openShelfLifeFor({ openShelfLifeDays: '28' }), 28, 'string net');
});

test('penCost deriva el cost per dosi', () => {
  const { pen } = base();
  assert.equal(penCost(pen), null, 'sense preu → null');

  pen.priceCents = 12900;
  const cost = penCost(pen);
  assert.equal(cost.cents, 12900);
  assert.equal(cost.doses, 4, 'dosesPerPen de la ploma');
  assert.equal(cost.perDoseCents, 3225, '129,00 € / 4');

  // sense dosesPerPen, es deriva de la capacitat en clics
  pen.dosesPerPen = null;
  assert.equal(penCost(pen).doses, 4, '240 clics / 60 per dosi');
});

test('treatmentCosts suma plomes + despeses en cèntims', () => {
  const { treatment, pen } = base();
  assert.deepEqual(treatmentCosts(treatment), {
    penCents: 0, otherCents: 0, totalCents: 0, currency: 'EUR',
  });

  pen.priceCents = 12900;
  treatment.costs = [
    createCost({ date: '2026-11-02', kind: 'other', amountCents: 1550 }),
    createCost({ date: '2026-11-03', kind: 'admin', amountCents: 400 }),
  ];
  const totals = treatmentCosts(treatment);
  assert.equal(totals.penCents, 12900);
  assert.equal(totals.otherCents, 1950);
  assert.equal(totals.totalCents, 14850);

  // una ploma esborrada no compta
  pen.status = 'deleted';
  assert.equal(treatmentCosts(treatment).penCents, 0);
});

test('treatmentWeek i latestWeight per al dashboard', () => {
  const { treatment } = base();
  assert.equal(treatmentWeek(treatment, '2026-11-01'), 1, 'primer dia → setmana 1');
  assert.equal(treatmentWeek(treatment, '2026-11-07'), 1);
  assert.equal(treatmentWeek(treatment, '2026-11-08'), 2, 'dia 8 → setmana 2');
  assert.equal(treatmentWeek(treatment, '2026-10-01'), null, 'abans de començar');
  assert.equal(treatmentWeek({ startDate: null }, '2026-11-01'), null);

  assert.equal(latestWeight(treatment), null, 'sense pesos');

  treatment.health = [
    createHealth({ date: '2026-11-01', weightKg: 82.4 }),
    createHealth({ date: '2026-11-08', weightKg: 81.9 }),
  ];
  const last = latestWeight(treatment);
  assert.equal(last.kg, 81.9);
  assert.equal(last.date, '2026-11-08');
  assert.equal(last.delta, -0.5, 'variació respecte l\'anterior');
  assert.equal(last.validated, false, 'per defecte, dada no validada');

  // una tomba no compta
  treatment.health[1].deletedAt = new Date().toISOString();
  assert.equal(latestWeight(treatment).kg, 82.4);

  treatment.health[0].validated = true;
  assert.equal(latestWeight(treatment).validated, true);
});

test('el catàleg no inventa valideses: són dades que ha d\'entrar l\'admin', () => {
  for (const drug of Object.values(DRUGS)) {
    assert.equal(openShelfLifeFor(drug), null,
      `${drug.id} no hauria de portar una validesa sense font`);
  }
  assert.equal(typeof setDrugCatalog, 'function');
  assert.equal(addDays('2026-11-01', 27), '2026-11-28', 'helper de data utilitzat per la regla');
  assert.equal(todayISO().length, 10);
});
