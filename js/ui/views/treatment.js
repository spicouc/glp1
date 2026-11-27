// Tractaments: creació, edició, estats, pauta prevista per trams i historial.

import { h, btn, icon, iconBtn, sectionCard, emptyState, chip, formatNumber, formatEur, penNumber } from '../dom.js';
import { openDialog, confirmDialog, toast, formError, clearFormError } from '../modal.js';
import { t, tStatus } from '../../i18n/index.js';
import { drugList, getDrug, clickModeState, clicksAvailable, intervalDaysFor, resolveConversion } from '../../core/drugs.js';
import { createTreatment, createSchedule, createCost, createInitialPen, presentationForDose, resolvePenCapacity, nextPenSeq } from '../../core/model.js';
import {
  activeTreatment,
  activePen,
  sortedSchedules,
  currentDose,
  scheduleAt,
  pendingPlans,
  clearAdministrations,
  allAdministrations,
  visibleTreatments,
  registerAmount,
  propagatePlanChanges,
  resequencePlanDates,
  cancelPlan,
  plannedEntries,
  treatmentCosts,
  visiblePens,
} from '../../core/calc.js';
import { persist, update, selectedTreatmentOf } from '../state.js';
import { patientPath, navigate } from '../router.js';
import { todayISO, fmtShort, isValidISO, cmpDates, addDays } from '../../core/dates.js';
import { amountLabel, doseLabel, equivalenceLine } from '../components/summary.js';


