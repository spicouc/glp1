# Seguiment GLP-1 / GIP

Aplicació web **mobile-first** per al registre i seguiment longitudinal de pacients
que utilitzen tractaments injectables GLP-1/GIP.

> **Eina de registre, càlcul i planificació. No prescriu.**
> Les equivalències entre clics i mg es mostren sempre etiquetades com a
> *equivalència teòrica* i l'aplicació mai genera recomanacions de dosi
> ("augmenta" / "baixa") sense una acció explícita de l'usuari.

Jerarquia del model: **Pacient → Tractament → Plomes → Administracions → Calendari → Evolució**.

---

## Execució

No té build ni dependències en temps d'execució (JS de navegador amb ES modules).

### Docker (recomanat)

```bash
cd glp1
docker compose up -d --build     # 2 serveis: glp1 (app) + glp1-api (dades)
docker compose ps                # tots "Up (healthy)"
docker compose logs -f glp1-api  # registres de l'API
docker compose down              # atura
```

Primer accés: entra amb l'usuari del `.env` (`GLP1_ADMIN_USER` i
`GLP1_ADMIN_PASSWORD` generats en aquesta instal·lació) i canvia la contrasenya
des de *Administració → Usuaris*.

`restart: unless-stopped` + healthcheck fan que el servei torni a arrencar
sol i que sobrevisqui a un reinici de la màquina. Després de **canviar codi**:
`docker compose up -d --build`.

Port alternatiu: `GLP1_PORT=9000 docker compose up -d --build`.

Pila E2E (aïllada, per a les proves; no cal arrencar-la a mà: `npm run e2e` ho
fa sol):

```bash
npm run e2e:up        # glp1-e2e + glp1-api-e2e a :8098 amb volum propi
npm run e2e:down      # l'atura (les dades de prova es conserven)
```

### Alternativa sense Docker

```bash
./serve.sh                # o: npm run serve
```

### Adreces accessibles des de la xarxa

Tots dos escolten a **totes les interfícies** (`0.0.0.0`), de manera que
l'aplicació s'obre des de qualsevol dispositiu de la xarxa:

```
http://192.168.1.146:8099/   (eth0)        ← mòbil / tauleta / portàtil
http://100.85.57.11:8099/    (tailscale0)  ← fora de casa, via Tailscale
http://127.0.0.1:8099/       (aquest ordinador)
```

`./serve.sh` les imprimeix automàticament en arrencar.

### ⚠ On viuen les dades

`localStorage` és **per origen i per navegador**: cada dispositiu té la seva
pròpia base de dades local. Accedir des del mòbil i des de l'ordinador no
sincronitza els registres. Per a una base compartida caldrà posar el
repositori sobre un servidor (IndexedDB + backend / Supabase / API pròpia); la
capa `js/data/repository.js` ja està aïllada específicament per a això.

### Tests

```bash
npm run test:api       # tests de l'API (Python): auth, merge, rols, tokens, catàleg, tombes,
                       #   duplicats, saldos, auditoria, purga, enllaç amb discrepància (28)
npm test               # tests unitaris: model, càlcul, pla, plomes, sync, catàleg,
                       #   migració v3, estats, fases, inventari (101)
npm run e2e            # proves de navegador: arrenca la PILA AÏLLADA (:8098)
                       #   smoke.mjs   flux complet per la UI
                       #   pens.mjs    plomes: capacitat en clics, esborrar/restaurar,
                       #               presets de dosi i dosi partida en injeccions
                       #   planner.mjs calendari de planificació per plomes
                       #   paint.mjs   eina de calendari (pinta/esborra/consulta)
                       #   planestats.mjs estats (ajorna/omet/cancel·la) i editor de fases
                       #   inventory.mjs  caducitat, obertura, preu, costos, dashboard
                       #   backup.mjs  exportació, importació i confirmació
                       #   sync.mjs    2 dispositius + administració (usuaris/tokens/fàrmacs)
npm run e2e:restore    # restaura només l'últim snapshot del servidor
npm run e2e:up         # només arrenca la pila E2E   /  e2e:down → l'atura
```

**Els E2E mai toquen la base de producció.** El runner arrenca una **còpia
aïllada** de l'entorn (`docker-compose.e2e.yml`): altres contenidors
(`glp1-e2e`, `glp1-api-e2e`), **port 8098** i volum de dades propi
(`glp1e2e_glp1_data`), així que pacients, catàleg i usuaris del 8099 queden
intactes. Les suites importen `BASE` d'`e2e/helpers.mjs` (font única: 8098 per
defecte, o `BASE_URL` si se n'especifica un altre).

