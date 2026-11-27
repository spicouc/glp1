// E2E: eina de calendari del mode Pla (pinta / esborra / consulta).
//
//   - Consulta (per defecte): tocar un dia obre la seva fitxa.
//   - Pinta: un sol toc hi posa (o hi canvia) la dosi triada al planificador,
//     sense obrir cap diàleg → es poden pintar molts dies seguits.
//   - Esborra: un sol toc treu la proposta (amb Desfés).
//   - Les dates amb registre real sempre obren la fitxa: la pintura mai toca
//     dades reals.
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
const tools = () => page.locator('.plantools');
const tool = (re) => tools().getByRole('button', { name: re }).first();
const ariaOf = (label) => page.locator(`.day[aria-label^="${label}"]`).getAttribute('aria-label');
const dialogOpen = async () => (await page.locator('.dialog').count()) > 0;
const closeDialog = async () => {
  await page.locator('.dialog__header button').click();
  await page.waitForTimeout(250);
};
let step = 'inici';
const at = (v) => { step = v; };

try {
  await resetServer();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await login(page);

  // --- pacient + tractament (ploma de 5 mg → 60 clics per dosi) ----------
  await page.getByRole('button', { name: 'Nou pacient' }).first().click();
  await page.locator('.dialog input[name="code"]').fill('P-001');
  await page.locator('.dialog input[name="name"]').fill('Pintar');
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
  log('✓ tractament creat (ploma de 5 mg → 2,5 mg = 30 clics)');

  // --- mode Pla: proposta estàndard automàtica --------------------------
  at('mode pla');
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Pla', exact: true }).click();
  const planner = page.locator('.card', { hasText: 'Planificació per plomes' });
  await planner.waitFor({ timeout: 10000 });
  await planner.getByRole('button', { name: /Genera el pla|Torna a generar/ }).waitFor({ timeout: 12000 });
  await tools().waitFor({ timeout: 10000 });
  log('✓ barra d\'eines visible al mode Pla');
  await shot('70-eines-pla');

  // --- 1) Consulta (per defecte): tocar obre la fitxa --------------------
  at('consulta');
  const pressed = await tool(/^Consulta/).getAttribute('aria-pressed');
  if (pressed !== 'true') problems.push('L\'eina per defecte no és Consulta (aria-pressed=' + pressed + ')');
  const before08 = await ariaOf('8 de novembre de 2026');
  if (!/Dosi prevista/.test(before08 || '')) problems.push('El 08/11 no té proposta: ' + (before08 || '(cap)'));
  await page.locator('.day[aria-label^="8 de novembre de 2026"]').click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const sheet08 = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
  if (!/DOSI PREVISTA/.test(sheet08)) problems.push('Consulta no obre la fitxa de la proposta: ' + sheet08.slice(0, 150));
  else log('✓ Consulta → obre la fitxa del dia');
  await closeDialog();

  // --- 2) Pinta: canvia la dosi d'un dia sense obrir cap diàleg ----------
  at('pinta');
  // la dosi es tria DINS la barra (és on viu el disseny)
  const barChips = tools().locator('.dosechip');
  const nChips = await barChips.count();
  if (nChips < 4) problems.push('La barra no té els xips de dosi (n=' + nChips + ')');
  const hasPresets = await tools().locator('.presets .dosechip--preset').count();
  if (!hasPresets) problems.push('La barra no té els presets de dosi');
  else log('✓ barra amb xips de dosi (' + nChips + ') i presets');
  await barChips.filter({ hasText: /^5 mg/ }).first().click();
  await page.waitForTimeout(250);
  const doseInCard = await planner.locator('.dosechip.is-selected').first().innerText().catch(() => '');
  if (!/5 mg/.test(doseInCard)) problems.push('La tria de la barra no es reflecteix a la targeta del planificador: ' + doseInCard.replace(/\n/g, ' '));
  else log('✓ la dosi triada a la barra es reflecteix a tot arreu');
  await tool(/Pinta/).click();
  await page.waitForTimeout(200);
  const pintaPressed = await tool(/Pinta/).getAttribute('aria-pressed');
  if (pintaPressed !== 'true') problems.push('L\'eina Pinta no queda activa');
  const labelPinta = await tool(/Pinta/).innerText();
  if (!/Pinta · 5 mg/.test(labelPinta)) problems.push('L\'eina Pinta no mostra la dosi triada: ' + labelPinta);
  else log('✓ Pinta activa amb la dosi del planificador:', labelPinta);

  const before15 = await ariaOf('15 de novembre de 2026');
  await page.locator('.day[aria-label^="15 de novembre de 2026"]').click();
  await page.waitForTimeout(350);
  if (await dialogOpen()) problems.push('Pinta ha obert un diàleg (no havia d\'obrir-ne cap)');
  const after15 = await ariaOf('15 de novembre de 2026');
  if (!/60 clics/.test(after15 || '')) {
    problems.push('Pinta no ha posat 5 mg (60 clics) al 15/11: ' + (after15 || '(cap)') + ' (abans: ' + before15 + ')');
  } else {
    log('✓ Pinta → 15/11 passa de 2,5 mg a 5 mg (60 clics) amb un sol toc');
  }
  await shot('71-pinta');

  // --- 3) Esborra: treu la proposta d'un sol toc -------------------------
  at('esborra');
  const before22 = await ariaOf('22 de novembre de 2026');
  if (!/Dosi prevista/.test(before22 || '')) problems.push('El 22/11 no té proposta: ' + (before22 || '(cap)'));
  await tool(/^Esborra/).click();
  await page.waitForTimeout(200);
  await page.locator('.day[aria-label^="22 de novembre de 2026"]').click();
  await page.waitForTimeout(350);
  if (await dialogOpen()) problems.push('Esborra ha obert un diàleg');
  const after22 = await ariaOf('22 de novembre de 2026');
  if (/Dosi prevista/.test(after22 || '')) {
    problems.push('Esborra no ha tret la proposta del 22/11: ' + after22);
  } else {
    log('✓ Esborra → la proposta del 22/11 desapareix amb un sol toc');
  }
  await shot('72-esborra');

  // --- 4) Consulta torna a obrir la fitxa -------------------------------
  at('consulta 2');
  await tool(/^Consulta/).click();
  const before06 = await ariaOf('6 de desembre de 2026');
  if (!/Dosi prevista/.test(before06 || '')) problems.push('El 06/12 no té proposta: ' + (before06 || '(cap)'));
  await page.locator('.day[aria-label^="6 de desembre de 2026"]').click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const sheet06 = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
  if (!/DOSI PREVISTA/.test(sheet06)) problems.push('Consulta no obre la fitxa (06/12): ' + sheet06.slice(0, 150));
  else log('✓ Consulta → la fitxa de la proposta del 06/12');
  await closeDialog();

  // --- 5) Protecció: un dia amb registre real sempre obre la fitxa ------
  at('registre real');
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Registre', exact: true }).click();
  await page.waitForSelector('.calgrid');
  await page.locator('.segmented__btn', { hasText: 'Clics' }).first().click();
  await page.locator('input[aria-label="Valor"]').fill('30');
  await page.locator('.day[aria-label^="26 de novembre de 2026"]').click();
  await page.waitForTimeout(400);
  if (await dialogOpen()) await closeDialog();
  const realDay = await ariaOf('26 de novembre de 2026');
  if (!/30 clics/.test(realDay || '')) problems.push('No s\'ha registrat la dosi real del 26/11: ' + (realDay || '(cap)'));

  await page.locator('.segmented--calendar').getByRole('button', { name: 'Pla', exact: true }).click();
  await tools().waitFor({ timeout: 8000 });
  await tool(/Pinta/).click();
  await page.locator('.day[aria-label^="26 de novembre de 2026"]').click();
  await page.waitForTimeout(400);
  if (!(await dialogOpen())) {
    problems.push('Pintar un dia amb registre real havia d\'obrir la fitxa');
  } else {
    const realSheet = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
    if (!/REGISTRE REAL/.test(realSheet)) problems.push('El diàleg no és el del registre real: ' + realSheet.slice(0, 150));
    else log('✓ Registre real → sempre s\'obre la fitxa, la pintura no el toca');
    await closeDialog();
  }
  const realAfter = await ariaOf('26 de novembre de 2026');
  if (!/30 clics/.test(realAfter || '')) problems.push('La pintura ha modificat el registre real: ' + (realAfter || '(cap)'));
  await shot('73-proteccio-registre-real');

} catch (err) {
  problems.push(`pas «${step}» → ` + err.message.split('\n').slice(0, 3).join(' ⏎ '));
  await shot('99-error').catch(() => {});
}

await browser.close();

console.log('\n=== PROBLEMES ===');
if (!problems.length) {
  console.log('cap problema');
} else {
  for (const p of problems) console.log('• ' + p);
}
process.exit(problems.length ? 1 : 0);
