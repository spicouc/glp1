// Blocs de resum compartits entre la llista de pacients i la capçalera de la fitxa.

import { h, chip, progressBar, formatNumber, formatEur, icon } from '../dom.js';
import { t, tStatus } from '../../i18n/index.js';
import { fmtShort, fmtCompact, todayISO, isValidISO, cmpDates } from '../../core/dates.js';
import { resolveConversion } from '../../core/drugs.js';
import { selectedTreatmentOf } from '../state.js';
import {
  activeTreatment,
  activePen,
  allAdministrations,
  buildAlerts,
  completeDoses,
  currentDose,
  nextDueDate,
  penBalance,
  penDoseSummary,
  projectBalance,
  treatmentCosts,
  treatmentDrug,
  treatmentWeek,
  latestWeight,
  visiblePens,
} from '../../core/calc.js';

export function doseLabel(dose) {
  if (!dose) return '—';
  if (dose.mg != null) return `${formatNumber(dose.mg)} mg`;
  if (dose.mode === 'clicks' && dose.amount != null) return `${formatNumber(dose.amount)} ${t('admin.clicks')}`;
  if (dose.value != null) return `${formatNumber(dose.value)}`;
  return '—';
}

export function amountLabel(amount, unit) {
  if (amount === null || amount === undefined) return '—';
  // Pla prescrit sense ploma: la quantitat és en mg
  if (unit === 'mg') return `${formatNumber(amount)} mg`;
  return unit === 'doses'
    ? `${formatNumber(amount)} ${Number(amount) === 1 ? 'dosi' : 'doses'}`
    : `${formatNumber(amount)} ${t('admin.clicks')}`;
}

/**
 * Etiqueta d'una quantitat registrada: a les plomes mesurades en dosis es
 * mostra la dosi en mg (el consum real són 1 dosi), i a les de clics, els clics.
 */
export function doseAmountLabel({ amount, unit, mg } = {}) {
  if (unit === 'doses') {
    if (mg != null && Number.isFinite(Number(mg))) return `${formatNumber(mg)} mg`;
    return `${formatNumber(amount)} ${Number(amount) === 1 ? 'dosi' : 'doses'}`;
  }
  return amountLabel(amount, unit);
}

/**
 * Equivalència clics ↔ mg per a una ploma concreta (mai global).
 * Retorna null si la ploma no té conversió definida.
 */
export function equivalenceOf(pen, drug, { mg = null, clicks = null } = {}) {
  const conv = pen ? resolveConversion(pen, drug) : null;
  if (!conv) return null;
  if (mg == null && clicks == null) return null;

  let m = mg;
  let c = clicks;
  if (m == null) m = Math.round(Number(c) * conv.mgPerClick * 1000) / 1000;
  if (c == null) m != null ? (c = Math.round(Number(m) / conv.mgPerClick)) : null;

  if (m == null || c == null || !Number.isFinite(Number(m)) || !Number.isFinite(Number(c))) return null;

  return {
    mg: Number(m),
    clicks: Number(c),
    text: `${formatNumber(m)} mg = ${formatNumber(c)} ${t('admin.clicks')}`,
    theoretical: conv.sourceType !== 'official',
    warning: conv.warning || null,
  };
}

/**
 * Línia d'equivalència SEMPRE visible:
 *   Equivalència  2,5 mg = 15 clics  [Equivalència teòrica]
 * o, si la ploma no en té:
 *   Equivalència  Aquesta ploma no té equivalència clics ↔ mg definida.
 */
export function equivalenceLine(pen, drug, values = {}) {
  const eq = equivalenceOf(pen, drug, values);
  if (eq) {
    return h('p', { class: 'eq', title: eq.warning || '' },
      h('span', { class: 'eq__label' }, t('eq.title')),
      h('strong', { class: 'eq__value' }, eq.text),
      eq.theoretical ? chip(t('cal.theoretical'), { tone: 'warn' }) : null);
  }
  const conv = pen ? resolveConversion(pen, drug) : null;
  if (conv) return null; // conversió disponible però encara no hi ha res a convertir
  const note = drug && drug.noClickNote ? drug.noClickNote : t('eq.none');
  return h('p', { class: 'eq eq--none' },
    h('span', { class: 'eq__label' }, t('eq.title')),
    h('span', {}, note));
}

