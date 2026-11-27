// Presets ràpids de dosi i avisos de dosi partida.
//
// Inspirats en count.click, adaptats al nostre model per presentació de ploma:
//   - ½ i ¼ de la dosi de la ploma triada
//   - dosis intermèdies del fàrmac (p. ex. 3,75 · 6,25 · 8,75 mg a Mounjaro)
// Les que ja són dosi estàndard no es repeteixen: ja hi ha el seu xip.
//
// `splitDoseNote` avisa quan la dosi supera la dosi completa de la ploma i
// caldrà fer-la en diverses injeccions. Mai pren decisions clíniques.

import { h, formatNumber } from '../dom.js';
import { t } from '../../i18n/index.js';
import { dosesForPen, round } from '../../core/drugs.js';
import { registerAmount } from '../../core/calc.js';

/** Llista de presets per a una ploma + fàrmac concrets. */
export function dosePresets({ pen = null, drug = null } = {}) {
  if (!drug) return [];
  const standard = dosesForPen(drug);
  const candidates = [];

  const pres = Number(pen && pen.presentationMg);
  if (Number.isFinite(pres) && pres > 0) {
    candidates.push({ value: round(pres / 2, 4), kind: 'half' });
    candidates.push({ value: round(pres / 4, 4), kind: 'quarter' });
  }
  for (const v of drug.intermediateDosesMg || []) {
    candidates.push({ value: Number(v), kind: 'intermediate' });
  }

  const taken = new Set(standard.map((d) => String(d)));
  const out = [];
  for (const c of candidates) {
    const key = String(c.value);
    if (!Number.isFinite(c.value) || c.value <= 0) continue;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({
      value: c.value,
      label: c.kind === 'half'
        ? `½ dosi (${formatNumber(c.value)} mg)`
        : c.kind === 'quarter'
          ? `¼ dosi (${formatNumber(c.value)} mg)`
          : `${formatNumber(c.value)} mg`,
    });
  }
  return out;
}

/** Fila de presets. Retorna `null` si no n'hi ha cap per a aquesta combinació. */
export function presetsRow({ pen = null, drug = null, value = null, onPick }) {
  const items = dosePresets({ pen, drug });
  if (!items.length) return null;
  return h(
    'div',
    { class: 'presets' },
    h('span', { class: 'presets__label' }, t('dose.presets')),
    ...items.map((p) =>
      h('button', {
        type: 'button',
        class: `dosechip dosechip--preset ${Number(value) === p.value ? 'is-selected' : ''}`,
        onClick: () => onPick(p.value),
      }, p.label))
  );
}

/**
 * Aviso de dosi partida: quan la dosi supera la dosi completa de la ploma
 * (més clics dels que la ploma marca en una injecció). `null` si no cal.
 */
export function splitDoseNote({ pen = null, drug = null, mode = 'standard', value = null }) {
  if (value === null || value === undefined || value === '') return null;
  const computed = registerAmount({ mode, value: Number(value), pen, drug });
  if (!computed.valid || computed.injections <= 1) return null;
  return t('cal.splitDose', { n: computed.injections, clicks: formatNumber(computed.amount) });
}