export function treatmentFormDialog(patient, existing = null) {
  const isNew = !existing;
  const drugOptions = drugList().map((d) => ({ value: d.id, label: `${d.label} (${d.activeSubstance})` }));
  const initialDrug = existing ? existing.drugId : drugOptions[0].value;

  const drugSel = h('select', { class: 'input', name: 'drugId' },
    drugOptions.map((o) => h('option', { value: o.value, selected: o.value === initialDrug }, o.label)));
  const startInput = h('input', { class: 'input', type: 'date', name: 'startDate', value: existing ? existing.startDate : todayISO() });
  const endInput = h('input', { class: 'input', type: 'date', name: 'endDate', value: existing && existing.endDate ? existing.endDate : '' });
  const statusSel = h('select', { class: 'input', name: 'status' },
    ['active', 'paused', 'finished'].map((s) => h('option', { value: s, selected: existing ? existing.status === s : s === 'active' }, tStatus('treatment', s))));
  const reasonInput = h('input', { class: 'input', name: 'endReason', value: existing ? existing.endReason : '', placeholder: t('treatment.endReasons') });
  const notesInput = h('textarea', { class: 'input input--area', name: 'notes', rows: '3' }, existing ? existing.notes : '');
  const errorSlot = h('div', { class: 'form__errors' });

  // --- Dosi i ploma inicials (només en crear) ---------------------------
  // L'usuari tria la dosi I amb quina ploma s'inicia; els valors es deriven
  // del catàleg i de la dosi però es poden canviar lliurement.
  const doseState = { value: null };
  const penForm = { presTouched: false, capTouched: false, unitTouched: false };

  const autoPenInput = h('input', { type: 'checkbox', name: 'autoPen', checked: true });
  const autoPenHint = h('span', { class: 'field__hint' });
  const doseSlot = h('div', { class: 'quick__value' });
  const doseEqSlot = h('div', { class: 'eqslot' });
  const presSlot = h('div', {});
  const capInput = h('input', {
    class: 'input', name: 'initialCapacity', type: 'number', inputmode: 'numeric',
    min: '1', step: '1', 'aria-label': t('pen.capacity'),
  });
  const unitSel = h('select', { class: 'input', name: 'capacityUnit', 'aria-label': t('pen.capacityUnit') },
    ['clicks', 'doses'].map((u) => h('option', { value: u },
      u === 'clicks' ? t('pen.capacityClicks') : t('pen.capacityDoses'))));

  const penFields = h('div', { class: 'grid3' },
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.presentation')), presSlot),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.capacity')), capInput),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.capacityUnit')), unitSel));

  const readPres = () => {
    const el = presSlot.firstElementChild;
    return el ? String(el.value) : '';
  };
  const writePres = (val) => {
    const el = presSlot.firstElementChild;
    if (el) el.value = val === null || val === undefined ? '' : String(val);
  };

  const selectedPresentation = () => {
    const d = getDrug(drugSel.value);
    if (!d) return null;
    if (penForm.presTouched) {
      const raw = readPres();
      return raw === '' ? null : Number(raw);
    }
    return presentationForDose(drugSel.value, Number(doseState.value));
  };

  const selectedCapacity = () => {
    if (penForm.capTouched) return Number(capInput.value) || null;
    const d = getDrug(drugSel.value);
    return d ? d.defaultInitialCapacity : null;
  };

  const selectedUnit = () => {
    if (penForm.unitTouched) return unitSel.value;
    const d = getDrug(drugSel.value);
    return d ? d.capacityUnit : 'doses';
  };

  const currentTempPen = () => ({
    presentationMg: selectedPresentation(),
    capacityUnit: selectedUnit(),
    initialCapacity: selectedCapacity(),
  });

  const refreshDoseEq = () => {
    const d = getDrug(drugSel.value);
    const line = equivalenceLine(currentTempPen(), d, { mg: Number(doseState.value) });
    doseEqSlot.replaceChildren(...(line ? [line] : []));
  };

  const refreshAutoPenHint = () => {
    const d = getDrug(drugSel.value);
    if (!d) { autoPenHint.textContent = ''; return; }
    const pres = selectedPresentation();
    // Mostra la capacitat REAL que es crearà: si es coneixen els clics per dosi
    // completa, la ploma es desa en clics (240, 128, 288…) i es deriven les dosis.
    const plan = resolvePenCapacity({
      drug: d,
      presentationMg: pres,
      capacity: selectedCapacity(),
      unit: selectedUnit(),
    });
    const clickUnit = t('admin.clicks');
    const doseUnit = t('pen.capacityDoses');
    const unit = plan.unit === 'clicks' ? clickUnit : doseUnit;
    // Si la presentació no es pot derivar, no es posa una guió que sembli un
    // error: es descriu la ploma pel que sí que se sap (capacitat i unitat).
    const label = pres != null ? `${formatNumber(pres)} mg` : t('pen.presentationUnk');
    let desc = `${label} · ${plan.capacity == null ? '—' : formatNumber(plan.capacity)} ${unit}`;
    if (plan.clicksPerDose && plan.unit === 'clicks') {
      desc += ` = ${formatNumber(plan.capacity / plan.clicksPerDose)} ${doseUnit} de ${formatNumber(plan.clicksPerDose)} ${clickUnit}`;
    }
    autoPenHint.textContent = t('treatment.autoPenHint', { pen: desc });
  };

  const renderPres = () => {
    const d = getDrug(drugSel.value);
    const prev = readPres();
    presSlot.replaceChildren();

    if (d && d.penStrengthsMg) {
      const sel = h('select', { class: 'input', name: 'presentationMg', 'aria-label': t('pen.presentation') },
        d.penStrengthsMg.map((s) => h('option', { value: String(s) }, `${formatNumber(s)} mg`)));
      sel.addEventListener('change', () => {
        penForm.presTouched = true;
        refreshDoseEq();
        refreshAutoPenHint();
      });
      presSlot.appendChild(sel);
      if (penForm.presTouched && prev !== '') writePres(prev);
      else writePres(presentationForDose(drugSel.value, Number(doseState.value)));
    } else {
      const inp = h('input', {
        class: 'input', name: 'presentationMg', type: 'number', inputmode: 'decimal',
        step: '0.01', min: '0', 'aria-label': t('pen.presentation'),
        value: penForm.presTouched ? prev : '',
      });
      inp.addEventListener('input', () => {
        penForm.presTouched = true;
        refreshDoseEq();
        refreshAutoPenHint();
      });
      presSlot.appendChild(inp);
      if (!penForm.presTouched) writePres(presentationForDose(drugSel.value, Number(doseState.value)));
    }
  };

  const renderDoseChips = () => {
    const d = getDrug(drugSel.value);
    const doses = d ? [...d.standardDosesMg] : [];
    const optional = d && d.optionalMaintenanceMg ? d.optionalMaintenanceMg : [];
    if (!doses.length) {
      doseSlot.replaceChildren();
      doseEqSlot.replaceChildren();
      return;
    }
    if (!doses.includes(Number(doseState.value))) doseState.value = doses[0];

    const chipFor = (dose, isOptional) => h('button', {
      type: 'button',
      class: `dosechip ${isOptional ? 'dosechip--optional' : ''} ${Number(doseState.value) === dose ? 'is-selected' : ''}`,
      onClick: () => { doseState.value = dose; renderDoseChips(); },
    }, h('span', { class: 'dosechip__mg' }, `${formatNumber(dose)} mg`));

    doseSlot.replaceChildren();
    doses.forEach((x) => doseSlot.appendChild(chipFor(x, false)));
    optional.forEach((x) => doseSlot.appendChild(chipFor(x, true)));

    // La presentació segueix la dosi (si l'usuari no l'ha canviada a mà)
    if (!penForm.presTouched) renderPres();
    refreshDoseEq();
    refreshAutoPenHint();
  };

  const applyDrugDefaults = () => {
    const d = getDrug(drugSel.value);
    penForm.presTouched = false;
    penForm.capTouched = false;
    penForm.unitTouched = false;
    capInput.value = d ? d.defaultInitialCapacity : '';
    unitSel.value = d ? d.capacityUnit : 'doses';
  };

  capInput.addEventListener('input', () => { penForm.capTouched = true; refreshDoseEq(); refreshAutoPenHint(); });
  unitSel.addEventListener('change', () => { penForm.unitTouched = true; refreshDoseEq(); refreshAutoPenHint(); });

  const togglePenFields = () => { penFields.hidden = !autoPenInput.checked; };
  autoPenInput.addEventListener('change', () => { togglePenFields(); refreshAutoPenHint(); });

  drugSel.addEventListener('change', () => {
    doseState.value = null;
    applyDrugDefaults();
    renderPres();
    renderDoseChips();
  });

  const doseRow = isNew
    ? h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('treatment.doseInitial')),
        doseSlot,
        doseEqSlot,
        h('span', { class: 'field__hint' }, t('treatment.doseInitialHint')))
    : null;

  const penRow = isNew
    ? h('div', { class: 'stack stack--tight' },
        h('label', { class: 'switch' }, autoPenInput, h('span', {}, t('treatment.autoPen'))),
        penFields,
        autoPenHint)
    : null;

  if (isNew) {
    applyDrugDefaults();
    renderPres();
    renderDoseChips();
    togglePenFields();
  } else {
    refreshAutoPenHint();
  }

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.drug')), drugSel),
    doseRow,
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.start')), startInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.end')), endInput, h('span', { class: 'field__hint' }, t('app.optional')))),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.status')), statusSel),
    penRow,
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.finishWhy')), reasonInput, h('span', { class: 'field__hint' }, t('app.optional'))),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.notes')), notesInput),
    errorSlot
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFormError(form);
    const startDate = startInput.value;
    const endDate = endInput.value || null;
    if (!isValidISO(startDate)) return errorSlot.replaceChildren(formError(t('form.date')));
    if (endDate && !isValidISO(endDate)) return errorSlot.replaceChildren(formError(t('form.date')));
    if (endDate && cmpDates(endDate, startDate) < 0) return errorSlot.replaceChildren(formError(t('form.dateOrder')));

    // Primer tractament del pacient: cal estipular la ploma que s'hi fa servir
    const isFirstTreatment = isNew && visibleTreatments(patient).length === 0;
    if (isFirstTreatment && !autoPenInput.checked) {
      penFields.hidden = false;
      return errorSlot.replaceChildren(formError(t('treatment.penRequired')));
    }

    const target = existing || createTreatment({ drugId: drugSel.value, startDate });
    const drugChanged = target.drugId !== drugSel.value;
    Object.assign(target, {
      drugId: drugSel.value,
      startDate,
      endDate,
      status: statusSel.value,
      endReason: reasonInput.value.trim(),
      notes: notesInput.value.trim(),
    });

    // En iniciar un tractament, la ploma ja queda iniciada (evita un pas més)
    let createdPen = null;
    if (isNew) {
      const initialDose = Number(doseState.value);
      const firstSchedule = target.schedules[0];
      if (firstSchedule && Number.isFinite(initialDose) && initialDose > 0) {
        firstSchedule.startDate = startDate;
        firstSchedule.mode = 'standard';
        firstSchedule.value = initialDose;
      }

      // Només hi pot haver un tractament actiu: l'anterior es tanca (sense
      // perdre'n cap dada; tot segueix a l'historial).
      if (statusSel.value === 'active') {
        for (const old of visibleTreatments(patient)) {
          if (old.status !== 'active' || old.id === target.id) continue;
          old.status = 'finished';
          old.endDate = cmpDates(startDate, old.startDate) > 0 ? addDays(startDate, -1) : old.startDate;
          if (!old.endReason) old.endReason = t('treatment.superseded');
        }
      }

      patient.treatments.push(target);
      if (autoPenInput.checked) {
        createdPen = createInitialPen(drugSel.value, startDate, {
          presentationMg: selectedPresentation(),
          initialCapacity: selectedCapacity(),
          capacityUnit: selectedUnit(),
        });
        if (createdPen) {
          createdPen.seq = nextPenSeq(target); // número congelat des de l'alta
          target.pens.push(createdPen);
        }
      }
    }

    persist(patient);
    close();

    const penDesc = createdPen
      ? `#1${createdPen.presentationMg ? ` · ${formatNumber(createdPen.presentationMg)} mg` : ''} · ${createdPen.initialCapacity} ${createdPen.capacityUnit === 'clicks' ? t('admin.clicks') : 'doses'}`
      : '';
    toast(
      isNew
        ? (createdPen ? t('treatment.createdWithPen', { pen: penDesc }) : t('form.created'))
        : t('form.saved'),
      { tone: 'ok' }
    );
    update('treatment-saved');
    if (drugChanged) update('drug-changed');
  });

  const { close } = openDialog({
    title: isNew ? t('treatment.new') : t('treatment.edit'),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('app.save'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

/**
 * Editor de FASES: dosi, interval, data d'inici, durada i data de fi.
 * `existing` = edició d'una fase (el formulari inline de sota és l'alta);
 * `onClose` quan es fa servir dins d'un diàleg.
 */
function scheduleForm(patient, treatment, { existing = null, onClose = null } = {}) {
  const drug = getDrug(treatment.drugId);
  const pen = activePen(treatment);
  const st = clickModeState(pen, drug);
  const phase = existing;

  const dateInput = h('input', { class: 'input', type: 'date', name: 'startDate', value: phase ? phase.startDate : todayISO() });
  const modeSel = h('select', { class: 'input', name: 'mode' },
    h('option', { value: 'standard', selected: !phase || phase.mode !== 'clicks' }, t('treatment.modeStandard')),
    h('option', { value: 'clicks', selected: phase && phase.mode === 'clicks', disabled: !clicksAvailable(pen, drug) }, t('treatment.modeClicks')));
  const valueInput = h('input', { class: 'input', type: 'number', name: 'value', inputmode: 'decimal', min: '0', step: '0.01',
    value: phase ? phase.value : (drug ? drug.standardDosesMg[0] : '') });
  const intervalInput = h('input', { class: 'input', type: 'number', name: 'intervalDays', inputmode: 'numeric', min: '1', max: '60',
    value: phase ? phase.intervalDays : intervalDaysFor(drug) });
  const durationInput = h('input', { class: 'input', type: 'number', name: 'durationDays', inputmode: 'numeric', min: '1',
    value: phase && phase.durationDays ? phase.durationDays : '' });
  const endInput = h('input', { class: 'input', type: 'date', name: 'endDate', value: phase ? phase.endDate || '' : '' });
  const statusSel = h('select', { class: 'input', name: 'status' },
    h('option', { value: 'active', selected: !phase || phase.status === 'active' }, t('treatment.phaseActive')),
    h('option', { value: 'done', selected: phase && phase.status === 'done' }, t('treatment.phaseDone')),
    h('option', { value: 'cancelled', selected: phase && phase.status === 'cancelled' }, t('treatment.phaseCancelled')));

  // durada ↔ data de fi: l'una calcula l'altra
  const syncFromDuration = () => {
    const start = dateInput.value;
    const dur = Number(durationInput.value);
    if (isValidISO(start) && Number.isFinite(dur) && dur > 0) {
      endInput.value = addDays(start, Math.round(dur) - 1);
    }
  };
  const syncFromEnd = () => {
    const start = dateInput.value;
    const end = endInput.value;
    if (isValidISO(start) && isValidISO(end)) {
      const d = diffDays(start, end) + 1;
      durationInput.value = d > 0 ? String(d) : '';
    }
  };
  // `input` + `change`: així s'actualitza mentre s'escriu (i també en sortir
  // del camp), i les dues opcions queden sempre coherents entre elles.
  for (const el of [durationInput]) {
    el.addEventListener('input', syncFromDuration);
    el.addEventListener('change', syncFromDuration);
  }
  for (const el of [endInput]) {
    el.addEventListener('input', syncFromEnd);
    el.addEventListener('change', syncFromEnd);
  }
  dateInput.addEventListener('change', () => { if (durationInput.value) syncFromDuration(); });
  const valueHint = h('span', { class: 'field__hint' });
  const errorSlot = h('div', { class: 'form__errors' });

  const updateValueHint = () => {
    const v = Number(valueInput.value);
    if (!Number.isFinite(v) || v <= 0) { valueHint.textContent = ''; return; }
    if (modeSel.value === 'clicks') {
      valueHint.textContent = `${v} ${t('admin.clicks')}`;
      return;
    }
    const conv = resolveConversion(pen, drug);
    const clicks = conv ? Math.round(v / conv.mgPerClick) : null;
    const standard = drug && drug.standardDosesMg.includes(v);
    const base = clicks != null
      ? `${formatNumber(v)} mg = ${clicks} ${t('admin.clicks')} · ${t('cal.theoretical')}`
      : `${formatNumber(v)} mg`;
    valueHint.textContent = standard ? base : `${base} · ${t('treatment.nonStandardDose')}`;
  };
  valueInput.addEventListener('input', updateValueHint);
  modeSel.addEventListener('change', updateValueHint);
  updateValueHint();

  const form = h('form', { class: `form ${onClose ? '' : 'form--inline'}`, novalidate: true },
    h('div', { class: 'grid4' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.scheduleFrom')), dateInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.mode')), modeSel),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.scheduleValue')), valueInput, valueHint),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.week')), intervalInput)),
    h('div', { class: 'grid4' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.phaseDuration')), durationInput,
        h('span', { class: 'field__hint' }, t('treatment.phaseDurationHint'))),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.phaseTo')), endInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('treatment.phaseStatus')), statusSel)),
    h('div', { class: 'row row--end' },
      h('p', { class: 'muted small' }, t('treatment.scheduleHint')),
      btn(t('app.save'), { variant: 'primary', icon: phase ? 'check' : 'plus', type: 'submit' })),
    errorSlot
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFormError(form);
    const startDate = dateInput.value;
    if (!isValidISO(startDate)) return errorSlot.replaceChildren(formError(t('form.date')));
    const value = Number(valueInput.value);
    if (!Number.isFinite(value) || value <= 0) return errorSlot.replaceChildren(formError(t('form.number')));
    const interval = Number(intervalInput.value);
    if (!Number.isInteger(interval) || interval < 1) return errorSlot.replaceChildren(formError(t('form.integer')));
    const endDate = endInput.value || null;
    if (endDate && !isValidISO(endDate)) return errorSlot.replaceChildren(formError(t('form.date')));
    if (endDate && cmpDates(endDate, startDate) < 0) return errorSlot.replaceChildren(formError(t('form.dateOrder')));
    const durationDays = durationInput.value ? Number(durationInput.value) : null;
    if (durationDays != null && (!Number.isInteger(durationDays) || durationDays < 1)) {
      return errorSlot.replaceChildren(formError(t('form.integer')));
    }
    const status = statusSel.value;
    const computed = registerAmount({ mode: modeSel.value, value, pen, drug });
    if (!computed.valid) return errorSlot.replaceChildren(formError(t('cal.quickInvalid')));

    const doseChanged = !phase || phase.value !== value || phase.mode !== modeSel.value;
    const rangeChanged = !phase || phase.startDate !== startDate || phase.endDate !== endDate;
    // Cadència i estat de la fase: abans NO es preguntava per res si canviaven
    // sols, i les propostes del tram quedaven amb dates obsoletes o actives
    // sota una fase cancel·lada (issue #3).
    const intervalChanged = Boolean(phase) && Number(phase.intervalDays) !== interval;
    const cancelPhase = Boolean(phase && phase.status !== 'cancelled' && status === 'cancelled');

    if (phase) {
      Object.assign(phase, {
        startDate, mode: modeSel.value, value, intervalDays: interval,
        endDate, durationDays, status, updatedAt: new Date().toISOString(),
      });
    } else {
      treatment.schedules.push(createSchedule({
        startDate, mode: modeSel.value, value, intervalDays: interval,
        endDate, durationDays, status,
      }));
    }
    persist(patient);
    update(phase ? 'schedule-updated' : 'schedule-added');
    toast(phase ? t('treatment.phaseUpdated') : t('treatment.phaseAdded'), { tone: 'ok' });
    if (onClose) onClose();

    // Els canvis d'una fase futura es poden aplicar a les seves propostes (mai
    // a registres reals) i sempre amb confirmació explícita; cada canvi amb el
    // seu missatge i en cadena, perquè es puguin demanar dos d'un cop.
    const targets = plannedEntries(treatment).filter((p) => {
      if (cmpDates(p.date, startDate) < 0) return false;
      if (endDate && cmpDates(p.date, endDate) > 0) return false;
      return true;
    });
    const steps = [];
    if (cancelPhase && targets.length) {
      steps.push([t('treatment.phaseCancelAsk', { n: targets.length }), () => {
        for (const p of targets) cancelPlan(treatment, p.id, t('treatment.phaseCancelReason'));
        persist(patient);
        update('plan-propagated');
        toast(t('treatment.phaseCancelled', { n: targets.length }), { tone: 'ok' });
      }]);
    } else {
      if ((doseChanged || rangeChanged) && targets.length) {
        steps.push([t('treatment.phaseApplyAsk', { n: targets.length }), () => {
          const n = propagatePlanChanges(treatment, {
            fromDate: startDate,
            toDate: endDate,
            value: modeSel.value === 'standard' ? value : Math.round(value),
            mode: modeSel.value,
            amount: computed.amount,
            unit: computed.unit,
            mg: computed.mg,
          });
          persist(patient);
          update('plan-propagated');
          toast(t('treatment.phaseApplied', { n }), { tone: 'ok' });
        }]);
      }
      if (intervalChanged && targets.length) {
        steps.push([t('treatment.phaseIntervalAsk', { n: targets.length, interval }), () => {
          const { moved, conflicts } = resequencePlanDates(treatment, {
            fromDate: startDate, toDate: endDate, start: startDate, interval,
          });
          persist(patient);
          update('plan-propagated');
          toast(conflicts
            ? t('treatment.phaseIntervalConflicts', { n: moved, c: conflicts })
            : t('treatment.phaseIntervalApplied', { n: moved }), { tone: conflicts ? 'warn' : 'ok' });
        }]);
      }
    }
    (async () => {
      for (const [message, run] of steps) {
        const ok = await confirmDialog(message, { danger: false, okLabel: t('plan.applyToPlan') });
        if (ok) run();
      }
    })();
  });

  return form;
}

