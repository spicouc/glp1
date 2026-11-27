// Disseny del calendari segons les plomes i les seves dosis.
// Les entrades de pla són entitats independents de la pauta i dels registres:
// es generen, es mouen, s'editen i s'esborren sense tocar res del passat.

import { h, btn, icon, sectionCard, formatNumber, penColorClass, penNumber } from '../dom.js';
import { confirmDialog, toast, openDialog, formError, clearFormError } from '../modal.js';
import { t } from '../../i18n/index.js';
import { createPlanEntry, createAdministration } from '../../core/model.js';
import { presetsRow, splitDoseNote } from './presets.js';
import {
  activePen,
  visiblePens,
  planCoverage,
  plansForPen,
  pendingPlans,
  plannedEntries,
  generatePlan,
  maxDosesFor,
  suggestNextPenStart,
  planStartDateAfter,
  allPlans,
  registerAmount,
  penBalance,
  penById,
  recomputeBalances,
  treatmentDrug,
  applyRegisteredDose,
  standardProposalSettings,
  selectPlanTargets,
  propagatePlanChanges,
  clearPendingPlan,
  tombstonePlan,
  phaseAt,
  postponePlan,
  omitPlan,
  cancelPlan,
  intervalAt,
} from '../../core/calc.js';
import {
  clickModeState,
  clicksAvailable,
  dosesForPen,
  getDrug,
  intervalDaysFor,
  resolveConversion,
  theoreticalDisclaimer,
} from '../../core/drugs.js';
import { persist, update, promptOnce } from '../state.js';
import { todayISO, fmtShort, diffDays, cmpDates, addDays, isValidISO } from '../../core/dates.js';
import { amountLabel, equivalenceOf, equivalenceLine } from './summary.js';
import { penFormDialog } from '../views/pens.js';

