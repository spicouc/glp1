// Ploma inicial automàtica + equivalències clics ↔ mg.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialPen, presentationForDose, createTreatment, createPen, createPatient } from '../js/core/model.js';
import { activeTreatment, activePen, registerAmount } from '../js/core/calc.js';
import { DRUGS, resolveConversion, getDrug } from '../js/core/drugs.js';
import { equivalenceOf } from '../js/ui/components/summary.js';

test('en iniciar un tractament, la ploma inicial ja ve creada i activa', () => {
  const m = createInitialPen('mounjaro', '2026-11-01');
  assert.equal(m.presentationMg, 2.5, 'presentació inicial del catàleg');
  assert.equal(m.initialCapacity, 240, '4 dosis × 60 clics');
  assert.equal(m.capacityUnit, 'clicks');
  assert.equal(m.status, 'active');
  assert.equal(m.startDate, '2026-11-01', 'mateixa data que l\'inici del tractament');

  // Ozempic té llista de plomes FlexTouch (0,25 · 0,5 · 1 · 2): es pot TRIAR.
  const oz = createInitialPen('ozempic', '2026-11-01');
  assert.equal(oz.presentationMg, 0.25, 'Ozempic: ploma per defecte del catàleg (0,25 mg)');
  assert.equal(oz.capacityUnit, 'clicks', 'clics per defecte, com a qualsevol altra ploma');
  assert.equal(oz.initialCapacity, 128, '4 dosis de 32 clics = 2 mg de la ploma');
  assert.equal(oz.clicksPerDose, 32);

  const sx = createInitialPen('saxenda', '2026-11-01');
  assert.equal(sx.capacityUnit, 'doses');
  assert.equal(sx.initialCapacity, 30, 'administració diària');

  assert.equal(createInitialPen('no-existeix'), null);
});

test('la presentació de la ploma segueix la dosi triada al tractament', () => {
  assert.equal(presentationForDose('mounjaro', 2.5), 2.5);
  assert.equal(presentationForDose('mounjaro', 5), 5);
  assert.equal(presentationForDose('mounjaro', 15), 15);
  assert.equal(presentationForDose('mounjaro', 999), 15, 'dosi per sobre del catàleg → la ploma més gran');
  assert.equal(presentationForDose('mounjaro', 6.25), 7.5, 'dosi intermèdia → la ploma més petita que la admet');
  assert.equal(presentationForDose('ozempic', 1), 1, 'Ozempic: presentació al catàleg');
  assert.equal(presentationForDose('ozempic', 0.75), 1, 'Ozempic: 0,75 mg toca la ploma d\'1 mg');
  assert.equal(presentationForDose('no-existeix', 1), null);

  const pen = createInitialPen('mounjaro', '2026-11-01', { presentationMg: presentationForDose('mounjaro', 5) });
  assert.equal(pen.presentationMg, 5, 'ploma de 5 mg per a una dosi de 5 mg');
  assert.equal(pen.initialCapacity, 240);
  assert.equal(pen.capacityUnit, 'clicks');

  const explicitNull = createInitialPen('ozempic', '2026-11-01', { presentationMg: null });
  assert.equal(explicitNull.presentationMg, null, 'presentació buida lliurement');
  assert.equal(explicitNull.capacityUnit, 'doses', 'sense presentació no s\'inventen clics');

  // L'usuari pot triar la ploma: presentació, capacitat i unitat pròpies
  const chosen = createInitialPen('mounjaro', '2026-11-01', {
    presentationMg: 10, initialCapacity: 120, capacityUnit: 'clicks',
  });
  assert.equal(chosen.presentationMg, 10, 'presentació triada per l’usuari');
  assert.equal(chosen.initialCapacity, 120, 'capacitat triada per l’usuari');
  assert.equal(chosen.capacityUnit, 'clicks');
  assert.equal(chosen.startDate, '2026-11-01');
  assert.equal(chosen.status, 'active');

  const partial = createInitialPen('mounjaro', '2026-11-01', { presentationMg: 7.5 });
  assert.equal(partial.initialCapacity, 240, 'sense capacitat triada es manté la del catàleg');
  assert.equal(partial.capacityUnit, 'clicks');
});

test('tractament actiu + ploma inicial llestos per registrar sense més passos', () => {
  const patient = createPatient({ code: 'P-001' });
  const treatment = createTreatment({ drugId: 'mounjaro', startDate: '2026-11-01' });
  const pen = createInitialPen('mounjaro', treatment.startDate);
  treatment.pens.push(pen);
  patient.treatments.push(treatment);

  assert.equal(activeTreatment(patient).id, treatment.id);
  assert.equal(activePen(treatment).id, pen.id);

  // es pot registrar directament: 2,5 mg = 60 clics en una ploma de 2,5 mg
  const computed = registerAmount({
    mode: 'standard', value: 2.5, pen, drug: getDrug('mounjaro'),
  });
  assert.equal(computed.amount, 60);
  assert.equal(computed.mg, 2.5);
});

test('equivalència clics ↔ mg calculada per presentació de ploma', () => {
  const drug = DRUGS.mounjaro;

  const pen10 = createPen({ presentationMg: 10, initialCapacity: 240, capacityUnit: 'clicks' });
  assert.equal(resolveConversion(pen10, drug).sourceType, 'theoretical');

  const fromMg = equivalenceOf(pen10, drug, { mg: 5 });
  assert.equal(fromMg.clicks, 30, '5 mg en ploma de 10 mg = 30 clics');
  assert.equal(fromMg.mg, 5);
  assert.match(fromMg.text, /^5 mg = 30 clics$/);
  assert.equal(fromMg.theoretical, true, 'sempre marcada com a teòrica');

  const fromClicks = equivalenceOf(pen10, drug, { clicks: 15 });
  assert.equal(fromClicks.mg, 2.5, '15 clics en ploma de 10 mg = 2,5 mg');

  const pen15 = createPen({ presentationMg: 15, initialCapacity: 240, capacityUnit: 'clicks' });
  assert.equal(equivalenceOf(pen15, drug, { mg: 5 }).clicks, 20, 'dependeix de la presentació');
  assert.equal(equivalenceOf(pen15, drug, { clicks: 60 }).mg, 15);

  // Plomes sense conversió → null (la UI ho mostra explícitament)
  const ozempic = createPen({ presentationMg: null, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(equivalenceOf(ozempic, DRUGS.ozempic, { mg: 0.5 }), null);

  const trulicity = createPen({ presentationMg: 1.5, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(equivalenceOf(trulicity, DRUGS.trulicity, { mg: 1.5 }), null, 'ploma de dosi fixa sense clics');

  // Res a convertir → null (però no diu que manqui la conversió)
  assert.equal(equivalenceOf(pen10, drug, {}), null);
});
