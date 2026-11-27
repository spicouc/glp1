// Tests del sistema de plomes v2:
//   - derivació de clics per dosi completa i capacitat en clics (unitat real)
//   - migració de plomes antigues (doses → clics) sense perdre res
//   - ploma ja començada (consum prèvi) i resum «N dosis completes»
//   - esborrar ploma: moure les dades / esborrar-les, tomba i numeració estable
//   - presets de dosi (count.click) i validació de l'esquema

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTreatment,
  createInitialPen,
  createPen,
  createAdministration,
  createPlanEntry,
  normalisePatient,
  nextPenSeq,
} from '../js/core/model.js';
import {
  allAdministrations,
  allPlans,
  activePen,
  visiblePens,
  penBalance,
  penUsed,
  penRegisteredUsed,
  penCapacityIn,
  penValueIn,
  penDoseSummary,
  penClicksPerDose,
  deletePen,
  restorePen,
  registerAmount,
} from '../js/core/calc.js';
import { clicksPerDoseFor, dosesPerPenFor, getDrug } from '../js/core/drugs.js';
import { validateBackup, SCHEMA_VERSION } from '../js/core/validate.js';
import { penNumber } from '../js/ui/dom.js';
import { dosePresets } from '../js/ui/components/presets.js';

const MJ = getDrug('mounjaro');
const WG = getDrug('wegovy');

function mounjaroTreatment(opts = {}) {
  const treatment = createTreatment({ drugId: 'mounjaro', startDate: '2026-11-01' });
  const pen = createInitialPen('mounjaro', '2026-11-01', {
    presentationMg: 10,
    initialCapacity: 240,
    capacityUnit: 'clicks',
    ...opts,
  });
  pen.seq = nextPenSeq(treatment);
  treatment.pens.push(pen);
  return { treatment, pen };
}

function addAdmin(treatment, pen, { date, amount = 15, mode = 'standard', value = 2.5, mg = 2.5 }) {
  const adm = createAdministration({
    date, penId: pen.id, mode, value, amount, unit: pen.capacityUnit, mg,
    balanceBefore: penBalance(treatment, pen), balanceAfter: penBalance(treatment, pen) - amount,
  });
  treatment.administrations.push(adm);
  return adm;
}

/* ------------------------------------------------------------------ */
/* Derivació de clics i capacitat                                      */
/* ------------------------------------------------------------------ */

test('clics per dosi completa: per fàrmac i per presentació', () => {
  assert.equal(clicksPerDoseFor(MJ, 10), 60, 'Mounjaro: 60 clics sempre');
  assert.equal(clicksPerDoseFor(MJ, 15), 60);
  assert.equal(clicksPerDoseFor(WG, 0.25), 32, 'FlexTouch 1,5 mL');
  assert.equal(clicksPerDoseFor(WG, 1), 72, 'FlexTouch 3 mL');
  assert.equal(clicksPerDoseFor(WG, 2.4), 75, 'taula de tercers');
  assert.equal(clicksPerDoseFor(WG, 1.7), null, 'sense taula → no s\'inventa');
  assert.equal(clicksPerDoseFor(getDrug('ozempic'), null), null, 'Ozempic sense presentació: sense clics');
  assert.equal(clicksPerDoseFor(getDrug('ozempic'), 1), 72, 'Ozempic amb presentació: taula del catàleg');
  assert.equal(clicksPerDoseFor(getDrug('trulicity'), 1.5), null, 'ploma de dosi fixa: sense clics');
  assert.equal(dosesPerPenFor(WG), 4);
  assert.equal(dosesPerPenFor(getDrug('saxenda')), 30);
});

