// Prova E2E del calendari de planificació per plomes.
//   node e2e/planner.mjs   (cal el servidor a BASE_URL)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { login, resetServer, BASE } from './helpers.mjs';

const EXE = process.env.CHROME_PATH || '/home/vinegart/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const SHOTS = process.env.SHOTS_DIR || '/tmp/opencode/glp1-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const problems = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push('console: ' + m.text());
  if (m.type() === 'warning' && m.text().includes('[i18n]')) problems.push('i18n: ' + m.text());
});

const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const inDialog = (sel) => page.locator(`.dialog ${sel}`);
const dialogClick = async (text) => {
  const l = page.locator('.dialog').getByRole('button', { name: text, exact: true }).first();
  await l.waitFor({ state: 'visible', timeout: 5000 });
  await l.click();
};

try {
  // --- base: pacient + tractament + ploma ------------------------------
  await resetServer();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await login(page);
  await page.waitForSelector('.view--patients');
  await page.getByRole('button', { name: 'Nou pacient' }).first().click();
  await inDialog('input[name="code"]').fill('P-001');
  await dialogClick('Desa');
  await page.waitForSelector('.list-card');

  await page.getByRole('button', { name: 'Entra a la fitxa' }).first().click();
  await page.waitForSelector('.tabs');
  await page.waitForSelector('.dialog input[name="startDate"]', { timeout: 8000 });
  log('✓ sense tractament actiu, «Nou tractament» s\'obre automàticament');
  await inDialog('input[name="startDate"]').fill('2026-11-01');
  await dialogClick('Desa');
  await page.waitForSelector('.tabs');
  await page.locator('.tab', { hasText: 'Tractament' }).click();
  await page.waitForSelector('.schedules');

  await page.locator('.tab', { hasText: 'Plomes' }).click();
  await page.getByRole('button', { name: 'Nova ploma' }).first().click();
  await inDialog('select[name="presentationMg"]').selectOption('10');
  await inDialog('input[name="initialCapacity"]').fill('240');
  await inDialog('select[name="capacityUnit"]').selectOption('clicks');
  await dialogClick('Desa');
  await page.waitForSelector('.pen--active');
  log('✓ base creada (Mounjaro, ploma 10 mg / 240 clics)');

  // --- mode Pla ---------------------------------------------------------
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Pla', exact: true }).click();

  const planner = page.locator('.card', { hasText: 'Planificació per plomes' });
  await planner.waitFor({ timeout: 5000 });
  log('✓ mode Pla actiu (planner visible)');

  // --- #1 · P0: la continuació automàtica és opt-in -----------------------
  const autoLabel = planner.locator('label.switch').filter({ hasText: 'Continua la dosi' });
  if (!(await autoLabel.count())) {
    problems.push('No es troba l\'interruptor de continuació automàtica');
  } else {
    const autoInput = autoLabel.locator('input[type="checkbox"]');
    if (await autoInput.isChecked()) {
      problems.push('La continuació automàtica no pot estar activada sense consentiment explícit');
    } else {
      log('✓ continuació automàtica per defecte DESACTIVADA (cal consentiment)');
    }
    await autoLabel.click(); // consentiment explícit → es permet provar-ne la continuació
    await page.waitForTimeout(200);
    if (!(await autoInput.isChecked())) problems.push('No s\'ha activat la continuació automàtica');
    else log('✓ consentiment activat des del planificador');
  }

  // ploma #2 (10 mg) — la #1 ve creada amb el tractament
  await planner.locator('select').first().selectOption({ index: 1 });

  // el mode Pla proposa EL TRACTAMENT ESTÀNDARD de per sí
  await planner.getByRole('button', { name: 'Torna a generar' }).waitFor({ timeout: 12000 });
  log('✓ el mode Pla proposa el tractament estàndard automàticament');
  const covAuto = (await page.locator('.coverage').innerText()).replace(/\n/g, ' ');
  log('  proposta automàtica:', covAuto.slice(0, 130));
  if (!/dosis/.test(covAuto)) problems.push('La proposta automàtica no apareix a la cobertura');
  const capAuto = await planner.locator('.plan__cap').innerText();
  if (!/ja ocupa tota la capacitat/.test(capAuto)) {
    problems.push('La pista no explica que el pla ja omple la ploma: ' + capAuto);
  } else {
    log('  pista:', capAuto.trim().slice(0, 120));
  }
  await shot('20-planner-proposta-estandar');

  // l'usuari ho modifica: regenera amb 4 dates des del 20/11 (amb confirmació)
  await planner.locator('input[type="date"]').fill('2026-11-20');
  await planner.locator('input[aria-label="Cada quants dies"]').fill('7');
  await planner.locator('input[aria-label="Nombre de dosis"]').fill('4');
  await planner.getByRole('button', { name: /Genera el pla|Torna a generar/ }).click();
  // --- previsualització: les dates es veien ABANS de confirmar (req. 5) ---
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const preview = (await page.locator('.dialog').innerText()).replace(/\n/g, ' ');
  if (!/Previsualització del pla/.test(preview)) {
    problems.push('No es mostra la previsualització del pla: ' + preview.slice(0, 180));
  } else if (!/20\/11\/2026/.test(preview)) {
    problems.push('La previsualització no llista les dates: ' + preview.slice(0, 220));
  } else {
    log('✓ previsualització amb les dates abans de confirmar:', preview.slice(0, 160));
  }
  const regenConfirm = page.locator('.dialog').getByRole('button', { name: 'Genera el pla', exact: true });
  if (await regenConfirm.count()) await regenConfirm.click();
  else problems.push('El diàleg de previsualització no té el botó «Genera el pla»');
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  const planCells = await page.locator('.day--plan').count();
  log(`✓ pla regenerat: ${planCells} cel·les visibles amb dosi prevista`);
  if (planCells < 3) problems.push(`S'esperaven almenys 3 dates planificades visibles, hi ha ${planCells}`);

  const firstPlan = await page.locator('.day--plan').first().getAttribute('aria-label');
  log('  cel·la:', firstPlan);
  if (!/Dosi prevista/.test(firstPlan || '')) problems.push('La cel·la de pla no s\'etiqueta com a prevista');
  if (!/#2/.test(firstPlan || '')) problems.push('La cel·la de pla no mostra el número de ploma');

  const coverage = await page.locator('.coverage').innerText();
  log('--- cobertura ---\n' + coverage);
  if (!/4 dosis/.test(coverage)) problems.push('La cobertura no mostra 4 dosis');
  if (!/180/.test(coverage)) problems.push('No mostra el saldo després del pla (180)');
  await shot('21-pla-generat');

  // --- mes següent: les dates de desembre hi són -----------------------
  await page.getByRole('button', { name: 'Mes següent' }).click();
  await page.waitForTimeout(300);
  const decBefore = await page.locator('.day--plan').count();
  log(`✓ desembre: ${decBefore} dates planificades visibles`);
  if (decBefore < 2) problems.push(`S'esperaven dates de desembre (4 i 11), hi ha ${decBefore}`);

  // --- tocar un dia buit afegeix una altra data prevista ---------------
  await page.locator('.day[aria-label^="15 de desembre de 2026"]').click();
  await page.waitForTimeout(300);
  const planCells2 = await page.locator('.day--plan').count();
  if (planCells2 !== decBefore + 1) problems.push(`Tocar un dia buit ha d'afegir 1 entrada (ara ${planCells2}, abans ${decBefore})`);
  else log('✓ tocar un dia buit ha afegit una dosi prevista');

  // --- dia amb pla → fitxa amb accions ---------------------------------
  await page.getByRole('button', { name: 'Mes anterior' }).click();
  await page.waitForTimeout(300);
  await page.locator('.day[aria-label^="20 de novembre de 2026"]').click();
  await page.waitForSelector('.dialog');
  const sheet = await page.locator('.dialog').innerText();
  log('--- fitxa de pla ---\n' + sheet.slice(0, 300));
  for (const expected of ['Dosi prevista', 'Registra aquesta dosi', 'Edita la dosi prevista', 'Treu-la del pla']) {
    if (!new RegExp(expected, 'i').test(sheet)) problems.push(`La fitxa del pla no conté «${expected}»`);
  }
  await shot('22-fitxa-pla');

  // --- registrar la dosi prevista → esdevé administració real ----------
  await page.locator('.dialog').getByRole('button', { name: 'Registra aquesta dosi' }).click();
  await page.waitForTimeout(400);

  const coverageAfter = await page.locator('.coverage').innerText();
  if (!/4 dosis/.test(coverageAfter)) problems.push('En registrar una dosi la cobertura ha de baixar a 4 (ara: ' + coverageAfter.replace(/\n/g, ' ') + ')');
  else log('✓ la dosi registrada tanca l\'entrada de pla (4 pendents)');

  // --- tornar al mode registre: el dia ja és real ----------------------
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Registre', exact: true }).click();
  await page.waitForTimeout(300);
  const realCell = await page.locator('.day--real[aria-label^="20 de novembre de 2026"]').getAttribute('aria-label');
  log('cel·la real:', realCell || '(cap)');
  if (!realCell || !/15/.test(realCell)) problems.push('El 20/11 no apareix com a administració real de 15 clics');
  await shot('23-registre-despres-de-pla');

  // --- continuació automàtica: registrar allarga el pla ----------------
  await page.locator('.segmented--calendar').getByRole('button', { name: 'Pla', exact: true }).click();
  await page.waitForTimeout(250);
  await page.locator('.day[aria-label^="27 de novembre de 2026"]').click();
  await page.waitForSelector('.dialog');
  await page.locator('.dialog').getByRole('button', { name: 'Registra aquesta dosi' }).click();
  await page.waitForTimeout(400);

  const coverage2 = await page.locator('.coverage').innerText();
  log('--- després de registrar (continuació automàtica) ---\n' + coverage2);
  if (!/4 dosis/.test(coverage2)) problems.push('La continuació no ha mantingut 4 dates futures: ' + coverage2.replace(/\n/g, ' '));
  else log('✓ en registrar, la dosi es torna a posar a les setmanes següents (4 dates al davant)');
  if (!/22\/12\/2026/.test(coverage2)) problems.push('Falta la data continuada 22/12/2026');

  // --- modificar una dosi → opció d\'aplicar-la a les futures ----------
  await page.getByRole('button', { name: 'Mes següent' }).click();
  await page.waitForTimeout(250);
  await page.locator('.day[aria-label^="4 de desembre de 2026"]').click();
  await page.waitForSelector('.dialog');
  await page.locator('.dialog').getByRole('button', { name: 'Edita la dosi prevista' }).click();
  await page.waitForSelector('.dialog select[name="scope"]');
  const defaultScope = await page.locator('.dialog select[name="scope"] option').first().getAttribute('value');
  if (defaultScope !== 'future') {
    problems.push('L\'abast per defecte de l\'edició hauria de ser «aquesta i les futures», és ' + defaultScope);
  } else {
    log('✓ en editar, l\'abast per defecte és «Aquesta i les futures» (la modificada mana sobre les següents)');
  }
  await page.locator('.dialog input[name="value"]').fill('5');
  await page.locator('.dialog select[name="scope"]').selectOption('future');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForTimeout(250);

  const confirmVisible = await page.locator('.dialog').getByText(/Actualitzar també les/).isVisible().catch(() => false);
  log('✓ pregunta per aplicar el canvi a les futures:', confirmVisible);
  if (!confirmVisible) problems.push('No apareix l\'opció d\'aplicar el canvi a les dosis futures');
  await page.locator('.dialog').getByRole('button', { name: /^Aquesta i les futures/ }).click();
  await page.waitForTimeout(400);

  await page.locator('.day[aria-label^="11 de desembre de 2026"]').click();
  await page.waitForSelector('.dialog');
  const sheet11 = await page.locator('.dialog').innerText();
  if (!/30 clics/.test(sheet11)) problems.push('La dosi futura del 11/12 no s\'ha actualitzat a 30 clics:\n' + sheet11.slice(0, 200));
  else log('✓ el canvi s\'ha aplicat a les dates futures (11/12 → 30 clics)');
  if (/2,5 mg/.test(sheet11) && !/30 clics/.test(sheet11)) problems.push('La data següent conserva la dosi antiga');
  await page.locator('.dialog__header button').click();
  await page.waitForTimeout(200);

  // --- disseny progressiu: afegir un tram amb una altra dosi -------------
  const plannerAppend = page.locator('.card', { hasText: 'Planificació per plomes' });
  const proposalVisible = await plannerAppend.getByText(/PROPOSTA de calendari/).count();
  if (!proposalVisible) problems.push('No es veu l\'avís que el pla és una proposta');
  else log('✓ avís «el pla és una PROPOSTA» visible');

  await plannerAppend.locator('.dosechip').filter({ hasText: /^5 mg/ }).first().click();
  await plannerAppend.locator('input[aria-label="Nombre de dosis"]').fill('2');
  await plannerAppend.getByRole('button', { name: 'Afegeix un tram al pla' }).click();
  // afegir un tram també passa per previsualització i confirmació
  await page.waitForSelector('.dialog', { timeout: 5000 });
  const appendOk = page.locator('.dialog').getByRole('button', { name: 'Genera el pla', exact: true });
  if (await appendOk.count()) await appendOk.click();
  else problems.push('En afegir un tram no es va la previsualització');
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);

  const covAppend = await page.locator('.coverage').innerText();
  log('--- després d\'afegir un tram ---\n' + covAppend);
  if (!/6 dosis/.test(covAppend)) problems.push('El tram no s\'ha afegit al pla: ' + covAppend.replace(/\n/g, ' '));
  else log('✓ tram afegit amb una altra dosi (6 dates proposades en total)');
  if (!/05\/01\/2027/.test(covAppend)) problems.push('El tram no continua després de l\'última data: ' + covAppend.replace(/\n/g, ' '));

  // les dates dissenyades abans no s'han tocat
  await page.locator('.day[aria-label^="4 de desembre de 2026"]').click();
  await page.waitForSelector('.dialog');
  const oldDay = await page.locator('.dialog').innerText();
  if (!/2,5 mg/.test(oldDay)) problems.push('El tram anterior ha canviat: ' + oldDay.replace(/\n/g, ' ').slice(0, 150));
  else log('✓ les dates dissenyades abans continuen igual (04/12 → 2,5 mg)');
  if (!/Proposta/.test(oldDay)) problems.push('La fitxa del pla no identifica l\'entrada com a proposta');
  else log('✓ la fitxa marca l\'entrada com a «Proposta»');
  await page.locator('.dialog__header button').click();
  await page.waitForTimeout(250);
  await shot('26-tram-proposta');

  // --- canviar la dosi de TOT el pla d'un cop (sense editar-les una a una) --
  const plannerApply = page.locator('.card', { hasText: 'Planificació per plomes' });
  await plannerApply.locator('.dosechip').filter({ hasText: /^2,5 mg/ }).first().click();
  await plannerApply.getByRole('button', { name: 'Aplica la dosi a les propostes' }).click();
  await page.waitForSelector('.dialog');
  const applyTxt = await page.locator('.dialog').innerText();
  if (!/6 propostes/.test(applyTxt) || !/TOT el pla/.test(applyTxt)) {
    problems.push('Confirmació d\'aplicar inadequada (s\'esperava abast «tot el pla"): ' + applyTxt.replace(/\n/g, ' ').slice(0, 170));
  } else {
    log('✓ confirmació d\'aplicació (tot el pla):', applyTxt.replace(/\n/g, ' ').slice(0, 130));
  }
  await shot('27-aplicar-dosi-propostes');
  await page.locator('.dialog').getByRole('button', { name: 'Aplica la dosi a les propostes', exact: true }).click();
  await page.waitForTimeout(400);

  // baixa tant l'última com una de més antiga (que era de dosi superior)
  for (const data of ['29 de desembre de 2026', '11 de desembre de 2026']) {
    await page.locator(`.day[aria-label^="${data}"]`).click();
    await page.waitForSelector('.dialog');
    const lowered = await page.locator('.dialog').innerText();
    if (!/15 clics/.test(lowered)) {
      problems.push(`La proposta del ${data} no ha baixat a 15 clics: ` + lowered.replace(/\n/g, ' ').slice(0, 150));
    } else {
      log(`✓ ${data} → 15 clics (tot el pla modificat d'un cop)`);
    }
    await page.locator('.dialog__header button').click();
    await page.waitForTimeout(250);
  }

  // --- esborrar tot el pla (sense tocar els registres reals) ------------
  await page.getByRole('button', { name: 'Mes anterior' }).click();
  await page.waitForTimeout(300);
  const plannerCard = page.locator('.card', { hasText: 'Planificació per plomes' });
  await plannerCard.getByRole('button', { name: 'Esborra tot el pla' }).click();
  await page.waitForSelector('.dialog');
  const clearTxt = await page.locator('.dialog').innerText();
  if (!/S'eliminaran les \d+ dates/.test(clearTxt)) {
    problems.push('Confirmació de l\'esborrat de pla inadequada: ' + clearTxt.replace(/\n/g, ' ').slice(0, 160));
  } else {
    log('✓ confirmació explícita: ' + clearTxt.replace(/\n/g, ' ').slice(0, 120));
  }
  await page.locator('.dialog').getByRole('button', { name: 'Esborra tot el pla', exact: true }).click();
  await page.waitForTimeout(500);
  const planLeft = await page.locator('.day--plan').count();
  const realLeft = await page.locator('.day--real').count();
  log(`✓ pla esborrat → dates de pla: ${planLeft}, administracions reals: ${realLeft}`);
  if (planLeft !== 0) problems.push(`Queden ${planLeft} dates de pla després d'esborrar-lo`);
  if (realLeft < 2) problems.push('Esborrar el pla ha tocat els registres reals!');
  await shot('24-pla-esborrat');

  // --- esborrar TOT el registre de dosis (per tornar-lo a registrar) -----
  await page.locator('.tab', { hasText: 'Tractament' }).click();
  await page.waitForSelector('.view--treatment');
  const trtCard2 = page.locator('.view--treatment .card').filter({ hasText: 'Mounjaro' }).first();
  await trtCard2.getByRole('button', { name: 'Esborra el registre de dosis', exact: true }).click();
  await page.waitForSelector('.dialog');
  const regConf = await page.locator('.dialog').innerText();
  if (!/administracions d\'aquest tractament/.test(regConf)) {
    problems.push('Confirmació buit registre inadequada: ' + regConf.replace(/\n/g, ' ').slice(0, 160));
  } else {
    log('✓ confirmació esborrar registre:', regConf.replace(/\n/g, ' ').slice(0, 130));
  }
  await page.locator('.dialog').getByRole('button', { name: 'Esborra el registre de dosis', exact: true }).first().click();
  await page.waitForTimeout(500);

  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForSelector('.calgrid');
  const realAfter = await page.locator('.day--real').count();
  if (realAfter !== 0) problems.push('Queden ' + realAfter + ' administracions després d\'esborrar el registre');
  else log('✓ registre de dosis esborrat (cap dia real)');
  const sumAfter = (await page.locator('.summary').innerText()).replace(/\n/g, ' ');
  if (!/Saldo actual: 240 clics/.test(sumAfter)) problems.push('El saldo no ha tornat a l\'inicial: ' + sumAfter.slice(0, 150));
  else log('✓ el saldo de la ploma ha tornat a l\'inicial (240 clics)');
  await shot('26b-registre-buid');

  // --- persistència ----------------------------------------------------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.calgrid', { timeout: 8000 });
  const fitxaOk = await page.locator('.view--patient').count();
  const resumOk = (await page.locator('.summary').innerText()).replace(/\n/g, ' ');
  log('✓ després de recarregar: la fitxa carrega i conserva les dades');
  if (fitxaOk !== 1) problems.push('La fitxa no s\'ha carregat després de recarregar');
  if (!/Saldo actual: 240 clics/.test(resumOk)) problems.push('Les dades no han sobreviscut a la recàrrega: ' + resumOk.slice(0, 150));
  // --- esborrar el tractament --------------------------------------------
  await page.locator('.tab', { hasText: 'Tractament' }).click();
  await page.waitForSelector('.view--treatment');
  const trtCard = page.locator('.view--treatment .card').filter({ hasText: 'Mounjaro' }).first();
  await trtCard.getByRole('button', { name: 'Esborra', exact: true }).click();
  await page.waitForSelector('.dialog');
  const tConf = await page.locator('.dialog').innerText();
  if (!/Es perdran/.test(tConf)) {
    problems.push('Confirmació d\'esborrat de tractament inadequate: ' + tConf.replace(/\n/g, ' ').slice(0, 160));
  } else {
    log('✓ confirmació explícita:', tConf.replace(/\n/g, ' ').slice(0, 130));
  }
  await page.locator('.dialog').getByRole('button', { name: 'Esborra el tractament', exact: true }).click();
  await page.waitForTimeout(500);
  const trtEmpty = await page.locator('.view--treatment .empty__title').first().innerText().catch(() => '(cap)');
  if (!/Encara no hi ha cap tractament/.test(trtEmpty)) problems.push('El tractament no s\'ha esborrat: ' + trtEmpty);
  else log('✓ tractament esborrat (estat buit a la pestanya Tractament)');
  await shot('25-tractament-esborrat');

  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForTimeout(300);
  const calEmpty = await page.locator('.tabpanel .empty__title').first().innerText().catch(() => '(cap)');
  log('  calendari després d\'esborrar el tractament:', calEmpty);
  if (!/tractament/i.test(calEmpty)) problems.push('El calendari no indica que falta un tractament');
} catch (err) {
  problems.push('flux: ' + err.message);
  await shot('error-planner').catch(() => {});
}

log('\n=== PROBLEMES ===');
if (!problems.length) log('cap');
else problems.forEach((p) => log('•', p));

await browser.close();
process.exit(problems.length ? 1 : 0);
