// E2E: inventari (caducitat, obertura, preu), costos, dashboard i dades no
// validades de salut.
//
//   - La ploma registra caducitat, data d'obertura i preu → es mostren a la
//     targeta (i l'avís de caducitat surt a les alertes).
//   - El dashboard de la fitxa mostra setmana de tractament, pes, inventari i
//     costos.
//   - Les despeses es registren al tractament i es sumen amb els preus de ploma.
//   - Una entrada de salut sense validar es veu marcada com a NO VALIDAT.
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
const text = async (sel) => (await page.locator(sel).first().innerText().catch(() => '')).replace(/\n/g, ' ');
const closeDialog = async () => {
  await page.locator('.dialog__header button').click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
};

let step = 'inici';
const at = (v) => { step = v; };

try {
  await resetServer();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await login(page);

  // --- pacient + tractament + ploma --------------------------------------
  await page.getByRole('button', { name: 'Nou pacient' }).first().click();
  await page.locator('.dialog input[name="code"]').fill('P-001');
  await page.locator('.dialog input[name="name"]').fill('Inventari');
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

  // --- dashboard (fitxa del pacient) -------------------------------------
  at('dashboard');
  const dash = await text('.stats--secondary');
  if (!dash) problems.push('El dashboard no té la segona fila d\'indicadors');
  for (const label of ['setmana', 'pes', 'inventari', 'costos']) {
    if (!new RegExp(label, 'i').test(dash)) problems.push(`El dashboard no mostra «${label}»: ` + dash.slice(0, 200));
  }
  if (!/4a|3a|5a/.test(dash)) problems.push('La setmana de tractament no surt numèrica: ' + dash.slice(0, 200));
  else log('✓ dashboard:', dash.slice(0, 220));
  await shot('90-dashboard');

  // --- ploma: caducitat, obertura i preu ---------------------------------
  at('ploma inventari');
  await page.locator('.tab', { hasText: 'Plomes' }).click();
  await page.waitForSelector('.view--pens');
  await page.locator('.pen--active').getByRole('button', { name: 'Edita', exact: true }).click();
  await page.waitForSelector('.dialog input[name="expiryDate"]', { timeout: 5000 });
  await page.locator('.dialog input[name="expiryDate"]').fill('2026-12-15');
  await page.locator('.dialog input[name="openedAt"]').fill('2026-11-01');
  await page.locator('.dialog input[name="priceEur"]').fill('129');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  const meta = await text('.pen--active .pen__meta');
  if (!/Caduca el 15\/12\/2026/.test(meta)) problems.push('No es mostra la caducitat: ' + meta.slice(0, 400));
  else log('✓ caducitat a la fitxa de la ploma');
  if (!/Oberta el 01\/11\/2026/.test(meta)) problems.push('No es mostra l\'obertura: ' + meta.slice(0, 400));
  else log('✓ data d\'obertura registrada');
  if (!/Cost:\s*129,00\s*€/.test(meta) || !/per dosi/.test(meta)) {
    problems.push('No es mostra el cost per dosi: ' + meta.slice(0, 400));
  }
  else log('✓ cost de la ploma i cost per dosi:', (meta.match(/Cost:[^·]*/) || [''])[0].trim());

  const badges = await text('.pen--active .pen__badges');
  if (!/Caduca aviat/.test(badges)) problems.push('No surt l\'avís «Caduca aviat»: ' + badges);
  else log('✓ xip «Caduca aviat» a la targeta');
  await shot('91-ploma-inventari');

  // --- alerta a la fitxa --------------------------------------------------
  at('alerta caducitat');
  await page.locator('.tab', { hasText: 'Calendari' }).click();
  await page.waitForTimeout(300);
  const alerts = await text('.alerts');
  if (!/caduca d'aquí a \d+ dies/.test(alerts)) problems.push('No hi ha alerta de caducitat: ' + (alerts || '(cap)'));
  else log('✓ alerta de caducitat:', alerts.slice(0, 140));

  // --- costos del tractament ---------------------------------------------
  at('costos');
  await page.locator('.tab', { hasText: 'Tractament' }).click();
  await page.waitForSelector('.view--treatment');
  const totals0 = await text('.costs__totals');
  if (!/Plomes:\s*129,00\s*€/.test(totals0)) problems.push('El total de plomes no surt: ' + totals0);
  await page.getByRole('button', { name: 'Nova despesa' }).click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  await page.locator('.dialog input[name="amount"]').fill('15.50');
  await page.locator('.dialog input[name="notes"]').fill('Agulles');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const totals = await text('.costs__totals');
  if (!/Total:\s*144,50\s*€/.test(totals)) problems.push('El total no suma ploma + despesa: ' + totals);
  else log('✓ costos sumen:', totals.slice(0, 160));
  await shot('92-costos');

  // --- salut: dada no validada → validada ---------------------------------
  at('salut');
  await page.locator('.tab', { hasText: 'Pes / EA' }).click();
  await page.waitForSelector('.view--health, .tabpanel');
  await page.getByRole('button', { name: 'Nou registre' }).click();
  await page.waitForSelector('.dialog', { timeout: 5000 });
  await page.locator('.dialog input[name="weightKg"]').fill('82.4');
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  const unvalidated = await text('.records .record');
  if (!/NO VALIDAT/.test(unvalidated)) problems.push('La dada manual no es marca com a no validada: ' + unvalidated.slice(0, 200));
  else log('✓ entrada de salut marcada com a NO VALIDAT');

  await page.locator('.records .record').first().getByRole('button', { name: 'Edita' }).click();
  await page.waitForSelector('.dialog input[name="validated"]', { timeout: 5000 });
  await page.locator('.dialog input[name="validated"]').check();
  await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const validated = await text('.records .record');
  if (!/Validada/.test(validated) || /NO VALIDAT/.test(validated)) {
    problems.push('La validació no es reflecteix: ' + validated.slice(0, 200));
  } else log('✓ marcada com a validada');

  const dash2 = await text('.stats--secondary');
  if (!/82,4 kg/.test(dash2)) problems.push('El pes no arriba al dashboard: ' + dash2.slice(0, 200));
  else log('✓ el pes apareix al dashboard');
  await shot('93-salut');
} catch (err) {
  problems.push(`pas «${step}» → ` + err.message.split('\n').slice(0, 3).join(' ⏎ '));
  await shot('99-error').catch(() => {});
}

await browser.close();

console.log('\n=== PROBLEMES ===');
if (problems.length) problems.forEach((p) => console.log('•', p));
else console.log('cap');
