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

try {
  await resetServer();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await login(page);
  await page.waitForSelector('.view--patients');
  await shot('01-pacients-buit');

  // --- 1. Nou pacient ----------------------------------------------------
  await clickText('Nou pacient');
  await inDialog('input[name="code"]').fill('P-001');
  await inDialog('input[name="name"]').fill('Prova');
  await dialogClick('Desa');
  await page.waitForSelector('.list-card');
  log('✓ pacient creat');

  // --- 2. Tractament (sense tractament actiu → s'obre sol la primera vegada) ---
  await clickText('Entra a la fitxa');
  await page.waitForSelector('.tabs');
  await page.waitForSelector('.dialog select[name="drugId"]', { timeout: 8000 });
  log('✓ sense tractament actiu, «Nou tractament» s\'obre automàticament');

  // el primer tractament no es pot desar sense estipular la ploma
  await page.locator('.dialog .switch', { hasText: 'Inicia la ploma automàticament' }).locator('input').uncheck();
  await page.waitForTimeout(150);
  await dialogClick('Desa');
  await page.waitForTimeout(250);
  const penErr = await page.locator('.dialog .form-error').first().innerText().catch(() => '(cap)');
  if (!/estipular quina ploma/.test(penErr)) problems.push('El primer tractament s\'ha pogut desar sense ploma: ' + penErr);
  else log('✓ el primer tractament exigeix estipular la ploma:', penErr.slice(0, 80) + '…');
  await page.locator('.dialog .switch', { hasText: 'Inicia la ploma automàticament' }).locator('input').check();
  await page.waitForTimeout(150);

  await inDialog('select[name="drugId"]').selectOption('mounjaro');
  await inDialog('input[name="startDate"]').fill('2026-11-01');

  // dosi inicial: xips + equivalència
  const doseChips = await page.locator('.dialog .dosechip').allInnerTexts();
  log('  dosis disponibles:', JSON.stringify(doseChips.slice(0, 3)));
  if (!doseChips.length) problems.push('No es veuen les dosis al diàleg de tractament');
  if (!doseChips.some((c) => /mg/.test(c))) problems.push('Els xips de dosi no mostren la dosi en mg');
  await page.locator('.dialog .dosechip').filter({ hasText: /^2,5 mg/ }).first().click();
  const doseEq = (await page.locator('.dialog .eq').first().innerText()).replace(/\n/g, ' ');
  if (!/2,5 mg = 60 clics/.test(doseEq)) problems.push('No es veu la dosi/equivalència escollida: ' + doseEq);
  else log('✓ dosi inicial triada amb equivalència:', doseEq);

  // la ploma es pot triar independentment de la dosi
  await inDialog('select[name="presentationMg"]').selectOption('5');
  await page.waitForTimeout(150);
  const eqPen = (await page.locator('.dialog .eq').first().innerText()).replace(/\n/g, ' ');
  if (!/2,5 mg = 30 clics/.test(eqPen)) problems.push('La tria de ploma no actualitza l\'equivalència: ' + eqPen);
  else log('✓ ploma triada (5 mg) → equivalència actualitzada:', eqPen);
  const penHint = await page.locator('.dialog .stack--tight .field__hint').first().innerText();
  if (!/5 mg · 240 clics/.test(penHint)) problems.push('La pista de la ploma no reflecteix la tria: ' + penHint);
  else log('✓ pista de la ploma triada:', penHint.replace(/\n/g, ' '));

  await dialogClick('Desa');
  await page.waitForSelector('.tabs');
  log('✓ tractament creat');
  await page.locator('.tab', { hasText: 'Tractament' }).click();
  await page.waitForSelector('.schedules');
  const schedText = await page.locator('.schedules').innerText();
  if (!/2,5 mg/.test(schedText)) {
    problems.push('La pauta inicial no és la dosi triada: ' + schedText.replace(/\n/g, ' '));
  } else {
    log('✓ pauta inicial = dosi triada (2,5 mg)');
  }
  await shot('02-tractament');

  // --- 3. Ploma ----------------------------------------------------------
  await page.locator('.tab', { hasText: 'Plomes' }).click();
  await page.waitForSelector('.view--pens');
  const autoPenCards = await page.locator('.pen', { hasText: 'Mounjaro · 5 mg' }).count();
  if (autoPenCards < 1) problems.push('No es veu la ploma automàtica amb la presentació triada (5 mg)');
  else log('✓ ploma automàtica amb la presentació TRIADA (5 mg), no la de la dosi');
  await clickText('Nova ploma');
  await inDialog('select[name="presentationMg"]').selectOption('10');
  await inDialog('input[name="initialCapacity"]').fill('240');
  await inDialog('select[name="capacityUnit"]').selectOption('clicks');
  await dialogClick('Desa');
  await page.waitForSelector('.pen--active');
  const saldoInitial = await page.locator('.pen--active').getByText(/Saldo/).first().textContent();
  log('✓ ploma creada:', saldoInitial?.trim());
  await shot('03-plomes');

  // --- 4. Calendari: registre ràpid 15 clics en 4 dies -------------------
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  await shot('04-calendari-buit');

  await page.locator('.segmented__btn', { hasText: 'Clics' }).first().click();
  await page.locator('input[aria-label="Valor"]').fill('15');

  for (const d of ['1', '8', '15', '18']) {
    await page.locator(`.day[aria-label^="${d} de novembre de 2026"]`).click();
    await page.waitForTimeout(120);
  }
  const after15 = await page.locator('.penbox__balance, .stat--real .stat__value').first().textContent();
  log('✓ 4 registres de 15 clics →', after15?.trim());
  await shot('05-calendari-15');

  // --- 5. Canvi a 30 clics: els anteriors no es toquen -------------------
  await page.locator('input[aria-label="Valor"]').fill('30');
  await page.locator(`.day[aria-label^="22 de novembre de 2026"]`).click();
  await page.waitForTimeout(150);

  // espera determinista: la cel·la ha de mostrar el valor registrat
  const waitCell = (prefix, re) => page.waitForFunction(
    ({ pfx, pat }) => {
      const el = [...document.querySelectorAll('.day')]
        .find((d) => (d.getAttribute('aria-label') || '').startsWith(pfx));
      return Boolean(el) && new RegExp(pat).test(el.getAttribute('aria-label') || '');
    },
    { pfx: prefix, pat: re },
    { timeout: 8000 }
  );

  await waitCell('1 de novembre de 2026', '15');
  await waitCell('22 de novembre de 2026', '30');
  const cell1 = await page.locator('.day[aria-label^="1 de novembre de 2026"]').getAttribute('aria-label');
  const cell22 = await page.locator('.day[aria-label^="22 de novembre de 2026"]').getAttribute('aria-label');
  log('✓ dia 1 →', cell1);
  log('✓ dia 22 →', cell22);
  if (!/15/.test(cell1 || '')) problems.push('El registre del dia 1 ha canviat de valor!');
  if (!/30/.test(cell22 || '')) problems.push('El dia 22 no té 30 clics!');
  await shot('06-calendari-mixt');

  // --- 6. Fitxa del dia --------------------------------------------------
  await page.locator(`.day[aria-label^="22 de novembre de 2026"]`).click();
  await page.waitForSelector('.dialog');
  const sheet = await page.locator('.dialog').innerText();
  log('--- fitxa dia 22 ---\n' + sheet.slice(0, 400));
  await shot('07-fitxa-dia');
  await page.locator('.dialog__header button').click();

  // --- 7. Projecció + dosis completes ------------------------------------
  await page.locator('.tab', { hasText: 'Tractament' }).click();
  await page.waitForSelector('.schedules');
  await inDialog('input[name="startDate"]').count(); // assegura formulari present
  const scheduleForm = page.locator('.form--inline');
  await scheduleForm.locator('select[name="mode"]').selectOption('clicks');
  await scheduleForm.locator('input[name="startDate"]').fill('2026-12-01');
  await scheduleForm.locator('input[name="value"]').fill('30');
  await scheduleForm.getByRole('button', { name: 'Desa' }).click();
  await page.waitForTimeout(300);
  // Canviar/afegir una fase ofereix aplicar el canvi a les seves propostes
  // (req. 7: modificar el futur sense tocar l'historial real) — sempre amb
  // confirmació explícita.
  const applyDlg = page.locator('.dialog').getByRole('button', { name: /Aplicar/ });
  await page.waitForSelector('.dialog', { timeout: 4000 }).catch(() => {});
  if (await applyDlg.count()) {
    const ask = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
    log('✓ la fase pregunta per les propostes:', ask.slice(0, 150));
    await applyDlg.first().click();
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
  } else {
    problems.push('En canviar de fase no es pregunta per les propostes de la fase');
  }
  log('✓ tram de pauta afegit (30 clics des de 01/12)');

  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.projlist');
  const proj = await page.locator('.projlist').innerText();
  log('--- projecció ---\n' + proj);
  if (!/15 clics/.test(proj)) problems.push('La projecció no mostra la dosi de 15 clics');
  if (!/30 clics/.test(proj)) problems.push('La projecció no mostra el canvi a 30 clics');
  await shot('08-projeccio');

  // --- 8. Nova ploma mantenint l'anterior --------------------------------
  await page.locator('.tab', { hasText: 'Plomes' }).click();
  await clickText('Nova ploma');
  await inDialog('select[name="presentationMg"]').selectOption('15');
  await inDialog('input[name="startDate"]').fill('2026-12-01');
  await dialogClick('Desa');
  await page.waitForTimeout(250);
  const penCount = await page.locator('.pen').count();
  log('✓ plomes visibles:', penCount);
  if (penCount < 2) problems.push('No es veuen les dues plomes (l\'anterior ha de quedar a l\'històric)');
  await shot('09-historic-plomes');

  // --- 9. Historial i salut ---------------------------------------------
  await page.locator('.tab', { hasText: 'Historial' }).click();
  await page.waitForSelector('.timeline');
  await shot('10-historial');

  await page.locator('.tab', { hasText: 'Pes' }).click();
  await page.waitForSelector('.view--health');
  await clickText('Nou registre');
  await inDialog('input[name="weightKg"]').fill('82.4');
  await inDialog('select[name="nausea"]').selectOption('1');
  await dialogClick('Desa');
  await page.waitForSelector('.record');
  log('✓ registre de salut creat');

  await clickText('Nou registre');
  await inDialog('input[name="date"]').fill('2026-11-26');
  await inDialog('input[name="weightKg"]').fill('81.9');
  await inDialog('select[name="diarrhea"]').selectOption('1');
  await dialogClick('Desa');
  await page.waitForSelector('.chart', { timeout: 8000 });
  log('✓ gràfic d\'evolució dibuixat');
  await shot('11-pes');

  // --- 10. Tornar a la llista + export -----------------------------------
  await page.locator('button[aria-label="Pacients"]').click();
  await page.waitForSelector('.view--patients');
  const listText = await page.locator('.list-card').first().innerText();
  log('--- targeta pacient ---\n' + listText);
  await shot('12-llistat-ple');

  // --- 11. Persistència: recarrega ---------------------------------------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.view--patients');
  const afterReload = await page.locator('.list-card').count();
  if (afterReload !== 1) problems.push(`Després de recarregar s'han trobat ${afterReload} pacients (s'esperava 1)`);
  log('✓ persistència localStorage OK');

  // --- 12. Llista mínima: només el pacient (les dades, a la fitxa) ------
  const firstCard = page.locator('.list-card').first();
  const cardHtml = await firstCard.innerHTML();
  const cardText = await firstCard.innerText();
  log('--- targeta de la llista ---\n' + cardText.replace(/\n/g, ' | '));
  if (/penbox|stat__value|class="alerts|summary__drug/.test(cardHtml)) {
    problems.push('La llista encara renderitza dades derivades (resum/ploma/alertes)');
  } else {
    log('✓ la llista només identifica el pacient');
  }
  if (/\bSaldo\b|DOSI ACTUAL|PLOMA ACTIVA/i.test(cardText)) {
    problems.push('La targeta de la llista mostra dades de la fitxa: ' + cardText.replace(/\n/g, ' | '));
  }
  if (!(await firstCard.getByRole('button', { name: 'Esborra' }).count())) {
    problems.push('Falta el botó «Esborra» a la llista');
  } else {
    log('✓ botó «Esborra» present');
  }

  // --- 13. Esmocada d'escriptori ----------------------------------------
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);
  await shot('13-escriptori');

  // --- 14. Esborrar el pacient (amb confirmació explícita) ---------------
  await firstCard.getByRole('button', { name: 'Esborra' }).click();
  await page.waitForSelector('.dialog');
  const delConfirm = await page.locator('.dialog').innerText();
  if (!/permanentment/.test(delConfirm)) {
    problems.push('La confirmació d\'esborrat no és explícita: ' + delConfirm.replace(/\n/g, ' ').slice(0, 160));
  }
  await page.locator('.dialog').getByRole('button', { name: 'Esborra', exact: true }).click();
  await page.waitForTimeout(500);
  const leftCards = await page.locator('.list-card:not(.list-card--empty)').count();
  const emptyShown = await page.locator('.empty__title').count();
  log(`✓ pacient esborrat → ${leftCards} targetes restants, estat buit: ${emptyShown > 0}`);
  if (leftCards !== 0 || emptyShown < 1) problems.push('L\'esborrat del pacient no ha funcionat');
  await shot('14-llistat-buit');
} catch (err) {
  problems.push(`flux: ${err.message}`);
  await shot('error').catch(() => {});
}

log('\n=== PROBLEMES ===');
if (!problems.length) log('cap');
else problems.forEach((p) => log('•', p));

await browser.close();
process.exit(problems.length ? 1 : 0);
