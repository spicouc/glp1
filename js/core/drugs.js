// Catàleg de fàrmacs i conversions clics <-> mg.
//
// Regla de disseny: NO s'assumeix que totes les plomes tenen X clics.
// La conversió queda vinculada a medicament + presentació concreta + model de
// ploma, i cada conversió porta {sourceType, verified, warning, lastReviewed}.
//
// Aquest fitxer és DADES, no codi: afegir un medicament nou no toca el model
// de dades ni la UI (la UI deriva els selectors del catàleg).

/**
 * Versió del catàleg base. Quan canvia (s'afegeix un camp o un fàrmac), el
 * catàleg guardat al servidor amb una versió antiga es descarta i es fa servir
 * el base: d'aquesta manera les edicions de l'administració guanyen mentre
 * duren, però una actualització de l'app no deixa camps nous sense aplicar.
 * En desar des de l'administració es segella aquesta versió.
 */
export const CATALOG_VERSION = 3; // v3: Ozempic amb clics per defecte (taules per presentació)

/**
 * Dies de validesa d'una ploma un cop OBERTA (`openShelfLifeDays` del catàleg).
 *
 * El catàleg NO en porta valors per defecte: són dades de la fitxa tècnica
 * (RCP) i han d'entrar-les des d'Administració → Fàrmacs amb la seva font.
 * `null` = desconegut → l'app no inventa cap caducitat calculada.
 */
export function openShelfLifeFor(drug) {
  const days = Number(drug && drug.openShelfLifeDays);
  return Number.isFinite(days) && days > 0 ? Math.round(days) : null;
}

export const CLICK_MODES = {
  THEORETICAL: 'theoretical',
  PEN_SPECIFIC: 'pen-specific',
  UNSUPPORTED: 'unsupported',
  FIXED_DOSE: 'fixed-dose',
};

const THEORETICAL_WARNING =
  'Equivalència teòrica no validada pel fabricant. La KwikPen es comercialitza com a ploma de quatre dosis fixes, no com a dosificador per recompte de clics.';

