import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeTreatment,
  activePen,
  buildAlerts,
  completeDoses,
  currentDose,
  lastAdministration,
  nextDueDate,
  penBalance,
  penUsed,
  projectAdministrations,
  projectBalance,
  recomputeBalances,
  registerAmount,
} from '../js/core/calc.js';
import {
  createAdministration,
  createPatient,
  createPen,
  createSchedule,
  createTreatment,
} from '../js/core/model.js';
import { DRUGS, clicksForDose, mgForClicks, resolveConversion } from '../js/core/drugs.js';

const TODAY = '2026-11-19';

/** Reproducció de l'exemple del document (apartats 5, 9, 10 i 11). */
function scenario() {
  const patient = createPatient({ code: 'P-001' });
  const treatment = createTreatment({ drugId: 'mounjaro', startDate: '2026-11-01' });
  treatment.schedules = [createSchedule({ startDate: '2026-11-01', mode: 'clicks', value: 15, intervalDays: 7 })];
  treatment.pens = [];
  treatment.administrations = [];

  const pen = createPen({ presentationMg: 10, startDate: '2026-11-01', initialCapacity: 240, capacityUnit: 'clicks' });
  treatment.pens.push(pen);

  const pattern = [
    ['2026-11-01', 15],
    ['2026-11-05', 30],
    ['2026-11-08', 15],
    ['2026-11-12', 22],
    ['2026-11-15', 15],
    ['2026-11-19', 22],
    ['2026-11-22', 15],
  ];
  for (const [date, clicks] of pattern) {
    treatment.administrations.push(
      createAdministration({ date, penId: pen.id, mode: 'clicks', value: clicks, amount: clicks, unit: 'clicks' })
    );
  }

  patient.treatments.push(treatment);
  return { patient, treatment, pen, pattern };
}

test('saldo de la ploma = capacitat inicial − Σ consum', () => {
  const { treatment, pen } = scenario();
  assert.equal(penUsed(treatment, pen.id), 134); // 4×15 + 1×30 + 2×22
  assert.equal(penBalance(treatment, pen), 106); // 240 − 134
});

test('canviar la pauta no modifica cap administració registrada', () => {
  const { treatment, pattern } = scenario();
  const before = JSON.stringify(treatment.administrations);

  treatment.schedules.push(
    createSchedule({ startDate: '2026-12-10', mode: 'clicks', value: 30, intervalDays: 7 })
  );

  assert.equal(JSON.stringify(treatment.administrations), before);
  assert.equal(treatment.administrations.filter((a) => a.value === 30).length, 1);
  assert.equal(treatment.administrations.length, pattern.length);
});

test('projecció de saldo: 15, 15, 30, 30, 30 amb dèficit de 14 clics', () => {
  const { treatment, pen } = scenario();
  treatment.schedules.push(
    createSchedule({ startDate: '2026-12-10', mode: 'clicks', value: 30, intervalDays: 7 })
  );

  const rows = projectBalance(treatment, { pen, from: TODAY, horizon: 120 }).filter(
    (r) => r.date >= TODAY
  ).slice(0, 5);
  const dates = rows.map((r) => r.date);
  assert.deepEqual(dates, ['2026-11-29', '2026-12-06', '2026-12-13', '2026-12-20', '2026-12-27']);

  assert.deepEqual(rows.map((r) => r.amount), [15, 15, 30, 30, 30]);
  assert.deepEqual(rows.map((r) => r.balanceAfter), [91, 76, 46, 16, -14]);
  assert.equal(rows.at(-1).insufficient, true);
  assert.equal(rows.at(-1).missing, 14);
  assert.equal(rows.at(-1).kind, 'projected');
});

test('dosis completes i sobrant', () => {
  assert.deepEqual(completeDoses(76, 30), { completes: 2, remainder: 16, valid: true });
  assert.deepEqual(completeDoses(106, 15), { completes: 7, remainder: 1, valid: true });
  assert.deepEqual(completeDoses(16, 30), { completes: 0, remainder: 16, valid: true });
  assert.deepEqual(completeDoses(100, 0), { completes: 0, remainder: 0, valid: false });
});

test('equivalència teòrica Mounjaro: 60 clics = dosi nominal', () => {
  const drug = DRUGS.mounjaro;
  const pen = createPen({ presentationMg: 10, initialCapacity: 240, capacityUnit: 'clicks' });
  const conv = resolveConversion(pen, drug);

  assert.equal(mgForClicks(60, conv), 10);
  assert.equal(mgForClicks(30, conv), 5);
  assert.equal(mgForClicks(45, conv), 7.5);
  assert.equal(clicksForDose(5, conv), 30);
  assert.equal(clicksForDose(7.5, conv), 45);
  assert.equal(conv.sourceType, 'theoretical');
  assert.equal(conv.verified, false);
});

test('registre: dosi estàndard en clics i clics lliures', () => {
  const drug = DRUGS.mounjaro;
  const pen = createPen({ presentationMg: 10, initialCapacity: 240, capacityUnit: 'clicks' });

  const std = registerAmount({ mode: 'standard', value: 5, pen, drug });
  assert.deepEqual(std, { amount: 30, unit: 'clicks', mg: 5, valid: true, injections: 1 });

  const free = registerAmount({ mode: 'clicks', value: 22, pen, drug });
  assert.deepEqual(free, { amount: 22, unit: 'clicks', mg: 3.6667, valid: true, injections: 1 });

  const zero = registerAmount({ mode: 'clicks', value: 0, pen, drug });
  assert.equal(zero.valid, false);
});