/** Estat per defecte del planner (viu a calendarState del pacient). */
export function ensurePlanner(treatment, cal) {
  const drug = treatmentDrug(treatment);
  const pens = visiblePens(treatment);
  const active = activePen(treatment) || pens[0] || null;

  if (!cal.planner) cal.planner = {};
  const p = cal.planner;

  // `penId`: `undefined` encara no s'ha triat (es proposa l'activa); `null` =
  // triat expressament «Sense ploma» (pla prescrit en mg, issue #2) i no
  // s'hi torna a posar cap.
  if (p.penId === undefined) p.penId = active ? active.id : null;
  else if (p.penId && !penById(treatment, p.penId)) p.penId = active ? active.id : null;
  if (p.mode !== 'clicks') p.mode = 'standard';
  if (p.value === undefined || p.value === null || p.value === '') {
    p.value = drug ? drug.standardDosesMg[0] : '';
  }
  if (!Number.isInteger(Number(p.intervalDays)) || Number(p.intervalDays) < 1) {
    p.intervalDays = intervalDaysFor(drug);
  }
  if (!p.startDate) {
    p.startDate = suggestNextPenStart(treatment, p.penId, Number(p.intervalDays)) || todayISO();
  }
  if (p.scope !== 'from') p.scope = 'all';
  if (p.tool !== 'paint' && p.tool !== 'erase') p.tool = 'inspect';
  if (!Number.isInteger(Number(p.count)) || Number(p.count) < 1 || !p.countTouched) {
    const max = maxDosesFor(treatment, penById(treatment, p.penId), { mode: p.mode, value: p.value });
    // Sense ploma no hi ha saldo que limiti → es proposen 4 dates (mateix
    // criteri que la continuació); amb ploma, les que hi caben.
    p.count = p.penId ? Math.max(1, max) : Math.max(4, Number(p.count) || 0);
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Barra d'eines del calendari en mode Pla                             */
/* ------------------------------------------------------------------ */

/** Text de la dosi triada al planner (per a la pista de l'eina Pinta). */
export function plannerDoseLabel(treatment, cal) {
  const state = ensurePlanner(treatment, cal);
  const drug = treatmentDrug(treatment);
  const pen = penById(treatment, state.penId);
  const computed = registerAmount({ mode: state.mode, value: Number(state.value), pen, drug });
  if (!computed.valid) return '—';
  return state.mode === 'standard'
    ? `${formatNumber(Number(state.value))} mg`
    : `${formatNumber(Number(state.value))} ${t('admin.clicks')}`;
}

/**
 * Eines de disseny del calendari, a l'estil «pinta i esborra»:
 *
 *  - **Consulta** (per defecte): tocar un dia obre la seva fitxa (com sempre).
 *  - **Pinta**: tocar un dia hi posa (o hi canvia) la dosi triada al planner,
 *    sense obrir cap diàleg — per pintar molts dies seguits.
 *  - **Esborra**: tocar un dia amb proposta la treu (amb Desfés).
 *
 * Les dates amb **registre real** sempre obren la fitxa: aquestes eines només
 * toquen les propostes del pla.
 */
export function plannerTools({ treatment, cal, onPick = () => {} }) {
  const state = ensurePlanner(treatment, cal);
  const drug = treatmentDrug(treatment);
  const pen = penById(treatment, state.penId);
  const dose = plannerDoseLabel(treatment, cal);

  // Mateix editor de dosi que la targeta del planificador: comparteixen
  // l'estat, així que la dosi triada aquí es reflecteix a tot arreu.
  const editor = doseEditor({ drug, pen, state, onChange: () => onPick('dose') });

  const tool = (id, label, iconName, opts = {}) => h('button', {
    type: 'button',
    class: `plantool ${state.tool === id ? 'is-selected' : ''}${opts.danger ? ' plantool--erase' : ''}`,
    'aria-pressed': state.tool === id ? 'true' : 'false',
    onClick: () => { state.tool = id; onPick(id); },
  }, icon(iconName), h('span', {}, label));

  return h('section', { class: 'card plantools', 'aria-label': t('plan.tools') },
    h('div', { class: 'plantools__row' },
      tool('inspect', t('plan.toolInspect'), 'calendar'),
      tool('paint', `${t('plan.toolPaint')} · ${dose}`, 'pencil'),
      tool('erase', t('plan.toolErase'), 'trash', { danger: true })),
    // Dosi a pintar, a la mateixa barra: xips estàndard + presets (+ clics lliures)
    h('div', { class: 'plantools__doses' }, editor.node, editor.presets));
}

/* ------------------------------------------------------------------ */
/* Editor de dosi (chips d'estàndard o clics lliures)                  */
/* ------------------------------------------------------------------ */
function doseEditor({ drug, pen, state, onChange }) {
  const wrap = h('div', { class: 'quick__value' });
  const presetsSlot = h('div', { class: 'quickvalue__presets' });
  const hint = h('span', { class: 'field__hint' });
  const eqSlot = h('div', { class: 'eqslot' });

  const refreshHint = () => {
    const conv = resolveConversion(pen, drug);
    const v = Number(state.value);
    const values = v > 0 ? (state.mode === 'clicks' ? { clicks: v } : { mg: v }) : {};
    eqSlot.replaceChildren(...[equivalenceLine(pen, drug, values)].filter(Boolean));

    if (state.mode === 'clicks') {
      const warn = theoreticalDisclaimer(drug, conv);
      hint.textContent = conv && v > 0
        ? `≈ ${formatNumber(Math.round(v * conv.mgPerClick * 1000) / 1000)} mg · ${t('cal.theoretical')}`
        : (conv ? warn || '' : t('pen.conversionMissing'));
    } else if (conv && v > 0) {
      hint.textContent = `${formatNumber(v)} mg = ${Math.round(v / conv.mgPerClick)} ${t('admin.clicks')} · ${t('cal.theoretical')}`;
    } else {
      hint.textContent = '';
    }

    // Dosi superior a la dosi completa de la ploma: es parteix en injeccions.
    const split = splitDoseNote({ pen, drug, mode: state.mode, value: state.value });
    if (split) {
      hint.textContent = hint.textContent ? `${split} · ${hint.textContent}` : split;
      hint.classList.add('warn');
    } else {
      hint.classList.remove('warn');
    }
  };

  const render = () => {
    wrap.replaceChildren();
    presetsSlot.replaceChildren();
    if (state.mode === 'clicks') {
      const input = h('input', {
        class: 'input input--big', type: 'number', inputmode: 'numeric', min: '1', step: '1',
        value: state.value ?? '', 'aria-label': t('plan.dose'),
        onInput: (e) => { state.value = e.target.value; state.countTouched = false; refreshHint(); onChange(); },
      });
      wrap.append(input, h('span', { class: 'quick__unit' }, t('admin.clicks')));
    } else {
      const doses = dosesForPen(drug);
      if (!doses.length) {
        const input = h('input', {
          class: 'input input--big', type: 'number', inputmode: 'decimal', min: '0', step: '0.01',
          value: state.value ?? '', 'aria-label': t('plan.dose'),
          onInput: (e) => { state.value = e.target.value; state.countTouched = false; refreshHint(); onChange(); },
        });
        wrap.append(input, h('span', { class: 'quick__unit' }, 'mg'));
      } else {
        // No es reseteja un valor vàlid: els presets (3,75 · 6,25 · 8,75 mg…)
        // també són dosi vàlida i es poden triar.
        if (!Number(state.value)) state.value = doses[0];
        const chipFor = (d) => {
          const eq = equivalenceOf(pen, drug, { mg: d });
          return h('button', {
            type: 'button',
            class: `dosechip ${Number(state.value) === d ? 'is-selected' : ''}`,
            onClick: () => { state.value = d; state.countTouched = false; render(); onChange(); },
          },
            h('span', { class: 'dosechip__mg' }, `${formatNumber(d)} mg`),
            eq ? h('span', { class: 'dosechip__eq' }, `${formatNumber(eq.clicks)} ${t('admin.clicks')}`) : null
          );
        };
        for (const d of doses) wrap.appendChild(chipFor(d));
      }
      const row = presetsRow({
        pen, drug, value: Number(state.value),
        onPick: (v) => { state.value = v; state.countTouched = false; render(); onChange(); },
      });
      if (row) presetsSlot.appendChild(row);
    }
    refreshHint();
  };

  render();
  return { node: wrap, presets: presetsSlot, hint, eq: eqSlot, render };
}

/* ------------------------------------------------------------------ */
/* Planner principal                                                    */
/* ------------------------------------------------------------------ */
export function planPlanner({ patient, treatment, cal }) {
  const drug = treatmentDrug(treatment);
  const state = ensurePlanner(treatment, cal);
  const pens = visiblePens(treatment);

  if (!pens.length) {
    return sectionCard(
      t('plan.title'),
      h('p', { class: 'muted warn' }, icon('alert'), ' ', t('pen.empty')),
      h('div', { class: 'row' },
        btn(t('pen.startNew'), { variant: 'primary', icon: 'plus', onClick: () => penFormDialog(patient, treatment, { isNew: true }) }))
    );
  }

  // Primera visita al mode Pla: es proposa el tractament ESTÀNDARD de per sí
  // (primera dosi del fàrmac, cadència del fàrmac, tantes dosis com hi
  // capiguin). És un DISSENY inicial (es pot esborrar), res a veure amb la
  // continuació automàtica en registrar, que és explícita i per defecte fora.
  // L'usuari ho pot modificar o esborrar després.
  if (allPlans(treatment).length === 0) {
    promptOnce(`stdplan:${treatment.id}`, () => {
      setTimeout(() => {
        if (allPlans(treatment).length > 0) return; // algú ja ha dissenyat algo
        const settings = standardProposalSettings(treatment);
        if (!settings) return;
        const result = generatePlan(treatment, settings);
        if (!result.ok) return;
        const entries = result.dates.map((date) => createPlanEntry({
          date,
          penId: settings.penId,
          mode: settings.mode,
          value: settings.value,
          amount: result.amount,
          unit: result.unit,
          mg: result.mg,
        }));
        treatment.plans = [...(treatment.plans || []), ...entries];
        persist(patient);
        update('plan-standard');
        toast(t('plan.stdProposal', {
          value: `${formatNumber(settings.value)} mg`,
          interval: settings.intervalDays,
          n: entries.length,
        }), { tone: 'ok' });
      }, 0);
    });
  }

  const currentPen = () => penById(treatment, state.penId);
  const refresh = () => { update('planner'); };

  const penSelect = h('select', {
    class: 'input',
    'aria-label': t('plan.pen'),
    onChange: (e) => { state.penId = e.target.value || null; state.countTouched = false; refresh(); },
  },
  pens.map((p, i) =>
    h('option', { value: p.id, selected: p.id === state.penId },
      `#${i + 1} · ${p.presentationMg ? `${formatNumber(p.presentationMg)} mg` : '—'} · ${tStatusShort(p.status)} · ${fmtShort(p.startDate)}`)),
  // Pla prescrit en mg sense ploma: l'assignació ve després (issue #2)
  h('option', { value: '', selected: !state.penId }, t('plan.noPen')));

  const modeGroup = h('div', { class: 'segmented', role: 'group', 'aria-label': t('app.mode') });
  const modeButtons = [];
  for (const m of ['standard', 'clicks']) {
    const b = h('button', {
      type: 'button',
      class: `segmented__btn ${state.mode === m ? 'is-selected' : ''}`,
      dataset: { mode: m },
      onClick: () => { state.mode = m; state.value = null; state.countTouched = false; refresh(); },
    }, m === 'standard' ? t('treatment.modeStandard') : t('treatment.modeClicks'));
    modeButtons.push(b);
    modeGroup.appendChild(b);
  }
  const clicksAllowed = clicksAvailable(currentPen(), drug);
  for (const b of modeButtons) b.disabled = b.dataset.mode === 'clicks' && !clicksAllowed;
  if (!clicksAllowed && state.mode === 'clicks') state.mode = 'standard';
  modeGroup.hidden = clickModeState(currentPen(), drug) === 'fixed-dose';

  const editor = doseEditor({
    drug,
    pen: currentPen(),
    state,
    onChange: () => { if (!state.countTouched) { update('planner-dose'); } },
  });

  const dateInput = h('input', {
    class: 'input', type: 'date', value: state.startDate,
    'aria-label': t('plan.from'),
    onChange: (e) => { state.startDate = e.target.value; refresh(); },
  });
  const intervalInput = h('input', {
    class: 'input', type: 'number', inputmode: 'numeric', min: '1', max: '60', value: state.intervalDays,
    'aria-label': t('plan.interval'),
    onInput: (e) => { state.intervalDays = e.target.value; state.countTouched = false; refresh(); },
  });
  const countInput = h('input', {
    class: 'input', type: 'number', inputmode: 'numeric', min: '1', max: '104', value: state.count,
    'aria-label': t('plan.count'),
    onInput: (e) => { state.count = e.target.value; state.countTouched = true; },
  });

  const toolsHint = h('p', { class: 'muted small plan__tools-hint' }, t('plan.toolHint'));

  const capHint = h('p', { class: 'muted small plan__cap' });
  const refreshCap = () => {
    const pen = currentPen();
    const max = maxDosesFor(treatment, pen, { mode: state.mode, value: state.value });
    const balance = pen ? penBalance(treatment, pen) : 0;
    const pending = pen
      ? plansForPen(treatment, pen.id).reduce((s, p) => s + Number(p.amount || 0), 0)
      : 0;
    const free = Math.max(0, balance - pending);
    const unit = pen ? unitShort(pen) : '';
    if (!pen) {
      capHint.textContent = t('plan.noPenCap');
      if (!state.countTouched && !(Number(countInput.value) > 0)) countInput.value = '4';
      return;
    }
    if (max > 0) {
      capHint.textContent = t('plan.capHint', { saldo: `${formatNumber(free)} ${unit}`, n: max });
    } else if (pending > 0) {
      capHint.textContent = t('plan.capFull', {
        pendents: `${formatNumber(pending)} ${unit}`,
        saldo: `${formatNumber(balance)} ${unit}`,
      });
    } else {
      capHint.textContent = t('plan.noFit');
    }
    if (!state.countTouched) countInput.value = String(Math.max(1, max));
  };
  refreshCap();

  const pending = () => plansForPen(treatment, state.penId);

  const doGenerate = async () => {
    const result = generatePlan(treatment, {
      penId: state.penId,
      mode: state.mode,
      value: Number(state.value),
      startDate: dateInput.value,
      intervalDays: Number(intervalInput.value),
      count: Number(countInput.value),
    });
    if (!result.ok) { toast(t('plan.invalid'), { tone: 'warn' }); return; }

    const commit = () => {
      // Les propostes que es substitueixen queden com a TOMBES (es sincronitzen):
      // un altre dispositiu les seguirà veient esborrades, no les ressuscita.
      const stamp = new Date().toISOString();
      for (const p of treatment.plans || []) {
        if (p.penId === state.penId && !p.registeredAdminId && !p.deletedAt) p.deletedAt = stamp;
      }
      const fresh = result.dates.map((date) => createPlanEntry({
        date,
        penId: state.penId,
        mode: state.mode,
        value: state.mode === 'standard' ? Number(state.value) : Math.round(Number(state.value)),
        amount: result.amount,
        unit: result.unit,
        mg: result.mg,
      }));
      treatment.plans = [...(treatment.plans || []), ...fresh];
      persist(patient);
      update('plan-generated');
      toast(t('plan.generated', {
        n: fresh.length,
        from: fmtShort(result.dates[0]),
        to: fmtShort(result.dates[result.dates.length - 1]),
      }), { tone: 'ok' });
    };

    // Previsualització + confirmació (mai es genera sense veure què es crearà)
    const ok = await planPreviewDialog({
      treatment, result, penId: state.penId, replacing: pending().length,
    });
    if (!ok) return;
    commit();
  };

  const pendingAll = pendingPlans(treatment);

  const doClearAll = async () => {
    if (!pendingAll.length) return;
    const ok = await confirmDialog(t('plan.clearAllConfirm', { n: pendingAll.length }), {
      danger: true,
      okLabel: t('plan.clearAll'),
    });
    if (!ok) return;
    const removed = clearPendingPlan(treatment);
    persist(patient);
    update('plan-cleared');
    toast(t('plan.clearedN', { n: removed }), { tone: 'ok' });
  };

  // --- Disseny progressiu: afegir un tram amb una dosi diferent ---------
  // No esborra res: s'annadeix després de l'última data planificada i tot
  // continua sent PROPOSTA (mai administració registrada).
  const hasDesign = allPlans(treatment).some((p) => p.penId === state.penId);
  const appendStart = hasDesign
    ? planStartDateAfter(treatment, state.penId, Number(intervalInput.value) || 7)
    : null;

  const doAppend = async () => {
    const start = appendStart || dateInput.value;
    const result = generatePlan(treatment, {
      penId: state.penId,
      mode: state.mode,
      value: Number(state.value),
      startDate: start,
      intervalDays: Number(intervalInput.value),
      count: Number(countInput.value),
    });
    if (!result.ok) { toast(t('plan.invalid'), { tone: 'warn' }); return; }

    const okAppend = await planPreviewDialog({ treatment, result, penId: state.penId, replacing: 0 });
    if (!okAppend) return;

    const fresh = result.dates.map((date) => createPlanEntry({
      date,
      penId: state.penId,
      mode: state.mode,
      value: state.mode === 'standard' ? Number(state.value) : Math.round(Number(state.value)),
      amount: result.amount,
      unit: result.unit,
      mg: result.mg,
    }));
    treatment.plans = [...(treatment.plans || []), ...fresh];

    // El camp d'inici passa a indicar on començaria el següent tram
    state.startDate = planStartDateAfter(treatment, state.penId, Number(intervalInput.value) || 7) || start;

    persist(patient);
    update('plan-appended');
    toast(t('plan.appended', {
      n: fresh.length,
      from: fmtShort(result.dates[0]),
      to: fmtShort(result.dates[result.dates.length - 1]),
    }), { tone: 'ok' });
  };

  // --- Aplicar la dosi seleccionada a les propostes (pujar o abaixar) ----
  // Una sola acció per a totes les propostes a partir d'una data: evita
  // editar-les una a una quan es vol abaixar la dosi. Res del passat real.
  const applyScope = () => state.scope || 'all';

  const applyTargets = () => selectPlanTargets(pendingPlans(treatment), {
    penId: state.penId,
    scope: applyScope(),
    fromDate: dateInput.value,
  });

  const scopeGroup = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('plan.applyScopeLabel') },
    [['all', t('plan.scopeAll')], ['from', t('plan.scopeFrom')]].map(([key, label]) =>
      h('button', {
        type: 'button',
        class: `segmented__btn ${applyScope() === key ? 'is-selected' : ''}`,
        onClick: () => { state.scope = key; refresh(); },
      }, label))
  );

  const selectedDoseText = () => {
    const v = Number(state.value);
    return state.mode === 'clicks'
      ? `${formatNumber(v)} ${t('admin.clicks')}`
      : `${formatNumber(v)} mg`;
  };

  const doApplyAll = async () => {
    const targets = applyTargets();
    if (!targets.length) { toast(t('plan.applyNone'), { tone: 'warn' }); return; }

    const pen = penById(treatment, state.penId);
    const computed = registerAmount({ mode: state.mode, value: Number(state.value), pen, drug });
    if (!computed.valid) { toast(t('plan.invalid'), { tone: 'warn' }); return; }

    const ok = await confirmDialog(
      applyScope() === 'all'
        ? t('plan.applyConfirmAll', { value: selectedDoseText(), n: targets.length })
        : t('plan.applyConfirm', {
            value: selectedDoseText(),
            n: targets.length,
            date: fmtShort(dateInput.value),
          }),
      { danger: false, okLabel: t('plan.applyAll') }
    );
    if (!ok) return;

    const n = propagatePlanChanges(treatment, {
      ids: targets.map((p) => p.id), // exactament els objectius de l'abast triat
      value: state.mode === 'standard' ? Number(state.value) : Math.round(Number(state.value)),
      mode: state.mode,
      amount: computed.amount,
      unit: computed.unit,
      mg: computed.mg,
      shiftDays: 0,
    });
    persist(patient);
    update('plan-applied');
    toast(t('plan.futureUpdated', { n }), { tone: 'ok' });
  };

  const coverage = planCoverageList({ patient, treatment });

  return sectionCard(
    t('plan.title'),
    h('p', { class: 'muted small' }, t('plan.hint')),
    h('p', { class: 'note note--projected' }, icon('info'), h('span', {}, t('plan.proposalNote'))),
    h('div', { class: 'quick__grid' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('plan.pen')), penSelect),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.mode')), modeGroup)),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('plan.dose')), editor.node, editor.presets, editor.hint, editor.eq),
    toolsHint,
    h('div', { class: 'grid3' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('plan.from')), dateInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('plan.interval')), intervalInput, h('span', { class: 'field__hint' }, t('plan.intervalUnit'))),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('plan.count')), countInput)),
    capHint,
    h('label', { class: 'switch' },
      h('input', {
        type: 'checkbox',
        checked: treatment.autoPlan === true,
        onChange: (e) => {
          const on = e.target.checked;
          treatment.autoPlanConsent = on; // consentiment explícit
          treatment.autoPlan = on;
          persist(patient);
          update('auto-plan');
          toast(on ? t('plan.autoOn') : t('plan.autoOff'), { tone: on ? 'ok' : 'muted' });
        },
      }),
      h('span', {}, t('plan.auto'))),
    h('p', { class: 'muted small' }, t('plan.autoHint')),
    appendStart
      ? h('p', { class: 'muted small' }, t('plan.appendHint', { date: fmtShort(appendStart) }))
      : null,
    h('div', { class: 'row' },
      btn(pending().length ? t('plan.regenerate') : t('plan.generate'), {
        variant: 'primary', icon: 'calendar', onClick: doGenerate,
      }),
      hasDesign
        ? btn(t('plan.append'), { variant: 'secondary', icon: 'plus', onClick: doAppend })
        : null),
    h('div', { class: 'row' },
      applyTargets().length
        ? btn(t('plan.applyAll'), { variant: 'secondary', icon: 'check', onClick: doApplyAll })
        : null,
      pendingAll.length ? btn(t('plan.clearAll'), { variant: 'ghost', icon: 'trash', onClick: doClearAll }) : null),
    applyTargets().length
      ? h('div', { class: 'field' },
          h('span', { class: 'field__label' }, t('plan.applyScopeLabel')),
          scopeGroup,
          h('span', { class: 'field__hint' },
            applyScope() === 'all'
              ? t('plan.applyHintAll', { n: applyTargets().length })
              : t('plan.applyHint', { date: fmtShort(dateInput.value) })))
      : null,
    coverage
  );
}

