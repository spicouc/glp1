// Calendari mensual tàctil amb dos modes:
//   Registre → administracions reals (tocar un dia buit registra la dosi)
//   Pla      → calendari dissenyat per plomes (tocar un dia hi posa una dosi prevista)
// Regla: cada toc crea una entrada independent amb el valor seleccionat AQUELL
// moment; canviar el selector no modifica cap entrada anterior.

import { h, btn, iconBtn, icon, formatNumber, sectionCard, emptyState, penColorClass, penNumber } from '../dom.js';
import { toast, confirmDialog } from '../modal.js';
import { t, tStatus } from '../../i18n/index.js';
import {
  addDays,
  addMonths,
  fmtLong,
  fmtShort,
  isSameMonth,
  monthGrid,
  monthLabel,
  todayISO,
  isValidISO,
  WEEKDAYS_CA,
} from '../../core/dates.js';
import {
  activeTreatment,
  activePen,
  visiblePens,
  projectBalance,
  scheduleAt,
  penById,
  plansByDate,
  plansForPen,
  registerAmount,
  tombstonePlan,
  restorePlan,
  allAdministrations,
} from '../../core/calc.js';
import {
  clickModeState,
  clicksAvailable,
  dosesForPen,
  getDrug,
  resolveConversion,
  theoreticalDisclaimer,
} from '../../core/drugs.js';
import { createPlanEntry } from '../../core/model.js';
import { calendarState, update, persist, promptOnce, selectedTreatmentOf } from '../state.js';
import { patientPath, navigate } from '../router.js';
import { openDaySheet } from '../components/daySheet.js';
import { penFormDialog } from './pens.js';
import { createQuickAdmin } from '../components/adminForm.js';
import { planPlanner, ensurePlanner, plannerTools } from '../components/planForm.js';
import { amountLabel, equivalenceOf, equivalenceLine } from '../components/summary.js';

