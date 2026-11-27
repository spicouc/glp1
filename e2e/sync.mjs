// Prova E2E: dades al servidor + usuaris + tokens + catàleg des de l'admin.
//
// Escenari: dos "dispositius" (contexts de navegador independents) que entren
// amb el mateix usuari i comparteixen les dades.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { BASE, SHOTS, login, resetServer, waitForSynced } from './helpers.mjs';

const problems = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/home/vinegart/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox'],
});

function watch(page, tag) {
  page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${tag} console: ${m.text()}`);
    if (m.type() === 'warning' && m.text().includes('[i18n]')) problems.push(`${tag} i18n: ${m.text()}`);
  });
}

try {
  await resetServer();

  // ---------- dispositiu A (ordinador) ---------------------------------
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = await ctxA.newPage();
  watch(a, 'A');
  await a.goto(BASE, { waitUntil: 'networkidle' });
  await login(a);
  await a.waitForSelector('.view--patients');
  log('✓ dispositiu A: ha entrat amb sessió');

  // crear pacient
  await a.getByRole('button', { name: 'Nou pacient' }).first().click();
  await a.locator('.dialog input[name="code"]').fill('P-001');
  await a.locator('.dialog input[name="name"]').fill('Creat des de A');
  await a.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await a.waitForSelector('.list-card');
  await waitForSynced(a);
  log('✓ A: pacient creat i sincronitzat amb el servidor');
  await a.screenshot({ path: `${SHOTS}/70-dispositiu-a.png`, fullPage: true });

  // ---------- dispositiu B (mòbil amb emmagatzematge buit) -------------
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const b = await ctxB.newPage();
  watch(b, 'B');
  await b.goto(BASE, { waitUntil: 'networkidle' });
  await login(b);
  await b.waitForSelector('.view--patients');
  const bText = await b.locator('.list-card').first().innerText().catch(() => '(cap)');
  if (!/P-001/.test(bText)) problems.push('El dispositiu B no rep el pacient creat a A: ' + bText.replace(/\n/g, ' '));
  else log('✓ B (emmagatzematge buit) ve el pacient creat a A:', bText.replace(/\n/g, ' | ').slice(0, 60));
  await b.screenshot({ path: `${SHOTS}/71-dispositiu-b.png`, fullPage: true });

  // B modifica el nom → A l'ha de veure
  await b.locator('.list-card').first().getByRole('button', { name: 'Edita', exact: true }).click();
  await b.locator('.dialog input[name="name"]').fill('Editat des de B');
  await b.locator('.dialog').getByRole('button', { name: 'Desa', exact: true }).click();
  await waitForSynced(b);
  log('✓ B: edició sincronitzada');

  await a.locator('.syncchip').first().click();
  await a.waitForFunction(() => /Editat des de B/.test(document.body.innerText), { timeout: 15000 });
  log('✓ A: rep l\'edició feta des de B (merge per updatedAt)');
  await a.screenshot({ path: `${SHOTS}/72-merge-entre-dispositius.png`, fullPage: true });

  // ---------- esborrat: s'ha de propagar i no ressuscitar --------------
  await b.locator('.list-card').first().getByRole('button', { name: 'Esborra', exact: true }).click();
  await b.waitForSelector('.dialog');
  await b.locator('.dialog').getByRole('button', { name: 'Esborra', exact: true }).first().click();
  // tolerant al ritme: si el diàleg encara és obert, es torna a clicar
  await b.waitForTimeout(300);
  if (await b.locator('.dialog').isVisible().catch(() => false)) {
    await b.locator('.dialog').getByRole('button', { name: 'Esborra', exact: true }).first().click();
  }
  await b.waitForFunction(
    () => document.querySelectorAll('.list-card:not(.list-card--empty)').length === 0,
    { timeout: 20000 }
  );
  await b.waitForSelector('.list-card--empty', { timeout: 10000 });
  await waitForSynced(b);
  log('✓ B: pacient esborrat (tomba enviada al servidor)');

  await b.reload({ waitUntil: 'networkidle' });
  await b.waitForSelector('.view--products, .view--patients', { timeout: 20000 }).catch(() => {});
  await b.waitForSelector('.view--patients', { timeout: 20000 });
  const bAfterReload = await b.locator('.list-card:not(.list-card--empty)').count();
  if (bAfterReload !== 0) problems.push('B: el pacient esborrat ha ressuscitat en recarregar (' + bAfterReload + ')');
  else log('✓ B: en recarregar, el pacient esborrat NO torna a aparèixer');

  await a.locator('.syncchip').first().click();
  await a.waitForFunction(
    () => document.querySelectorAll('.list-card:not(.list-card--empty)').length === 0,
    { timeout: 15000 }
  );
  log('✓ A: l\'esborrat fet a B també desapareix aquí');

  // ---------- administració --------------------------------------------
  await a.locator('button[aria-label="Administració"]').click();
  await a.waitForSelector('.view--admin');
  for (const tab of ['Usuaris', 'Tokens', 'Fàrmacs']) {
    if (!(await a.locator('.view--admin .tab', { hasText: tab }).count())) problems.push(`Falta la pestanya ${tab}`);
  }
  log('✓ administració oberta amb les pestanyes Usuaris / Tokens / Fàrmacs');

  // nou usuari (nom únic: les proves es poden repetir sense xocar)
  const newUser = 'prova_' + Date.now().toString(36);
  await a.getByRole('button', { name: 'Nou usuari' }).click();
  await a.locator('.dialog input[name="username"]').fill(newUser);
  await a.locator('.dialog input[name="password"]').fill('prova12345');
  await a.locator('.dialog').getByRole('button', { name: 'Crea', exact: true }).click();
  await a.waitForFunction(
    (name) => {
      const view = document.querySelector('.view--admin');
      const dialogOpen = Boolean(document.querySelector('.dialog'));
      return !dialogOpen && view && view.innerText.includes(name);
    },
    newUser,
    { timeout: 10000 }
  );
  log('✓ usuari creat des de l\'administració:', newUser);

  // esborrar l'usuari: no ha de tornar a aparèixer
  const userRow = a.locator('.view--admin .record').filter({ hasText: newUser }).first();
  await userRow.getByRole('button', { name: 'Esborra', exact: true }).click();
  await a.waitForSelector('.dialog');
  await a.locator('.dialog').getByRole('button', { name: 'Esborra', exact: true }).first().click();
  await a.waitForFunction(
    (name) => {
      const view = document.querySelector('.view--admin');
      return Boolean(view) && !view.innerText.includes(name);
    },
    newUser,
    { timeout: 10000 }
  );
  log('✓ usuari esborrat de debò (no torna a aparèixer)');

  // token (es mostra un sol cop)
  if (await a.locator('.dialog').count()) {
    problems.push('Hi ha un diàleg obert després de crear l\'usuari');
    await a.locator('.dialog').getByRole('button', { name: 'Cancel·la' }).first().click();
    await a.waitForTimeout(300);
  }
  await a.locator('.view--admin .tab', { hasText: 'Tokens' }).click();
  await a.waitForSelector('.view--admin .records');
  await a.getByRole('button', { name: 'Nou token' }).click();
  await a.locator('.dialog input[name="label"]').fill('e2e');
  await a.locator('.dialog').getByRole('button', { name: 'Crea el token', exact: true }).click();
  await a.waitForSelector('.dialog input[readonly]', { timeout: 8000 });
  const tokenValue = await a.locator('.dialog input[readonly]').inputValue();
  if (!/^glp1_/.test(tokenValue)) problems.push('El token creat no té el format esperat: ' + tokenValue.slice(0, 20));
  else log('✓ token creat i mostrat un sol cop:', tokenValue.slice(0, 14) + '…');
  await a.screenshot({ path: `${SHOTS}/73-token-creacion.png` });
  await a.locator('.dialog').getByRole('button', { name: 'Tanca', exact: true }).first().click();
  await a.waitForTimeout(300);

  // catàleg de fàrmacs: editar dosis estàndard (Ozempic, no altera altres proves)
  await a.locator('.view--admin .tab', { hasText: 'Fàrmacs' }).click();
  const dosesInput = a.locator('.drugcard[data-id="ozempic"] input[name="standardDosesMg"]');
  await dosesInput.waitFor({ timeout: 8000 });
  const original = await dosesInput.inputValue();
  await dosesInput.fill('0.25, 0.5, 1, 2, 3');
  await a.getByRole('button', { name: 'Desa el catàleg' }).click();
  await a.waitForTimeout(600);
  log('✓ catàleg desat amb les dosis editades (Ozempic):', original, '→ 0.25, 0.5, 1, 2, 3');

  // recarrega: la ruta #/admin es manté i el servidor ha de tornar el catàleg editat
  await a.reload({ waitUntil: 'networkidle' });
  await a.waitForSelector('.view--admin', { timeout: 20000 });
  await a.locator('.view--admin .tab', { hasText: 'Fàrmacs' }).click();
  const afterReload = await a.locator('.drugcard[data-id="ozempic"] input[name="standardDosesMg"]').inputValue();
  if (afterReload !== '0.25, 0.5, 1, 2, 3') problems.push('El catàleg no s\'ha desat al servidor: ' + afterReload);
  else log('✓ el catàleg editat persisteix al servidor després de recarregar');

  // restaurar el catàleg original (no altera les altres proves)
  await a.locator('.drugcard[data-id="ozempic"] input[name="standardDosesMg"]').fill(original);
  await a.getByRole('button', { name: 'Desa el catàleg' }).click();
  await a.waitForTimeout(500);

  // ---------- tancar sessió ---------------------------------------------
  await a.goto(new URL('#/', BASE).toString(), { waitUntil: 'networkidle' });
  await a.locator('button[aria-label="Surt de la sessió"]').click();
  await a.waitForSelector('.view--login', { timeout: 10000 });
  log('✓ sortida de sessió → pantalla d\'entrada');

  // el token del dispositiu B continua sent vàlid (sessió independent)
  const bMe = await b.evaluate(async () => {
    const res = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('glp1.token') } });
    return res.status;
  });
  if (bMe !== 200) problems.push('La sessió de B hauria de continuar viva: ' + bMe);
  else log('✓ les sessions són independents per dispositiu');
} catch (err) {
  problems.push('flux: ' + err.message);
}

log('\n=== PROBLEMES ===');
if (!problems.length) log('cap');
else problems.forEach((p) => log('•', p));

await browser.close();
process.exit(problems.length ? 1 : 0);