/* ------------------------------------------------------------------ */
/* Cobertura: què consumeix el pla a cada ploma i quan cal-ne una de nova */
/* ------------------------------------------------------------------ */
export function planCoverageList({ patient, treatment }) {
  const rows = planCoverage(treatment).filter((r) => r.entries.length || r.pen.status === 'active');
  const noPen = pendingPlans(treatment).filter((p) => !p.penId);
  if (!rows.length && !noPen.length) return null;

  const drug = treatmentDrug(treatment);

  return h('div', { class: 'coverage-block' },
    h('h4', { class: 'subhead' }, t('plan.coverage')),
    h('ul', { class: 'coverage' },
      rows.map((row) => {
        const pen = row.pen;
        const n = penNumber(treatment.pens, pen.id);
        const lastEntry = row.entries[row.entries.length - 1];
        const penInterval = row.entries.length >= 2
          ? Math.abs(diffDays(row.entries[row.entries.length - 2].date, lastEntry.date))
          : intervalDaysFor(drug);
        const nextStart = lastEntry ? suggestNextPenStart(treatment, pen.id, penInterval) : null;
        const exhausted = Boolean(row.entries.length) && row.afterPlan < Number(lastEntry.amount || 0);

        return h('li', {
          class: `coverage__row ${row.insufficient ? 'is-short' : ''} ${penColorClass(treatment.pens, pen.id)}`,
        },
          h('span', { class: 'coverage__swatch' }),
          h('div', { class: 'coverage__body' },
            h('p', { class: 'coverage__title' },
              h('strong', {}, `#${n}`),
              ' ', pen.presentationMg ? `${formatNumber(pen.presentationMg)} mg` : '—',
              row.entries.length
                ? h('span', { class: 'muted' }, ` · ${t('plan.coverageRow', {
                    n: row.doses,
                    from: fmtShort(row.from),
                    to: fmtShort(row.to),
                  })}`)
                : h('span', { class: 'muted' }, ` · ${t('pen.status.active')}`)),
            h('p', { class: 'coverage__line' },
              h('span', { class: 'pill pill--derived' }, t('k.derived')),
              t('plan.afterPlan', { n: `${formatNumber(Math.max(0, row.afterPlan))} ${unitShort(pen)}` })),
            row.insufficient
              ? h('p', { class: 'coverage__alert' }, icon('alert'), ' ',
                  t('plan.shortPen', {
                    pen: n,
                    n: `${formatNumber(row.shortfall)} ${unitShort(pen)}`,
                    date: fmtShort(row.firstBad ? row.firstBad.date : row.to),
                  }))
              : exhausted && nextStart
                ? h('div', { class: 'coverage__next' },
                    h('p', { class: 'muted small' }, t('plan.nextPenHint', { next: fmtShort(nextStart) })),
                    btn(t('plan.createNextPen'), {
                      variant: 'accent', icon: 'plus',
                      onClick: () => penFormDialog(patient, treatment, { isNew: true, startDate: nextStart }),
                    }))
                : null)
        );
      }),
      // Propostes prescrites en mg sense ploma assignada (issue #2)
      noPen.length
        ? h('li', { class: 'coverage__row coverage__row--nopen' },
          h('span', { class: 'coverage__swatch coverage__swatch--none' }),
          h('div', { class: 'coverage__body' },
            h('p', { class: 'coverage__title' },
              h('strong', {}, '—'), ' ', t('plan.noPenShort'),
              h('span', { class: 'muted' }, ` · ${t('plan.coverageNoPen', { n: noPen.length })}`)),
            h('p', { class: 'coverage__line' },
              h('span', { class: 'pill pill--projected' }, t('plan.noPenShort')),
              t('plan.noPenCap'))))
        : null
    ));
}