function quickRegister({ patient, treatment, drug, pen, cal }) {
  const hint = h('span', { class: 'field__hint' });
  const valueSlot = h('div', { class: 'quick__value' });
  const disclaimer = h('p', { class: 'disclaimer' });
  const eqSlot = h('div', { class: 'eqslot' });

  if (!pen) {
    return {
      node: sectionCard(
        t('cal.quick'),
        h('p', { class: 'muted warn' }, icon('alert'), ` ${t('cal.quickNoPen')}`),
        h('div', { class: 'row' },
          btn(t('cal.quickNoPenCta'), { variant: 'primary', onClick: () => navigate(patientPath(patient.id, 'pens')) }))
      ),
      isValid: () => false,
      quick: cal.quick,
    };
  }

  // S'hi llisten TOTES les plomes visibles (no només l'activa): així es pot
  // registrar una dosi amb la ploma antiga o amb la que s'hagi fet servir.
  const pens = visiblePens(treatment);
  if (cal.quick.penId && !pens.some((p) => p.id === cal.quick.penId)) cal.quick.penId = null;
  if (!cal.quick.penId) cal.quick.penId = pen.id;

  const currentPen = () => penById(treatment, cal.quick.penId) || pen;

  // --- Selector de ploma -------------------------------------------------
  const penSelect = h('select', {
    class: 'input',
    'aria-label': t('cal.quickPen'),
    onChange: (e) => { cal.quick.penId = e.target.value; ensureMode(); renderValue(); },
  }, pens.map((p) => h('option', { value: p.id, selected: p.id === cal.quick.penId },
    `#${penNumber(treatment.pens, p.id)}` +
    `${p.presentationMg ? ` · ${formatNumber(p.presentationMg)} mg` : ''}` +
    `${p.status !== 'active' ? ` · ${tStatus('pen', p.status)}` : ''}`)));

  // --- Mode ---------------------------------------------------------------
  const modeGroup = h('div', { class: 'segmented', role: 'group', 'aria-label': t('app.mode') });
  const modeButtons = [];
  for (const m of ['standard', 'clicks']) {
    const b = h('button', {
      type: 'button',
      class: 'segmented__btn',
      dataset: { mode: m },
      onClick: () => {
        cal.quick.mode = m;
        cal.quick.value = null;
        ensureMode(true);
        renderValue();
      },
    }, m === 'standard' ? t('treatment.modeStandard') : t('treatment.modeClicks'));
    modeButtons.push(b);
    modeGroup.appendChild(b);
  }

  function ensureMode(force = false) {
    const st = clickModeState(currentPen(), drug);
    const clicksAllowed = clicksAvailable(currentPen(), drug);
    for (const b of modeButtons) {
      b.disabled = b.dataset.mode === 'clicks' && !clicksAllowed;
      b.classList.toggle('is-selected', b.dataset.mode === cal.quick.mode);
      b.hidden = false;
    }
    if (!clicksAllowed && cal.quick.mode === 'clicks') cal.quick.mode = 'standard';
    if (force) for (const b of modeButtons) b.classList.toggle('is-selected', b.dataset.mode === cal.quick.mode);
    modeGroup.hidden = st === 'fixed-dose';
  }

  // --- Valor --------------------------------------------------------------
  function renderValue() {
    valueSlot.replaceChildren();
    const pc = currentPen();
    const conv = resolveConversion(pc, drug);

    if (cal.quick.mode === 'clicks') {
      const input = h('input', {
        class: 'input input--big',
        type: 'number',
        inputmode: 'numeric',
        min: '1',
        step: '1',
        value: cal.quick.value ?? '',
        'aria-label': t('cal.quickValue'),
        onInput: (e) => { cal.quick.value = e.target.value; refreshHint(); },
      });
      valueSlot.append(input, h('span', { class: 'quick__unit' }, t('admin.clicks')));
      if (cal.quick.value === null) cal.quick.value = '';
    } else {
      const doses = [...dosesForPen(drug)];
      const optional = drug && drug.optionalMaintenanceMg ? drug.optionalMaintenanceMg : [];
      if (!doses.length) {
        const input = h('input', {
          class: 'input input--big',
          type: 'number',
          inputmode: 'decimal',
          min: '0',
          step: '0.01',
          value: cal.quick.value ?? '',
          'aria-label': t('cal.quickValue'),
          onInput: (e) => { cal.quick.value = e.target.value; refreshHint(); },
        });
        valueSlot.append(input, h('span', { class: 'quick__unit' }, 'mg'));
        if (cal.quick.value === null) cal.quick.value = '';
      } else {
        if (cal.quick.value === null || cal.quick.value === '' || !doses.includes(Number(cal.quick.value))) {
          cal.quick.value = doses[0];
        }
        const pc0 = currentPen();
        const chipFor = (d, isOptional) => {
          const eq = equivalenceOf(pc0, drug, { mg: d });
          return h('button', {
            type: 'button',
            class: `dosechip ${isOptional ? 'dosechip--optional' : ''} ${Number(cal.quick.value) === d ? 'is-selected' : ''}`,
            title: isOptional ? 'Dosi de manteniment opcional' : '',
            onClick: () => { cal.quick.value = d; renderValue(); },
          },
            h('span', { class: 'dosechip__mg' }, `${formatNumber(d)} mg`),
            eq ? h('span', { class: 'dosechip__eq' }, `${formatNumber(eq.clicks)} ${t('admin.clicks')}`) : null
          );
        };
        for (const d of doses) valueSlot.appendChild(chipFor(d, false));
        for (const d of optional) valueSlot.appendChild(chipFor(d, true));
      }
    }
    refreshHint();
  }

  function refreshHint() {
    const pc = currentPen();
    const conv = resolveConversion(pc, drug);
    const warn = theoreticalDisclaimer(drug, conv);
    let msg = '';

    const n = Number(cal.quick.value);
    const values = n > 0
      ? (cal.quick.mode === 'clicks' ? { clicks: n } : { mg: n })
      : {};
    eqSlot.replaceChildren(...[equivalenceLine(pc, drug, values)].filter(Boolean));

    if (cal.quick.mode === 'clicks') {
      const n = Number(cal.quick.value);
      if (conv && n > 0) msg = `≈ ${formatNumber(Math.round(n * conv.mgPerClick * 1000) / 1000)} mg · ${t('cal.theoretical')}`;
      else if (!conv) msg = t('pen.conversionMissing');
      disclaimer.hidden = false;
      disclaimer.textContent = warn || msg;
      hint.textContent = msg && warn ? '' : t('cal.quickHint');
    } else {
      disclaimer.hidden = true;
      const n = Number(cal.quick.value);
      if (conv && n > 0) {
        const clicks = Math.round(n / conv.mgPerClick);
        hint.textContent = `${formatNumber(n)} mg = ${clicks} ${t('admin.clicks')} · ${t('cal.theoretical')}`;
      } else {
        hint.textContent = t('cal.quickHint');
      }
    }
  }

  ensureMode();
  renderValue();

  const isValid = () => {
    const v = Number(cal.quick.value);
    return cal.quick.value !== '' && cal.quick.value !== null && Number.isFinite(v) && v > 0;
  };

  const node = h(
    'section',
    { class: 'card quick' },
    h('h3', { class: 'card__title' }, t('cal.quick')),
    h('div', { class: 'quick__grid' },
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('cal.quickPen')),
        penSelect),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('app.mode')),
        modeGroup)),
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('cal.quickValue')),
      valueSlot,
      hint,
      eqSlot),
    disclaimer,
    h('p', { class: 'muted small' }, t('cal.quickHint'))
  );

  return { node, isValid, quick: cal.quick };
}