export const DRUGS = {
  mounjaro: {
    id: 'mounjaro',
    catalogVersion: CATALOG_VERSION,
    label: 'Mounjaro',
    activeSubstance: 'tirzepatida',
    frequency: 'weekly',
    standardDosesMg: [2.5, 5, 7.5, 10, 12.5, 15],
    // Presets intermedis que NO són dosi estàndard (count.click: 3,75 · 6,25 · 8,75)
    intermediateDosesMg: [3.75, 6.25, 8.75],
    penStrengthsMg: [2.5, 5, 7.5, 10, 12.5, 15],
    dosesPerPen: 4,
    fullDoseVolumeMl: 0.6,
    capacityUnit: 'clicks',
    defaultInitialCapacity: 240,
    clickMode: CLICK_MODES.THEORETICAL,
    fullDoseClicks: 60,
    // 60 clics = dosi nominal de la ploma → mgPerClick = presentació / 60
    // (ploma de 15 mg: 2,5 mg = 10 clics, 5 mg = 20, 7,5 mg = 30)
    clickNote:
      'Taules orientatives: 60 clics corresponen a la dosi completa de la ploma. En una ploma de 15 mg, 2,5 mg = 10 clics, 5 mg = 20 clics i 7,5 mg = 30 clics. La KwikPen es comercialitza com a ploma de quatre dosis fixes.',
    escalation:
      '2,5 mg × 4 setmanes → 5 mg; després increments de 2,5 mg, mantenint cada dosi almenys 4 setmanes. Màxim 15 mg/setmana.',
  },
  ozempic: {
    id: 'ozempic',
    catalogVersion: CATALOG_VERSION,
    label: 'Ozempic',
    activeSubstance: 'semaglutida',
    frequency: 'weekly',
    standardDosesMg: [0.25, 0.5, 1, 2],
    // Plomes FlexTouch: 0,25 i 0,5 (2 mg/1,5 mL), 0,5 (2 mg/3 mL), 1 (4 mg/3 mL),
    // 2 (8 mg/3 mL). Totes de 4 dosis. Els clics NO són oficials (es compten
    // amb el selector de dosis), per això es queden en dosis tret que
    // l'usuari adjunti ell mateix la conversió.
    penStrengthsMg: [0.25, 0.5, 1, 2],
    intermediateDosesMg: [0.75, 1.5],
    capacityUnit: 'doses',
    defaultInitialCapacity: 4,
    dosesPerPen: 4,
    // Clics PER DEFECTE, com a qualsevol altra ploma: taules per presentació
    // (FlexTouch) amb l'avís del fabricant — la dosi es marca amb el selector
    // de dosis i els clics són orientatius/acordats amb el metge.
    clickMode: CLICK_MODES.PEN_SPECIFIC,
    noClickNote:
      'Instruccions del fabricant: no seleccionar la dosi comptant els clics. En alguns entorns clínics es fan servir taules no oficials.',
    escalation:
      '0,25 mg durant 4 setmanes; després 0,5 mg. Passar a 1 mg després d\'almenys 4 setmanes i a 2 mg després d\'almenys 4 setmanes més.',
  },
  wegovy: {
    id: 'wegovy',
    catalogVersion: CATALOG_VERSION,
    label: 'Wegovy',
    activeSubstance: 'semaglutida',
    frequency: 'weekly',
    standardDosesMg: [0.25, 0.5, 1, 1.7, 2.4],
    optionalMaintenanceMg: [7.2],
    penStrengthsMg: [0.25, 0.5, 1, 1.7, 2.4],
    capacityUnit: 'doses',
    defaultInitialCapacity: 4,
    dosesPerPen: 4,
    clickMode: CLICK_MODES.PEN_SPECIFIC,
    noClickNote:
      'Les instruccions oficials desaconsellen comptar clics; les taules per a FlexTouch són orientatives i depenen de la presentació exacta.',
    escalation:
      '0,25 → 0,5 → 1 → 1,7 → 2,4 mg/setmana (1–4, 5–8, 9–12, 13–16 i des de la 17). Opcionalment 7,2 mg en adults després de 4 setmanes a 2,4 mg.',
  },
  saxenda: {
    id: 'saxenda',
    catalogVersion: CATALOG_VERSION,
    label: 'Saxenda',
    activeSubstance: 'liraglutida',
    frequency: 'daily',
    standardDosesMg: [0.6, 1.2, 1.8, 2.4, 3],
    penStrengthsMg: null,
    capacityUnit: 'doses',
    defaultInitialCapacity: 30,
    dosesPerPen: 30,
    clickMode: CLICK_MODES.UNSUPPORTED,
    noClickNote:
      'Instruccions: no comptar els clics perquè el so pot variar. La dosi es mesura en mil·ligrams.',
    escalation: '0,6 → 1,2 → 1,8 → 2,4 → 3 mg/dia, amb almenys una setmana per esglaó. Manteniment: 3 mg/dia.',
  },
  victoza: {
    id: 'victoza',
    catalogVersion: CATALOG_VERSION,
    label: 'Victoza',
    activeSubstance: 'liraglutida',
    frequency: 'daily',
    standardDosesMg: [0.6, 1.2, 1.8],
    penStrengthsMg: null,
    capacityUnit: 'doses',
    defaultInitialCapacity: 30,
    dosesPerPen: 30,
    clickMode: CLICK_MODES.UNSUPPORTED,
    noClickNote:
      'El mecanisme de la ploma té 10 clics entre dosis marcades (0,6 mg). Per a dosis intermèdies (0,3 · 0,9 · 1,5 mg) s\'hi arriba amb 5 clics.',
    clickTables: [
      {
        presentationMg: null, // relació mecànica comuna a les plomes de Victoza
        label: 'Esglaons de la ploma (10 clics = 0,6 mg)',
        mgPerClick: 0.06,
        rows: [
          { mg: 0.3, clicks: 5 },
          { mg: 0.6, clicks: 10 },
          { mg: 0.9, clicks: 15 },
          { mg: 1.2, clicks: 20 },
          { mg: 1.5, clicks: 25 },
          { mg: 1.8, clicks: 30 },
        ],
        sourceType: 'third-party',
        verified: false,
        warning:
          'Relació derivada dels esglaons marcats de la ploma (10 clics = 0,6 mg). Orientativa, no oficial.',
      },
    ],
    escalation: '0,6 → 1,2 → 1,8 mg/dia amb almenys una setmana abans d\'incrementar.',
  },
  trulicity: {
    id: 'trulicity',
    catalogVersion: CATALOG_VERSION,
    label: 'Trulicity',
    activeSubstance: 'dulaglutida',
    frequency: 'weekly',
    standardDosesMg: [0.75, 1.5, 3, 4.5],
    // Cada ploma Trulicity és d'una dosi fixa: es pot triar quina s'usa.
    penStrengthsMg: [0.75, 1.5, 3, 4.5],
    capacityUnit: 'doses',
    defaultInitialCapacity: 4,
    dosesPerPen: 4,
    clickMode: CLICK_MODES.FIXED_DOSE,
    noClickNote:
      'Ploma monodosi carregada amb la dosi completa (0,75 · 1,5 · 3 · 4,5 mg): no té selector de dosi, no es pot ajustar ni comptar clics.',
    escalation: '1,5 → 3 → 4,5 mg amb almenys 4 setmanes entre esglaons.',
  },
};

