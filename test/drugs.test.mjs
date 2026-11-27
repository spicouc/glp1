// Catàleg de fàrmacs: taules de clics, modes i avisos.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRUGS,
  CLICK_CONVERSIONS,
  CLICK_MODES,
  clickModeState,
  clicksAvailable,
  resolveConversion,
  theoreticalDisclaimer,
  clicksForDose,
  clicksPerDoseFor,
} from '../js/core/drugs.js';
import { createPen, presentationForDose } from '../js/core/model.js';
import { registerAmount } from '../js/core/calc.js';
import { equivalenceOf } from '../js/ui/components/summary.js';

test('Mounjaro: 60 clics = dosi nominal de la ploma (presentació / 60)', () => {
  // Ploma de 15 mg → 2,5 mg = 10 clics, 5 mg = 20, 7,5 mg = 30 (taula orientativa)
  const pen15 = createPen({ presentationMg: 15, initialCapacity: 240, capacityUnit: 'clicks' });
  const conv15 = resolveConversion(pen15, DRUGS.mounjaro);
  assert.equal(conv15.mgPerClick, 0.25);
  assert.equal(conv15.sourceType, 'theoretical');
  assert.equal(registerAmount({ mode: 'standard', value: 2.5, pen: pen15, drug: DRUGS.mounjaro }).amount, 10);
  assert.equal(registerAmount({ mode: 'standard', value: 5, pen: pen15, drug: DRUGS.mounjaro }).amount, 20);
  assert.equal(registerAmount({ mode: 'standard', value: 7.5, pen: pen15, drug: DRUGS.mounjaro }).amount, 30);
  assert.equal(registerAmount({ mode: 'standard', value: 15, pen: pen15, drug: DRUGS.mounjaro }).amount, 60);

  // Ploma de 2,5 mg → dosi nominal = 60 clics
  const pen25 = createPen({ presentationMg: 2.5, initialCapacity: 240, capacityUnit: 'clicks' });
  assert.equal(registerAmount({ mode: 'standard', value: 2.5, pen: pen25, drug: DRUGS.mounjaro }).amount, 60);

  // La conversió depèn de la presentació triada
  assert.equal(presentationForDose('mounjaro', 5), 5);
  assert.equal(clicksAvailable(pen15, DRUGS.mounjaro), true);
});

