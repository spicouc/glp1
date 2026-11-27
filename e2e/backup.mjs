import { chromium } from 'playwright-core';
import { login, resetServer, BASE } from './helpers.mjs';
import fs from 'node:fs';
import { SCHEMA_VERSION } from '../js/core/validate.js';

const EXE = process.env.CHROME_PATH || '/home/vinegart/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const SHOTS = process.env.SHOTS_DIR || '/tmp/opencode/glp1-shots';
const problems = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push('console: ' + m.text());
  if (m.type() === 'warning' && m.text().includes('[i18n]')) problems.push('i18n: ' + m.text());
});

await resetServer();
await page.goto(BASE, { waitUntil: 'networkidle' });
await login(page);
await page.waitForSelector('.view--patients');

// pacient base
await page.getByRole('button', { name: 'Nou pacient' }).first().click();
await page.locator('.dialog input[name="code"]').fill('P-001');
await page.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
await page.waitForSelector('.list-card');

// --- exportació completa ---
await page.locator('button[aria-label="Còpies de seguretat"]').click();
await page.waitForSelector('.dialog');
const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.dialog').getByRole('button', { name: 'Exporta tota la base' }).click(),
]);
const path = await dl.path();
const json = JSON.parse(fs.readFileSync(path, 'utf8'));
log('✓ export:', dl.suggestedFilename(), '→', json.patients.length, 'pacients, schemaVersion', json.schemaVersion);
if (dl.suggestedFilename() !== 'glp1-pacients-backup.json') problems.push('Nom d\'exportació incorrecte: ' + dl.suggestedFilename());
if (json.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion de l\'export incorrecte: ${json.schemaVersion} (s\'esperava ${SCHEMA_VERSION})`);

// --- exportació individual ---
const [dl2] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.dialog').getByRole('button', { name: 'Exporta aquest pacient' }).click().catch(() => null),
]).catch(() => [null]);
if (dl2) log('✓ export individual:', dl2.suggestedFilename());

// --- importació: fitxer invàlid ---
await page.locator('.dialog').getByRole('button', { name: 'Importa un fitxer' }).click();
await page.waitForSelector('.dialog input[type="file"]');
fs.writeFileSync('/tmp/opencode/glp1-shots/invalid.json', JSON.stringify({ schemaVersion: 99, patients: [] }));
await page.locator('.dialog input[type="file"]').setInputFiles('/tmp/opencode/glp1-shots/invalid.json');
await page.waitForTimeout(300);
const invalidText = await page.locator('.dialog').innerText();
log('--- import invàlid ---\n' + invalidText.slice(0, 300));
if (!/no s'ha pogut|no vàlid|Versió|errors/i.test(invalidText)) problems.push('La importació invàlid no mostra errors');
const replaceDisabled = await page.locator('.dialog').getByRole('button', { name: 'Substitueix tota la base' }).isDisabled().catch(() => null);
if (replaceDisabled !== true) problems.push('El botó de substitució hauria d\'estar desactivat per a un fitxer invàlid');

// --- importació: fitxer vàlid (merge) ---
const incoming = {
  app: 'glp1',
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  patients: [{ id: 'pat_importada', code: 'P-002', name: 'Importat', birthYear: 1980, notes: '', archived: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', treatments: [] }],
};
fs.writeFileSync('/tmp/opencode/glp1-shots/valid.json', JSON.stringify(incoming));
await page.locator('.dialog input[type="file"]').setInputFiles('/tmp/opencode/glp1-shots/valid.json');
await page.waitForTimeout(300);
const preview = await page.locator('.dialog').innerText();
log('--- previsualització ---\n' + preview.slice(0, 400));
if (!/1\s*\n?\s*pacients/.test(preview)) problems.push('La previsualització no mostra el contingut del fitxer (1 pacient)');
await page.locator('.dialog').getByRole('button', { name: 'Afegeix els pacients nous' }).click();
await page.waitForTimeout(400);
const cards = await page.locator('.list-card').count();
log('✓ després de merge:', cards, 'pacients');
if (cards !== 2) problems.push(`S'esperaven 2 pacients després del merge, hi ha ${cards}`);

// --- substitució total (amb confirmació) ---
await page.locator('button[aria-label="Còpies de seguretat"]').click();
await page.waitForSelector('.dialog');
await page.locator('.dialog').getByRole('button', { name: 'Importa un fitxer' }).click();
await page.waitForSelector('.dialog input[type="file"]');
await page.locator('.dialog input[type="file"]').setInputFiles('/tmp/opencode/glp1-shots/valid.json');
await page.waitForTimeout(300);
await page.locator('.dialog').getByRole('button', { name: 'Substitueix tota la base' }).click();
await page.waitForTimeout(250);
const confirmVisible = await page.locator('.dialog').getByText(/Segur que vols substituir/).isVisible().catch(() => false);
log('✓ confirmació de substitució visible:', confirmVisible);
if (!confirmVisible) problems.push('La substitució no demana confirmació explícita');
await page.getByRole('button', { name: 'Substitueix tota la base' }).last().click();
await page.waitForTimeout(400);
const after = await page.locator('.list-card').count();
if (after !== 1) problems.push(`Després de substituir hi ha ${after} pacients (s'esperava 1)`);
log('✓ substitució completada →', after, 'pacient');

await page.screenshot({ path: `${SHOTS}/14-importacio.png`, fullPage: true });

log('\n=== PROBLEMES ===');
if (!problems.length) log('cap'); else problems.forEach((p) => log('•', p));
await browser.close();
process.exit(problems.length ? 1 : 0);