function dayCell({ iso, ctx }) {
  const admins = ctx.adminsByDate.get(iso) || [];
  const plans = ctx.planMap.get(iso) || [];
  const projected = ctx.projectedByDate.get(iso);
  const inMonth = isSameMonth(iso, ctx.month);

  const classes = ['day'];
  if (!inMonth) classes.push('day--out');
  if (iso === ctx.today) classes.push('day--today');
  if (admins.length) classes.push('day--real');
  else if (plans.length) classes.push('day--plan');
  else if (projected) classes.push('day--projected');
  if (iso === ctx.dueDate) classes.push('day--due');
  if (projected && projected.insufficient && !admins.length && !plans.length) classes.push('day--short');

  // Color de ploma (determina l'origen de la dosi d'aquest dia)
  const owner = admins[0] ? admins[0].penId : plans[0] ? plans[0].penId : null;
  const colorClass = owner ? penColorClass(ctx.pens, owner) : '';
  if (colorClass) classes.push(colorClass);

  const dayNum = Number(iso.slice(8, 10));
  const body = h('div', { class: 'day__body' });
  body.appendChild(h('span', { class: 'day__num' }, String(dayNum)));

  if (admins.length) {
    const first = admins[0];
    body.appendChild(h('span', { class: 'day__amount' }, formatNumber(first.amount)));
    if (admins.length > 1) body.appendChild(h('span', { class: 'day__more' }, `+${admins.length - 1}`));
    if (first.mg != null) body.appendChild(h('span', { class: 'day__mg' }, `≈${formatNumber(first.mg)} mg`));
    body.appendChild(h('span', { class: 'day__rest' }, t('cal.rest', { n: formatNumber(first.balanceAfter) })));
  } else if (plans.length) {
    const first = plans[0];
    const status = first.status || 'planned';
    body.appendChild(h('span', { class: 'day__amount day__amount--plan' }, formatNumber(first.amount)));
    body.appendChild(h('span', { class: 'day__penmark' }, `#${penNumber(ctx.pens, first.penId)}`));
    if (first.mg != null) body.appendChild(h('span', { class: 'day__mg' }, `≈${formatNumber(first.mg)} mg`));
    if (plans.length > 1) body.appendChild(h('span', { class: 'day__more' }, `+${plans.length - 1}`));
    // Estat que no és "prevista": es veu a la casella (ajornada/omesa/cancel·lada)
    if (status !== 'planned') {
      body.appendChild(h('span', { class: `day__label day__label--${status}` }, t(`plan.status.${status}`)));
      if (['omitted', 'cancelled'].includes(status)) classes.push('day--inactive');
    }
  } else if (projected) {
    body.appendChild(h('span', { class: 'day__amount day__amount--proj' }, formatNumber(projected.amount)));
    body.appendChild(h('span', { class: 'day__label' }, t('cal.projected')));
    if (projected.balanceAfter != null) {
      body.appendChild(h('span', { class: 'day__rest' }, t('cal.rest', { n: formatNumber(projected.balanceAfter) })));
    }
    if (projected.insufficient) body.appendChild(h('span', { class: 'day__flag' }, icon('alert')));
  } else if (iso === ctx.dueDate) {
    body.appendChild(h('span', { class: 'day__label day__label--due' }, t('cal.projected')));
  }

  const aria = [fmtLong(iso)];
  if (admins.length) aria.push(amountLabel(admins[0].amount, admins[0].unit));
  else if (plans.length) {
    const st = plans[0].status || 'planned';
    aria.push(`${t('plan.entry')}: ${amountLabel(plans[0].amount, plans[0].unit)} · #${penNumber(ctx.pens, plans[0].penId)}`
      + (st !== 'planned' ? ` · ${t(`plan.status.${st}`)}` : ''));
  }

  return h('button', {
    type: 'button',
    class: classes.join(' '),
    'aria-label': aria.join(' · '),
    onClick: () => ctx.onDay(iso),
  }, body);
}

