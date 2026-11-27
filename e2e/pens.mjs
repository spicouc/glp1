// E2E: sistema de plomes.
//
//   - la ploma neix en Clics (capacitat real) amb la vista en dosis derivada
//   - metadades de la ploma: capacitat/saldo en clics i dosis, mg per clic,
//     quantes dosis completes queden i quantes hi caben a la dosi actual
//   - «ploma ja començada» (consum prèvi) i el seu efecte al saldo
//   - esborrar ploma: moure les dades a una altra ploma / esborrar-les, tomba
//     restaurable i numeració congelada (#N)
//   - presets de dosi (count.click) i avís de dosi partida en injeccions
//
//   npm run e2e   (el runner fa snapshot i restaura el servidor al final)

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { login, resetServer, BASE } from './helpers.mjs';

const EXE = process.env.CHROME_PATH || '/home/vinegart/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const SHOTS = process.env.SHOTS_DIR || '/tmp/opencode/glp1-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const problems = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const txt = m.text();
  if (m.type() === 'error') problems.push(`console.error: ${txt}`);
  if (m.type() === 'warning' && txt.includes('[i18n]')) problems.push(`i18n: ${txt}`);
});

let step = 'inici';
const at = (v) => { step = v; };
const shot = async (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const clickText = async (text, opts = {}) => {
  const loc = page.getByRole('button', { name: text, exact: opts.exact ?? false }).first();
  await loc.waitFor({ state: 'visible', timeout: 5000 });
  await loc.click();
};
const inDialog = (sel) => page.locator(`.dialog ${sel}`);
const dialogClick = async (text) => {
  const loc = page.locator('.dialog').getByRole('button', { name: text, exact: true }).first();
  await loc.waitFor({ state: 'visible', timeout: 5000 });
  await loc.click();
};
/** Obre la paperera fins que la fitxa esborrada sigui visible (tolera
 *  re-renderitzats de fons). */
const openTrash = async () => {
  for (let i = 0; i < 4; i += 1) {
    if (await page.locator('.pen--deleted').first().isVisible().catch(() => false)) return;
    await page.locator('.penlist > summary').click();
    await page.waitForTimeout(250);
  }
  await page.waitForSelector('.pen--deleted', { timeout: 5000 });
};

/** Canvia de pestanya i espera la vista (torna a clicar si cal). */
const gotoTab = async (name, viewSel) => {
  for (let i = 0; i < 4; i += 1) {
    await page.locator('.tab', { hasText: name }).click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);
    if (await page.locator(viewSel).first().isVisible().catch(() => false)) return;
  }
  await page.waitForSelector(viewSel, { timeout: 15000 });
};

const hasDialogButton = async (text) =>
  (await page.locator('.dialog').getByRole('button', { name: text, exact: false }).count()) > 0;

