// Criteris d'acceptació principals (apartat 24 del document funcional).
//
// Ha de ser possible: crear un pacient, iniciar un tractament, afegir una
// ploma, seleccionar 15 clics, registrar-los tocant diverses dates del
// calendari, canviar a 30 clics sense modificar els registres anteriors, veure
// com disminueix el saldo, consultar les dosis completes, programar un canvi
// futur, detectar la insuficiència, iniciar una nova ploma mantenint
// l'anterior a l'històric i finalitzar el tractament per crear-ne un segon
// sense perdre cap dada.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, memoryAdapter } from '../js/data/repository.js';
import { createPatient, createTreatment, createPen, createAdministration, createSchedule, nextPatientCode } from '../js/core/model.js';
import {
  activePen,
  activeTreatment,
  buildAlerts,
  completeDoses,
  penBalance,
  projectBalance,
  registerAmount,
  recomputeBalances,
} from '../js/core/calc.js';
import { getDrug } from '../js/core/drugs.js';

const TODAY = '2026-11-19';

test('acceptació: flux complet pacient → tractament → ploma → calendari → projecció', () => {
  const repo = createRepository(memoryAdapter());

  // 1. Nou pacient
  const patient = createPatient({ code: nextPatientCode(repo.list()), name: '' });
  assert.equal(patient.code, 'P-001');
  repo.save(patient);

  // 2. Tractament actiu + ploma activa
  const treatment = createTreatment({ drugId: 'mounjaro', startDate: '2026-11-01' });
  treatment.schedules = [createSchedule({ startDate: '2026-11-01', mode: 'clicks', value: 15, intervalDays: 7 })];
  const pen = createPen({ presentationMg: 10, startDate: '2026-11-01', initialCapacity: 240, capacityUnit: 'clicks' });
  treatment.pens.push(pen);
  patient.treatments.push(treatment);
  repo.save(patient);

  assert.equal(activeTreatment(repo.get(patient.id)).id, treatment.id);
  assert.equal(activePen(treatment).id, pen.id);
  assert.equal(penBalance(treatment, pen), 240);

  // 3. Registre ràpid: selector a 15 clics, tocar 4 dates del calendari
  const drug = getDrug('mounjaro');
  const quick = registerAmount({ mode: 'clicks', value: 15, pen, drug });
  assert.equal(quick.valid, true);

  for (const date of ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-18']) {
    treatment.administrations.push(
      createAdministration({
        date,
        penId: pen.id,
        mode: 'clicks',
        value: 15,
        amount: quick.amount,
        unit: quick.unit,
        mg: quick.mg,
      })
    );
  }
  assert.equal(penBalance(treatment, pen), 180); // 240 − 60

  // 4. Canvi del selector a 30 clics i registre en una altra data
  const quick2 = registerAmount({ mode: 'clicks', value: 30, pen, drug });
  treatment.administrations.push(
    createAdministration({ date: '2026-11-05', penId: pen.id, mode: 'clicks', value: 30, amount: quick2.amount, unit: 'clicks', mg: quick2.mg })
  );

  const values = treatment.administrations.map((a) => a.value);
  assert.deepEqual(values, [15, 15, 15, 15, 30], 'els registres anteriors NO s\'han modificat');
  assert.equal(penBalance(treatment, pen), 150);

  // 5. Dos registres de 22 clics més (saldo de l'exemple)
  for (const date of ['2026-11-12', '2026-11-16']) {
    treatment.administrations.push(
      createAdministration({ date, penId: pen.id, mode: 'clicks', value: 22, amount: 22, unit: 'clicks', mg: 3.6667 })
    );
  }
  recomputeBalances(treatment);
  assert.equal(penBalance(treatment, pen), 106, '240 − (60 + 30 + 44) = 106');

  // 6. Pauta futura: a partir del 2026-12-02, 30 clics/setmana
  treatment.schedules.push(createSchedule({ startDate: '2026-12-02', mode: 'clicks', value: 30, intervalDays: 7 }));
  repo.save(patient);

  // 7. Projecció: la pauta nova no toca cap registre existent
  const snapshot = JSON.stringify(treatment.administrations);
  const rows = projectBalance(treatment, { pen, from: TODAY, horizon: 120 })
    .filter((r) => r.date >= TODAY)
    .slice(0, 5);
  assert.equal(JSON.stringify(treatment.administrations), snapshot);

  assert.deepEqual(rows.map((r) => r.date), ['2026-11-25', '2026-12-02', '2026-12-09', '2026-12-16', '2026-12-23']);
  assert.deepEqual(rows.map((r) => r.amount), [15, 30, 30, 30, 30]);
  assert.deepEqual(rows.map((r) => r.balanceAfter), [91, 61, 31, 1, -29]);
  assert.equal(rows.at(-1).insufficient, true);
  assert.equal(rows[4].missing, 29);

  // 8. Dosis completes amb la pauta actual (saldo 106 / dosi 22) i el cas de l'exemple
  assert.deepEqual(completeDoses(106, 22), { completes: 4, remainder: 18, valid: true });
  assert.deepEqual(completeDoses(76, 30), { completes: 2, remainder: 16, valid: true });

  // 9. Alertes contextuels
  const alerts = buildAlerts(repo.get(patient.id), TODAY);
  assert.ok(alerts.some((a) => a.type === 'insufficient-pen'));
  assert.ok(alerts.every((a) => !/augment|baixa|incremente/i.test(JSON.stringify(a))), 'cap recomanació clínica automàtica');

  // 10. Nova ploma: l'anterior queda a l'històric amb les seves dades
  const pen2 = createPen({ presentationMg: 15, startDate: '2026-12-15', initialCapacity: 240, capacityUnit: 'clicks' });
  pen.status = 'finished';
  pen.endDate = '2026-12-14';
  treatment.pens.push(pen2);
  repo.save(patient);

  assert.equal(treatment.pens.length, 2);
  assert.equal(activePen(treatment).id, pen2.id);
  assert.equal(penBalance(treatment, pen), 106, 'la ploma antiga conserva el seu saldo');
  assert.equal(treatment.administrations.filter((a) => a.penId === pen.id).length, 7);
  assert.equal(penBalance(treatment, pen2), 240);

  // 11. Finalitzar el tractament i crear-ne un de segon sense perdre dades
  treatment.status = 'finished';
  treatment.endDate = '2026-12-31';
  treatment.endReason = 'Canvi de fàrmac';
  const t2 = createTreatment({ drugId: 'wegovy', startDate: '2027-01-01' });
  patient.treatments.push(t2);
  repo.save(patient);

  const loaded = repo.get(patient.id);
  assert.equal(loaded.treatments.length, 2);
  assert.equal(loaded.treatments[0].status, 'finished');
  assert.equal(loaded.treatments[0].administrations.length, 7, 'cap administració perduda');
  assert.equal(loaded.treatments[0].pens.length, 2, 'cap ploma perduda');
  assert.equal(activeTreatment(loaded).id, t2.id);

  // 12. Export / import manté la integritat
  const backup = repo.exportAll();
  const repo2 = createRepository(memoryAdapter());
  const imported = repo2.importBackup(backup, 'replace');
  assert.ok(imported.ok);
  const reloaded = repo2.get(patient.id);
  assert.equal(reloaded.treatments[0].administrations.length, 7);
  assert.equal(penBalance(reloaded.treatments[0], reloaded.treatments[0].pens[0]), 106);
});