test('Wegovy: taules orientatives per presentació (pen-specific)', () => {
  const w = DRUGS.wegovy;
  assert.equal(w.penStrengthsMg.length, 5, 'les presentacions són les de les plomes FlexTouch');

  const p025 = createPen({ presentationMg: 0.25, initialCapacity: 4, capacityUnit: 'doses' });
  const c025 = resolveConversion(p025, w);
  assert.ok(c025, 'la presentació 0,25 mg té taula registrada');
  assert.equal(c025.fullDoseClicks, 32);
  assert.equal(c025.sourceType, 'third-party');
  assert.equal(c025.verified, false);
  assert.equal(clickModeState(p025, w), 'enabled');
  assert.equal(clicksAvailable(p025, w), true);

  // Equivalència visible: 32 clics = 0,25 mg
  assert.equal(equivalenceOf(p025, w, { clicks: 32 }).mg, 0.25);
  assert.equal(equivalenceOf(p025, w, { mg: 0.25 }).clicks, 32);

  // Consum: la capacitat d'aquesta ploma es mesura en dosis (1 administració = 1 dosi)
  const std = registerAmount({ mode: 'standard', value: 0.25, pen: p025, drug: w });
  assert.equal(std.amount, 1);
  assert.equal(std.unit, 'doses');
  assert.equal(std.mg, 0.25);
  const byClicks = registerAmount({ mode: 'clicks', value: 32, pen: p025, drug: w });
  assert.equal(byClicks.amount, 1, 'registrant 32 clics es consumeix 1 dosi');
  assert.equal(byClicks.mg, 0.25, 'i es registra la dosi equivalent');

  const p1 = createPen({ presentationMg: 1, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(resolveConversion(p1, w).fullDoseClicks, 72);
  assert.equal(equivalenceOf(p1, w, { clicks: 72 }).mg, 1);

  const p24 = createPen({ presentationMg: 2.4, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(resolveConversion(p24, w).fullDoseClicks, 75);

  const p17 = createPen({ presentationMg: 1.7, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(resolveConversion(p17, w), null, '1,7 mg no té taula registrada');
  assert.equal(clickModeState(p17, w), 'needs-conversion');
  assert.equal(clicksAvailable(p17, w), false);

  assert.equal(CLICK_CONVERSIONS.filter((c) => c.drugId === 'wegovy').length, 3);
});

test('Ozempic: clics PER DEFECTE com a qualsevol altra ploma (taules per presentació)', () => {
  const o = DRUGS.ozempic;
  assert.equal(o.clickMode, CLICK_MODES.PEN_SPECIFIC, 'clics actius per defecte, com a Wegovy');
  assert.equal(CLICK_CONVERSIONS.filter((c) => c.drugId === 'ozempic').length, 4, 'una taula per presentació');
  assert.match(o.noClickNote, /no seleccionar la dosi comptant els clics/, 'el camí del fabricant es conserva com a avís');

  // Ploma de 2 mg/1,5 mL (0,25 i 0,5): dosi completa = 32 clics
  const p025 = createPen({ presentationMg: 0.25, initialCapacity: 128, capacityUnit: 'clicks', clicksPerDose: 32 });
  const c025 = resolveConversion(p025, o);
  assert.equal(clickModeState(p025, o), 'enabled');
  assert.equal(clicksAvailable(p025, o), true);
  assert.equal(c025.fullDoseClicks, 32);
  assert.equal(clicksForDose(0.25, c025), 16, 'count.click: 0,25 mg = 16 clics');
  assert.equal(clicksForDose(0.5, c025), 32, '0,5 mg = 32 clics');
  assert.equal(clicksPerDoseFor(o, 0.25), 32, 'capacitat = 4 × 32 = 128 clics (2 mg)');
  assert.match(theoreticalDisclaimer(o, c025), /selector de dosis/, 'sempre amb l\'avís del fabricant');

  // Ploma de 4 mg/3 mL (1 mg): dosi completa = 72 clics
  const p1 = createPen({ presentationMg: 1, initialCapacity: 288, capacityUnit: 'clicks', clicksPerDose: 72 });
  const c1 = resolveConversion(p1, o);
  assert.equal(clicksForDose(0.25, c1), 18, 'ploma de 4 mg/3 mL: 0,25 mg = 18 clics');
  assert.equal(clicksForDose(0.5, c1), 36, '0,5 mg = 36 clics');
  assert.equal(clicksForDose(0.75, c1), 54, '0,75 mg = 54 clics');
  assert.equal(clicksForDose(1, c1), 72, 'dosi completa = 72 clics');
  assert.equal(clicksForDose(1.5, c1), 108, 'dosi que no cap en una injecció → injeccions partides');
  assert.equal(clicksPerDoseFor(o, 1), 72, 'capacitat = 4 × 72 = 288 clics (4 mg)');

  // Ploma de 8 mg/3 mL (2 mg)
  const p2 = createPen({ presentationMg: 2, initialCapacity: 288, capacityUnit: 'clicks', clicksPerDose: 72 });
  const c2 = resolveConversion(p2, o);
  assert.equal(clicksForDose(0.25, c2), 9, 'ploma de 8 mg/3 mL: 0,25 mg = 9 clics');
  assert.equal(clicksForDose(0.5, c2), 18);
  assert.equal(clicksForDose(2, c2), 72);

  // Sense presentació (ploma antiga) no s'inventa cap conversió
  const noPres = createPen({ presentationMg: null, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(resolveConversion(noPres, o), null);
  assert.equal(clickModeState(noPres, o), 'needs-conversion');
  assert.equal(clicksPerDoseFor(o, null), null);

  // La conversió adjuntada per l'usuari guanya (variant de 3 mL, 0,5 mg = 72)
  const alt = createPen({
    presentationMg: 0.5, capacityUnit: 'doses', initialCapacity: 4,
    conversion: { mgPerClick: 0.5 / 72, sourceType: 'third-party', verified: false, warning: 'X' },
  });
  assert.equal(clicksForDose(0.5, resolveConversion(alt, o)), 72, 'variant 2 mg/3 mL');
  assert.equal(clicksPerDoseFor(o, 0.5, alt), 72, 'els clics per dosi segueixen la conversió adjuntada');
});

test('Victoza: 10 clics = 0,6 mg i dosis intermèdies amb 5 clics', () => {
  const v = DRUGS.victoza;
  const table = v.clickTables[0];
  assert.equal(table.mgPerClick, 0.06);
  const rows = Object.fromEntries(table.rows.map((r) => [r.mg, r.clicks]));
  assert.equal(rows[0.3], 5, 'mig clic → dosi intermèdia de 0,3 mg');
  assert.equal(rows[0.6], 10);
  assert.equal(rows[1.2], 20);
  assert.equal(rows[1.8], 30);

  const pen = createPen({ presentationMg: null, initialCapacity: 30, capacityUnit: 'doses', conversion: {
    mgPerClick: table.mgPerClick, sourceType: 'third-party', verified: false, warning: table.warning,
  } });
  assert.equal(clicksAvailable(pen, v), true);
  assert.equal(registerAmount({ mode: 'clicks', value: 5, pen, drug: v }).mg, 0.3);
  assert.equal(registerAmount({ mode: 'clicks', value: 10, pen, drug: v }).mg, 0.6);
});

test('Saxenda i Trulicity: sense comptatge (amb nota de per què)', () => {
  const sx = DRUGS.saxenda;
  assert.equal(sx.clickTables, undefined, 'Saxenda no en té (les instruccions adverteixen)');
  assert.match(sx.noClickNote, /no comptar els clics/);
  const penSx = createPen({ initialCapacity: 30, capacityUnit: 'doses' });
  assert.equal(clickModeState(penSx, sx), 'unsupported');
  assert.equal(clicksAvailable(penSx, sx), false);

  const tr = DRUGS.trulicity;
  assert.equal(tr.clickMode, 'fixed-dose');
  const penTr = createPen({ presentationMg: 1.5, initialCapacity: 4, capacityUnit: 'doses' });
  assert.equal(clickModeState(penTr, tr), 'fixed-dose');
  assert.equal(clicksAvailable(penTr, tr), false);
  assert.match(tr.noClickNote, /no té selector de dosi/);
  assert.equal(registerAmount({ mode: 'standard', value: 1.5, pen: penTr, drug: tr }).amount, 1, 'monodosi: 1 unitat');
});

test('cap conversió no oficial es mostra sense avís', () => {
  for (const [id, drug] of Object.entries(DRUGS)) {
    const pen = createPen({ presentationMg: drug.penStrengthsMg ? drug.penStrengthsMg[0] : null, initialCapacity: 4, capacityUnit: drug.capacityUnit });
    const conv = resolveConversion(pen, drug);
    if (!conv || conv.sourceType === 'official') continue;
    const warn = theoreticalDisclaimer(drug, conv);
    assert.ok(warn && warn.length > 10, `${id}: falta l'avís de la conversió no oficial`);
  }
});