try {
  await resetServer();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await login(page);

  // --- pacient ---
    at('pacient');
  await clickText('Nou pacient');
  await inDialog('input[name="code"]').fill('P-001');
  await inDialog('input[name="name"]').fill('Plomes');
  await dialogClick('Desa');
  await page.waitForSelector('.list-card');
  await clickText('Entra a la fitxa');
  await page.waitForSelector('.tabs');

  // --- tractament: la ploma neix
    // en Clics amb la vista en dosis ------------
    at('tractament');
  await page.waitForSelector('.dialog select[name="drugId"]', { timeout: 8000 });
  await inDialog('select[name="drugId"]').selectOption('mounjaro');
  await inDialog('input[name="startDate"]').fill('2026-11-01');
  await page.locator('.dialog .dosechip').filter({ hasText: /^2,5 mg/ }).first().click();
  await inDialog('select[name="presentationMg"]').selectOption('10');
  await page.waitForTimeout(200);
  const penHint = (await page.locator('.dialog .stack--tight .field__hint').first().innerText()).replace(/\n/g, ' ');
  if (!/10 mg · 240 clics = 4 dosis de 60 clics/.test(penHint)) {
    problems.push('La pista de la ploma no mostra la capacitat en clics i dosis: ' + penHint);
  } else {
    log('✓ pista de la ploma nova en clics i dosis:', penHint.slice(0, 110));
  }
  await dialogClick('Desa');
  // Verifiquem que el diàleg es tanca I que el tractament queda desat: un
  // `waitForSelector('.tabs')` pur falsaria l'èxit (les pestanyes ja existeixen).
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 4000 }).catch(() => {});
  if (await page.locator('.dialog').count()) {
    problems.push('El diàleg de tractament no s\'ha tancat: ' +
      (await page.locator('.dialog').innerText()).replace(/\n/g, ' | ').slice(0, 220));
  }
  const trtSaved = await page.evaluate(() => {
    const raw = localStorage.getItem('glp1.db.v1');
    const db = raw ? JSON.parse(raw) : null;
    const p = db && db.patients && db.patients[0];
    return p ? (p.treatments || []).length : -1;
  });
  if (trtSaved < 1) problems.push('El tractament NO s\'ha desat (localStorage=' + trtSaved + ')');
  await page.waitForSelector('.tabs');
  log('✓ tractament creat');

  // --- fitxa de la ploma ---
    at('fitxa ploma');
  await gotoTab('Plomes', '.view--pens');
  const meta1 = (await page.locator('.pen--active .pen__meta').innerText().catch(() => '')).replace(/\n/g, ' | ');
  log('  metadades:', meta1);
  const need = [
    [/Capacitat: 240 clics = 4 dosis de 60 clics/, 'capacitat en clics i dosis'],
    [/0,167 mg per clic/, 'mg per clic'],
    [/Saldo: 240 clics = 4 dosis/, 'saldo en les dues unitats'],
    [/Queden 4 dosis completes/, 'dosis completes restants'],
    [/A la dosi actual \(2,5 mg\) hi caben 16 dosis/, 'dosis que hi caben a la dosi actual'],
  ];
  for (const [re, label] of need) {
    if (!re.test(meta1)) problems.push(`La fitxa no mostra ${label}: ${meta1}`);
  }
  const title1 = await page.locator('.pen--active .pen__title').innerText();
  if (!/#1/.test(title1)) problems.push('La ploma activa no és la #1: ' + title1);
  await shot('50-ploma-fitxa');

  // --- ploma ja començada ---
    at('ploma ja començada');
  await page.locator('.pen--active').getByRole('button', { name: 'Edita', exact: true }).click();
  await page.waitForSelector('.dialog input[name="startUsed"]');
  await inDialog('input[name="startUsed"]').fill('60');
  await inDialog('input[name="startUsed"]').dispatchEvent('input');
  await page.waitForTimeout(150);
  const preview = (await inDialog('.pen__preview').innerText()).replace(/\n/g, ' ');
  log('  vista prèvia:', preview);
  if (!/Saldo resultant: 180 clics/.test(preview)) problems.push('La vista prèvia no mostra el saldo amb consum prèvi: ' + preview);
  else log('✓ ploma ja començada → la vista prèvia ja calcula 180 clics de saldo');
  await dialogClick('Desa');
  await page.waitForTimeout(300);
  const meta2 = (await page.locator('.pen--active .pen__meta').innerText().catch(() => '')).replace(/\n/g, ' | ');
  if (!/Saldo: 180 clics = 3 dosis/.test(meta2)) problems.push('El saldo no descompta el consum prèvi: ' + meta2);
  else log('✓ saldo inicial 180 clics (240 − 60 de ploma ja començada)');
  if (!/Ploma ja començada: 60/.test(meta2)) problems.push('No es menciona la ploma ja començada: ' + meta2);
  await shot('51-ploma-comencada');

  // --- registres reals (mode clics, 15 clics) ---
    at('registres ploma #1');
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  await page.locator('.segmented__btn', { hasText: 'Clics' }).first().click();
  await page.locator('input[aria-label="Valor"]').fill('15');
  for (const d of ['1', '8', '15']) {
    await page.locator(`.day[aria-label^="${d} de novembre de 2026"]`).click();
    await page.waitForTimeout(150);
  }
  log('✓ 3 administracions registrades a la ploma #1');

  // --- nova ploma (#2) ---
    at('nova ploma #2');
  await gotoTab('Plomes', '.view--pens');
  await clickText('Nova ploma');
  await inDialog('select[name="presentationMg"]').selectOption('5');
  await page.waitForTimeout(150);
  await dialogClick('Desa');
  // Esperem el tancament real del diàleg (el `.pen--active` anterior ja existeix
  // i un `waitForSelector` ingenu tornaria abans de re-renderitzar).
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  if (await page.locator('.dialog').count()) {
    problems.push('El diàleg de nova ploma no s\'ha tancat: ' +
      (await page.locator('.dialog').innerText()).replace(/\n/g, ' | ').slice(0, 200));
  }
  await page.waitForTimeout(200);
  const title2 = await page.locator('.pen--active .pen__title').innerText();
  if (!/#2/.test(title2)) problems.push('La ploma nova no és la #2: ' + title2);
  else log('✓ ploma #2 creada (la numeració segueix #1, #2…)');
  const card1Now = await page.locator('.view--pens .pen').filter({ hasText: '#1' }).first().innerText().catch(() => '');
  if (!/#1/.test(card1Now)) problems.push('La ploma anterior ha perdut el seu número: ' + card1Now.replace(/\n/g, ' '));
  await shot('52-dues-plomes');

  // --- registre a la ploma #2
    // i esborrat amb "moure les dades" -------------
    at('registres ploma #2');
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  await page.locator('input[aria-label="Valor"]').fill('15');
  for (const d of ['22', '25']) {
    await page.locator(`.day[aria-label^="${d} de novembre de 2026"]`).click();
    await page.waitForTimeout(150);
  }
  log('✓ 2 administracions registrades a la ploma #2');

  await gotoTab('Plomes', '.view--pens');
  await page.locator('.pen--active').getByRole('button', { name: 'Esborra', exact: true }).click();
  await page.waitForSelector('.dialog');
  const delTxt = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
  log('  diàleg d\'esborrat:', delTxt.slice(0, 150));
  if (!/2 administracions/.test(delTxt)) problems.push('El diàleg no recompta les administracions de la ploma: ' + delTxt);
  if (!/Ploma de destí/.test(delTxt)) problems.push('El diàleg no ofereix triar ploma de destí: ' + delTxt);
  const targetLabel = await inDialog('select[name="target"] option').first().innerText();
  if (!/#1/.test(targetLabel)) problems.push('La ploma de destí per defecte no és la #1: ' + targetLabel);
  else log('✓ destí per defecte (més proper en el temps):', targetLabel);
  await shot('53-esborrar-ploma');
  await dialogClick('Mou les dades i esborra');
  await page.waitForTimeout(400);

  const pensAfter = (await page.locator('.view--pens').innerText()).replace(/\n/g, ' | ');
  if (/Paperera de plomes \(1\)/.test(pensAfter)) log('✓ ploma #2 a la paperera');
  else problems.push('La ploma #2 no apareix a la paperera: ' + pensAfter.slice(0, 200));
  if (!/#1/.test(pensAfter)) problems.push('La ploma #1 ha desaparegut o ha canviat de número');

  // obre la paperera i comprova que es pot restaurar
  await openTrash();
  const deletedTxt = (await page.locator('.pen--deleted').innerText()).replace(/\n/g, ' ');
  if (!/#2/.test(deletedTxt)) problems.push('La ploma esborrada no conserva el número #2: ' + deletedTxt);
  if (!/Esborrada/.test(deletedTxt)) problems.push('La ploma esborrada no està etiquetada com a tal: ' + deletedTxt);
  log('✓ paperera:', deletedTxt.slice(0, 110));

  // les dades mogudes s'han de veure a la ploma #1
  await page.locator('.penlist > summary').click(); // tanca
  await page.waitForTimeout(150);
  const card1 = (await page.locator('.view--pens .pen').filter({ hasText: '#1' }).first().innerText()).replace(/\n/g, ' | ');
  log('  ploma #1 després de moure-hi les dades:', card1.slice(0, 220));
  if (!/Saldo: 105 clics/.test(card1)) {
    problems.push('Saldo inesperat a la ploma #1 després de moure-hi les dades (s\'esperava 105): ' + card1.slice(0, 220));
  } else {
    log('✓ saldo de la ploma #1 després de moure-hi les dades: 105 clics (240 − 60 prèvi − 45 − 30)');
  }
  await shot('54-despres-moure');

  // --- restaurar ---
    at('restaurar');
  await openTrash();
  await page.locator('.pen--deleted').getByRole('button', { name: 'Restaura', exact: true }).click();
  await page.waitForTimeout(400);
  const afterRestore = (await page.locator('.view--pens').innerText()).replace(/\n/g, ' ');
  if (/Paperera de plomes/.test(afterRestore)) problems.push('La paperera continua després de restaurar');
  else if (!/#2/.test(afterRestore)) problems.push('La ploma restaurada no torna a aparèixer: ' + afterRestore.slice(0, 200));
  else log('✓ ploma #2 restaurada (torna a l\'històric amb el seu número)');
  await shot('55-ploma-restaurada');

  // --- presets de dosi + dosi partida (mode Pla) ---
    at('presets');
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Pla', exact: true }).click();
  const planner = page.locator('.card', { hasText: 'Planificació per plomes' });
  await planner.waitFor({ timeout: 10000 });
  await planner.getByRole('button', { name: /Genera el pla|Torna a generar/ }).waitFor({ timeout: 12000 });
  log('✓ mode Pla (la proposta estàndard automàtica funciona)');

  const presetsTxt = (await planner.locator('.presets').innerText().catch(() => '')).replace(/\n/g, ' ');
  log('  presets:', presetsTxt);
  if (!/3,75 mg/.test(presetsTxt) || !/6,25 mg/.test(presetsTxt)) {
    problems.push('No es veuen els presets intermedis de count.click: ' + presetsTxt);
  } else {
    log('✓ presets ràpids visibles (count.click)');
  }

  // dosi partida: 15 mg en ploma de 10 mg = 90 clics → dues injeccions
  await planner.locator('.dosechip').filter({ hasText: /^15 mg/ }).first().click();
  await page.waitForTimeout(200);
  const splitHint = (await planner.locator('.field__hint.warn').first().innerText().catch(() => '')).replace(/\n/g, ' ');
  if (!/2 injeccions/.test(splitHint) || !/90 clics/.test(splitHint)) {
    problems.push('No apareix l\'avís de dosi partida: ' + splitHint);
  } else {
    log('✓ avís de dosi partida:', splitHint.slice(0, 130));
  }
  await shot('56-presets-i-dosi-partida');

  // tria un preset → s'aplica i l'equivalència es recalcula
  await planner.locator('.dosechip--preset').filter({ hasText: '6,25 mg' }).first().click();
  await page.waitForTimeout(250);
  const selectedPreset = await planner.locator('.dosechip--preset.is-selected').first().innerText().catch(() => '');
  if (!/6,25 mg/.test(selectedPreset)) problems.push('El preset triat no queda seleccionat: ' + selectedPreset);
  else log('✓ preset 6,25 mg triat correctament');
  const eqAfter = (await planner.locator('.eqslot').first().innerText()).replace(/\n/g, ' ');
  if (!/38 clics/.test(eqAfter)) problems.push('L\'equivalència del preset no s\'ha recalculat: ' + eqAfter);
  else log('✓ equivalència recalculada:', eqAfter.slice(0, 90));

  // --- registre amb injeccions partides
    // → xip a la fitxa del dia -----------
    at('injeccions partides');
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Registre', exact: true }).click();
  await page.waitForSelector('.calgrid');
  await page.locator('.segmented__btn', { hasText: 'Clics' }).first().click();
  await page.locator('input[aria-label="Valor"]').fill('90');
  await page.locator('.day[aria-label^="26 de novembre de 2026"]').click();
  await page.waitForTimeout(400);
  await page.locator('.day[aria-label^="26 de novembre de 2026"]').click();
  await page.waitForSelector('.dialog');
  const dayTxt = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
  if (!/2 injeccions/.test(dayTxt)) problems.push('La fitxa del dia no indica les injeccions: ' + dayTxt.slice(0, 200));
  else log('✓ la fitxa del dia mostra el xip «2 injeccions»');
  if (!/90 clics/.test(dayTxt)) problems.push('La fitxa del dia no mostra els 90 clics: ' + dayTxt.slice(0, 200));
  await shot('57-dosi-partida-fitxa-dia');
  await page.locator('.dialog__header button').click();
  await page.waitForTimeout(250);

  at('tractament ozempic + tria de ploma');
  // --- Ozempic: es pot TRIAR quina ploma es fa servir -----------------------
  await gotoTab('Tractament', '.view--treatment');
  await page.getByRole('button', { name: 'Nou tractament', exact: true }).first().click();
  await page.waitForSelector('.dialog select[name="drugId"]', { timeout: 8000 });
  await inDialog('select[name="drugId"]').selectOption('ozempic');
  await page.waitForTimeout(300);

  const presOptions = await inDialog('select[name="presentationMg"] option').allInnerTexts();
  if (presOptions.length < 4) {
    problems.push('Ozempic no deixa triar la ploma (selector absent o incomplet): ' + JSON.stringify(presOptions));
  } else {
    log('✓ Ozempic: plomes per triar →', presOptions.join(' · '));
  }
  const hintOz = (await page.locator('.dialog .stack--tight .field__hint').first().innerText()).replace(/\n/g, ' ');
  if (!/128 clics = 4 dosis de 32 clics/.test(hintOz)) {
    problems.push('La pista de la ploma d\'Ozempic no mostra els clics per defecte: ' + hintOz);
  }
  else log('✓ pista de la ploma Ozempic:', hintOz.slice(0, 120));

  await inDialog('select[name="presentationMg"]').selectOption('1');
  await page.waitForTimeout(250);
  const eqOz = (await page.locator('.dialog .eq').first().innerText().catch(() => '')).replace(/\n/g, ' ');
  if (!/\d+ clics/.test(eqOz)) {
    problems.push('Ozempic no mostra els clics per defecte a l\'equivalència: ' + eqOz);
  } else {
    log('✓ clics per defecte a Ozempic (equivalència):', eqOz.slice(0, 90));
  }
  await dialogClick('Desa');
  await page.waitForSelector('.tabs');
  await shot('58-ozempic-tractament');

  // Plomes: ploma creada amb la presentació triada i capacitat en dosis
  await gotoTab('Plomes', '.view--pens');
  const ozCard = (await page.locator('.pen--active').innerText()).replace(/\n/g, ' | ');
  if (!/Ozempic · 1 mg/.test(ozCard)) problems.push('La ploma d\'Ozempic no mostra la presentació triada: ' + ozCard.slice(0, 220));
  else log('✓ ploma Ozempic amb la presentació TRIADA (1 mg)');
  if (!/CAPACITAT INICIAL[ |]+288 clics/.test(ozCard)) {
    problems.push('La ploma d\'Ozempic no té la capacitat en clics (288 = 4 × 72): ' + ozCard.slice(0, 240));
  } else {
    log('✓ ploma Ozempic en Clics com a la resta: 288 = 4 dosis de 72');
  }
  if (!/Capacitat: 288 clics = 4 dosis de 72 clics/.test(ozCard)) {
    problems.push('La fitxa d\'Ozempic no mostra la vista en clics i dosis: ' + ozCard.slice(0, 240));
  }

  // una segona ploma per poder-ne triar
  await clickText('Nova ploma');
  await inDialog('select[name="presentationMg"]').selectOption('0.5');
  await dialogClick('Desa');
  await page.waitForSelector('.pen--active');
  const ozCard2 = (await page.locator('.pen--active').innerText()).replace(/\n/g, ' | ');
  if (!/#2/.test(ozCard2) || !/0,5 mg/.test(ozCard2)) problems.push('La segona ploma d\'Ozempic no queda ben creada: ' + ozCard2.slice(0, 220));
  else log('✓ segona ploma d\'Ozempic creada (#2 · 0,5 mg)');
  await shot('59-ozempic-dues-plomes');

  // calendari: el selector de ploma llista les dues per triar
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  const clicksBtn = page.locator('.segmented__btn', { hasText: 'Clics' }).first();
  if (await clicksBtn.count()) {
    const enabled = await clicksBtn.isEnabled();
    if (!enabled) problems.push('A Ozempic el mode Clics està desactivat (hauria de funcionar com a la resta)');
    else log('✓ mode Clics habilitat per defecte a Ozempic');
  } else {
    problems.push('No es veu el selector de mode (Clics) al registre ràpid');
  }
  const quickPens = await page.locator('select[aria-label="Ploma activa"] option').allInnerTexts();
  log('  plomes al registre ràpid:', JSON.stringify(quickPens));
  if (quickPens.length < 2) {
    problems.push('El registre ràpid no deixa triar entre les plomes: ' + JSON.stringify(quickPens));
  } else if (!quickPens.some((o) => /#1/.test(o)) || !quickPens.some((o) => /#2/.test(o))) {
    problems.push('El selector no identifica les plomes pel seu número: ' + JSON.stringify(quickPens));
  } else {
    log('✓ es pot triar quina ploma fer servir (les dues apareixen amb el seu #)');
  }
  await shot('60-tria-de-ploma');

} catch (err) {
  problems.push(`pas «${step}» → ` + err.message.split('\n').slice(0, 3).join(' ⏎ '));
  await shot('99-error').catch(() => {});
  // Diagnòstic: què hi ha localment i què té el servidor (per detectar pèrdues)
  try {
    const local = await page.evaluate(() => {
      const raw = localStorage.getItem('glp1.db.v1');
      const db = raw ? JSON.parse(raw) : null;
      const p = db && db.patients && db.patients[0];
      return p
        ? { patients: db.patients.length, treatments: (p.treatments || []).length, pens: (p.treatments?.[0]?.pens || []).length, updatedAt: p.updatedAt }
        : { patients: db ? db.patients.length : -1 };
    });
    log('DIAG local:', JSON.stringify(local));
    const { apiToken } = await import('./helpers.mjs');
    const token = await apiToken();
    const r = await fetch(new URL('api/patients', BASE), { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    log('DIAG servidor:', JSON.stringify((data.patients || []).map((x) => ({ code: x.code, name: x.name, treatments: (x.treatments || []).length, updatedAt: x.updatedAt }))));
  } catch (e) {
    log('DIAG error:', e.message);
  }
}

await browser.close();

console.log('\n=== PROBLEMES ===');
if (!problems.length) {
  console.log('cap problema');
} else {
  for (const p of problems) console.log('• ' + p);
}
process.exit(problems.length ? 1 : 0);
