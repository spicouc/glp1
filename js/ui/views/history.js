// Historial: tot el que s'ha registrat mai, de manera permanent i en ordre.

import { h, icon, emptyState, formatNumber, penNumber } from '../dom.js';
import { t, tStatus } from '../../i18n/index.js';
import { fmtShort, cmpDates } from '../../core/dates.js';
import { getDrug } from '../../core/drugs.js';
import { amountLabel, doseLabel, unitLabel, summaryOf } from '../components/summary.js';
import { visibleTreatments } from '../../core/calc.js';

const FILTERS = [
  ['all', 'history.filterAll'],
  ['treatment', 'history.treatment'],
  ['pen', 'app.pens'],
  ['plan', 'history.filterPlan'],
  ['admin', 'history.filterAdmin'],
  ['health', 'history.filterHealth'],
];

function iconFor(type) {
  return {
    'treatment-start': 'pill',
    'treatment-end': 'check',
    'pen-start': 'syringe',
    'pen-end': 'archive',
    plan: 'calendar',
    admin: 'calendar',
    schedule: 'clock',
    health: 'scale',
  }[type] || 'list';
}

function buildTimeline(patient) {
  const events = [];
  for (const tr of visibleTreatments(patient)) {
    const drug = getDrug(tr.drugId);
    const drugLabel = drug ? drug.label : tr.drugId;

    events.push({ date: tr.startDate, type: 'treatment-start', group: 'treatment', title: t('history.treatmentStart', { drug: drugLabel }), meta: tStatus('treatment', tr.status) });

    if (tr.endDate) {
      events.push({ date: tr.endDate, type: 'treatment-end', group: 'treatment', title: t('history.treatmentEnd', { drug: drugLabel }), meta: tr.endReason || '' });
    }

    for (const s of tr.schedules || []) {
      events.push({
        date: s.startDate,
        type: 'schedule',
        group: 'treatment',
        title: t('history.scheduleStart', {
          value: s.mode === 'clicks' ? `${formatNumber(s.value)} ${t('admin.clicks')}` : `${formatNumber(s.value)} mg`,
          date: fmtShort(s.startDate),
        }),
        meta: `${s.intervalDays} ${t('app.days')}`,
        kind: 'projected',
      });
    }

    for (const p of tr.pens || []) {
      events.push({
        date: p.startDate,
        type: 'pen-start',
        group: 'pen',
        title: t('history.penStart', { presentation: p.presentationMg ? `${formatNumber(p.presentationMg)} mg` : '—' }),
        meta: `${p.initialCapacity ?? '—'} ${unitLabel(p.capacityUnit)}`,
      });
      if (p.endDate) {
        events.push({
          date: p.endDate,
          type: 'pen-end',
          group: 'pen',
          title: t('history.penEnd', { presentation: p.presentationMg ? `${formatNumber(p.presentationMg)} mg` : '—' }),
          meta: '',
        });
      }
    }

    for (const pl of (tr.plans || []).filter((x) => !x.deletedAt)) {
      events.push({
        date: pl.date,
        type: 'plan',
        group: 'plan',
        title: t('history.planStart', {
          value: pl.mode === 'clicks'
            ? `${formatNumber(pl.amount)} ${t('admin.clicks')}`
            : `${formatNumber(pl.value ?? pl.mg ?? pl.amount)} mg`,
          pen: penNumber(tr.pens, pl.penId),
        }),
        meta: pl.registeredAdminId ? t('plan.registered') : t('plan.entry'),
        kind: pl.registeredAdminId ? 'derived' : 'projected',
        createdAt: pl.createdAt,
      });
    }

    for (const a of (tr.administrations || []).filter((x) => !x.deletedAt)) {
      events.push({
        date: a.date,
        type: 'admin',
        group: 'admin',
        title: amountLabel(a.amount, a.unit),
        meta: `${a.balanceAfter != null ? `${formatNumber(a.balanceAfter)} ${unitLabel(a.unit)}` : ''}${a.mg != null ? ` · ≈${formatNumber(a.mg)} mg` : ''}`,
        kind: 'real',
        createdAt: a.createdAt,
        edited: a.editedAt,
      });
    }

    for (const hl of tr.health || []) {
      events.push({
        date: hl.date,
        type: 'health',
        group: 'health',
        title: hl.weightKg != null ? t('history.healthRecorded', { weight: formatNumber(hl.weightKg) }) : t('health.effects'),
        meta: hl.otherEffects || '',
        createdAt: hl.id,
      });
    }
  }

  return events.sort((a, b) => cmpDates(b.date, a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function renderHistory(patient) {
  const all = buildTimeline(patient);
  let filter = 'all';

  const list = h('div', { class: 'timeline' });

  function renderList() {
    list.replaceChildren();
    const items = filter === 'all' ? all : all.filter((e) => e.group === filter);

    if (!items.length) {
      list.appendChild(emptyState(t('history.empty'), null, null));
      return;
    }

    let lastDate = null;
    for (const e of items) {
      if (e.date !== lastDate) {
        lastDate = e.date;
        list.appendChild(h('div', { class: 'timeline__date' }, fmtShort(e.date)));
      }
      list.appendChild(
        h('div', { class: `timeline__item timeline__item--${e.kind || 'derived'}` },
          h('div', { class: 'timeline__icon' }, icon(iconFor(e.type))),
          h('div', { class: 'timeline__body' },
            h('p', { class: 'timeline__title' }, e.title),
            e.meta ? h('p', { class: 'timeline__meta' }, e.meta) : null),
          e.kind === 'real' ? h('span', { class: 'pill pill--real' }, t('k.real'))
            : e.kind === 'projected' ? h('span', { class: 'pill pill--projected' }, t('k.projected'))
            : h('span', { class: 'pill pill--derived' }, t('k.derived')))
      );
    }
  }

  const segs = h('div', { class: 'segmented', role: 'group' },
    FILTERS.map(([key, label]) =>
      h('button', {
        type: 'button',
        class: `segmented__btn ${key === 'all' ? 'is-selected' : ''}`,
        onClick: (e) => {
          filter = key;
          for (const b of segs.children) b.classList.toggle('is-selected', b === e.currentTarget);
          renderList();
        },
      }, t(label))));

  renderList();

  const s = summaryOf(patient);

  return h(
    'div',
    { class: 'view view--history' },
    h('div', { class: 'section-head' },
      h('h2', { class: 'section-head__title' }, t('nav.history')),
      h('span', { class: 'muted small' }, `${all.length} registres`)),
    segs,
    list,
    s.last ? h('p', { class: 'muted small' }, `${t('patients.lastAdmin')}: ${fmtShort(s.last.date)}`) : null
  );
}