/**
 * Taules orientatives per presentació, vinculades a medicament + presentació
 * + model de ploma. S'apliquen només quan el fàrmac és `pen-specific`.
 */
export const CLICK_CONVERSIONS = [
  {
    drugId: 'wegovy',
    presentationMg: 0.25,
    sourceType: 'third-party',
    verified: false,
    lastReviewed: '2026-11-19',
    fullDoseClicks: 32,
    mgPerClick: 0.25 / 32,
    warning: 'Taula orientativa no oficial per a la ploma FlexTouch de 0,25 mg (32 clics per dosi completa).',
  },
  {
    drugId: 'wegovy',
    presentationMg: 1,
    sourceType: 'third-party',
    verified: false,
    lastReviewed: '2026-11-19',
    fullDoseClicks: 72,
    mgPerClick: 1 / 72,
    warning: 'Taula orientativa no oficial per a la ploma FlexTouch d\'1,0 mg (72 clics per dosi completa).',
  },
  {
    drugId: 'wegovy',
    presentationMg: 2.4,
    sourceType: 'third-party',
    verified: false,
    lastReviewed: '2026-11-19',
    fullDoseClicks: 75,
    mgPerClick: 2.4 / 75,
    warning:
      'Taula orientativa de tercers per a una FlexTouch de 3 ml (75 clics per a 2,4 mg). Especifica de presentació.',
  },
];

const OZEMPIC_CLICK_WARNING =
  'Instruccions del fabricant: la dosi es marca amb el selector de dosis, no comptant clics. ' +
  'Els clics d\'aquesta presentació són orientatius (mesurats sobre ploma real) i només s\'han d\'usar ' +
  'per a dosis acordades amb el metge prescriptor.';

/**
 * Taules d'Ozempic per presentació de ploma FlexTouch (totes de 4 dosis):
 *   0,25 i 0,5 mg → ploma de 2 mg/1,5 mL: dosi completa = 32 clics (0,5 mg)
 *                   → 0,25 mg = 16, 0,5 mg = 32 · capacitat 128 clics (2 mg)
 *   1 mg          → ploma de 4 mg/3 mL:   dosi completa = 72 clics
 *                   → 0,25 = 18, 0,5 = 36, 0,75 = 54, 1 = 72 · 288 clics (4 mg)
 *   2 mg          → ploma de 8 mg/3 mL:   dosi completa = 72 clics
 *                   → 0,25 = 9, 0,5 = 18, 1 = 36, 2 = 72 · 288 clics (8 mg)
 *
 * Font: comptatges publicats a count.click (volums i dosis per ploma, EPAR/EMA).
 */
for (const entry of [
  { presentationMg: 0.25, fullDoseClicks: 32, mgPerClick: 0.5 / 32 },
  { presentationMg: 0.5, fullDoseClicks: 32, mgPerClick: 0.5 / 32 },
  { presentationMg: 1, fullDoseClicks: 72, mgPerClick: 1 / 72 },
  { presentationMg: 2, fullDoseClicks: 72, mgPerClick: 2 / 72 },
]) {
  CLICK_CONVERSIONS.push({
    drugId: 'ozempic',
    sourceType: 'third-party',
    verified: false,
    lastReviewed: '2026-10-11',
    warning: OZEMPIC_CLICK_WARNING,
    ...entry,
  });
}

