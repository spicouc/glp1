// Pes i efectes adversos + gràfic temporal (sense inferir causalitat).

import { h, btn, icon, sectionCard, emptyState, chip, formatNumber } from '../dom.js';
import { openDialog, confirmDialog, toast, formError, clearFormError } from '../modal.js';
import { t } from '../../i18n/index.js';
import { createHealth } from '../../core/model.js';
import { activeTreatment, allAdministrations, treatmentDrug } from '../../core/calc.js';
import { persist, update, selectedTreatmentOf } from '../state.js';
import { todayISO, isValidISO, cmpDates, fmtShort, fmtMedium, parseISO } from '../../core/dates.js';
import { navigate, patientPath } from '../router.js';

const EFFECTS = [
  ['nausea', 'health.nausea'],
  ['vomiting', 'health.vomiting'],
  ['diarrhea', 'health.diarrhea'],
  ['constipation', 'health.constipation'],
  ['abdominalPain', 'health.abdominalPain'],
];
const LEVELS = ['health.none', 'health.mild', 'health.moderate', 'health.severe'];

function effectBadges(entry) {
  const used = EFFECTS.filter(([key]) => Number(entry[key]) > 0);
  if (!used.length && !entry.otherEffects) return h('span', { class: 'muted small' }, t('health.none'));
  return h('span', { class: 'badges' },
    used.map(([key, label]) => chip(`${t(label)} · ${t(LEVELS[Number(entry[key])])}`, { tone: Number(entry[key]) >= 2 ? 'warn' : 'muted' })),
    entry.otherEffects ? chip(`${t('health.other')}: ${entry.otherEffects}`, { tone: 'warn' }) : null);
}