/* ------------------------------------------------------------------ */
/* Previsualització + confirmació de la generació                     */
/* ------------------------------------------------------------------ */
/**
 * Generar mai és automàtic: primer es mostren les dates que es crearien (i el
 * saldo que en quedaria) i l'usuari confirma.
 * @returns {Promise<boolean>}
 */
function planPreviewDialog({ treatment, result, penId, replacing = 0 }) {
  const pen = penById(treatment, penId);
  const balance = pen ? penBalance(treatment, pen) : null;
  const total = result.dates.length * Number(result.amount || 0);
  const others = replacing
    ? 0
    : plansForPen(treatment, penId).reduce((s, p) => s + Number(p.amount || 0), 0);
  const after = balance == null ? null : balance - total - others;
  const unit = pen ? (pen.capacityUnit === 'clicks' ? t('admin.clicks') : 'dosis') : '';
  const shown = result.dates.slice(0, 14);
  const rest = result.dates.length - shown.length;

  const list = h('ul', { class: 'preview-list' },
    shown.map((date) => h('li', { class: 'preview-list__row' },
      h('span', { class: 'preview-list__date' }, fmtShort(date)),
      h('span', {}, result.mode === 'clicks'
        ? `${formatNumber(result.amount)} ${t('admin.clicks')}`
        : `${formatNumber(result.value)} mg`),
      result.mg != null ? h('span', { class: 'muted small' }, `≈ ${formatNumber(result.mg)} mg`) : null)));

  const body = h('div', { class: 'form' },
    h('p', { class: 'muted' }, t('plan.previewIntro', {
      n: result.dates.length,
      from: fmtShort(result.dates[0]),
      to: fmtShort(result.dates[result.dates.length - 1]),
    })),
    replacing
      ? h('p', { class: 'note note--projected' }, icon('info'), ' ',
          t('plan.replaceConfirm', { n: replacing }))
      : null,
    list,
    rest > 0 ? h('p', { class: 'muted small' }, t('plan.previewMore', { n: rest })) : null,
    after != null
      ? h('p', { class: 'muted small' }, t('plan.previewBalance', {
          saldo: `${formatNumber(Math.max(0, after))} ${unit}`,
        }))
      : null);

  return new Promise((resolve) => {
    const { close } = openDialog({
      title: t('plan.previewTitle'),
      body,
      actions: [
        // ORDRE IMPORTANT: resoldre PRIMER, tancar després — `close()` crida
        // `onClose` i aquest resoldria `false` abans que el clic arribés.
        btn(t('app.cancel'), { variant: 'ghost', onClick: () => { resolve(false); close(); } }),
        btn(t('plan.previewConfirm'), {
          variant: 'primary', icon: 'check',
          onClick: () => { resolve(true); close(); },
        }),
      ],
      onClose: () => resolve(false),
    });
  });
}