// Ordre de visualització: el del servidor si n'hi ha, després els base.
let ORDER = Object.keys(DRUGS);

export function drugList() {
  return ORDER.map((id) => DRUGS[id]).filter(Boolean);
}

/**
 * Aplica el catàleg editat per l'administració (des del servidor).
 * Els camps que no arriben (funcions com `mgPerClick`) es conserven del base.
 */
export function setDrugCatalog(list = []) {
  const ids = [];
  for (const d of list) {
    if (!d || !d.id) continue;
    ids.push(d.id);
    const base = DRUGS[d.id];
    if (base) {
      // Catàleg del servidor antic → es conserva el base (la versió nova guanya).
      const version = Number(d.catalogVersion ?? 0);
      if (Number.isFinite(version) && version < CATALOG_VERSION) continue;
      Object.assign(base, d);
    } else {
      DRUGS[d.id] = d; // fàrmac creat des de l'administració
    }
  }
  for (const id of Object.keys(DRUGS)) if (!ids.includes(id)) ids.push(id);
  ORDER = ids;
  return ids.length;
}

/** Versió JSON d'un fàrmac (sense funcions) per desar-la al servidor. */
export function serializeDrug(drug) {
  const out = {};
  for (const [k, v] of Object.entries(drug || {})) {
    if (typeof v === 'function') continue;
    out[k] = v;
  }
  return out;
}

export function getDrug(id) {
  return DRUGS[id] || null;
}

export function intervalDaysFor(drug) {
  if (!drug) return 7;
  return drug.frequency === 'daily' ? 1 : 7;
}

export function hasClickMode(drug) {
  if (!drug) return false;
  return (
    drug.clickMode === CLICK_MODES.THEORETICAL ||
    drug.clickMode === CLICK_MODES.PEN_SPECIFIC
  );
}

/**
 * Estat del mode clics per a una ploma concreta.
 * 'enabled' | 'enabled-manual' | 'needs-conversion' | 'unsupported' | 'fixed-dose'
 *
 *  - theoretical (Mounjaro): activat per defecte
 *  - pen-specific (Wegovy): activat quan existeix una conversió (registrada o adjuntada)
 *  - unsupported (Ozempic, Saxenda, Victoza): desactivat tret que l'usuari
 *    adjunti explícitament una conversió pròpia per a aquella ploma
 *  - fixed-dose (Trulicity): mai
 */
export function clickModeState(pen, drug) {
  if (!drug) return 'unsupported';
  if (drug.clickMode === CLICK_MODES.THEORETICAL) return 'enabled';
  if (drug.clickMode === CLICK_MODES.FIXED_DOSE) return 'fixed-dose';
  if (drug.clickMode === CLICK_MODES.PEN_SPECIFIC) {
    return resolveConversion(pen, drug) ? 'enabled' : 'needs-conversion';
  }
  return pen && pen.conversion ? 'enabled-manual' : 'unsupported';
}

/** Si el mode clics es pot fer servir en aquesta ploma (inclou el manual). */
export function clicksAvailable(pen, drug) {
  if (!pen) return false; // sense ploma no hi ha clics (issue #2)
  const state = clickModeState(pen, drug);
  return state === 'enabled' || state === 'enabled-manual';
}

/** Conversió aplicable a una ploma: manual (pen.conversion) > registrada > teòrica Mounjaro. */
export function resolveConversion(pen, drug) {
  if (pen && pen.conversion) return pen.conversion;
  if (!drug) return null;

  if (drug.clickMode === CLICK_MODES.THEORETICAL) {
    const strength = pen && pen.presentationMg ? pen.presentationMg : null;
    if (!strength) return null;
    const fullDoseClicks = drug.fullDoseClicks || 60;
    return {
      sourceType: 'theoretical',
      verified: false,
      warning: THEORETICAL_WARNING,
      lastReviewed: '2026-11-19',
      fullDoseClicks,
      mgPerClick: strength / fullDoseClicks,
      mgLabel: `${round(strength / fullDoseClicks, 4)} mg per clic`,
    };
  }

  // Taules orientatives registrades: només per als fàrmacs pen-specific
  if (drug.clickMode === CLICK_MODES.PEN_SPECIFIC) {
    const registered = CLICK_CONVERSIONS.find(
      (c) => (!c.drugId || c.drugId === drug.id) &&
        (!c.presentationMg || !pen || c.presentationMg === pen.presentationMg)
    );
    if (registered) return registered;
  }
  return null;
}