test('la ploma nova es desa en Clics (unitat real) i les dosis es deriven', () => {
  const mj = createInitialPen('mounjaro', '2026-11-01', { presentationMg: 10, initialCapacity: 240, capacityUnit: 'clicks' });
  assert.equal(mj.capacityUnit, 'clicks');
  assert.equal(mj.initialCapacity, 240);
  assert.equal(mj.clicksPerDose, 60);
  assert.equal(mj.dosesPerPen, 4);

  // Wegovy: 4 dosis × 32 clics = 128 clics de capacitat real
  const wg = createInitialPen('wegovy', '2026-11-01', { presentationMg: 0.25, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(wg.capacityUnit, 'clicks', 'es passa a clics automàticament');
  assert.equal(wg.initialCapacity, 128, '4 × 32');
  assert.equal(wg.clicksPerDose, 32);
  assert.equal(wg.dosesPerPen, 4);

  // Saxenda: sense clics coneguts → es queda en dosis
  const sx = createInitialPen('saxenda', '2026-11-01', { initialCapacity: 30, capacityUnit: 'doses' });
  assert.equal(sx.capacityUnit, 'doses');
  assert.equal(sx.initialCapacity, 30);
  assert.equal(sx.clicksPerDose, null);
});

test('Ozempic: clics per defecte com a la resta i capacitat en clics', () => {
  const OZ = getDrug('ozempic');
  assert.deepEqual(OZ.penStrengthsMg, [0.25, 0.5, 1, 2], 'plomes FlexTouch triables');
  assert.deepEqual(OZ.intermediateDosesMg, [0.75, 1.5], 'presets intermedis de count.click');
  assert.equal(OZ.clickMode, 'pen-specific', 'clics ACTIVATS per defecte, com a la resta de plomes');

  // derivació: taula del catàleg per presentació (sense adjuntar res)
  assert.equal(clicksPerDoseFor(OZ, 0.5), 32, 'ploma de 2 mg/1,5 mL → 4 × 32 = 128 clics');
  assert.equal(clicksPerDoseFor(OZ, 1), 72, 'ploma de 4 mg/3 mL → 4 × 72 = 288 clics');
  assert.equal(clicksPerDoseFor(OZ, 2), 72);
  assert.equal(clicksPerDoseFor(OZ, null), null, 'sense presentació no s\'inventen clics');

  // ploma creada: capacitat en clics com a Mounjaro o Wegovy
  const pen = createInitialPen('ozempic', '2026-11-01', { presentationMg: 1 });
  assert.equal(pen.capacityUnit, 'clicks');
  assert.equal(pen.initialCapacity, 288, '4 dosis × 72 clics');
  assert.equal(pen.clicksPerDose, 72);
  assert.equal(pen.dosesPerPen, 4);

  // conversió adjuntada per l'usuari → guanya sobre la del catàleg
  const attached = { conversion: { mgPerClick: 0.5 / 72 } };
  assert.equal(clicksPerDoseFor(OZ, 0.5, attached), 72, 'variant de 3 mL');

  // migració: ploma antiga en dosis passa a clics (i els consums també)
  const converted = normalisePatient({
    id: 'p', code: 'P-1', name: 'x',
    treatments: [{
      id: 't', drugId: 'ozempic', startDate: '2026-11-01', status: 'active',
      pens: [{ id: 'pen-oz', presentationMg: 0.25, startDate: '2026-11-01', status: 'active', capacityUnit: 'doses', initialCapacity: 4 }],
      administrations: [{ id: 'a', date: '2026-11-01', penId: 'pen-oz', mode: 'standard', value: 0.25, amount: 1, unit: 'doses', mg: 0.25, balanceBefore: 4, balanceAfter: 3, createdAt: '2026-11-01T00:00:00.000Z' }],
      plans: [], schedules: [], health: [],
    }],
    updatedAt: '2026-11-01T00:00:00.000Z',
  }).treatments[0];
  assert.equal(converted.pens[0].capacityUnit, 'clicks');
  assert.equal(converted.pens[0].initialCapacity, 128, '4 × 32');
  assert.equal(converted.administrations[0].amount, 32, '1 dosi = 32 clics');
  assert.equal(converted.administrations[0].balanceAfter, 96, '128 − 32');
});

test('la migració converteix ploma, administracions i propostes de doses a clics', () => {
  const raw = {
    id: 'pat1', code: 'P-001', name: 'Prova',
    treatments: [{
      id: 'trt1', drugId: 'wegovy', startDate: '2026-11-01', status: 'active',
      pens: [{ id: 'pen1', presentationMg: 0.25, startDate: '2026-11-01', status: 'active', capacityUnit: 'doses', initialCapacity: 4 }],
      administrations: [{
        id: 'a1', date: '2026-11-01', penId: 'pen1', mode: 'standard', value: 0.25,
        amount: 1, unit: 'doses', mg: 0.25, balanceBefore: 4, balanceAfter: 3,
        createdAt: '2026-11-01T10:00:00.000Z',
      }],
      plans: [{ id: 'pl1', date: '2026-11-08', penId: 'pen1', mode: 'standard', value: 0.25, amount: 1, unit: 'doses', mg: 0.25, createdAt: '2026-11-01T10:00:00.000Z' }],
      schedules: [], health: [],
    }],
    updatedAt: '2026-11-01T10:00:00.000Z',
  };

  const out = normalisePatient(raw);
  const t = out.treatments[0];
  assert.equal(t.pens[0].capacityUnit, 'clicks');
  assert.equal(t.pens[0].initialCapacity, 128);
  assert.equal(t.pens[0].clicksPerDose, 32);
  assert.equal(t.pens[0].seq, 1, 'número d\'alta assignat');
  assert.equal(t.administrations[0].amount, 32, '1 dosi = 32 clics');
  assert.equal(t.administrations[0].unit, 'clicks');
  assert.equal(t.administrations[0].balanceBefore, 128, 'snapsots recalculats');
  assert.equal(t.administrations[0].balanceAfter, 96);
  assert.equal(t.plans[0].amount, 32);
  assert.equal(t.plans[0].unit, 'clicks');

  const again = normalisePatient(out);
  assert.deepEqual(again.treatments[0], t, 'idempotent: no es converteix dues vegades');
});

/* ------------------------------------------------------------------ */
/* Consum prèvi i resum                                                */
/* ------------------------------------------------------------------ */

test('ploma ja començada: el consum prèvi resta al saldo', () => {
  const { treatment, pen } = mounjaroTreatment({ startUsed: 60 });
  assert.equal(penUsed(treatment, pen.id), 60);
  assert.equal(penRegisteredUsed(treatment, pen.id), 0, 'encara no hi ha registres');
  assert.equal(penBalance(treatment, pen), 180);

  addAdmin(treatment, pen, { date: '2026-11-01' });
  assert.equal(penRegisteredUsed(treatment, pen.id), 15);
  assert.equal(penUsed(treatment, pen.id), 75);
  assert.equal(penBalance(treatment, pen), 165);

  const sum = penDoseSummary(treatment, pen);
  assert.equal(sum.capacityClicks, 240);
  assert.equal(sum.clicksPerDose, 60);
  assert.equal(sum.full, 2, '165 → 2 dosis completes de 60');
  assert.equal(sum.remainder, 45, 'sobra mig');
  assert.equal(sum.partial, true);
});

test('capacitat i saldo es poden expressar en clics i en dosis', () => {
  const { treatment, pen } = mounjaroTreatment({ startUsed: 60 });
  assert.equal(penCapacityIn(pen, 'clicks'), 240);
  assert.equal(penCapacityIn(pen, 'doses'), 4);
  assert.equal(penValueIn(pen, penBalance(treatment, pen), 'clicks'), 180);
  assert.equal(penValueIn(pen, penBalance(treatment, pen), 'doses'), 3);
  assert.equal(penClicksPerDose(pen), 60);

  const dosesPen = createPen({ presentationMg: 1.5, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(penCapacityIn(dosesPen, 'doses'), 4);
  assert.equal(penCapacityIn(dosesPen, 'clicks'), null, 'sense clics coneguts no s\'inventen');
});

/* ------------------------------------------------------------------ */
/* Esborrar / restaurar                                                */
/* ------------------------------------------------------------------ */

test('esborrar ploma MOU les dades a una altra ploma (tomba, número congelat)', () => {
  const { treatment, pen: p1 } = mounjaroTreatment();
  const p2 = createInitialPen('mounjaro', '2026-11-20', { presentationMg: 5, initialCapacity: 240, capacityUnit: 'clicks' });
  p2.seq = nextPenSeq(treatment);
  treatment.pens.push(p2);
  p1.status = 'finished';

  addAdmin(treatment, p1, { date: '2026-11-01' });
  addAdmin(treatment, p2, { date: '2026-11-20' });
  treatment.plans.push(createPlanEntry({ date: '2026-11-27', penId: p2.id, mode: 'standard', value: 2.5, amount: 15, unit: 'clicks', mg: 2.5 }));

  assert.equal(penBalance(treatment, p1), 225);
  assert.equal(penBalance(treatment, p2), 225);

  const res = deletePen(treatment, p2, { targetPenId: p1.id });
  assert.equal(res.ok, true);
  assert.equal(res.moved, 1, '1 administració moguda');
  assert.equal(res.plansMoved, 1, '1 proposta moguda');

  assert.equal(treatment.administrations.filter((a) => a.penId === p2.id).length, 0);
  assert.equal(treatment.administrations.filter((a) => a.penId === p1.id).length, 2);
  assert.equal(treatment.plans[0].penId, p1.id);

  // saldos de la ploma de destí recalculats (cronològicament)
  const p1Balance = penBalance(treatment, p1);
  assert.equal(p1Balance, 210, '240 − 15 − 15');
  const adminsP1 = treatment.administrations.filter((a) => a.penId === p1.id);
  assert.equal(adminsP1[0].balanceBefore, 240);
  assert.equal(adminsP1[0].balanceAfter, 225);
  assert.equal(adminsP1[1].balanceBefore, 225);
  assert.equal(adminsP1[1].balanceAfter, 210);

  // tomba + numeració congelada
  assert.equal(p2.status, 'deleted');
  assert.ok(p2.deletedAt, 'tomba per sincronitzar');
  assert.equal(p2.seq, 2, 'el número es conserva');
  assert.equal(visiblePens(treatment).length, 1, 'no es veu la ploma esborrada');
  assert.equal(activePen(treatment), p1, 'la ploma restant torna a estar activa');
  assert.equal(p1.status, 'active');
  assert.equal(penNumber(treatment.pens, p1.id), '1');
  assert.equal(penNumber(treatment.pens, p2.id), '2', 'la resta de números no es mou');
});

test('esborrar ploma amb «esborra també les dades» elimina registres i propostes', () => {
  const { treatment, pen } = mounjaroTreatment();
  const other = createPen({ presentationMg: 5, startDate: '2026-11-20', initialCapacity: 240, capacityUnit: 'clicks', clicksPerDose: 60, seq: 2 });
  treatment.pens.push(other);
  addAdmin(treatment, pen, { date: '2026-11-01' });
  treatment.plans.push(createPlanEntry({ date: '2026-11-08', penId: pen.id, mode: 'standard', value: 2.5, amount: 15, unit: 'clicks', mg: 2.5 }));

  const res = deletePen(treatment, pen, { removeData: true });
  assert.equal(res.ok, true);
  assert.equal(res.removed, 1);
  assert.equal(res.plansRemoved, 1);
  assert.equal(allAdministrations(treatment).length, 0, 'cap registre actiu');
  assert.equal(allPlans(treatment).length, 0, 'cap proposta activa');
  assert.equal(treatment.administrations.filter((a) => a.deletedAt).length, 1, 'es conserva com a tomba');
  assert.equal(pen.status, 'deleted');
  assert.equal(activePen(treatment), other, 'la ploma restant passa a activa');
  assert.equal(penBalance(treatment, pen), 240, 'sense consum, el saldo torna a l\'inicial');
});

test('esborrar ploma sense destí possible → error controlat', () => {
  const { treatment, pen } = mounjaroTreatment();
  addAdmin(treatment, pen, { date: '2026-11-01' });
  const res = deletePen(treatment, pen, { targetPenId: 'que-no-existeix' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-target');
  assert.equal(pen.status, 'active', 'no s\'esborra res');
  assert.equal(treatment.administrations.length, 1);
});

test('restaurar una ploma esborrada la torna a l\'històric', () => {
  const { treatment, pen: p1 } = mounjaroTreatment();
  const p2 = createPen({ presentationMg: 5, startDate: '2026-11-20', initialCapacity: 240, capacityUnit: 'clicks', clicksPerDose: 60, seq: 2 });
  treatment.pens.push(p2);
  deletePen(treatment, p2, { removeData: true });
  assert.equal(visiblePens(treatment).length, 1);

  const res = restorePen(treatment, p2);
  assert.equal(res.ok, true);
  assert.equal(p2.status, 'finished', 'ja hi ha una altra activa');
  assert.equal(p2.deletedAt, null);
  assert.equal(visiblePens(treatment).length, 2);
  assert.equal(activePen(treatment), p1);

  // esborra també l'altra → no en queda cap activa
  deletePen(treatment, p1, { removeData: true });
  deletePen(treatment, p2, { removeData: true });
  assert.equal(activePen(treatment), null);
  const res2 = restorePen(treatment, p1);
  assert.equal(res2.status, 'active', 'sense cap altra activa, torna a ser-ho');
  assert.equal(activePen(treatment), p1);
});

/* ------------------------------------------------------------------ */
/* Presets (count.click) i esquema                                     */
/* ------------------------------------------------------------------ */

test('presets: dosis intermèdies i mitja/quarta dosi sense repetir estàndards', () => {
  const mjPen = createPen({ presentationMg: 10, initialCapacity: 240, capacityUnit: 'clicks', clicksPerDose: 60 });
  const mj = dosePresets({ pen: mjPen, drug: MJ });
  assert.deepEqual(mj.map((p) => p.value), [3.75, 6.25, 8.75], 'count.click: 3,75 · 6,25 · 8,75');
  assert.equal(mj[1].label, '6,25 mg');
  assert.ok(!mj.some((p) => p.value === 5), 'la mitja dosi (5 mg) ja és dosi estàndard: no es duplica');

  const wgPen = createPen({ presentationMg: 0.25, initialCapacity: 128, capacityUnit: 'clicks', clicksPerDose: 32 });
  const wg = dosePresets({ pen: wgPen, drug: WG });
  assert.deepEqual(wg.map((p) => p.value), [0.125, 0.0625], 'mitja i quarta dosi de la ploma');
  assert.match(wg[0].label, /½ dosi/);
  assert.match(wg[1].label, /¼ dosi/);

  assert.deepEqual(dosePresets({ pen: null, drug: getDrug('trulicity') }), [], 'sense presets on no n\'hi caben');
});

test('l\'esquema accepta plomes esborrades i els camps nous', () => {
  const { treatment } = mounjaroTreatment({ startUsed: 30 });
  treatment.pens[0].status = 'deleted';
  treatment.pens[0].deletedAt = '2026-11-26T10:00:00.000Z';

  const data = {
    app: 'glp1',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-11-26T10:00:00.000Z',
    patients: [{ id: 'pat1', code: 'P-001', name: 'Prova', treatments: [treatment], updatedAt: '2026-11-26T10:00:00.000Z' }],
  };
  const res = validateBackup(data);
  assert.equal(res.ok, true, res.errors.join(' | '));

  const broken = JSON.parse(JSON.stringify(data));
  broken.patients[0].treatments[0].pens[0].status = 'esborrada';
  const res2 = validateBackup(broken);
  assert.equal(res2.ok, false, 'estat desconegut es rebutja');
  assert.match(res2.errors.join(' '), /status/);
});