export function unitLabel(unit) {
  return unit === 'doses' ? 'dosis' : t('admin.clicks');
}

/** Tota la informació derivada d'un pacient, en un sol càlcul. */
export function summaryOf(patient) {
  const treatment = selectedTreatmentOf(patient);
  const drug = treatment ? treatmentDrug(treatment) : null;
  const pen = treatment ? activePen(treatment) : null;
  const dose = treatment ? currentDose(treatment) : null;
  const due = treatment ? nextDueDate(treatment) : null;
  const balance = pen ? penBalance(treatment, pen) : null;
  const rows = treatment && pen ? projectBalance(treatment, { pen }) : [];
  const today = todayISO();
  const nextRow = rows.find((r) => cmpDates(r.date, today) >= 0) || rows[0] || null;
  const doses = nextRow ? completeDoses(balance, nextRow.amount) : { completes: 0, remainder: 0, valid: false };
  const alerts = buildAlerts(patient, today);
  const visibleAdmins = treatment ? allAdministrations(treatment) : [];
  const last = visibleAdmins.length ? visibleAdmins[visibleAdmins.length - 1] : null;

  return { treatment, drug, pen, dose, due, balance, rows, nextRow, doses, alerts, last, today };
}

function stat(label, value, { tone = '' } = {}) {
  return h(
    'div',
    { class: `stat ${tone ? `stat--${tone}` : ''}` },
    h('span', { class: 'stat__label' }, label),
    h('span', { class: 'stat__value' }, value)
  );
}

export function alertChips(alerts) {
  if (!alerts.length) return null;
  return h(
    'ul',
    { class: 'alerts' },
    alerts.slice(0, 3).map((a) =>
      h(
        'li',
        { class: `alert alert--${a.severity}` },
        icon(a.severity === 'info' ? 'info' : 'alert'),
        h('span', {}, t(`alerts.${a.type}`, {
          date: fmtShort(a.date || a.due),
          missing: formatNumber(a.missing),
          unit: a.unit ? unitLabel(a.unit) : '',
          n: a.daysLeft,
        })),
        a.type === 'insufficient-pen' ? h('strong', {}, ` ${t('doses.insufficient')}`) : null
      )
    )
  );
}