`npm run e2e` passa per un **runner** (`e2e/runner.mjs`): arrenca la pila E2E,
fa un *snapshot* del servidor (`/tmp/opencode/glp1-e2e-server-snapshot.json`:
pacients **i catàleg de fàrmacs**, que les proves d'administració poden editar),
executa les 6 suites — que buiden la base per aïllar-se — i **restaura les dades
al final**, amb reintents. El *snapshot* i la restauració són un segon cinturó
de seguretat per si algú hi apunta amb `BASE_URL`.

Els tests E2E necessiten `playwright-core` (`npm install`) i un binari de
Chromium; es configura amb variables d'entorn:

```bash
CHROME_PATH=/ruta/a/chrome BASE_URL=http://127.0.0.1:8098/ npm run e2e
```

En aquesta màquina el Chromium de Playwright necessita
`LD_LIBRARY_PATH=/tmp/opencode/chlibs/usr/lib/x86_64-linux-gnu`.

---

### Git

El projecte viu a **github.com/spicouc/glp1** (branca `main`). Al final de cada
tongada de feina:

```bash
npm run push                 # git add -A + commit amb resum automàtic + push
npm run push -- "Missatge"   # missatge propi
```

- **`tools/git-push.sh`** no fa res si no hi ha canvis; si el push falla, el
  commit local es conserva i et diu com repetir-lo.
- **`.githooks/pre-commit`** (activat amb `git config core.hooksPath .githooks`)
  **bloqueja** qualsevol intent de pujar `.env`, `*.log`, `__pycache__/`,
  `node_modules/` o claus — protecció doble amb el `.gitignore`.
- Els secrets mai no surten del teu disc: `.env` (contrasenya d'admin) i els
  logs estan ignorats i, a més, el hook ho impedeix (prova: `git add -f .env`
  → el commit queda bloquejat).

---

## Arquitectura

Tres capes separades des del primer dia; canviar l'emmagatzematge no toca cap vista.

```
index.html
css/app.css                     estil únic (mobile first)
js/
  app.js                        bootstrap + límit d'errors + cicle de render
  i18n/
    index.js                    registre d'idiomes (t / tStatus)
    ca.js                       català (totes les cadenes de la UI)
  core/                         LÒGICA DE NEGOCI — pura, sense DOM ni storage
    drugs.js                    catàleg de fàrmacs + conversions clics↔mg
    calc.js                     saldos, dosis, projeccions, alertes
    model.js                    fàbriques d'entitats
    validate.js                 validació d'esquema i de backups
    dates.js                    dates ISO 'YYYY-MM-DD' (sense zona horària)
  data/                         REPOSITORI
    repository.js               API del repositori + adaptadors (localStorage, memòria)
    localRepository.js          instància per defecte (localStorage)
    migrations.js               cadena de migracions d'esquema (schemaVersion)
  ui/                           INTERFÍCIE
    dom.js modal.js state.js router.js
    components/                 summary, daySheet, adminForm, backup, presets
    views/                      patients, patient, calendar, treatment, pens, health, history
docker-compose.yml              pila de producció (glp1 + glp1-api)
docker-compose.e2e.yml          pila E2E aïllada (:8098, volum propi)
test/                           tests unitaris + acceptació (node --test)
e2e/                            proves de navegador (playwright-core)
                                runner.mjs (snapshot + suites + restauració),
                                smoke, pens, planner, backup, sync, helpers
```

### Per què sense build

La V1 és local-first i local: ES modules natius s'executen tal com estan, cosa
que permet servir l'aplicació des de qualsevol servidor estàtic i obrir-la des
del navegador del mòbil sense eina de compilació. Les capes són pròpies d'un
projecte amb arquitectura, no del bundler.

---

## Pantalla inicial (llistat de pacients)

La llista **només identifica el pacient**: codi, nom, any de naixement (si n'hi
ha) i l'estat *Arxivat*. Cap dada derivada (fàrmac, dosi, ploma, saldo,
alertes) — tot això apareix **en entrar a la fitxa**.

Accions per pacient: `Entra a la fitxa` · `Edita` · `Arxiva`/`Desarxiva` ·
**`Esborra`** · `Exporta`.

- **Esborrar** demana confirmació explícita amb recompte (*«Vols esborrar
  permanentment P-001? Es perdran 2 tractaments, 7 administracions i 4 dates
  de pla. Recomanem exportar-lo abans»*). Internament es marca com a **tomba**
  (`deletedAt`), de manera que **es sincronitza**: desapareix de tots els
  dispositius i **no torna a aparèixer en recarregar**. El servidor purga les
  tombes passats **30 dies** (`GLP1_TOMBSTONE_DAYS`) i la còpia de seguretat
  (`Exporta`) no les inclou. Si queden sense pacients, es mostra l'estat buit
  amb `Nou pacient`.
- A la fitxa de cada dia i al planner hi ha les esborranades respectives:
  `Treu-la del pla` (una data) i **`Esborra tot el pla`** (confirma i conserva
  les dates ja registrades a l'historial; els registres reals no es toquen).

## Dades al servidor (i còpia local)

Les dades **ja no viuen només al navegador**: la font de veritat és el
contenidor `glp1-api` (Python stdlib + SQLite, volum `glp1_data`), i cada
dispositiu conserva una **còpia local de recerca** per consultar-les sense
connexió.

```
Navegador ── https://glp1.cala-adsum.top ──► nginx (glp1)
                                              ├─ /      → fitxers de l'app
                                              └─ /api/  → glp1-api:8001 (SQLite al volum glp1_data)
```

- **Sincronització automàtica**: en desar s'envia al servidor (indicador
  *Pendent → Sincronitzant → Sincronitzat*) i en obrir l'app es baixa l'estat
  del servidor. Clicant l'indicador es pot forçar.
- **Merge per `updatedAt`**: guanya sempre la versió més recent de cada
  pacient; cap dispositiu perd dades si editen dos alhora.
- **Offline**: si el servidor no respon, es treballa amb la còpia local i
  l'indicador diu *Sense servidor · còpia local*; en recuperar-se, es fusiona.
- **Sense sessió no es carrega cap dada** (pantalla d'entrada).
- Còpies de seguretat: continua havent-hi `Exporta / Importa` (JSON local) i,
  a més, la base del servidor és un fitxer SQLite al volum `glp1_data`.

### Usuaris, tokens i administració

| Què | Com |
|---|---|
| Entrar | Pantalla d'entrada (usuari + contrasenya) → token de sessió al dispositiu (caduca als 30 dies) |
| Administració | Icona *Administració* a la pantalla de pacients (només per a admins) o `#/admin` |
| Usuaris | Crear (mínim 8 caràcters), **esborrar** (revoca els seus tokens), activar/desactivar, canviar contrasenya |
| Tokens d'API | Crear amb etiqueta (es mostra **un sol cop**) i revocar; per a scripts/dispositius |
| Fàrmacs | Editar **dosis estàndard**, dosis opcionals i notes d'escalat → s'aplica a tots els dispositius |

Rols: `admin` (tot) i `usuari` (llegeix i escriu pacients; no toca catàleg ni usuaris).
**Tots els usuaris comparteixen la mateixa base de pacients** (és una base
compartida de l'equip, no per-metge).

### Seguretat

- L'API **no publica cap port** (només accessible via nginx `/api/`).
- Contrasevia: PBKDF2-HMAC-SHA256 (200k iteracions) + salt.
- Tokens: aleatoris, se'n desa només el SHA-256, comparació constant, TTL 30 dies,
  revocables.
- Credencials d'arrencada al fitxer `.env` (`GLP1_ADMIN_USER` / `GLP1_ADMIN_PASSWORD`)
  — **canvia-la des de Administració → Usuaris** després del primer accés.

## Model de dades (`schemaVersion: 3`)

```jsonc
{
  "schemaVersion": 3,
  "id": "pat_…", "code": "P-001", "name": "", "birthYear": null, "notes": "", "archived": false,
  "treatments": [{
    "id": "trt_…", "drugId": "mounjaro",
    "startDate": "2026-11-01", "endDate": null,
    "status": "active",            // active | paused | finished
    "endReason": "", "notes": "",
    "deletedAt": null,             // tomba: tractament esborrat (es sincronitza)
    "autoPlan": false,             // continuació automàtica (efectiu)
    "autoPlanConsent": false,      // consentiment explícit: sense ell, autoPlan = false
    "costs": [                     // despeses en CÈNTIMS enters (mai floats)
      { "id": "cst_…", "date": "2026-11-01", "kind": "pen", "amountCents": 12900,
        "currency": "EUR", "penId": "pen_…", "notes": "", "source": "manual" }
    ],
    "pens": [{
      "id": "pen_…", "seq": 1,     // número visible congelat (#N)
      "presentationMg": 10,
      "startDate": "2026-11-01", "endDate": null,
      "status": "active",          // active | finished | discarded | deleted
      "deletedAt": null,           // tomba: ploma esborrada (es restaura/sincronitza)
      "capacityUnit": "clicks",    // clicks | doses (clics quan es coneixen)
      "initialCapacity": 240,
      "clicksPerDose": 60,         // clics d'una dosi completa (60/32/72/75…)
      "dosesPerPen": 4,            // dosis nominals de la ploma
      "startUsed": 0,              // consum prèvi (ploma ja començada)
      "conversion": null,          // conversió manual opcional (pen-specific)
      "expiryDate": null,          // caducitat impresa (control de caducitat)
      "openedAt": null,            // data d'obertura (inicia el termini)
      "priceCents": null, "currency": "EUR",
      "notes": ""
    }],
    "administrations": [{
      "id": "adm_…", "date": "2026-11-01", "penId": "pen_…",
      "mode": "clicks",            // standard | clicks
      "value": 15, "amount": 15, "unit": "clicks", "mg": 2.5,
      "injections": null,          // >1 quan la dosi supera la dosi completa
      "balanceBefore": 195, "balanceAfter": 180,
      "time": "08:30",             // hora local opcional (traçabilitat)
      "prescribed": null,          // snapshot de la dosi PRESCRITA {mode,value,mg}
      "source": "manual",          // manual | import
      "idempotencyKey": "…",       // deduplicació: mai dos descomptes
      "deletedAt": null,           // tomba: esborrat que es sincronitza
      "notes": "", "createdAt": "…", "editedAt": null
    }],
    "schedules": [                 // a la UI es diuen FASES
      { "id": "sch_…", "startDate": "2026-12-01", "mode": "clicks", "value": 30,
        "intervalDays": 7, "endDate": null, "durationDays": null,
        "status": "active" }       // active | done | cancelled
    ],
    "plans": [
      { "id": "pln_…", "date": "2026-11-20", "penId": "pen_…", "mode": "clicks", "value": 15,
        "amount": 15, "unit": "clicks", "mg": 2.5, "registeredAdminId": null, "notes": "",
        "status": "planned",       // planned | administered | postponed | omitted | cancelled
        "movedTo": null, "reason": "", "idempotencyKey": "…", "deletedAt": null }
    ],
    "health":    [{ "id": "hlh_…", "date": "…", "weightKg": 82.4, "nausea": 1, "vomiting": 0, "diarrhea": 0, "constipation": 0, "abdominalPain": 0, "otherEffects": "", "notes": "",
                    "source": "manual", "validated": false }]   // dada NO validada
  }]
}
```

### Regles immutabilitat

1. **Canviar la pauta no modifica cap administració ja registrada.** Un canvi de
   dosi és un nou tram de `schedules`, mai una edició retroactiva.
2. Cada administració desa `amount/unit/mg/balanceBefore/balanceAfter` com a
   **snapshot** en el moment de registrar.
3. Els saldos es recalculen **només** quan l'usuari edita o elimina un registre
   (acció explícita, amb avís).
4. Les plomes i tractaments antics mai s'esborren automàticament: canvien
   d'estat (`finished`, `discarded`) i es conserven amb totes les seves dades.
5. Els arxius no es substitueixen mai sense confirmació explícita.
6. **Esborrar és una tomba (`deletedAt`), mai un esborrat físic**, a tots els
   nivells: pacients, tractaments, plomes, administracions i propostes. Així
   l'esborrat **es sincronitza** i un dispositiu amb codi vell no el pot
   ressuscitar (les tombes es purgen passats `GLP1_TOMBSTONE_DAYS`).

### Autoritat del servidor (i auditoria)

La pujada (`PUT /api/patients`) ja no és un simple «guarda el document»: dins de
la mateixa transacció el servidor

| Regla | Què fa |
|---|---|
| **Absent ≠ esborrat** | Una entitat que el client no envia no és un esborrat (un mòbil amb codi vell simplement no la coneix) → **es conserva**. Les esborranades reals arriben com a tomba i sí que es propaguen |
| **Duplicats** | Mateixa ploma + data + quantitat + unitat, o mateixa `idempotencyKey` → **es descarta l'entrant** i es conserva el primer: una dosi es consumeix **una sola vegada** |
| **Saldos** | `balanceBefore/balanceAfter` es recalculen sempre (cap dispositiu pot propagar saldos vells) |
| **Propostes** | Una administració que coincideix amb una proposta pendent la **tanca**; si l'administració es tomba, la proposta **torna a quedar pendent** |
| **Auditoria** | Cada creació/modificació/esborrat queda a `audit_log` (append-only, amb actor i abans/després). Consulta: `GET /api/patients/<id>/audit` (admin) o la pestanya **Auditoria** de l'administració (tria pacient → llista amb actor, acció, entitat i el *abans → després*) |
| **Purga** | Les tombes de més de `GLP1_TOMBSTONE_DAYS` (30) s'eliminen |

A més, el client **descobreix les capacitats del servidor** (`/api/me` →
`capabilities`) i, si la versió del servidor és més nova que la del codi
executant, demana recarregar: una pestanya amb codi vell no pot pujar documents
incomplets.

### Tres tipus de dada, visualment diferenciats

| Tipus | Exemple | Com es mostra |
|---|---|---|
| **real** | `30 clics` | fons sòlid verd, pill `REGISTRE REAL` |
| **derived** | `24 dosis completes` | pill blau discontínu `CALCULAT` |
| **projected** | `15 clics` el 01/12 | vora discontínua violeta, pill `PROJECCIÓ` |

---

## Catàleg de fàrmacs

`js/core/drugs.js` és **dades pures**: afegir un medicament nou no toca el model
ni la UI (els selectors es deriven del catàleg).

| Fàrmac | Freqüència | Dosis estàndard | `clickMode` |
|---|---|---|---|
| Mounjaro (tirzepatida) | setmanal | 2,5 – 15 mg | `theoretical` |
| Ozempic (semaglutida) | setmanal | 0,25 / 0,5 / 1 / 2 mg | `pen-specific` |
| Wegovy (semaglutida) | setmanal | 0,25 / 0,5 / 1 / 1,7 / 2,4 (+7,2 opc.) | `pen-specific` |
| Saxenda (liraglutida) | **diària** | 0,6 – 3 mg | `unsupported` |
| Victoza (liraglutida) | **diària** | 0,6 / 1,2 / 1,8 mg | `unsupported` |
| Trulicity (dulaglutida) | setmanal | 0,75 / 1,5 / 3 / 4,5 mg | `fixed-dose` |

Camps del catàleg que determinen la interfície **sense tocar cap vista**:

| Camp | Què fa |
|---|---|
| `penStrengthsMg` | **llista de plomes triables** al diàleg de tractament i a *Plomes*: Mounjaro 2,5–15 · Wegovy 0,25–2,4 · **Ozempic 0,25 · 0,5 · 1 · 2** (FlexTouch, totes de 4 dosis) · Trulicity 0,75 · 1,5 · 3 · 4,5 (cada ploma d'una dosi fixa). Sense llista (Saxenda, Victoza) es deixa un camp numèric lliure. |
| `intermediateDosesMg` | **presets de dosi** que no són dosi estàndard: Mounjaro `3,75 · 6,25 · 8,75` i Ozempic `0,75 · 1,5`. |
| `dosesPerPen` | dosis nominals de la ploma (4 a Mounjaro/Wegovy/Ozempic/Trulicity, 30 a Saxenda/Victoza). |
| `catalogVersion` | versió del catàleg base (ara **3**). El catàleg guardat al servidor amb una **versió antiga es descarta** (així una actualització de l'app no deixa camps nous sense aplicar — va passar amb les plomes d'Ozempic); les edicions fetes des de l'administració **segellen la versió actual** i continuen guanyant. |

La presentació es **deriva de la dosi triada** (`presentationForDose`): si la
dosi no és exacta de cap ploma, es tria **la més petita que la admet** (6,25 mg
→ ploma de 7,5 mg; 0,75 mg d'Ozempic → ploma d'1 mg) i, si la supera totes, la
més gran.

### Clics i dosis: què fa l'aplicació per a cada fàrmac

| Fàrmac | `clickMode` | Comportament |
|---|---|---|
| **Mounjaro** | `theoretical` | Mode clics actiu per defecte: `mgPerClick = presentació / 60` (60 clics = dosi nominal). En ploma de **15 mg**: 2,5 mg = **10**, 5 mg = **20**, 7,5 mg = **30**; en ploma de 2,5 mg: 2,5 mg = 60. Sempre amb avís *"Equivalència teòrica"* i recordatori que la KwikPen és de quatre dosis fixes. |
| **Wegovy** | `pen-specific` | Taules orientatives **per presentació** registrades: ploma 0,25 mg → **32 clics**; 1,0 mg → **72 clics**; 2,4 mg → **75 clics** (FlexTouch 3 ml, de tercers). Activades només per a aquestes presentacions; 1,7 mg queda sense conversió fins que se n'adjunti una. |
| **Ozempic** | `pen-specific` | **Clics per defecte, com a la resta de plomes**: taules registrades per presentació (FlexTouch) i capacitat en clics. El fabricant recomana marcar la dosi amb el **selector de dosis**, així que cada taula porta el seu avís i `sourceType: third-party`; les plomes FlexTouch es poden triar (0,25 · 0,5 · 1 · 2 mg). |
| **Victoza** | `unsupported` | La ploma té **10 clics entre dosis marcades** (0,6 mg) → taula adjuntable amb dosis intermèdies (0,3 mg = 5 clics, 0,9 = 15, 1,5 = 25). |
| **Saxenda** | `unsupported` | Instruccions: **no comptar clics** (el so pot variar). Sense taula: es pot adjuntar-ne una de pròpia si se'n té font. |
| **Trulicity** | `fixed-dose` | Ploma monodosi sense selector: **no es pot ajustar ni comptar clics**; cada administració consumeix 1 unitat. |

**Taula de clics d'Ozempic** (per presentació de ploma, totes de 4 dosis;
comptatges de [count.click](https://count.click/es/calculadora-clics-ozempic)
sobre volums de l'EPAR/EMA):

| Ploma | Dosi completa | 0,25 mg | 0,5 mg | 0,75 mg | 1 mg | 1,5 mg | 2 mg | Capacitat |
|---|---|---|---|---|---|---|---|---|
| 0,25 / 0,5 mg · 2 mg/1,5 mL | **32** | 16 | 32 | – | 64* | – | – | **128 clics** (2 mg) |
| 1 mg · 4 mg/3 mL | **72** | 18 | 36 | 54 | 72 | 108* | – | **288 clics** (4 mg) |
| 2 mg · 8 mg/3 mL | **72** | 9 | 18 | 27 | 36 | 54 | 72 | **288 clics** (8 mg) |

`*` dosi més gran que la dosi completa → l'aplicació l'avisa: **es parteix en
diverses injeccions**. Una conversió **adjuntada a la ploma** guanya sempre
sobre la taula del catàleg (per exemple, per a la variant de 3 mL).

**Regles de la interfície:**

- Els clics **mai s'activen sols** en fàrmacs `unsupported`: només si l'usuari
  adjunta explícitament una conversió a la ploma (`enabled-manual`), amb el seu
  avís.
- La conversió és sempre **medicament + presentació + model de ploma**; mai una
  taula global. Cada conversió porta `{sourceType, verified, warning, lastReviewed}`.
- A les plomes de les quals es coneixen els **clics per dosi completa**
  (Mounjaro i Wegovy per presentació) la capacitat es desa en **clics** i el
  consum és exacte: es poden registrar mitges dosis i clics solts. A les de
  **doses** (Ozempic, Saxenda, Victoza, Trulicity) el consum real és **1 dosi
  per administració** i els clics només serveixen per a la dosi (registre de
  mg). L'equivalència es mostra a la fitxa, al registre ràpid i al planner, i
  quan no n'hi ha es diu per què (nota del fàrmac).
- **Presets de dosi** (prenent de [count.click](https://count.click/es)): sota
  dels xips hi ha `½ dosi` i `¼ dosi` de la ploma triada i les **dosis
  intermèdies** del fàrmac (`3,75 · 6,25 · 8,75 mg` a Mounjaro); el que ja és
  dosi estàndard no es duplica. Abans només es podien triar les dosis del
  catàleg.
- **Dosi partida en injeccions**: quan la dosi supera la dosi completa de la
  ploma (més clics dels que la ploma marca en una injecció) l'aplicació ho
  calcula i **avisa** (*«⚠ Aquesta dosi supera la dosi completa de la ploma:
  es parteix en 2 injeccions (90 clics)»*), i la fitxa del dia mostra el xip
  `2 injeccions`. És un càlcul informatiu, mai una decisió clínica.

### Esborrar el registre de dosis

A la pestanya **Tractament**, cada fitxa té **`Esborra el registre de dosis`**
(amb confirmació) per tornar-lo a registrar de nou:

- Esborra **totes les administracions** del tractament (només les reals).
- Els **saldos de les plomes tornen a la capacitat inicial** i les **dates de
  pla tornen a quedar pendents**.
- **Es conserven** plomes, pla, pauta i registres de pes/efectes.
- No confondre amb `Esborra el tractament` (borra tot, inclòs plomes i pla).

### Selector global de tractament

Quan un pacient té més d'un tractament, la fitxa mostra un **selector** just a
sota del resum. Canvia de tractament **a totes les pestanyes** (calendari,
plomes, pes, historial) i per defecte es veu l'actiu. És una decisió de *vista*:
l'historial de l'anterior no es toca mai i la lògica de negoci (alertes,
propostes, registre) continua usant el tractament **actiu**.

### Un sol tractament actiu

En crear un tractament amb estat *Actiu*, l'anterior tractament actiu es tanca
automàticament (`finalitzat`, amb data final = dia abans i motiu
*"Substituït per un tractament nou"*). Cap dada es perd: plomes,
administracions, pla i registres de salut es conserven a l'historial.

La conversió queda vinculada a **medicament + presentació + model de ploma**,
mai a una taula universal.

### Equivalències sempre visibles

L'equivalència clics ↔ mg es mostra a tot arreu on hi ha una dosi (mai amagada):

- **Línia `EQUIVALÈNCIA 2,5 mg = 60 clics [Equivalència teòrica]`** a la fitxa
  del pacient, al registre ràpid del calendari i al planner de pla.
- **Xips de dosi de dues línies**: a sobre la dosi en mg, a sota els clics
  (`2,5 mg` / `60 clics`) calculats per a **la presentació de la ploma triada**.
- **Fitxa d'un dia**: dosi administrada, equivalència i avís teòric.
- Si la ploma **no té conversió** (Ozempic, Saxenda, Victoza, Trulicity) es diu
  explícitament: *«Aquesta ploma no té equivalència clics ↔ mg definida.»*

### Dosi i ploma inicials al iniciar un tractament

El diàleg **Nou tractament** permet triar **fàrmac**, **dosi inicial** i **amb
quina ploma s'inicia**:

- Les dosis dels xips les determina el catàleg del fàrmac triat (canviar de
  fàrmac les recarrega) i s'hi afegeixen les de manteniment opcionals si n'hi ha.
- Sota els xips es mostra sempre l'**equivalència de la dosi triada**
  (`EQUIVALÈNCIA · 5 mg = 60 clics · Equivalència teòrica`), calculada amb la
  ploma seleccionada: si canvies la presentació, l'equivalència **es recalcula**
  (ploma de 10 mg i dosi de 5 mg → `5 mg = 30 clics`).
- Amb l'opció **«Inicia la ploma automàticament»** (per defecte marcada) es
  trien les dades de la ploma #1 al mateix diàleg:

  | Camp | Per defecte | Canviable |
  |---|---|---|
  | Presentació | la dosi triada (ex. dosi 5 mg → ploma de 5 mg) | sí (selector de forces del catàleg o nombre lliure) |
  | Capacitat | la del catàleg (ex. 240 clics) | sí |
  | Unitat | `clics` / `doses` segons el fàrmac | sí |

  La pista ho resumeix en tot moment: *«Es crearà la ploma #1 amb aquestes
  dades: 10 mg · 120 clics»*. Si desactives el switch, els camps s'amaguen i no
  es crea cap ploma (n'afegirems una després a *Plomes*).
- La dosi triada es desa com a **pauta inicial** del tractament (es pot
  modificar després des de la pestanya Tractament, amb abast futur).

Així es pot registrar la primera dosi sense un pas extra; la ploma es pot
ajustar després des de la pestanya **Plomes**.

### Plomes: capacitat en clics, esborrar i restaurar

La pestanya **Plomes** gestiona les plomes del tractament actiu (l'històric en
una llista separada i, quan n'hi ha, la **paperera**).

**La capacitat es desa en Clics (unitat real) sempre que se'n coneguin els
clics per dosi completa**; les dosis es deriven (i al revés):

| Ploma | Clics per dosi | Capacitat |
|---|---|---|
| Mounjaro KwikPen | 60 | 240 clics = 4 dosis |
| Wegovy FlexTouch 1,5 mL (0,25 mg) | 32 | 128 clics = 4 dosis |
| Wegovy FlexTouch 3 mL (1,0 mg) | 72 | 288 clics = 4 dosis |
| Wegovy 2,4 mg (taula de tercers) | 75 | 300 clics = 4 dosis |
| Ozempic / Saxenda / Victoza / Trulicity | desconeguts | es queden en dosis |

Les plomes existents en `doses` **es migren soles** en carregar el pacient
(capacitat, administracions, propostes i saldos registrats passen a clics;
procés **idempotent**, no es converteix dues vegades).

La fitxa mostra sempre les dues vistes i el resum tipus count.click:

> *Capacitat: 240 clics = 4 dosis de 60 clics · 0,167 mg per clic · Saldo: 180
> clics = 3 dosis · Queden 3 dosis completes · A la dosi actual (2,5 mg) hi
> caben 12 dosis*

**Formulari de ploma**: presentació, **capacitat**, **clics per dosi completa**,
**dosis per ploma**, data d'inici i **ploma ja començada** (clics ja usats abans
de començar-ho a registrar, que resten del saldo — útil quan et trobes una ploma
a mig ús). Una **vista prèvia en directe** calcula la capacitat resultanta, el
saldo i quantes dosis hi caben; si el saldo quedaria negatiu, el desament es
bloqueja amb un missatge que diu quin és el consum mínim que s'ha de respectar.
En editar la capacitat es recalculen els saldos «abans/després» d'aquella ploma.

**Esborrar i restaurar** — cada fitxa té el botó `Esborra` (també la ploma
activa):

- Si té dades, el diàleg proposa **`Mou les dades i esborra`** (per defecte): les
  administracions i les propostes passen a la **ploma de destí** (per defecte la
  més propera en el temps) i **es recalculen els seus saldos**. L'historial no es
  perd mai.
- L'alternativa **`Esborra també les dades`** elimina administracions i
  propostes d'aquella ploma, amb confirmació explícita i recomanació d'exportar
  abans.
- La ploma queda a la **paperera** com a tomba (`status: 'deleted'` +
  `deletedAt`), perquè l'esborrat **sincronitzi** als altres dispositius, i es
  pot **`Restaura`**. Si era l'activa, la més recent restant hi torna.
- El **número de ploma (#N) es congela a l'alta** (`seq`): esborrar-ne una
  **no renumera** la resta, així que el pla, l'historial i les notes continuen
  apuntant al mateix número.

### Esborrar un tractament

A la pestanya **Tractament** de qualsevol pacient, cada fitxa de tractament
té el botó **`Esborra`** (vermell), amb confirmació explícita que recomana
exportar el pacient abans:

> *Vols esborrar el tractament Mounjaro? Es perdran 2 plomes, 7
> administracions, 4 dates de pla i 2 registres de salut.*

S'elimina el tractament i **totes les seves dades** (plomes, administracions,
pla, pauta i registres de salut). Si el pacient es queda sense tractaments,
les pestanyes mostren l'estat buit amb `Nou tractament`. L'alternativa no
destructiva és `Finalitza`, que conserva tot l'historial.

---

## Calendari i registre ràpid

1. Selecciona **ploma** — el selector llista **totes les plomes visibles** del tractament amb el seu número i estat (`#1 · 1 mg · Acabada`, `#2 · 0,5 mg`), per defecte l'activa —, **mode** (dosi estàndard / clics) i **valor**.
2. Toca qualsevol dia buit → es demana **confirmació explícita** (*«Registrar
   15 clics el 08/11/2026? …»*, amb dosi, data i ploma) i, en acceptar, es crea
   una administració **independent** amb el valor seleccionat en aquell moment.
   Fins que no es confirma **no es desa ni es descompta res**.
3. Canvia el selector (p. ex. de 15 a 30 clics) i toca un altre dia → el registre
   nou és de 30 i **els anteriors continuen sent de 15**.
4. Tocar un dia ja registrat obre la fitxa: *Administrat / Equivalent calculat /
   Ploma (abans → administrats → després)* amb **Edita** i **Elimina**.
5. Cada registre mostra el saldo resultant (`Resta: …`).

Cada dia distingeix: administració registrada (sòlid), **dosi prevista del pla**
(discontinu, tintada amb el color de la ploma i etiqueta `#n`), pauta prevista
(discontinu violeta) i dia actual.

### Modes: Registre | Pla

El calendari té dues eines separades (selector a dalt):

| Mode | Què fa | Què toca |
|---|---|---|
| **Registre** | tocar un dia buit demana **confirmació** (dosi · data · ploma) i després crea una **administració real** amb el valor seleccionat | saldo real de la ploma |
| **Pla** | tocar un dia hi posa una **dosi prevista** (entrada `plans`) | res del passat |

**Pla (dissenyar el calendari segons les plomes):**

> El pla és una **PROPOSTA** de calendari: no crea administracions i no toca el
> saldo real. La dosi esdevé registre real **només quan la registres**. La nota
> es mostra sempre dins del planner i la fitxa de cada data marcada amb
> l'etiqueta **«Proposta»**.

1. **En entrar al mode Pla amb un tractament sense pla, l'app proposa el
   tractament ESTÀNDARD** del fàrmac (primera dosi del catàleg, cadència del
   fàrmac i tantes dosis com hi capiguin a la ploma). Es fa un sol cop per
   tractament: es pot modificar o esborrar al teu gust.
2. Tria **ploma**, **dosi**, **data d'inici**, **interval** i **nombre de dosis**
   (la pista mostra quines dosis cap la ploma amb aquesta quantitat).
3. `Genera el pla` reparteix les dates (p. ex. ploma #3 = 4 dosis els dies
   20/11, 27/11, 4/12 i 11/12). Tornar a generar **reemplaça** el pla d'aquesta
   ploma (amb confirmació); `Esborra tot el pla` l'esborra (conserva les dates
   ja registrades). Cap acció toca registres reals.
4. **Disseny progressiu amb diferents dosis**: canvia la dosi al selector i
   prem **`Afegeix un tram al pla`** → s'annadeix **després de l'última data
   planificada** (la pista en diu la data) i **no modifica res** del que ja hi
   ha. Així es pot dissenyar, per exemple, 2,5 mg fins al 11/12 i 5 mg a partir
   del 15/12, tram a tram.
5. **Pujar o abaixar la dosi de cop (abast)**: tria la dosi i prem
   **`Aplica la dosi a les propostes`** amb abast **`Tot el pla`** (per
   defecte) o **`A partir de la data`** → canvia les propostes pendents
   d'aquella ploma (pujar o baixa) en una sola acció, amb confirmació i
   recompte (*«Aplicar 2,5 mg a les 6 propostes de TOT el pla? Els registres
   reals no es toquen»*). Així no cal editar-les una a una.
6. **Cobertura de les plomes**: cada ploma amb el seu color, quantes dosis
   planificades, de quina data a quina, què en quedarà després del pla i, si la
   ploma no arriba, quant falta i des de quina data.
7. **Ploma següent**: quan la ploma planificada s'esgota, l'app proposa la data
   d'inici de la següent (última data planificada + interval) amb un botó
   `Crea la ploma següent` que obre l'alta amb la data ja triada.
8. Tocant una data prevista s'obre la fitxa amb: `Registra aquesta dosi`
   (esdevé administració real i l'entrada queda com a **feta**, visible a
   l'historial), `Edita la dosi prevista` (mou data, canvia ploma o dosi) i
   `Treu-la del pla`.
9. En registrar una data real que té pla amb la mateixa ploma **i la mateixa
   dosi**, l'entrada queda **enllaçada automàticament**; si esborres
   l'administració, la data torna a quedar pendent.

#### Eina de calendari: Pinta / Esborra / Consulta

Al mode Pla apareix una **barra fixa, sempre visible a baix** de la pantalla
(com una barra d'eines de pintura) per editar molts dies seguits **sense obrir
cap diàleg**. Hi viu **tot el disseny de dosis**: dalt les eines
(`Consulta · Pinta · dose · Esborra`) i a sota els **xips de dosi + presets** (i
el camp de clics lliures si el mode és clics) — mateix estat que la targeta del
planificador, així que la tria es reflecteix a tot arreu. Fa ~105 px, deixa
espai al final de la vista per no tapar res i els avisos hi pugen a sobre:

| Eina | Què fa en tocar un dia |
|---|---|
| **Consulta** (per defecte) | obre la fitxa del dia (proposta o registre), com sempre |
| **Pinta** | hi **posa o hi canvia** la dosi triada **a la mateixa barra**; el botó la mostra (`Pinta · 5 mg`) |
| **Esborra** | **treu** la proposta d'aquell dia (amb `Desfés`) |

- Cada acció de pintar/esborrar té **`Desfés`**.
- Les dates amb **registre real** sempre obren la fitxa: aquestes eines **només
  toquen propostes** de pla; mai es modifica cap dada ja registrada, i una
  proposta ja registrada (enllaçada a una administració) també queda protegida.
- L'eina, com la dosi i l'abast, es desa per pacient. La targeta de
  **Planificació** (interval, dates, generar, abast d'aplicació i la pista de
  les eines) es queda a dalt, on sempre ha sigut.

#### Continuació automàtica (switch per defecte **desactivat**)

Registrar una administració **mai reescriu el pla**: el registre, l'enllaç i
l'extensió són tres passos separats.

1. **Enllaç**: la proposta d'aquesta data i ploma queda tancada (`administered`)
   **encara que la dosi registrada no coincideixi amb la prevista**: la
   proposta conserva la dosi *prescrita* i l'administració, la *real*.
2. **Extensió** (només amb consentiment): amb el switch *«Continua la dosi les
   setmanes següents»* activat, s'afegeixen dates **futures** noves fins tenir
   **4 dates previstes al davant**, amb la dosi i l'interval del **disseny**
   (mai amb la dosi que es va punxar, ni inferint increment). L'àncora és
   l'última data del pla i **mai no es genera una data passada**: si el pla és
   antic, el primer tràfec és la pròxima data ≥ avui.
3. **Re-nivellació**: **no existeix** en registrar. Canviar les propostes ja
   escrites només passa per edicions explícites amb previsualització (editor de
   fases, eina Pinta, editor de la data prevista o l'opció «actualitzar les
   futures» en editar una dosi real).

El consentiment és explícit i per defecte **fora**: `autoPlanConsent` (`false`
també als tractaments creats abans del canvi, perquè l'interruptor antic estava
sempre encès i ningú el va activar a propòsit). El servidor en deriva
`autoPlan` a cada pujada, així que un client vell no pot reactivar-la.

S'atura també quan: la ploma ja no és activa · la ploma no admet més dosis
(llavors toca `Crea la ploma següent`) · ja hi ha prou dates futures · hi ha
una data ocupada (administració real o proposta, **en qualsevol estat**: les
omeses i cancel·lades segueixen reservant la seva data) · la ploma no arriba
a cobrir-ne més.

Mai toca registres reals (i `Desfés` del registre restaura el pla tal com estava).

#### Modificar dosis futures

| On | Opció |
|---|---|
| **Editant una data prevista** | abast per defecte **`Aquesta i les futures (N)`**: la dosi modificada mana sobre les següents (amb confirmació prèvia; `Cancel·la` = només aquesta data, sense perdre l'edició). També pots triar **`Aquesta fase`** (només el tram de pauta que conté la data) o `Només aquesta data`. Si es mou la data, les posteriors **es desplacen conservant l'interval**. |
| **Editant una administració real** | després de desar, si hi ha dosis futures pendents d'aquella ploma pregunta *«Vols actualitzar també les N dosis futures del pla?»*. |

En tots dos casos la propagació només afecta **entrades pendents** del pla:
les ja registrades i els registres reals mai es modifiquen.

Els plans també generen alerta informativa si no caben a la ploma
(`plan-pen-short`) i apareixen a l'Historial amb el filtre `Pla`.

#### Estats de la proposta

Una data prevista té **estat**, i l'estat es veu a la casella del calendari, a
la fitxa del dia i a l'Historial:

| Estat | Què vol dir | Com s'hi arriba | Efecte |
|---|---|---|---|
| **Prevista** | pendent de fer | per defecte | compta com a pla i ocupa saldo previst |
| **Ajornada** | es farà un altre dia | `Ajorna` → data nova + motiu | es mou de data (**es conserva l'original**), segueix sent pendent; es pot desplaçar tot el pla posterior per mantenir l'interval |
| **Omesa** | no es farà | `Omet` → motiu | **fora dels pendents** (no compta ni ocupa saldo), queda amb traça |
| **Cancel·lada** | treta del pla | `Cancel·la la dosi` → motiu | igual que l'omesa |
| **Registrada** | convertida en administració real | `Registra aquesta dosi` | passa a l'historial real |

`Torna al pla` (a la fitxa del dia) desfés una omissió, una cancel·lació o un
ajornament. Cap d'aquestes accions toca mai un registre real.

#### Fases del tractament (pauta)

La pauta es dissenya per **fases** (la col·lecció es diu `schedules`, a la UI
*Fases*): cadascuna té **dosi, interval, data d'inici, durada i data de fi**
(la durada i la fi es calculen l'una de l'altra) i un estat (*en curs · feta ·
cancel·lada*). Les fases futures poden tenir **data de fi** o quedar **obertes**
(quan n'acaba una, comença la següent).

En crear o editar una fase amb propostes dins del seu tram, l'aplicació pregunta
*«El pla proposa N dates dins d'aquesta fase. Aplicar-hi el canvi?»* — amb
confirmació explícita i **només sobre propostes** (mai sobre registres reals).
L'interval de la fase també mana sobre la continuació automàtica del pla.

### Esquemes i migracions

`schemaVersion: 3` — la V1 (sense `plans`) i la V2 (sense camps nous) s'importen correctament: la cadena de
migracions `0 → 1 → 2` s'aplica en carregar i en importar, i mai es perden
dades existents.

---

## Inventari de plomes, costos i dashboard

### Caducitat, obertura i preu

A cada ploma (pestanya *Plomes*) es poden registar tres dades d'inventari:

| Camp | Què és |
|---|---|
| **Caducitat** | la data impresa a la ploma (si en portes) |
| **Data d'obertura** | el dia que es va obrir; si el catàleg té la validesa un cop oberta (`openShelfLifeDays`), calcula el límit |
| **Preu (€)** | preu de compra → es deriva el **cost per dosi** |

La fitxa de la ploma ho mostra (`Caduca el… (queden N dies)`, `Oberta el…`,
`Cost: 129,00 € · 32,25 € per dosi`) i la targeta treu la xip **Caduca aviat**
(≤30 dies) o **Caducada**. A les alertes de la fitxa apareix
*«La ploma caduca d'aquí a N dies»*.

⚠ **El catàleg NO porta valores de validesa per defecte**: són dades de la fitxa
tècnica (RCP) i s'han d'entrar des d'**Administració → Fàrmacs**
(`openShelfLifeDays` + la seva font). Sense dada, l'app **no inventa cap
caducitat calculada**.

### Costos

La pestanya *Tractament* té la targeta **Costos del tractament**: suma el preu
de les plomes visibles + les despeses registrades (`Nova despesa`: data, tipus,
import en €, notes) i mostra el **total**. Tot es desa en **cèntims enters**.

### Dashboard de la fitxa

A més de la dosi actual, l'última administració i la propera data prevista, la
fitxa del pacient mostra una segona fila d'indicadors:

| Indicador | Valor |
|---|---|
| **Setmana** | setmana de tractament (1-based, des de la data d'inici) |
| **Pes** | últim pes registrat (+ variació respecte l'anterior) |
| **Inventari** | dosis completes restants i plomes vives |
| **Costos** | total del tractament |

### Dades de salut no validades

Cada entrada de *Pes i efectes adversos* és **manual per defecte** i es mostra
amb la xip **NO VALIDAT**. Un professional la pot marcar com a **Validada** des
de l'edició. Aquestes dades **mai entren a la lògica posològica** (ni dosis ni
saldos): només alimenten el gràfic i el dashboard.

---

## Saldo, projecció i alertes

```
saldoActual = capacitatInicial − Σ(consumAdministracions)

dosisCompletes = floor(saldo / dosiPrevista)
sobrant        = saldo % dosiPrevista
```

- La **projecció** recorre els trams de `schedules` (data d'inici + valor + mode
  + interval) a partir de l'última administració real i mostra el saldo
  resultant de cada pas, marcant on la ploma es queda curta.
- **Alertes informatives**: `insufficient-pen` (falten N clics), `pen-runs-out`
  (s'esgotarà el DD/MM), `no-active-pen`, `unregistered-scheduled` i
  `overdue-administration`. Cap d'elles conté una recomanació clínica.

---

## Emmagatzematge i còpies de seguretat

- **Local-first**: `localStorage` (`glp1.db.v1`) darrere de
  `createRepository(adapter)`. Migrar a IndexedDB / Supabase / servidor propi
  implica escriure un altre adaptador (`read`/`write`) i no tocar cap vista.
- **Exporta tota la base** → `glp1-pacients-backup.json`
  (`{app, schemaVersion, exportedAt, patients}`).
- **Exporta un pacient** → `pacient-P001.json`.
- **Importació** amb validació d'esquema, previsualització (pacients, tractaments,
  plomes, administracions, període) i tria explícita entre
  *Afegeix els pacients nous* i *Substitueix tota la base* (aquesta amb
  confirmació). Un fitxer de versió futura o invàlid **no** permet substituir.
- Les dades viuen al servidor Docker (SQLite, volum `glp1_data`) i a la còpia
  local de cada navegador; no hi ha analítica ni serveis externs.
- **Còpia de seguretat completa** (fora del projecte), generada abans de tocar
  el sistema de plomes a `/home/vinegart/backups/`:
  - `glp1-src-<data>.tar.gz` — codi font (sense `node_modules`);
  - `glp1-data-<data>.sqlite3` — `sqlite3 .backup` en calent del volum, amb
    `PRAGMA integrity_check`;
  - `glp1-patients-<data>.json` — export de tots els pacients via API.
- **E2E mai perd dades**: `npm run e2e` fa *snapshot* → 5 suites → **restaura**
  (`npm run e2e:restore` per restaurar a mà).

---

## Criteris d'acceptació (apartat 23–24)

`test/acceptance.test.mjs` reprodueix el flux complet:

1. crear pacient (`P-001` automàtic) → 2. iniciar tractament Mounjaro →
3. ploma de 240 clics → 4. registrar 15 clics tocant 4 dates →
5. canviar a 30 clics **sense tocar els anteriors** →
6. saldo 240 − 134 = **106** → 7. programar canvi futur de pauta →
8. projecció 15/15/30/30/30 amb **falten 14** →
9. `completeDoses(76, 30) = 2 + 16` → 10. alertes sense recomanacions clíniques →
11. nova ploma mantenint l'anterior → 12. finalitzar tractament i crear-ne un
segon **sense perdre cap dada** → 13. export/import conserva la integritat.

`e2e/smoke.mjs` fa el mateix flux a través de la interfície real (mòbil 390×844)
i verifica que **el document mai supera l'ample de pantalla**: si desborda,
el navegador mòbil eixampla el *layout viewport* i el peu dels diàlegs (els
botons) queda fora de l'àrea visible — per això `#app-root` retalla
l'horitzontal i les etiquetes de les targetes no poden desbordar.
`e2e/pens.mjs` verifica el sistema de plomes (capacitat en clics, fitxa i
metadades, ploma ja començada, **esborrar movent les dades**, paperera i
**restaurar**, presets de dosi, avís i xip d'injeccions partides) i la
**tria de plomes d'Ozempic** (selector amb 0,25 · 0,5 · 1 · 2 mg, ploma creada
amb la presentació triada i selector del registre ràpid amb les dues plomes),
`e2e/planner.mjs` verifica el calendari de pla (generar, tocar dies, registrar
una data prevista i persistència) i `e2e/backup.mjs` comprova exportació,
validació d'importació i confirmació de substitució.

`test/plan.test.mjs` cobreix a més: repartició de dates del pla, detecció de
ploma insuficient, càlcul de cobertura, enllaç pla ↔ administració **fins i
tot amb discrepància de dosi**, suggeriment de ploma següent,
**continuació automàtica només amb consentiment** (i que registrar **no
reescriu** cap proposta futura ni en inventa de noves), **mai dates passades**,
**propagació de canvis a les dosis futures** i migració v1 → v2.

`test/pens.test.mjs` cobreix el sistema de plomes: derivació de clics per
dosi, migració **doses → clics**, consum prèvi, resum de dosis, **esborrar
movent/esborrant les dades** (tomba, numeració congelada, promoció de l'activa),
**restaurar**, presets i validació de l'esquema amb plomes esborrades.

`e2e/planner.mjs` verifica el calendari de pla de punta a punta: generar,
tocar dies, registrar una data prevista, **interruptor de continuació per
defecte desactivat** i **allargament automàtic amb consentiment explícit**,
**edició d'una dosi aplicada a les futures** i persistència.

`e2e/planestats.mjs` verifica a més que **registrar una dosi diferent de la
prevista deixa intactes les propostes futures** (P0) i que el registre demana
confirmació abans de crear cap administració real.

Les re-renderitzacions de fons (p. ex. l'avis de sincronització, amb debounce
de 900 ms) **no esborren un formulari a mig omplir**: `render()` les salta si
hi ha un camp enfocat (`js/app.js`).

---

## Pendents (fora de l'MVP)

- PWA completa (manifest + service worker per a offline).
- Migració a IndexedDB i/o servidor opcional (la capa ja està aïllada).
- Internacionalització completa (l'arquitectura de diccionaris ja hi és;
  `js/i18n/index.js` amb `registerLocale`).
- Estadístiques avançades i informes PDF.
