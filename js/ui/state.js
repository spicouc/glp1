// Estat de sessió. Cap càlcul de negoci viu aquí: la UI llegeix de `core/calc`.

import { repo } from '../data/localRepository.js';
import { scheduleSync } from '../data/sync.js';
import { todayISO } from '../core/dates.js';
import { activeTreatment, visibleTreatments } from '../core/calc.js';

export const state = {
  route: { name: 'patients', params: {} },
  patients: [],
  /** recordatori d'última exportació */
  lastExportAt: null,
  calendar: new Map(), // patientId -> { month, quick: {penId, mode, value} }
  /** Selector global de tractament: patientId -> treatmentId (per defecte l'actiu) */
  selectedTreatment: new Map(),
  loading: true,
  error: null,
};

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function update(reason = 'state') {
  for (const fn of listeners) fn(reason);
}

export function loadPatients() {
  state.patients = repo.list();
  return state.patients;
}

export function findPatient(id) {
  return state.patients.find((p) => p.id === id) || null;
}

export function persist(patient) {
  const saved = repo.save(patient);
  loadPatients();
  scheduleSync(); // puja al servidor (debounce); si no hi és, es queda la còpia local
  return saved;
}

export function removePatient(id) {
  const ok = repo.remove(id);
  loadPatients();
  scheduleSync();
  return ok;
}

/**
 * Tractament que es VEU ara per a aquest pacient: el triat explícitament o, per
 * defecte, l'actiu. Si el triat ja no existeix (esborrat), torna a l'actiu.
 * És una decisió de VISTA: la lògica de negoci continua usant `activeTreatment`.
 */
export function selectedTreatmentOf(patient) {
  if (!patient) return null;
  const wanted = state.selectedTreatment.get(patient.id);
  if (wanted) {
    const found = visibleTreatments(patient).find((t) => t.id === wanted);
    if (found) return found;
  }
  return activeTreatment(patient);
}

export function setSelectedTreatment(patientId, treatmentId) {
  if (treatmentId) state.selectedTreatment.set(patientId, treatmentId);
  else state.selectedTreatment.delete(patientId);
}

export function calendarState(patientId) {
  if (!state.calendar.has(patientId)) {
    state.calendar.set(patientId, { month: todayISO(), quick: { penId: null, mode: 'standard', value: null } });
  }
  return state.calendar.get(patientId);
}

export function repoInfo() {
  return repo.usage();
}

/* --- Avisos "primera vegada" ------------------------------------------- */
// Persistits a localStorage: només es demana un cop EVER (també després de
// recarregar la pàgina o de reborrar tractaments), per no obrir diàlegs
// sorpresa en cada visita.
const PROMPT_KEY = 'glp1.prompts.v1';

function loadPrompts() {
  try {
    if (typeof localStorage === 'undefined') return new Set();
    const raw = localStorage.getItem(PROMPT_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

const prompts = loadPrompts();

function persistPrompts() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PROMPT_KEY, JSON.stringify([...prompts]));
    }
  } catch {
    /* sense permís d'emmagatzematge: els avisos només duraran la sessió */
  }
}

/**
 * Executa `fn` només la primera vegada que es demana `key` (per pacient o
 * tractament). Serveix per obrir automàticament el diàleg de tractament/ploma
 * en entrar la primera vegada, sense molestar després si l'usuari el tanca.
 */
export function promptOnce(key, fn) {
  if (prompts.has(key)) return false;
  prompts.add(key);
  persistPrompts();
  fn();
  return true;
}

export function promptShown(key) {
  return prompts.has(key);
}