export function renderCalendar(patient) {
  const cal = calendarState(patient.id);
  const treatment = selectedTreatmentOf(patient);
  const today = todayISO();

  if (!treatment) {
    return emptyState(
      t('treatment.empty'),
      t('treatment.emptyHint'),
      btn(t('treatment.new'), { variant: 'primary', icon: 'plus', onClick: () => navigate(patientPath(patient.id, 'treatment')) })
    );
  }

  const drug = getDrug(treatment.drugId);
  const pen = activePen(treatment);

  // Tractament sense cap ploma: la primera vegada es demana quina s'hi fa servir
  if (!visiblePens(treatment).length) {
    promptOnce(`pen:${treatment.id}`, () => {
      setTimeout(() => penFormDialog(patient, treatment, { isNew: true }), 0);
    });
  }

  if (!pen) {
    return emptyState(
      t('pen.empty'),
      t('pen.emptyHint'),
      btn(t('cal.quickNoPenCta'), { variant: 'primary', icon: 'plus', onClick: () => navigate(patientPath(patient.id, 'pens')) })
    );
  }

  if (!isValidISO(cal.month)) cal.month = today;
  if (cal.mode !== 'plan') cal.mode = 'register';

  // --- Eina activa: registre ràpid o planner de pla ---------------------
  const registerTool = cal.mode === 'register'
    ? quickRegister({ patient, treatment, drug, pen, cal })
    : null;
  const planTool = cal.mode === 'plan'
    ? planPlanner({ patient, treatment, cal })
    : null;

  const modeToggle = h(
    'div',
    { class: 'segmented segmented--calendar', role: 'group', 'aria-label': t('app.mode') },
    [['register', t('plan.toggleRegister')], ['plan', t('plan.togglePlan')]].map(([m, label]) =>
      h('button', {
        type: 'button',
        class: `segmented__btn ${cal.mode === m ? 'is-selected' : ''}`,
        onClick: () => { cal.mode = m; update('cal-mode'); },
      }, label))
  );

  // --- Dades derivades per a la graella --------------------------------
  const adminsByDate = new Map();
  for (const a of allAdministrations(treatment)) {
    if (!adminsByDate.has(a.date)) adminsByDate.set(a.date, []);
    adminsByDate.get(a.date).push(a);
  }

  const planMap = plansByDate(treatment);

  const rows = projectBalance(treatment, { pen, from: today, horizon: 400, limit: 60 });
  const projectedByDate = new Map();
  for (const r of rows) if (!projectedByDate.has(r.date)) projectedByDate.set(r.date, r);

  const visibleAdmins = allAdministrations(treatment);
  const dueDate = visibleAdmins.length
    ? (() => {
        const last = visibleAdmins[visibleAdmins.length - 1];
        const sch = scheduleAt(treatment, last.date);
        const interval = sch ? Number(sch.intervalDays) : 7;
        return addDays(last.date, interval);
      })()
    : (treatment.schedules[0] || {}).startDate || null;

  const quickValid = () => {
    const v = Number(cal.quick.value);
    return cal.quick.value !== '' && cal.quick.value !== null && Number.isFinite(v) && v > 0;
  };

  const planValid = () => {
    const p = ensurePlanner(treatment, cal);
    return Boolean(p.penId) && Number(p.value) > 0 && isValidISO(p.startDate);
  };

  const onDay = (iso) => {
    const admins = adminsByDate.get(iso) || [];
    const plans = planMap.get(iso) || [];

    // ---------- mode Pla: dissenyar el calendari ----------
    if (cal.mode === 'plan') {
      // Registre real → sempre s'obre la fitxa: les eines de disseny només
      // toquen les propostes, mai les dades ja registrades.
      if (admins.length) {
        openDaySheet({ patient, treatment, date: iso, plans, projection: projectedByDate.get(iso) || null, quick: cal.quick });
        return;
      }

      const p = ensurePlanner(treatment, cal);
      const tool = p.tool || 'inspect';
      const doseText = () => (p.mode === 'standard'
        ? `${formatNumber(Number(p.value))} mg`
        : `${formatNumber(Number(p.value))} ${t('admin.clicks')}`);

      /** Crea la proposta d'aquesta data amb la dosi del planner (amb Desfés). */
      const createProposal = () => {
        if (!planValid()) { toast(t('plan.invalid'), { tone: 'warn' }); return; }
        const plannerPen = penById(treatment, p.penId);
        const computed = registerAmount({ mode: p.mode, value: Number(p.value), pen: plannerPen, drug });
        if (!computed.valid) { toast(t('plan.invalid'), { tone: 'warn' }); return; }
        if (plansForPen(treatment, p.penId).some((e) => e.date === iso)) {
          toast(t('plan.alreadyThatDay'), { tone: 'warn' });
          return;
        }
        const entry = createPlanEntry({
          date: iso,
          penId: p.penId,
          mode: p.mode,
          value: p.mode === 'standard' ? Number(p.value) : Math.round(Number(p.value)),
          amount: computed.amount,
          unit: computed.unit,
          mg: computed.mg,
        });
        treatment.plans = [...(treatment.plans || []), entry];
        persist(patient);
        update('plan-created');
        toast(t('plan.newEntry', { date: fmtShort(iso) }), {
          tone: 'ok',
          actionLabel: t('cal.undo'),
          onAction: () => {
            tombstonePlan(treatment, entry.id); // desfés = tomba (es sincronitza)
            persist(patient);
            update('plan-undone');
            toast(t('cal.undoDone'), { tone: 'ok' });
          },
        });
      };

      const dayEntries = (plans || []).filter((e) => e.penId === p.penId);
      const locked = dayEntries.find((e) => e.registeredAdminId);

      // --- Eina ESBORRA: treu la proposta d'aquest dia (amb Desfés) ---
      if (tool === 'erase') {
        if (!dayEntries.length) { toast(t('plan.eraseNone'), { tone: 'warn' }); return; }
        if (locked) { toast(t('plan.linkedLocked'), { tone: 'warn' }); return; }
        const removed = dayEntries.map((e) => ({ ...e }));
        const ids = new Set(removed.map((x) => x.id));
        for (const e of removed) tombstonePlan(treatment, e.id);
        persist(patient);
        update('plan-erased');
        toast(t('plan.erased', { date: fmtShort(iso) }), {
          tone: 'ok',
          actionLabel: t('cal.undo'),
          onAction: () => {
            for (const id of ids) restorePlan(treatment, id);
            persist(patient);
            update('plan-restored');
            toast(t('cal.undoDone'), { tone: 'ok' });
          },
        });
        return;
      }

      // --- Eina PINTA: hi posa o hi canvia la dosi triada al planner ---
      if (tool === 'paint') {
        if (dayEntries.length) {
          if (locked) { toast(t('plan.linkedLocked'), { tone: 'warn' }); return; }
          if (!planValid()) { toast(t('plan.invalid'), { tone: 'warn' }); return; }
          const plannerPen = penById(treatment, p.penId);
          const computed = registerAmount({ mode: p.mode, value: Number(p.value), pen: plannerPen, drug });
          if (!computed.valid) { toast(t('plan.invalid'), { tone: 'warn' }); return; }
          const before = dayEntries.map((e) => ({ ...e }));
          for (const e of dayEntries) {
            e.mode = p.mode;
            e.value = p.mode === 'standard' ? Number(p.value) : Math.round(Number(p.value));
            e.amount = computed.amount;
            e.unit = computed.unit;
            e.mg = computed.mg;
          }
          persist(patient);
          update('plan-repainted');
          toast(t('plan.painted', { dose: doseText(), date: fmtShort(iso) }), {
            tone: 'ok',
            actionLabel: t('cal.undo'),
            onAction: () => {
              const ids = new Set(before.map((b) => b.id));
              treatment.plans = (treatment.plans || []).map((e) => (ids.has(e.id) ? before.find((b) => b.id === e.id) : e));
              persist(patient);
              update('plan-undone');
              toast(t('cal.undoDone'), { tone: 'ok' });
            },
          });
          return;
        }
        createProposal();
        return;
      }

      // --- Consulta (per defecte): obre la fitxa o crea si és buit ---
      if (dayEntries.length) {
        openDaySheet({ patient, treatment, date: iso, plans, projection: projectedByDate.get(iso) || null, quick: cal.quick });
        return;
      }
      createProposal();
      return;
    }

    // ---------- mode Registre: administracions reals ----------
    if (admins.length) {
      openDaySheet({ patient, treatment, date: iso, plans, projection: projectedByDate.get(iso) || null, quick: cal.quick });
      return;
    }
    if (!quickValid()) {
      toast(t('cal.quickInvalid'), { tone: 'warn' });
      return;
    }
    const result = createQuickAdmin({ patient, treatment, date: iso, pen: activePen(treatment) || pen, quick: cal.quick });
    if (!result.ok) {
      toast(t('cal.quickInvalid'), { tone: 'warn' });
      return;
    }
    const linked = (treatment.plans || []).some((x) => x.registeredAdminId === result.admin.id);
    update('admin-created');
    const base = linked
      ? t('plan.linked')
      : t('cal.quickRegistered', { value: result.label, date: fmtShort(iso) });
    toast(result.extended ? `${base} ${t('plan.extended', { n: result.extended })}` : base, {
      tone: 'ok',
      actionLabel: t('cal.undo'),
      onAction: () => { result.undo(); toast(t('cal.undoDone'), { tone: 'ok' }); },
    });
  };

  const ctx = {
    month: cal.month,
    today,
    adminsByDate,
    planMap,
    projectedByDate,
    dueDate,
    pens: treatment.pens || [],
    onDay,
  };

  const grid = h('div', { class: 'calgrid' },
    WEEKDAYS_CA.map((d) => h('div', { class: 'calgrid__wd' }, d)),
    monthGrid(cal.month).map((iso) => dayCell({ iso, ctx }))
  );

  const nav = h('div', { class: 'calnav' },
    iconBtn('chevronLeft', t('cal.monthPrev'), () => { cal.month = addMonths(cal.month, -1); update('month'); }, { variant: 'secondary' }),
    h('span', { class: 'calnav__label' }, monthLabel(cal.month)),
    iconBtn('chevronRight', t('cal.monthNext'), () => { cal.month = addMonths(cal.month, 1); update('month'); }, { variant: 'secondary' }),
    btn(t('app.today'), { variant: 'ghost', onClick: () => { cal.month = todayISO(); update('month'); } })
  );

  const legendItems = [
    h('li', {}, h('span', { class: 'legend__swatch legend__swatch--real' }), t('cal.legendReal')),
    h('li', {}, h('span', { class: 'legend__swatch legend__swatch--plan' }), t('plan.legendProposed')),
    h('li', {}, h('span', { class: 'legend__swatch legend__swatch--proj' }), t('cal.legendProjected')),
    h('li', {}, h('span', { class: 'legend__swatch legend__swatch--alert' }), t('cal.legendAlert')),
    h('li', {}, h('span', { class: 'legend__swatch legend__swatch--empty' }), t('cal.legendEmpty')),
  ];

  // Colors de ploma (per saber d'on ve cada dosi)
  const penLegend = (treatment.pens || []).filter((p) => p.status !== 'deleted').map((p) =>
    h('li', { class: `legend__pen ${penColorClass(treatment.pens, p.id)}` },
      h('span', { class: 'legend__swatch legend__swatch--pen' }),
      `#${penNumber(treatment.pens, p.id)}${p.presentationMg ? ` · ${formatNumber(p.presentationMg)} mg` : ''}`));

  const legend = h('ul', { class: 'legend' }, legendItems,
    penLegend.length ? h('li', { class: 'legend__sep' }, '·') : null,
    penLegend);

  // --- Llistat de projecció (només en mode registre) --------------------
  const upcoming = rows.filter((r) => r.date >= today).slice(0, 8);
  const projectionList = cal.mode === 'register' && upcoming.length
    ? sectionCard(
        t('treatment.schedule'),
        h('ul', { class: 'projlist' },
          upcoming.map((r) =>
            h('li', { class: `projlist__row ${r.insufficient ? 'is-short' : ''}` },
              h('span', { class: 'projlist__date' }, fmtShort(r.date)),
              h('span', { class: 'pill pill--projected' }, t('k.projected')),
              h('span', { class: 'projlist__dose' }, amountLabel(r.amount, r.unit)),
              h('span', { class: 'projlist__balance' },
                r.balanceAfter != null ? `${formatNumber(r.balanceAfter)}` : '—',
                r.insufficient ? h('strong', { class: 'danger-text' }, ` ${t('doses.insufficient')}`) : null)))
        ),
        h('p', { class: 'disclaimer small' }, t('k.projected'), ' · ', t('treatment.scheduleHint'))
      )
    : null;

  const conv = resolveConversion(pen, drug);
  const warn = theoreticalDisclaimer(drug, conv);

  return h(
    'div',
    { class: `view view--calendar${cal.mode === 'plan' ? ' view--planmode' : ''}` },
    h('div', { class: 'calmode' }, modeToggle),
    cal.mode === 'plan' ? planTool : (registerTool ? registerTool.node : null),
    warn ? h('p', { class: 'disclaimer disclaimer--block' }, icon('info'), ' ', warn) : null,
    h('section', { class: 'card' },
      nav,
      grid,
      legend),
    projectionList,
    // Eines de disseny (pinta/esborra): sempre al final, enganxades a baix
    // per arribar-hi amb el dit mentre es toquen els dies.
    cal.mode === 'plan' ? plannerTools({ treatment, cal, onPick: () => update('planner-tool') }) : null
  );
}