/* ------------------------------------------------------------------ */
/* Estats d'una proposta: ajornar / ometre / cancel·lar                */
/* ------------------------------------------------------------------ */
/**
 * Canvia l'estat d'una proposta sense tocar cap registre real.
 *  - ajornada: passa a una altra data (es conserva l'original) i, si es vol,
 *    tot el pla posterior es desplaça el mateix nombre de dies
 *  - omesa / cancel·lada: fora dels pendents, amb motiu i traça; es poden
 *    tornar al pla des de la mateixa fitxa
 */
export function planStatusDialog({ patient, treatment, entry, kind = 'postpone' }) {
  const drug = treatmentDrug(treatment);
  const isPostpone = kind === 'postpone';
  const interval = intervalAt(treatment, entry.date, drug) || 7;
  const defaultDate = addDays(entry.date, interval);
  const titleKey = { postpone: 'plan.postponeTitle', omit: 'plan.omitTitle', cancelPlan: 'plan.cancelTitle' }[kind] || 'plan.postponeTitle';
  const statusKey = { postpone: 'postponed', omit: 'omitted', cancelPlan: 'cancelled' }[kind] || 'postponed';

  const dateInput = h('input', { class: 'input', type: 'date', name: 'date', value: defaultDate });
  const reasonInput = h('input', {
    class: 'input', type: 'text', name: 'reason', maxlength: '140',
    placeholder: t('plan.reasonOptional'), value: entry.reason || '',
  });
  const later = pendingPlans(treatment).filter(
    (p) => p.id !== entry.id && p.penId === entry.penId && cmpDates(p.date, entry.date) > 0
  );
  const shiftInput = h('input', { type: 'checkbox', name: 'shift', checked: later.length > 0 });
  const occupied = plannedEntries(treatment).some((p) => p.id !== entry.id && p.date === defaultDate);
  const errorSlot = h('div', { class: 'form__errors' });

  const form = h('form', { class: 'form', novalidate: true },
    isPostpone
      ? h('div', { class: 'field' },
          h('span', { class: 'field__label' }, t('plan.postponeDate')),
          dateInput,
          h('span', { class: 'field__hint' }, t('plan.postponeDefault', { date: fmtShort(defaultDate) })),
          occupied ? h('span', { class: 'field__hint warn' }, t('plan.dateOccupied')) : null)
      : h('p', { class: 'muted small' }, t('plan.statusHint')),
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('plan.reason')), reasonInput),
    isPostpone && later.length
      ? h('label', { class: 'switch' },
          shiftInput,
          h('span', {}, t('plan.shiftRest', { n: later.length })),
          h('span', { class: 'field__hint' }, t('plan.shiftRestHint')))
      : null,
    errorSlot);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFormError(form);
    const reason = reasonInput.value.trim();
    let delta = 0;
    if (isPostpone) {
      const date = dateInput.value;
      if (!isValidISO(date)) return errorSlot.replaceChildren(formError(t('form.date')));
      delta = diffDays(entry.date, date);
      postponePlan(treatment, entry.id, { date, reason });
    } else if (kind === 'omit') {
      omitPlan(treatment, entry.id, reason);
    } else {
      cancelPlan(treatment, entry.id, reason);
    }

    // Opció: desplaçar el pla posterior per mantenir l'interval
    let shifted = 0;
    if (isPostpone && shiftInput.checked && delta) {
      shifted = propagatePlanChanges(treatment, {
        penId: entry.penId,
        fromDate: entry.originalDate || entry.date,
        excludeId: entry.id,
        shiftDays: delta,
      });
    }

    persist(patient);
    update('plan-status');
    close();
    toast(shifted
      ? `${t('plan.statusChanged', { status: t(`plan.status.${statusKey}`), date: fmtShort(entry.date) })} · ${t('plan.futureUpdated', { n: shifted })}`
      : t('plan.statusChanged', { status: t(`plan.status.${statusKey}`), date: fmtShort(entry.date) }), { tone: 'ok' });
  });

  const { close } = openDialog({
    title: t(titleKey),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('app.save'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Editar / moure / registrar una data planificada                     */
/* ------------------------------------------------------------------ */
export function planEntryDialog({ patient, treatment, entry }) {
  const drug = treatmentDrug(treatment);
  const pens = visiblePens(treatment);
  let mode = entry.mode;
  let value = entry.mode === 'clicks' ? entry.amount : entry.value;

  const dateInput = h('input', { class: 'input', type: 'date', value: entry.date });
  const penSelect = h('select', { class: 'input' },
    pens.map((p, i) => h('option', { value: p.id, selected: p.id === entry.penId },
      `#${i + 1} · ${p.presentationMg ? `${formatNumber(p.presentationMg)} mg` : '—'}`)));
  const valueInput = h('input', {
    class: 'input', type: 'number', name: 'value', inputmode: 'decimal', step: '0.01', min: '0', value: value ?? '',
  });
  const errorSlot = h('div', { class: 'form__errors' });

  // Opció d'aplicar el canvi a les dosis futures (pendents de la mateixa ploma)
  const futureTargets = pendingPlans(treatment).filter(
    (p) => p.id !== entry.id && p.penId === entry.penId && cmpDates(p.date, entry.date) > 0
  );
  // Abast de FASE: només les propostes dins del tram de pauta que conté aquesta data
  const phase = phaseAt(treatment, entry.date);
  const phaseTargets = phase
    ? futureTargets.filter((p) => cmpDates(p.date, phase.to || '9999-12-31') <= 0)
    : [];
  // Per defecte: AQUESTA I LES FUTURES (la modificada mana sobre les següents)
  const scopeSelect = futureTargets.length
    ? h('select', { class: 'input', name: 'scope' },
        h('option', { value: 'future' }, t('plan.scopeFuture', { n: futureTargets.length })),
        phaseTargets.length
          ? h('option', { value: 'phase' }, t('plan.phaseScope'))
          : null,
        h('option', { value: 'only' }, t('plan.scopeOnly')))
    : null;

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.date')), dateInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('plan.pen')), penSelect)),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('plan.dose')),
      h('span', { class: 'field__hint' }, entry.mode === 'clicks' ? t('treatment.modeClicks') : t('treatment.modeStandard')),
      valueInput),
    scopeSelect
      ? h('div', { class: 'field' },
          h('span', { class: 'field__label' }, t('plan.scope')),
          scopeSelect,
          h('span', { class: 'field__hint' }, t('plan.scopeHint')))
      : null,
    errorSlot);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormError(form);
    const date = dateInput.value;
    const penId = penSelect.value;
    const pen = penById(treatment, penId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorSlot.replaceChildren(formError(t('form.date')));
    const v = Number(valueInput.value);
    if (!Number.isFinite(v) || v <= 0) return errorSlot.replaceChildren(formError(t('form.number')));

    const computed = registerAmount({ mode, value: v, pen, drug });
    if (!computed.valid) return errorSlot.replaceChildren(formError(t('cal.quickInvalid')));

    const scope = scopeSelect ? scopeSelect.value : 'only';
    const oldDate = entry.date;
    const delta = diffDays(oldDate, date);
    const changedDose = entry.penId !== penId || Number(entry.amount) !== computed.amount;
    const changedDate = delta !== 0;
    const wantsFuture = scope !== 'only' && (changedDose || changedDate);
    const scopeCount = scope === 'phase' ? phaseTargets.length : futureTargets.length;

    // El diàleg evita aplicar per error el canvi a totes les futures:
    // "Cancel·la" no descarta l'edició, només la limita a aquesta data.
    let applyFuture = wantsFuture;
    if (wantsFuture) {
      applyFuture = await confirmDialog(t('plan.futureConfirm', { n: scopeCount }), {
        danger: false,
        okLabel: scope === 'phase'
          ? t('plan.phaseScope')
          : t('plan.scopeFuture', { n: scopeCount }),
      });
    }

    Object.assign(entry, {
      date,
      penId,
      value: mode === 'standard' ? v : Math.round(v),
      amount: computed.amount,
      unit: computed.unit,
      mg: computed.mg,
    });

    let affected = 0;
    if (applyFuture) {
      affected = propagatePlanChanges(treatment, {
        penId: entry.penId,
        fromDate: oldDate,
        // abast de fase: límit superior del tram de pauta
        toDate: scope === 'phase' && phase ? phase.to : null,
        excludeId: entry.id,
        value: entry.value,
        mode: entry.mode,
        amount: entry.amount,
        unit: entry.unit,
        mg: entry.mg,
        shiftDays: delta,
      });
    }

    persist(patient);
    update('plan-edited');
    close();
    toast(affected ? t('plan.futureUpdated', { n: affected }) : t('form.saved'), { tone: 'ok' });
  });

  const { close } = openDialog({
    title: t('plan.edit'),
    body: form,
    actions: [
      btn(t('plan.delete'), {
        variant: 'danger', icon: 'trash',
        onClick: async () => {
          const ok = await confirmDialog(t('plan.deleteConfirm'), { okLabel: t('plan.delete') });
          if (!ok) return;
          tombstonePlan(treatment, entry.id);
          persist(patient);
          update('plan-deleted');
          close();
          toast(t('form.deleted'), { tone: 'ok' });
        },
      }),
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('app.save'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

/**
 * Converteix una data planificada en administració real, tanca l'entrada de
 * pla (queda a l'historial com a "feta") i, si la continuació automàtica està
 * activada, torna a posar AQUELLA dosi a les setmanes següents.
 */
export function registerPlanEntry({ patient, treatment, entry }) {
  const pen = penById(treatment, entry.penId);
  if (!pen) return null;

  const balanceBefore = penBalance(treatment, pen);
  const adm = createAdministration({
    date: entry.date,
    penId: pen.id,
    mode: entry.mode,
    value: entry.value,
    amount: entry.amount,
    unit: entry.unit,
    mg: entry.mg,
    balanceBefore,
    balanceAfter: balanceBefore - Number(entry.amount || 0),
  });
  treatment.administrations.push(adm);
  entry.registeredAdminId = adm.id;

  const cont = applyRegisteredDose(treatment, adm);

  recomputeBalances(treatment);
  persist(patient);
  return { admin: adm, extended: cont.created.length, relevelled: cont.relevelled };
}

/* ------------------------------------------------------------------ */

function unitShort(pen) {
  return pen && pen.capacityUnit === 'doses' ? 'doses' : t('admin.clicks');
}

function tStatusShort(status) {
  if (status === 'active') return t('pen.status.active');
  if (status === 'finished') return t('pen.status.finished');
  return t('pen.status.discarded');
}