function healthFormDialog(patient, treatment, existing = null) {
  const isNew = !existing;
  const dateInput = h('input', { class: 'input', type: 'date', name: 'date', value: existing ? existing.date : todayISO() });
  const weightInput = h('input', { class: 'input', type: 'number', name: 'weightKg', inputmode: 'decimal', step: '0.1', min: '20', max: '400', value: existing && existing.weightKg != null ? existing.weightKg : '' });
  const otherInput = h('input', { class: 'input', name: 'otherEffects', value: existing ? existing.otherEffects : '', placeholder: t('health.otherPlaceholder') });
  const notesInput = h('textarea', { class: 'input input--area', name: 'notes', rows: '2' }, existing ? existing.notes : '');
  const errorSlot = h('div', { class: 'form__errors' });

  const selects = EFFECTS.map(([key, label]) => {
    const sel = h('select', { class: 'input', name: key },
      LEVELS.map((l, i) => h('option', { value: String(i), selected: existing ? Number(existing[key]) === i : i === 0 }, t(l))));
    return h('div', { class: 'field field--inline' }, h('span', { class: 'field__label' }, t(label)), sel);
  });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.date')), dateInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('health.weight')), weightInput, h('span', { class: 'field__hint' }, t('app.optional')))),
    h('h4', { class: 'subhead' }, t('health.effects')),
    h('div', { class: 'effects' }, selects),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('health.other')), otherInput),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.notes')), notesInput),
    h('label', { class: 'switch' },
      h('input', {
        type: 'checkbox', name: 'validated',
        checked: existing ? existing.validated === true : false,
      }),
      h('span', {}, t('health.validateToggle')),
      h('span', { class: 'field__hint' }, t('health.validateHint'))),
    errorSlot
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFormError(form);
    const date = dateInput.value;
    if (!isValidISO(date)) return errorSlot.replaceChildren(formError(t('form.date')));
    const w = weightInput.value === '' ? null : Number(weightInput.value);
    if (w !== null && (!Number.isFinite(w) || w < 20 || w > 400)) return errorSlot.replaceChildren(formError(t('form.number')));

    const validatedBox = form.querySelector('[name="validated"]');
    const values = {
      date,
      weightKg: w,
      otherEffects: otherInput.value.trim(),
      notes: notesInput.value.trim(),
      source: 'manual',
      validated: Boolean(validatedBox && validatedBox.checked),
    };
    for (const [key] of EFFECTS) {
      const sel = form.querySelector(`[name="${key}"]`);
      values[key] = Number(sel.value);
    }

    if (isNew) treatment.health.push(createHealth(values));
    else Object.assign(existing, values);

    persist(patient);
    close();
    toast(isNew ? t('form.created') : t('form.saved'), { tone: 'ok' });
    update('health-saved');
  });

  const { close } = openDialog({
    title: isNew ? t('health.new') : t('health.edit'),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('app.save'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

/** Gràfic SVG de pes amb marcadors de dosi i efectes. */
function weightChart(treatment) {
  const entries = [...(treatment.health || [])]
    .filter((e) => e.weightKg != null)
    .sort((a, b) => cmpDates(a.date, b.date));

  if (!entries.length) {
    return h('p', { class: 'muted small' }, t('health.empty'));
  }
  if (entries.length < 2) {
    return h('p', { class: 'muted small' }, t('health.chartNeedsTwo'));
  }

  const admins = allAdministrations(treatment).filter((a) => a.mg != null);
  const W = 640;
  const H = 240;
  const padL = 44;
  const padR = 16;
  const padT = 18;
  const padB = 54;

  const dates = [...entries.map((e) => e.date), ...admins.map((a) => a.date)].sort();
  const t0 = parseISO(dates[0]).getTime();
  const t1 = parseISO(dates[dates.length - 1]).getTime();
  const span = Math.max(1, t1 - t0);

  const weights = entries.map((e) => Number(e.weightKg));
  let minW = Math.min(...weights);
  let maxW = Math.max(...weights);
  if (maxW - minW < 2) { minW -= 1; maxW += 1; }
  const margin = (maxW - minW) * 0.1;
  minW -= margin;
  maxW += margin;

  const x = (iso) => padL + ((parseISO(iso).getTime() - t0) / span) * (W - padL - padR);
  const y = (w) => padT + (1 - (w - minW) / (maxW - minW)) * (H - padT - padB);

  const points = entries.map((e) => `${x(e.date).toFixed(1)},${y(Number(e.weightKg)).toFixed(1)}`).join(' ');

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('health.chart'));

  const add = (tag, attrs, text) => {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  // graella horitzontal + eix de pes
  for (let i = 0; i <= 4; i++) {
    const val = minW + ((maxW - minW) * i) / 4;
    const yy = y(val);
    add('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, class: 'chart__grid' });
    add('text', { x: padL - 6, y: yy + 4, class: 'chart__axis', 'text-anchor': 'end' }, val.toFixed(1));
  }

  // marcadors de dosi (dosi real registrada)
  for (const a of admins) {
    const xx = x(a.date);
    add('line', { x1: xx, y1: padT, x2: xx, y2: H - padB, class: 'chart__dose' });
    add('text', { x: xx, y: H - padB + 14, class: 'chart__doselabel', 'text-anchor': 'middle' }, `${formatNumber(a.mg)}`);
  }

  // efectes adversos
  for (const e of treatment.health || []) {
    const total = EFFECTS.reduce((s, [k]) => s + Number(e[k] || 0), 0) + (e.otherEffects ? 1 : 0);
    if (!total) continue;
    const xx = x(e.date);
    add('circle', { cx: xx, cy: H - padB + 30, r: total >= 2 ? 5 : 3.5, class: 'chart__effect' });
  }

  // línia de pes
  add('polyline', { points, class: 'chart__line' });
  for (const e of entries) {
    const c = add('circle', { cx: x(e.date), cy: y(Number(e.weightKg)), r: 4, class: 'chart__point' });
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${fmtMedium(e.date)} · ${formatNumber(e.weightKg)} kg`;
    c.appendChild(title);
  }

  // eix temporal (3 etiquetes)
  const labelIdx = [0, Math.floor(entries.length / 2), entries.length - 1];
  for (const i of labelIdx) {
    add('text', { x: x(entries[i].date), y: H - 6, class: 'chart__axis', 'text-anchor': i === 0 ? 'start' : i === entries.length - 1 ? 'end' : 'middle' }, fmtShort(entries[i].date));
  }

  return h('div', { class: 'chart-wrap' },
    svg,
    h('ul', { class: 'legend' },
      h('li', {}, h('span', { class: 'legend__swatch legend__swatch--weight' }), t('health.chart')),
      h('li', {}, h('span', { class: 'legend__swatch legend__swatch--dose' }), `${t('health.chartDose')} (mg)`),
      h('li', {}, h('span', { class: 'legend__swatch legend__swatch--effect' }), t('health.effects'))),
    h('p', { class: 'disclaimer small' }, t('health.noCausality')));
}

export function renderHealth(patient) {
  const treatment = selectedTreatmentOf(patient);

  if (!treatment) {
    return emptyState(
      t('treatment.empty'),
      t('treatment.emptyHint'),
      btn(t('treatment.new'), { variant: 'primary', icon: 'plus', onClick: () => navigate(patientPath(patient.id, 'treatment')) })
    );
  }

  const records = (treatment.health || [])
    .filter((r) => !r.deletedAt)
    .sort((a, b) => cmpDates(b.date, a.date));

  const list = records.length
    ? h('ul', { class: 'records' },
        records.map((r) =>
          h('li', { class: 'record' },
            h('div', { class: 'record__head' },
              h('span', { class: 'record__date' }, fmtShort(r.date)),
              r.weightKg != null ? h('strong', { class: 'record__weight' }, `${formatNumber(r.weightKg)} kg`) : null,
              // Dada auto-reportada i NO validada: es veu i s'explicita, però
              // mai entra a la lògica posològica (ni dosis ni saldos).
              r.validated
                ? chip(t('health.validated'), { tone: 'ok' })
                : chip(t('health.notValidated'), { tone: 'warn' })),
            effectBadges(r),
            r.notes ? h('p', { class: 'muted small' }, r.notes) : null,
            h('div', { class: 'row' },
              btn(t('app.edit'), { variant: 'ghost', icon: 'edit', onClick: () => healthFormDialog(patient, treatment, r) }),
              btn(t('app.delete'), {
                variant: 'ghost', icon: 'trash',
                onClick: async () => {
                  const ok = await confirmDialog(t('app.deleteConfirm'), { okLabel: t('app.delete') });
                  if (!ok) return;
                  // tomba (no esborrat físic): s'ha de poder sincronitzar
                  r.deletedAt = new Date().toISOString();
                  persist(patient);
                  update('health-deleted');
                  toast(t('form.deleted'), { tone: 'ok' });
                },
              }))))
      )
    : emptyState(t('health.empty'), null, null);

  return h(
    'div',
    { class: 'view view--health' },
    h('div', { class: 'section-head' },
      h('h2', { class: 'section-head__title' }, t('health.title')),
      btn(t('health.new'), { variant: 'primary', icon: 'plus', onClick: () => healthFormDialog(patient, treatment) })),
    sectionCard(t('health.chart'), weightChart(treatment)),
    list
  );
}