/** Bloc principal: fàrmac, dosi, ploma, saldo, dosis completes. */
export function summaryBlocks(patient, { variant = 'card' } = {}) {
  const s = summaryOf(patient);
  const nodes = [];

  if (!s.treatment) {
    nodes.push(
      h('div', { class: 'summary summary--empty' },
        h('p', { class: 'summary__title' }, patient.code + (patient.name ? ` · ${patient.name}` : '')),
        h('p', { class: 'muted' }, t('treatment.emptyHint')))
    );
    return { node: h('div', {}, ...nodes), summary: s };
  }

  const title = h(
    'div',
    { class: 'summary__head' },
    h('div', { class: 'summary__ident' },
      h('span', { class: 'summary__code' }, patient.code),
      patient.name ? h('span', { class: 'summary__name' }, patient.name) : null
    ),
    chip(tStatus('treatment', s.treatment.status), { tone: s.treatment.status === 'active' ? 'ok' : 'muted', title: s.drug ? s.drug.label : '' })
  );

  nodes.push(title);

  nodes.push(
    h(
      'div',
      { class: 'summary__drug' },
      h('span', { class: 'summary__drugName' }, s.drug ? s.drug.label.toUpperCase() : s.treatment.drugId.toUpperCase()),
      h('span', { class: 'summary__since' }, t('treatment.since', { date: fmtShort(s.treatment.startDate) }))
    )
  );

  nodes.push(
    h(
      'div',
      { class: 'stats' },
      stat(t('patients.currentDose'), doseLabel(s.dose), { tone: 'real' }),
      stat(t('patients.lastAdmin'), s.last ? fmtCompact(s.last.date) : '—'),
      stat(t('patients.nextDue'), s.due ? fmtCompact(s.due) : '—', { tone: s.due && s.due <= s.today ? 'alert' : '' })
    )
  );

  // --- Segona fila del dashboard (només a la fitxa del pacient) ----------
  // setmana de tractament · pes · inventari · cost acumulat
  if (variant === 'full') {
    const week = treatmentWeek(s.treatment, s.today);
    const weight = latestWeight(s.treatment);
    const pens = visiblePens(s.treatment);
    const dosesLeft = pens.reduce((sum, p) => {
      const d = penDoseSummary(s.treatment, p);
      return sum + (d ? d.full : 0);
    }, 0);
    const costs = treatmentCosts(s.treatment);
    nodes.push(
      h(
        'div',
        { class: 'stats stats--secondary' },
        stat(t('dash.week'), week ? t('dash.weekN', { n: week }) : '—', { tone: 'derived' }),
        stat(t('dash.weight'),
          weight ? `${formatNumber(weight.kg)} kg` : '—',
          { tone: weight && weight.validated === false ? 'warn' : '' }),
        stat(t('dash.inventory'),
          pens.length ? t('dash.inventoryValue', { n: dosesLeft, pens: pens.length }) : '—'),
        stat(t('dash.costs'), costs.totalCents ? formatEur(costs.totalCents) : '—')
      )
    );
    if (weight && weight.delta != null && weight.delta !== 0) {
      nodes.push(h('p', { class: 'muted small dash__weight' },
        t('dash.weightTrend', {
          delta: `${weight.delta > 0 ? '+' : ''}${formatNumber(weight.delta)}`,
          date: fmtShort(weight.date),
        })));
    }
  }

  // Equivalència clics ↔ mg, sempre visible
  const eqLine = equivalenceLine(s.pen, s.drug, {
    mg: s.dose ? s.dose.mg : null,
    clicks: s.dose && s.dose.amount != null ? s.dose.amount : null,
  });
  if (eqLine) nodes.push(eqLine);

  if (s.pen) {
    const capacity = Number(s.pen.initialCapacity || 0);
    const insufficient = s.balance != null && s.nextRow && s.balance < s.nextRow.amount;
    nodes.push(
      h(
        'div',
        { class: 'penbox' },
        h('div', { class: 'penbox__head' },
          h('span', { class: 'penbox__label' }, t('pen.title')),
          h('span', { class: 'penbox__presentation' }, s.pen.presentationMg ? `${formatNumber(s.pen.presentationMg)} mg` : '—')
        ),
        progressBar(s.balance, capacity, { danger: insufficient }),
        h('div', { class: 'penbox__meta' },
          h('span', { class: 'penbox__balance' }, `${t('doses.saldo')}: ${formatNumber(s.balance)} ${unitLabel(s.pen.capacityUnit)}`),
          s.nextRow
            ? h('span', { class: 'penbox__next', title: t('k.projected') }, t('doses.nextFull', { value: amountLabel(s.nextRow.amount, s.pen.capacityUnit) }))
            : null
        ),
        s.doses.valid
          ? h('div', { class: 'penbox__doses' },
              h('span', { class: 'pill pill--derived' }, t('k.derived')),
              s.doses.completes > 0
                ? h('strong', {}, t('doses.complete', { n: s.doses.completes }))
                : h('strong', {}, t('doses.none')),
              s.doses.remainder > 0
                ? h('span', {}, t(s.pen.capacityUnit === 'doses' ? 'doses.remainderDoses' : 'doses.remainder', { n: formatNumber(s.doses.remainder) }))
                : null)
          : null
      )
    );
  } else {
    nodes.push(h('p', { class: 'muted warn' }, icon('alert'), ` ${t('pen.empty')}`));
  }

  const alerts = alertChips(s.alerts);
  if (alerts) nodes.push(alerts);

  return { node: h('article', { class: `summary summary--${variant}` }, ...nodes), summary: s };
}
