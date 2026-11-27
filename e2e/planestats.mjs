// E2E: estats de la proposta (ajornada · omesa · cancel·lada) i editor de fases.
//
//   - La fitxa del dia ofereix Ajorna / Omet / Cancel·la / Torna al pla.
//   - L'estat es veu a la casella del calendari i a la fitxa (amb el motiu i la
//     data original).
//   - Les fases tenen durada i data de fi, i el seu canvi es pot aplicar al pla
//     (sempre amb confirmació explícita; mai toca registres reals).
//
//   npm run e2e   (el runner arrenca la pila E2E aïllada)

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

const shot = async (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const ariaOf = (label) => page.locator(`.day[aria-label^="${label}"]`).getAttribute('aria-label');
const closeDialog = async () => {
  await page.locator('.dialog__header button').click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
};
const hasButton = async (re, exact = false) =>
  (await page.locator('.dialog').getByRole('button', { name: re, exact }).count()) > 0;
/** Espera (amb sondeig) que la casella d'una data mostri un text. */
const waitForAria = async (label, re, timeout = 6000) => {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    last = await ariaOf(label);
    if (re.test(last || '')) return last;
    await page.waitForTimeout(150);
  }
  return last;
};

let step = 'inici';
const at = (v) => { step = v; };

try {
  await resetServer();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await login(page);

  // --- pacient + tractament --------------------------------------------
  await page.getByRole('button', { name: 'Nou pacient' }).first().click();
  await page.locator('.dialog input[name="code"]').fill('P-001');
  await page.locator('.dialog input[name="name"]').fill('Estats');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.list-card');
  await page.getByRole('button', { name: 'Entra a la fitxa' }).first().click();
  await page.waitForSelector('.tabs');

  at('tractament');
  await page.waitForSelector('.dialog select[name="drugId"]', { timeout: 8000 });
  await page.locator('.dialog select[name="drugId"]').selectOption('mounjaro');
  await page.locator('.dialog input[name="startDate"]').fill('2026-11-01');
  await page.locator('.dialog .dosechip').filter({ hasText: /^2,5 mg/ }).first().click();
  await page.locator('.dialog select[name="presentationMg"]').selectOption('5');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.tabs');
  log('✓ tractament creat');

  at('proposta automàtica');
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Pla', exact: true }).click();
  await page.locator('.card', { hasText: 'Planificació per plomes' }).waitFor({ timeout: 10000 });
  await page.locator('.card').getByRole('button', { name: /Genera el pla|Torna a generar/ }).waitFor({ timeout: 12000 });
  const day08 = await ariaOf('8 de novembre de 2026');
  if (!/Dosi prevista/.test(day08 || '')) problems.push('El 08/11 no té proposta: ' + (day08 || '(cap)'));
  else log('✓ proposta automàtica al 08/11');

  // --- accions d'estat a la fitxa del dia --------------------------------
  at('accions estat');
  await page.locator('.day[aria-label^="8 de novembre de 2026"]').click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  for (const name of ['Ajorna', 'Omet', 'Cancel·la la dosi', 'Treu-la del pla', 'Registra aquesta dosi', 'Edita la dosi prevista']) {
    if (!(await hasButton(name, true))) problems.push(`La fitxa no ofereix «${name}»`);
  }
  log('✓ la fitxa ofereix ajornar / ometre / cancel·lar / treure');
  await shot('80-fitxa-estats');

  // --- ajornar ------------------------------------------------------------
  at('ajornar');
  await page.locator('.dialog').getByRole('button', { name: 'Ajorna', exact: true }).click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const postTitle = await page.locator('.dialog .dialog__title, .dialog__header h2').first().innerText().catch(() => '');
  if (!/Ajorna la dosi/.test(postTitle)) problems.push('El diàleg d\'ajornament no té el títol esperat: ' + postTitle);
  await page.locator('.dialog input[name="date"]').fill('2026-11-09');
  await page.locator('.dialog input[name="reason"]').fill('Vacances');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  const moved = await waitForAria('9 de novembre de 2026', /Ajornada/);
  if (!/Ajornada/.test(moved || '')) problems.push('La proposta ajornada no es veu al 09/11: ' + (moved || '(cap)'));
  else log('✓ ajornada → es mou al 09/11 i es veu a la casella');
  const gone = await ariaOf('8 de novembre de 2026');
  if (/Dosi prevista/.test(gone || '')) problems.push('La data original continua com a proposta activa: ' + gone);

  // la fitxa de la nova data explica què ha passat
  await page.locator('.day[aria-label^="9 de novembre de 2026"]').click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const sheetPost = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
  if (!/Ajornada/.test(sheetPost)) problems.push('La fitxa no mostra l\'estat Ajornada: ' + sheetPost.slice(0, 200));
  if (!/Data original: 08\/11\/2026/.test(sheetPost)) problems.push('No es conserva la data original: ' + sheetPost.slice(0, 200));
  if (!/Vacances/.test(sheetPost)) problems.push('No es mostra el motiu: ' + sheetPost.slice(0, 200));
  else log('✓ la fitxa mostra estat, data original i motiu');

  // --- ometre -------------------------------------------------------------
  at('ometre');
  await page.locator('.dialog').getByRole('button', { name: 'Omet', exact: true }).click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  await page.locator('.dialog input[name="reason"]').fill('Oblidada');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const omitted = await waitForAria('9 de novembre de 2026', /Omesa/);
  if (!/Omesa/.test(omitted || '')) problems.push('L\'omissió no es veu a la casella: ' + (omitted || '(cap)'));
  else log('✓ omesa → fora dels pendents, amb traça');
  await shot('81-omesa');

  // --- tornar al pla ------------------------------------------------------
  at('torna al pla');
  await page.locator('.day[aria-label^="9 de novembre de 2026"]').click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  if (!(await hasButton('Torna al pla', true))) problems.push('Una proposta omesa no es pot tornar al pla');
  await page.locator('.dialog').getByRole('button', { name: 'Torna al pla', exact: true }).click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const reopened = await waitForAria('9 de novembre de 2026', /^9 de novembre[^·]*· Dosi prevista(?!.*Omesa)/);
  if (!/Dosi prevista/.test(reopened || '') || /Omesa/.test(reopened || '')) {
    problems.push('No torna a estar al pla: ' + (reopened || '(cap)'));
  } else log('✓ Torna al pla → altra vegada proposta activa');

  // --- cancel·lar ---------------------------------------------------------
  at('cancel·lar');
  await page.locator('.day[aria-label^="9 de novembre de 2026"]').click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  await page.locator('.dialog').getByRole('button', { name: 'Cancel·la la dosi', exact: true }).click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  await page.locator('.dialog input[name="reason"]').fill('Canvi de tractament');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const cancelled = await waitForAria('9 de novembre de 2026', /Cancel·lada/);
  if (!/Cancel·lada/.test(cancelled || '')) problems.push('La cancel·lació no es veu: ' + (cancelled || '(cap)'));
  else log('✓ cancel·lada → es veu i conserva el motiu');
  await shot('82-cancel-lada');

  // --- registre real intacte ---------------------------------------------
  at('registre real');
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Registre', exact: true }).click();
  await page.waitForSelector('.quick', { timeout: 5000 }).catch(() => {});
  // En mode estàndard el registre ràpid mostra xips de dosi (no un camp numèric)
  const doseChip = page.locator('.quick .dosechip').filter({ hasText: /^2,5 mg/ }).first();
  if (!(await doseChip.count())) {
    const quickHtml = await page.locator('.quick').innerHTML().catch(() => '(sense registre ràpid)');
    problems.push('No es veuen les dosis ràpides: ' + quickHtml.replace(/\s+/g, ' ').slice(0, 300));
  } else {
    // P0: es registra una dosi DIFERENT de la prevista → cap proposta futura
    // es reescriu i la data queda enllaçada igualment.
    const otherChip = page.locator('.quick .dosechip').filter({ hasText: /^5 mg/ }).first();
    await (await otherChip.count() ? otherChip : doseChip).click();
    const plan22Before = (await ariaOf('22 de novembre de 2026')) || '';
    await page.locator('.day[aria-label^="15 de novembre de 2026"]').click();
    await page.waitForSelector('.dialog', { timeout: 5000 });
    const confirmTxt = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
    if (!/Registrar .*el 15\/11\/2026/.test(confirmTxt)) {
      problems.push('El registre no demana confirmació amb data: ' + confirmTxt.slice(0, 180));
    }
    await page.locator('.dialog').getByRole('button', { name: 'Registra', exact: true }).click();
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const plan22After = (await ariaOf('22 de novembre de 2026')) || '';
    if (plan22Before !== plan22After) {
      problems.push('Registrar una dosi diferent ha reescrit una proposta futura: '
        + (plan22Before || '(cap)') + ' → ' + (plan22After || '(cap)'));
    } else {
      log('✓ registrar 5 mg no reescriu la proposta del 22/11:', plan22After.slice(0, 70));
    }
  }
  const real15 = await waitForAria('15 de novembre de 2026', /clics/);
  if (!/clics/.test(real15 || '')) problems.push('El registre real no es va crear: ' + (real15 || '(cap)'));
  const cancelledStill = await ariaOf('9 de novembre de 2026');
  if (!/Cancel·lada/.test(cancelledStill || '')) problems.push('Registrar ha tret la proposta cancel·lada: ' + cancelledStill);
  else log('✓ el registre real conviu amb les propostes estatades');

  // --- editor de fases ----------------------------------------------------
  at('fases');
  await page.locator('.tab', { hasText: 'Tractament' }).click();
  await page.waitForSelector('.schedules');
  const phaseForm = page.locator('.form--inline');
  await phaseForm.locator('select[name="mode"]').selectOption('standard');
  await phaseForm.locator('input[name="startDate"]').fill('2026-12-01');
  await phaseForm.locator('input[name="value"]').fill('7.5');
  await phaseForm.locator('input[name="durationDays"]').fill('14');
  await phaseForm.getByRole('button', { name: 'Desa' }).click();
  await page.waitForTimeout(300);

  // el canvi de fase pregunta per les propostes dins del seu tram
  await page.waitForSelector('.dialog', { timeout: 5000 }).catch(() => {});
  if (await page.locator('.dialog').getByRole('button', { name: /Aplicar/ }).count()) {
    const ask = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
    if (!/fase/.test(ask)) problems.push('L\'avís no parla de la fase: ' + ask.slice(0, 160));
    await page.locator('.dialog').getByRole('button', { name: /Aplicar/ }).click();
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
    log('✓ canvi de fase → pregunta per aplicar-lo al pla');
  } else {
    problems.push('En crear una fase no es pregunta per les propostes del seu tram');
  }
  await page.waitForTimeout(300);

  const phaseRow = await page.locator('.schedules__row').filter({ hasText: '01/12/2026' }).first().innerText().catch(() => '');
  if (!/14\/12\/2026/.test(phaseRow)) problems.push('La fase no mostra la data de fi: ' + phaseRow.replace(/\n/g, ' '));
  else log('✓ la fase mostra inici → fi i durada:', phaseRow.replace(/\n/g, ' | ').slice(0, 120));
  await shot('83-fase');

  // edició de la fase existent
  at('edició de fase');
  await page.locator('.schedules__row').filter({ hasText: '01/12/2026' }).first()
    .getByRole('button', { name: 'Edita la fase' }).click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const editValue = await page.locator('.dialog input[name="value"]').inputValue();
  if (editValue !== '7.5') problems.push('L\'editor no carrega la dosi de la fase: ' + editValue);
  await page.locator('.dialog input[name="durationDays"]').fill('28');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForTimeout(300);
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  const edited = await page.locator('.schedules__row').filter({ hasText: '01/12/2026' }).first().innerText().catch(() => '');
  if (!/28\/12\/2026/.test(edited)) problems.push('La durada no ha mogut la data de fi: ' + edited.replace(/\n/g, ' '));
  else log('✓ editar la durada recalcula la data de fi');
  await shot('84-fase-editada');
} catch (err) {
  problems.push(`pas «${step}» → ` + err.message.split('\n').slice(0, 3).join(' ⏎ '));
  await shot('99-error').catch(() => {});
}

await browser.close();

console.log('\n=== PROBLEMES ===');
if (problems.length) problems.forEach((p) => console.log('•', p));
else console.log('cap');