test('dosi més gran que la dosi completa → es parteix en diverses injeccions', () => {
  const drug = DRUGS.mounjaro;
  const pen = createPen({ presentationMg: 10, initialCapacity: 240, capacityUnit: 'clicks', clicksPerDose: 60 });

  const big = registerAmount({ mode: 'standard', value: 15, pen, drug });
  assert.equal(big.amount, 90, '15 mg en ploma de 10 mg = 90 clics');
  assert.equal(big.injections, 2, '60 + 30 → dues injeccions');

  const free = registerAmount({ mode: 'clicks', value: 150, pen, drug });
  assert.equal(free.injections, 3, '150 clics → tres injeccions');

  const normal = registerAmount({ mode: 'standard', value: 5, pen, drug });
  assert.equal(normal.injections, 1, 'una sola injecció quan la dosi hi cap');
});

test('ploma de dosis fixes: 1 unitat per administració i sense clics', () => {
  const drug = DRUGS.trulicity;
  const pen = createPen({ presentationMg: 1.5, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(registerAmount({ mode: 'standard', value: 1.5, pen, drug }).amount, 1);
  const registerable = registerAmount({ mode: 'standard', value: 3, pen, drug });
  assert.equal(registerable.unit, 'doses');
  assert.equal(registerable.amount, 1);
});

test('dosi actual i proper registre previst', () => {
  const { treatment, pen } = scenario();
  const dose = currentDose(treatment);
  assert.equal(dose.kind, 'real');
  assert.equal(dose.date, '2026-11-22');
  assert.equal(dose.amount, 15);

  assert.equal(nextDueDate(treatment, TODAY), '2026-11-29');

  const treatmentWithoutAdmins = createTreatment({ drugId: 'wegovy', startDate: '2026-12-01' });
  const pending = currentDose(treatmentWithoutAdmins);
  assert.equal(pending.kind, 'projected');
  assert.equal(nextDueDate(treatmentWithoutAdmins, TODAY), '2026-12-01');
  assert.ok(pen);
});

test('alertes: ploma insuficient i sense ploma activa', () => {
  const { patient, treatment, pen } = scenario();
  treatment.schedules.push(createSchedule({ startDate: '2026-12-10', mode: 'clicks', value: 30, intervalDays: 7 }));
  patient.treatments = [treatment];

  const alerts = buildAlerts(patient, TODAY);
  const types = alerts.map((a) => a.type);
  assert.ok(types.includes('insufficient-pen'), 's\'ha d\'alertar de la insuficiència');
  const insufficient = alerts.find((a) => a.type === 'insufficient-pen');
  assert.equal(insufficient.missing, 14);
  assert.ok(types.includes('pen-runs-out'));

  pen.status = 'finished';
  const noPen = buildAlerts(patient, TODAY);
  assert.deepEqual(noPen.map((a) => a.type), ['no-active-pen']);
});

test('administració prevista sense registrar', () => {
  const { patient, treatment } = scenario();
  treatment.administrations = treatment.administrations.filter((a) => a.date !== '2026-11-22');
  patient.treatments = [treatment];

  const pending = buildAlerts(patient, '2026-11-27');
  assert.ok(
    pending.map((a) => a.type).includes('unregistered-scheduled'),
    'la dosi prevista del 26/11 encara no registrada s\'hauria de mostrar'
  );

  const late = buildAlerts(patient, '2026-12-10');
  assert.ok(late.map((a) => a.type).includes('overdue-administration'));
});

test('recalcul de saldos només després d\'edició explícita', () => {
  const { treatment, pen } = scenario();
  recomputeBalances(treatment); // primera normalització de saldos
  const before = JSON.parse(JSON.stringify(treatment.administrations));
  const last = treatment.administrations.at(-1);
  last.amount = 40;
  last.value = 40;
  recomputeBalances(treatment);

  assert.equal(penUsed(treatment, pen.id), 159);
  assert.equal(penBalance(treatment, pen), 81);
  assert.equal(last.balanceAfter, 81);
  assert.equal(last.editedAt != null, true);

  const all = treatment.administrations;
  const earlier = before.slice(0, -1).map((a) => a.balanceAfter);
  assert.deepEqual(
    all.slice(0, -1).map((a) => a.balanceAfter),
    earlier,
    'els saldos anteriors no es toquen'
  );
});

test('tractament actiu i priorització de tractaments', () => {
  const patient = createPatient({ code: 'P-002' });
  const t1 = createTreatment({ drugId: 'mounjaro', startDate: '2026-02-01' });
  t1.status = 'finished';
  t1.endDate = '2026-10-15';
  const t2 = createTreatment({ drugId: 'wegovy', startDate: '2026-10-16' });
  patient.treatments = [t1, t2];

  assert.equal(activeTreatment(patient).id, t2.id);
  assert.equal(activeTreatment({ ...patient, treatments: [{ ...t1 }] }), null);
  assert.equal(lastAdministration(t1), null);
  assert.equal(activePen(t1), null);
  assert.ok(projectAdministrations(t2, { from: TODAY }).length > 0);
});