/** Obre l'editor de fases dins d'un diàleg (edició d'un tram existint). */
function phaseDialog(patient, treatment, phase) {
  let close = () => {};
  const form = scheduleForm(patient, treatment, {
    existing: phase,
    onClose: () => close(),
  });
  const dlg = openDialog({
    title: t('treatment.phaseEdit'),
    body: form,
    actions: [btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() })],
  });
  close = dlg.close;
}

function treatmentCard(patient, treatment) {
  const drug = getDrug(treatment.drugId);
  const isActive = treatment.status === 'active';
  const dose = currentDose(treatment);
  const schedules = sortedSchedules(treatment);
  const pen = activePen(treatment);
  const st = clickModeState(pen, drug);

  const nodes = [
    h('div', { class: 'trt__head' },
      h('div', {},
        h('h3', { class: 'trt__title' }, drug ? drug.label : treatment.drugId),
        h('p', { class: 'trt__sub' }, `${drug ? drug.activeSubstance : ''} · ${fmtShort(treatment.startDate)} → ${treatment.endDate ? fmtShort(treatment.endDate) : tStatus('treatment', treatment.status)}`)),
      chip(tStatus('treatment', treatment.status), { tone: isActive ? 'ok' : 'muted' })),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, t('patients.currentDose')), h('span', { class: 'stat__value' }, doseLabel(dose))),
      h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, dose ? dose.label : ''), h('span', { class: 'stat__value' }, dose && dose.date ? fmtShort(dose.date) : '—'))),
    h('dl', { class: 'kv-dl' },
      h('dt', {}, t('treatment.mode')),
      h('dd', {}, drug ? (drug.clickMode === 'theoretical' ? t('treatment.modeClicks') : t('treatment.modeStandard')) : '—'),
      h('dt', {}, t('treatment.drug')),
      h('dd', {}, `${treatment.drugId} · ${drug ? drug.frequency : ''}`)),
    treatment.endReason ? h('p', { class: 'muted' }, `${t('treatment.finishWhy')}: ${treatment.endReason}`) : null,
    treatment.notes ? h('p', { class: 'muted' }, treatment.notes) : null,
  ];

  if (isActive) {
    nodes.push(h('h4', { class: 'subhead' }, t('treatment.schedule')));
    nodes.push(
      h('ul', { class: 'schedules' },
        schedules.map((s) => {
          const current = dose ? scheduleAt(treatment, todayISO()) : null;
          const isCurrent = current && current.id === s.id;
          const range = s.endDate
            ? t('treatment.phaseRange', { from: fmtShort(s.startDate), to: fmtShort(s.endDate) })
            : `${fmtShort(s.startDate)} · ${t('treatment.phaseOpen')}`;
          const statusChip = s.status && s.status !== 'active'
            ? chip(t(`treatment.phase${s.status === 'done' ? 'Done' : 'Cancelled'}`), { tone: 'muted' })
            : null;
          return h('li', { class: `schedules__row ${isCurrent ? 'is-current' : ''}` },
            h('span', { class: 'schedules__date' }, range),
            h('span', {}, s.mode === 'clicks'
              ? `${formatNumber(s.value)} ${t('admin.clicks')}`
              : `${formatNumber(s.value)} mg`),
            h('span', { class: 'muted small' }, `${s.intervalDays} ${t('app.days')}`
              + (s.durationDays ? ` · ${s.durationDays} ${t('app.days')}` : '')),
            statusChip,
            isCurrent ? chip(t('k.real'), { tone: 'ok' }) : null,
            iconBtn('edit', t('treatment.phaseEdit'), () => phaseDialog(patient, treatment, s), { variant: 'secondary' }));
        }))
    );
    nodes.push(scheduleForm(patient, treatment));

    if (drug && drug.escalation) {
      nodes.push(
        h('details', { class: 'docs' },
          h('summary', {}, t('treatment.escalation')),
          h('p', { class: 'muted small' }, drug.escalation),
          st === 'needs-conversion' ? h('p', { class: 'disclaimer small' }, t('pen.conversionMissing'), ' ', t('pen.conversionMissingHint')) : null));
      }
    }

  nodes.push(
    h('div', { class: 'card__actions' },
      btn(t('treatment.edit'), { variant: 'secondary', icon: 'edit', onClick: () => treatmentFormDialog(patient, treatment) }),
      isActive
        ? btn(t('treatment.finish'), {
            variant: 'ghost', icon: 'check',
            onClick: async () => {
              const ok = await confirmDialog(`${t('treatment.finish')}? ${t('treatment.finishWhy')}`, { danger: false, okLabel: t('treatment.finish') });
              if (!ok) return;
              treatment.status = 'finished';
              treatment.endDate = todayISO();
              persist(patient);
              update('treatment-finished');
            },
          })
        : null,
      btn(t('nav.pens'), { variant: 'ghost', icon: 'syringe', onClick: () => navigate(patientPath(patient.id, 'pens')) }),
      btn(t('treatment.clearDoseReg'), {
        variant: 'secondary',
        icon: 'minus',
        onClick: async () => {
          const n = allAdministrations(treatment).length;
          if (!n) { toast(t('treatment.clearDoseRegEmpty'), { tone: 'warn' }); return; }
          const ok = await confirmDialog(
            t('treatment.clearDoseRegConfirm', { a: n }),
            { danger: true, okLabel: t('treatment.clearDoseReg') }
          );
          if (!ok) return;
          const res = clearAdministrations(treatment);
          persist(patient);
          update('administrations-cleared');
          toast(t('treatment.clearDoseRegDone', { n: res.removed, p: res.reopened }), { tone: 'ok' });
        },
      }),
      btn(t('treatment.delete'), {
        variant: 'danger',
        icon: 'trash',
        onClick: async () => {
          const drugLabel = drug ? drug.label : treatment.drugId;
          const ok = await confirmDialog(
            t('treatment.deleteConfirm', {
              drug: drugLabel,
              p: (treatment.pens || []).length,
              a: allAdministrations(treatment).length,
              pl: pendingPlans(treatment).length,
              h: (treatment.health || []).length,
            }),
            { danger: true, okLabel: t('treatment.deleteOk'), title: t('treatment.delete') }
          );
          if (!ok) return;
          // Tomba (mai esborrat físic): així l'esborrat es sincronitza i cap
          // dispositiu vell pot ressuscitar el tractament.
          treatment.deletedAt = new Date().toISOString();
          persist(patient);
          update('treatment-deleted');
          toast(t('treatment.deleted'), { tone: 'ok' });
        },
      })
    )
  );

  return sectionCard(null, ...nodes);
}