export function mgForClicks(clicks, conversion) {
  if (!conversion) return null;
  return round(Number(clicks) * conversion.mgPerClick, 4);
}

export function clicksForDose(mg, conversion) {
  if (!conversion) return null;
  return Math.round(Number(mg) / conversion.mgPerClick);
}

/**
 * Clics d'una dosi completa d'UNA ploma concreta (null si es desconeix).
 *
 * És la peça que sosté el sistema: quan es coneix, la capacitat de la ploma
 * es desa en Clics (240, 128, 288, 300…) i la vista en dosis es deriva.
 *
 * Fonts, per ordre:
 *  1. valor ja desat a la ploma (`pen.clicksPerDose`)
 *  2. taules per presentació (`CLICK_CONVERSIONS` / `drug.clickTables`)
 *  3. conversió manual de la ploma (`mgPerClick`) amb la presentació
 *  4. `fullDoseClicks` del fàrmac (Mounjaro: 60)
 */
export function clicksPerDoseFor(drug, presentationMg, pen = null) {
  const saved = Number(pen && pen.clicksPerDose);
  if (Number.isFinite(saved) && saved > 0) return Math.round(saved);
  if (!drug) return null;

  const pres = Number(presentationMg);
  const hasPres = Number.isFinite(pres) && pres > 0;
  const mode = drug.clickMode;

  // 1) Conversió manual adjuntada a la ploma: guanya sobre la taula del
  //    catàleg (per exemple, una altra variante de ploma amb altres clics).
  const manual = Number(pen && pen.conversion && pen.conversion.mgPerClick);
  if (Number.isFinite(manual) && manual > 0 && hasPres) return Math.round(pres / manual);

  // 2) Taules registrades del catàleg (pen-specific: Wegovy, Ozempic): formen
  //    part del catàleg, per tant ja estan "acceptades" per a aquest fàrmac.
  if (mode === CLICK_MODES.PEN_SPECIFIC && hasPres) {
    const table = CLICK_CONVERSIONS.find(
      (c) => (!c.drugId || c.drugId === drug.id) && Number(c.presentationMg) === pres
    );
    if (table && Number(table.fullDoseClicks) > 0) return Number(table.fullDoseClicks);

    const local = (drug.clickTables || []).find((x) => Number(x.presentationMg) === pres);
    if (local && Array.isArray(local.rows)) {
      const row = local.rows.find((r) => Number(r.mg) === pres);
      if (row && Number(row.clicks) > 0) return Number(row.clicks);
    }
  }

  // 3) Teòriques (Mounjaro): 60 clics = dosi nominal de la ploma.
  if (mode === CLICK_MODES.THEORETICAL && Number(drug.fullDoseClicks) > 0) {
    return Number(drug.fullDoseClicks);
  }
  return null;
}

/** Dosis que conté la ploma (nominals) segons el fàrmac. */
export function dosesPerPenFor(drug, pen = null) {
  const saved = Number(pen && pen.dosesPerPen);
  if (Number.isFinite(saved) && saved > 0) return Math.round(saved);
  if (drug && Number(drug.dosesPerPen) > 0) return Number(drug.dosesPerPen);
  return null;
}

/** Dosis estàndard que aquesta ploma concreta pot administrar. */
export function dosesForPen(drug) {
  return drug ? [...drug.standardDosesMg] : [];
}

export function round(n, digits = 4) {
  const f = 10 ** digits;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

/** Text d'avís de seguretat associat a una conversió que no és oficial. */
export function theoreticalDisclaimer(drug, conversion) {
  if (!conversion || conversion.sourceType === 'official') return null;
  return conversion.warning || THEORETICAL_WARNING;
}