/** Diàleg per afegir una despesa del tractament (cèntims enters). */
function costDialog(patient, treatment) {
  const dateInput = h('input', { class: 'input', type: 'date', name: 'date', value: todayISO() });
  const kindSel = h('select', { class: 'input', name: 'kind' },
    h('option', { value: 'other', selected: true }, t('costs.kindOther')),
    h('option', { value: 'admin' }, t('costs.kindAdmin')),
    h('option', { value: 'pen' }, t('costs.kindPen')));
  const amountInput = h('input', { class: 'input', type: 'number', name: 'amount', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0,00' });
  const notesInput = h('input', { class: 'input', name: 'notes', maxlength: '120' });
  const errorSlot = h('div', { class: 'form__errors' });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.date')), dateInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('costs.kind')), kindSel)),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('costs.amount')), amountInput),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.notes')), notesInput,
      h('span', { class: 'field__hint' }, t('costs.penHint'))),
    errorSlot);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFormError(form);
    const date = dateInput.value;
    if (!isValidISO(date)) return errorSlot.replaceChildren(formError(t('form.date')));
    const amount = Number(amountInput.value);
    if (!Number.isFinite(amount) || amount < 0) return errorSlot.replaceChildren(formError(t('form.number')));

    treatment.costs = treatment.costs || [];
    treatment.costs.push(createCost({
      date,
      kind: kindSel.value,
      amountCents: Math.round(amount * 100),
      notes: notesInput.value.trim(),
    }));
    persist(patient);
    update('cost-added');
    close();
    toast(t('costs.saved'), { tone: 'ok' });
  });

  const { close } = openDialog({
    title: t('costs.new'),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('app.save'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

/** Costos del tractament: preus de plomes + despeses + total. */
function costsCard(patient, treatment) {
  const totals = treatmentCosts(treatment);
  const penPrices = visiblePens(treatment).filter((p) => p.priceCents != null);
  const rows = (treatment.costs || [])
    .filter((c) => !c.deletedAt)
    .sort((a, b) => cmpDates(b.date, a.date));

  const list = rows.length
    ? h('ul', { class: 'records' },
        rows.map((c) => h('li', { class: 'record' },
          h('div', { class: 'record__head' },
            h('span', { class: 'record__date' }, fmtShort(c.date)),
            h('strong', {}, formatEur(c.amountCents))),
          h('p', { class: 'muted small' },
            `${t(`costs.kind${c.kind === 'pen' ? 'Pen' : c.kind === 'admin' ? 'Admin' : 'Other'}`)}${c.notes ? ` · ${c.notes}` : ''}`))))
    : h('p', { class: 'muted small' }, t('costs.empty'));

  return sectionCard(
    t('costs.title'),
    h('div', { class: 'costs__totals' },
      h('span', {}, `${t('costs.pens')}: `, h('strong', {}, formatEur(totals.penCents))),
      h('span', {}, `${t('costs.others')}: `, h('strong', {}, formatEur(totals.otherCents))),
      h('span', { class: 'costs__total' }, `${t('costs.total')}: `, h('strong', {}, formatEur(totals.totalCents)))),
    penPrices.length
      ? h('ul', { class: 'kv small' },
          penPrices.map((pen) => h('li', {},
            `${t('app.pen')} #${penNumber(treatment.pens, pen.id)} · ${formatEur(pen.priceCents)}`)))
      : h('p', { class: 'muted small' }, t('costs.noPenPrice')),
    list,
    h('div', { class: 'row' },
      btn(t('costs.new'), { variant: 'primary', icon: 'plus', onClick: () => costDialog(patient, treatment) }))
  );
}

export function renderTreatments(patient) {
  const active = selectedTreatmentOf(patient);
  const treatments = visibleTreatments(patient).sort((a, b) => cmpDates(b.startDate, a.startDate));

  return h(
    'div',
    { class: 'view view--treatment' },
    h('div', { class: 'section-head' },
      h('h2', { class: 'section-head__title' }, t('nav.treatment')),
      btn(t('treatment.new'), { variant: 'primary', icon: 'plus', onClick: () => treatmentFormDialog(patient) })),
    treatments.length
      ? h('div', { class: 'stack' },
          treatments.map((tr) => treatmentCard(patient, tr)),
          active ? costsCard(patient, active) : null)
      : emptyState(t('treatment.empty'), t('treatment.emptyHint'),
          btn(t('treatment.new'), { variant: 'primary', icon: 'plus', onClick: () => treatmentFormDialog(patient) })),
    active
      ? null
      : h('p', { class: 'muted warn' }, icon('alert'), ' ', t('alerts.no-active-treatment'))
  );
}
