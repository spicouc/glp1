#!/usr/bin/env python3
"""
API de dades de glp1 — Python (stdlib) + SQLite.

Cap dependències externes: http.server, sqlite3, hashlib, secrets.

Rutes
  GET    /api/health                     (sense auth) estat del servidor
  POST   /api/auth/login                 (sense auth) usuari+contrasenya → token
  POST   /api/auth/logout                revoca el token actual
  GET    /api/me                         perfil + resum de sincronització
  GET    /api/patients                   baixada (pull)
  PUT    /api/patients                   pujada (push) amb merge per updatedAt
  GET    /api/drugs                      catàleg de fàrmacs (amb edicions de l'admin)
  PUT    /api/drugs                      (admin) desa el catàleg editat
  GET    /api/users                      (admin)
  POST   /api/users                      (admin) crea usuari
  PATCH  /api/users/<id>                 (admin) desactiva / canvia rol / contrasenya
  GET    /api/tokens                     (admin) llista de tokens
  POST   /api/tokens                     (admin) crea token (es torna un sol cop)
  POST   /api/tokens/<id>/revoke         (admin) revoca

Seguretat
  - Contrasenyes: PBKDF2-HMAC-SHA256 (200k) + salt per usuari.
  - Tokens: aleatoris, es guarda només el SHA-256, comparació constant.
  - El contenedor NO publica port: només es accessible via nginx (/api/).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("GLP1_DATA", "/data")
DB_PATH = os.environ.get("GLP1_DB", os.path.join(DATA_DIR, "glp1.sqlite3"))
PORT = int(os.environ.get("GLP1_API_PORT", "8001"))
ADMIN_USER = os.environ.get("GLP1_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("GLP1_ADMIN_PASSWORD", "admin1234-change-me")
TOKEN_TTL_SECONDS = int(os.environ.get("GLP1_TOKEN_TTL_DAYS", "30")) * 86400
SCHEMA_VERSION = 3
TOMBSTONE_DAYS = int(os.environ.get("GLP1_TOMBSTONE_DAYS", "30"))
APP_VERSION = "1.1.0"
# El client descobreix què suporta aquesta API (i evita trencar-ne una de més
# vella, o de més nova, amb els atributs additius de la v3).
CAPABILITIES = {
    "apiVersion": 1,
    "appVersion": APP_VERSION,
    "commands": False,   # comandes transaccionals (fase 2)
    "audit": True,       # registre d'auditoria (append-only)
}

# Camps que afegeix l'esquema v3, agrupats per col·lecció i entitat.
V3_PLAN = ("status", "movedTo", "reason", "updatedAt", "idempotencyKey")
V3_ADMIN = ("time", "prescribed", "source", "revertsId", "idempotencyKey")
V3_PEN = ("expiryDate", "openedAt", "priceCents", "currency")
V3_SCHEDULE = ("endDate", "durationDays", "status")
V3_HEALTH = ("source", "validated")
V3_COST = ("kind", "amountCents", "currency", "source", "notes")


def _fill(items, defaults):
    """Afegeix els camps v3 que faltin (document vell) amb els seus per defecte."""
    if not isinstance(items, list):
        return
    for item in items:
        if isinstance(item, dict):
            for key, value in defaults.items():
                item.setdefault(key, value() if callable(value) else value)


def normalise_doc(doc):
    """Completa els camps de l'esquema v3 d'un document arribat d'un client vell.

    Additiu i idempotent: no modifica cap camp existent. Una app v2 reconstrueix
    els objectes sense els camps nous, així que sense això cada pujada d'un
    mòbil amb caché posaria a zero la caducitat, els costos, els estats, etc.

    Excepció (issue #1 · P0): la continuació automàtica del pla només pot estar
    activa amb consentiment explícit (`autoPlanConsent`), així que `autoPlan` es
    deriva d'aquí. Atura també els tractaments heretats del valor per defecte
    (true) i els clients vells que no coneixen el camp.
    """
    if not isinstance(doc, dict):
        return doc
    for treatment in doc.get("treatments") or []:
        if not isinstance(treatment, dict):
            continue
        treatment["autoPlanConsent"] = bool(treatment.get("autoPlanConsent"))
        treatment["autoPlan"] = treatment["autoPlanConsent"]
        for key in ("costs", "plans", "administrations", "schedules", "health", "pens"):
            treatment.setdefault(key, [])
        _fill(treatment.get("costs"), {
            "kind": "other", "amountCents": None, "currency": "EUR",
            "source": "manual", "notes": "",
        })
        _fill(treatment.get("plans"), {
            "status": "planned", "movedTo": None, "reason": "",
            "updatedAt": None, "idempotencyKey": None,
        })
        # una entrada vinculada a un registre real ha de ser 'administered';
        # si el vincle s'ha tret, torna a estar pendent
        for plan in treatment.get("plans") or []:
            if not isinstance(plan, dict):
                continue
            if plan.get("registeredAdminId"):
                plan["status"] = "administered"
            elif plan.get("status") == "administered":
                plan["status"] = "planned"
        _fill(treatment.get("administrations"), {
            "time": None, "prescribed": None, "source": "manual",
            "revertsId": None, "idempotencyKey": None,
        })
        _fill(treatment.get("pens"), {
            "expiryDate": None, "openedAt": None, "priceCents": None, "currency": "EUR",
        })
        _fill(treatment.get("schedules"), {
            "endDate": None, "durationDays": None, "status": "active",
        })
        _fill(treatment.get("health"), {"source": "manual", "validated": False})
    return doc


def inherit_v3(incoming, stored):
    """Herència de camps v3 quan el client és vell.

    Regla: una clau ABSENT vol dir que el client no la coneix (v2) → es pren el
    valor del servidor; una clau PRESENT (encara que sigui null) és una decisió
    explícita de l'usuari → guanya el client. Així una pestanya amb JS vell no
    esborra la caducitat, els estats ni els costos que ja s'havien desat.
    """
    if not isinstance(incoming, dict) or not isinstance(stored, dict):
        return incoming

    def merge_list(inc_list, st_list, keys, id_key="id"):
        if not isinstance(inc_list, list) or not isinstance(st_list, list):
            return
        by_id = {r.get(id_key): r for r in st_list if isinstance(r, dict) and r.get(id_key)}
        for row in inc_list:
            if not isinstance(row, dict):
                continue
            prev = by_id.get(row.get(id_key))
            if not prev:
                continue
            for key in keys:
                if key not in row and key in prev:
                    row[key] = prev[key]

    st_treatments = {t.get("id"): t for t in stored.get("treatments") or []
                     if isinstance(t, dict) and t.get("id")}
    for treatment in incoming.get("treatments") or []:
        if not isinstance(treatment, dict):
            continue
        prev = st_treatments.get(treatment.get("id"))
        if not prev:
            continue
        if "costs" not in treatment and isinstance(prev.get("costs"), list):
            treatment["costs"] = prev["costs"]
        # Tombes: si el client no coneix l'esborrat (clau absent), hereta el del
        # servidor. Una clau present (encara que sigui null) és decisió explícita.
        if "deletedAt" not in treatment and "deletedAt" in prev:
            treatment["deletedAt"] = prev["deletedAt"]
        st_pens = {r.get("id"): r for r in prev.get("pens") or []
                   if isinstance(r, dict) and r.get("id")}
        for pen in treatment.get("pens") or []:
            if not isinstance(pen, dict):
                continue
            old_pen = st_pens.get(pen.get("id"))
            if old_pen is None:
                continue
            if "deletedAt" not in pen and "deletedAt" in old_pen:
                pen["deletedAt"] = old_pen["deletedAt"]
            # una ploma que el servidor té esborrada i el client no ho sap
            if old_pen.get("status") == "deleted" and "status" not in pen:
                pen["status"] = "deleted"
        merge_list(treatment.get("plans"), prev.get("plans"), V3_PLAN)
        merge_list(treatment.get("administrations"), prev.get("administrations"), V3_ADMIN)
        merge_list(treatment.get("pens"), prev.get("pens"), V3_PEN)
        merge_list(treatment.get("schedules"), prev.get("schedules"), V3_SCHEDULE)
        merge_list(treatment.get("health"), prev.get("health"), V3_HEALTH)
    return incoming
PBKDF2_ITERATIONS = 200_000

_db_lock = threading.Lock()


# ---------------------------------------------------------------- base de dades
def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init_db() -> None:
    with _db_lock, connect() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                k TEXT PRIMARY KEY, v TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                pw_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                disabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tokens (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                label TEXT NOT NULL DEFAULT '',
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                last_used_at TEXT,
                revoked INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS patients (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS drugs (
                id TEXT PRIMARY KEY,
                updated_at TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id TEXT PRIMARY KEY,
                at TEXT NOT NULL,
                actor_id TEXT NOT NULL DEFAULT '',
                actor_name TEXT NOT NULL DEFAULT '',
                action TEXT NOT NULL,
                patient_id TEXT,
                treatment_id TEXT,
                entity TEXT,
                entity_id TEXT,
                before_json TEXT,
                after_json TEXT,
                request_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_log (patient_id, at);
            CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
            """
        )
        cols = {r["name"] for r in con.execute("PRAGMA table_info(patients)")}
        if "version" not in cols:
            # Comptador de canvis per pacient (optimisme futur + auditoria)
            con.execute("ALTER TABLE patients ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
        # version NO s'inclou a l'script de dalt: ALTER no admet IF NOT EXISTS
        if con.execute("SELECT 1 FROM users WHERE username = ?", (ADMIN_USER,)).fetchone() is None:
            con.execute(
                "INSERT INTO users (id, username, pw_hash, is_admin, disabled, created_at) "
                "VALUES (?,?,?,?,0,?)",
                (uid("usr"), ADMIN_USER, hash_password(ADMIN_PASSWORD), 1, now()),
            )
        con.execute(
            "INSERT OR REPLACE INTO meta (k, v) VALUES ('schemaVersion', ?)",
            (str(SCHEMA_VERSION),),
        )
        if ADMIN_PASSWORD == "admin1234-change-me":
            con.execute(
                "INSERT OR REPLACE INTO meta (k, v) VALUES ('adminPasswordDefault', '1')"
            )
        con.commit()


def uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------- autenticació
def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    ).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest = stored.split("$", 1)
    except ValueError:
        return False
    candidate = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    ).hex()
    return hmac.compare_digest(candidate, digest)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_token(user_id: str, label: str = "") -> str:
    token = f"glp1_{secrets.token_urlsafe(32)}"
    with _db_lock, connect() as con:
        con.execute(
            "INSERT INTO tokens (id, user_id, label, token_hash, created_at) VALUES (?,?,?,?,?)",
            (uid("tok"), user_id, label, hash_token(token), now()),
        )
        con.commit()
    return token


def authenticate(header_value: str | None) -> dict | None:
    """Retorna l'usuari si el token és vàlid i no caducat/revocat."""
    if not header_value:
        return None
    if header_value.lower().startswith("bearer "):
        header_value = header_value[7:].strip()
    token_hash = hash_token(header_value)
    with _db_lock, connect() as con:
        row = con.execute(
            """
            SELECT t.id AS token_id, t.created_at, t.last_used_at, t.revoked,
                   u.id, u.username, u.is_admin, u.disabled
            FROM tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
        if row is None:
            return None
        if row["revoked"] or row["disabled"]:
            return None
        created = row["created_at"]
        if _expired(created):
            return None
        con.execute("UPDATE tokens SET last_used_at = ? WHERE id = ?", (now(), row["token_id"]))
        con.commit()
    return {
        "id": row["id"],
        "username": row["username"],
        "is_admin": bool(row["is_admin"]),
        "token_id": row["token_id"],
    }


def _expired(created_at: str) -> bool:
    try:
        import datetime as dt

        created = dt.datetime.strptime(created_at, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc
        )
        age = (dt.datetime.now(dt.timezone.utc) - created).total_seconds()
        return age > TOKEN_TTL_SECONDS
    except Exception:
        return False




# ---------------------------------------------------------------- auditoria
def _num(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0.0
    return n


def _clean(n):
    """Sense artefactes float: 179.99999999999997 → 180."""
    return int(round(n)) if abs(n - round(n)) < 1e-9 else round(n, 4)


def _active(items, tomb="deletedAt"):
    return [x for x in items or [] if isinstance(x, dict) and not x.get(tomb)]


def recompute_balances(treatment):
    """Port exacte de `calc.recomputeBalances` (JS).

    saldo = capacitat − consumPrèvi − Σ consum. Les entrades tombades no
    consumeixen. Es recalcula a cada pujada: l'inventari és autoritat del
    servidor, així que un dispositiu amb saldos vells no els pot propagar.
    """
    pens = {p.get("id"): p for p in treatment.get("pens") or [] if isinstance(p, dict)}
    admins = sorted(
        _active(treatment.get("administrations")),
        key=lambda a: (str(a.get("date") or ""), str(a.get("createdAt") or "")),
    )
    used_by_pen = {}
    for a in admins:
        pen = pens.get(a.get("penId"))
        capacity = _num(pen.get("initialCapacity")) if pen else 0.0
        pen_id = a.get("penId")
        if pen_id not in used_by_pen:
            used_by_pen[pen_id] = _num(pen.get("startUsed")) if pen else 0.0
        before = used_by_pen[pen_id]
        after = before + _num(a.get("amount"))
        a["balanceBefore"] = _clean(capacity - before)
        a["balanceAfter"] = _clean(capacity - after)
        used_by_pen[pen_id] = after


def link_plans(treatment):
    """Port de `linkPlanToAdmin` / `unlinkPlanFromAdmin` (JS).

    - La comparació no inclou la dosi: registrar una dosi diferent de la
      prevista ha de tancar la proposta d'aquesta data igualment (la proposta
      conserva la prescrita i l'administració, la real).
    - Un pla prescrit en mg sense ploma (`penId` null) també enllaça i rep la
      ploma amb què es va registrar (assignació posterior, issue #2).
    """
    admins = treatment.get("administrations") or []
    plans = treatment.get("plans") or []
    changed = 0
    for a in _active(admins):
        if any(p.get("registeredAdminId") == a.get("id") for p in plans if isinstance(p, dict)):
            continue
        for pl in _active(plans):
            if (
                pl.get("registeredAdminId") is None
                and pl.get("date") == a.get("date")
                and (pl.get("penId") == a.get("penId") or pl.get("penId") is None)
            ):
                if pl.get("penId") is None:
                    pl["penId"] = a.get("penId")
                pl["registeredAdminId"] = a.get("id")
                pl["status"] = "administered"
                changed += 1
                break
    # un registre TOMBAT deixa la seva proposta pendent un altre cop
    tomb_ids = {a.get("id") for a in admins if isinstance(a, dict) and a.get("deletedAt")}
    for pl in plans:
        if isinstance(pl, dict) and pl.get("registeredAdminId") in tomb_ids:
            pl["registeredAdminId"] = None
            if pl.get("status") == "administered":
                pl["status"] = "planned"
            changed += 1
    return changed


def _is_duplicate(cand, stored_active):
    """Mateixa ploma + data + quantitat + unitat = la mateixa administració.

    Una dosi partida es registra com UNA administració amb `injections` > 1, així
    que dues entrades idèntiques són un doble registre. Si les dues porten hora
    i són diferents, són dues injeccions reals i NO es fusionen.
    """
    for a in stored_active:
        if (
            a.get("penId") == cand.get("penId")
            and a.get("date") == cand.get("date")
            and a.get("unit") == cand.get("unit")
            and _num(a.get("amount")) == _num(cand.get("amount"))
        ):
            t1, t2 = cand.get("time"), a.get("time")
            if t1 and t2 and t1 != t2:
                continue
            return a
    return None


def _purged(row, stamp_key="deletedAt"):
    """Tomba més vella que el termini de purga?"""
    stamp = row.get(stamp_key) if isinstance(row, dict) else None
    if not stamp:
        return False
    try:
        when = datetime.strptime(str(stamp)[:19], "%Y-%m-%dT%H:%M:%S")
        return (datetime.utcnow() - when).days >= TOMBSTONE_DAYS
    except Exception:
        return False


def _treatments(doc):
    return [t for t in (doc or {}).get("treatments") or [] if isinstance(t, dict)]


def _rows(treatment, key):
    return {
        r.get("id"): r
        for r in treatment.get(key) or []
        if isinstance(r, dict) and r.get("id")
    }


def _is_deleted(row, tomb):
    return row.get("status") == "deleted" if tomb == "status" else bool(row.get(tomb))


def _merge_collection(inc_list, st_list, key, tomb, trt_id, events, stats, dedup=False):
    """Fusió d'una col·lecció amb la regla "absent = client vell"."""
    st_map = {r.get("id"): r for r in (st_list or []) if isinstance(r, dict) and r.get("id")}
    out, seen_ids, seen_keys = [], set(), set()
    for row in inc_list or []:
        if not isinstance(row, dict) or not row.get("id"):
            out.append(row)
            continue
        rid = row["id"]
        idem = row.get("idempotencyKey")
        if idem and idem in seen_keys:
            stats["duplicates"] += 1
            continue
        if idem:
            seen_keys.add(idem)
        if rid in seen_ids:
            stats["duplicates"] += 1
            continue
        seen_ids.add(rid)
        if dedup and not _is_deleted(row, tomb) and rid not in st_map:
            stored_active = [r for r in st_map.values() if not _is_deleted(r, tomb)]
            dup = _is_duplicate(row, stored_active)
            if dup is not None:
                # mateixa ploma + data + quantitat → la mateixa dosi
                stats["duplicates"] += 1
                events.append({
                    "action": "duplicate", "treatment_id": trt_id, "entity": key,
                    "before": dup, "after": row,
                })
                continue
        if row.get("deletedAt") and _purged(row, "deletedAt"):
            stats["purged"] += 1
            continue
        out.append(row)
    # El que el servidor té i l'entrada NO envia: no és un esborrat (un client
    # vell simplement no ho coneix) → es conserva.
    for rid, row in st_map.items():
        if rid in seen_ids:
            continue
        if _is_deleted(row, tomb):
            continue  # ja estava tombat: no es ressuscita
        out.append(row)
        stats["preserved"] += 1
    return out


def merge_entities(inc_doc, st_doc, events):
    """Preserva el que un dispositiu VELL no envia i descarta duplicats.

    Regla: una entitat ABSENT de l'entrada no és un esborrat (un client vell
    simplement no la coneix) → es conserva la del servidor. Les esborranades
    reals arriben com a TOMBA (`deletedAt` / `status: deleted`), així que sí que
    es propagen a tots els dispositius.
    """
    stats = {"preserved": 0, "duplicates": 0, "purged": 0}
    st_by_id = {t.get("id"): t for t in _treatments(st_doc) if t.get("id")}
    out_treatments, seen = [], set()

    for t in _treatments(inc_doc):
        tid = t.get("id")
        seen.add(tid)
        # tractament tombat i vençut el termini → es purga
        if t.get("deletedAt") and _purged(t, "deletedAt"):
            stats["purged"] += 1
            continue
        # `st_t` buit quan el tractament és nou: la purga i la deduplicació
        # s'apliquen igualment (són regles de l'entrada, no de l'historial).
        st_t = st_by_id.get(tid) or {}
        t["administrations"] = _merge_collection(
            t.get("administrations"), st_t.get("administrations"),
            "administrations", "deletedAt", tid, events, stats, dedup=True)
        t["plans"] = _merge_collection(
            t.get("plans"), st_t.get("plans"),
            "plans", "deletedAt", tid, events, stats)
        t["health"] = _merge_collection(
            t.get("health"), st_t.get("health"),
            "health", "deletedAt", tid, events, stats)
        t["pens"] = _merge_collection(
            t.get("pens"), st_t.get("pens"),
            "pens", "status", tid, events, stats)
        # costos: sense tomba (esborrar-los és explícit; un client vell
        # no els envia mai → es preserven)
        st_costs = _rows(st_t, "costs")
        inc_ids = set(_rows(t, "costs"))
        for cid, row in st_costs.items():
            if cid not in inc_ids:
                t.setdefault("costs", []).append(row)
                stats["preserved"] += 1
        out_treatments.append(t)

    # tractaments que el client vell no envia → es conserven sencers
    # (si estan tombats, la tomba es conserva també: no es ressusciten)
    for tid, st_t in st_by_id.items():
        if tid in seen:
            continue
        if st_t.get("deletedAt") and _purged(st_t, "deletedAt"):
            stats["purged"] += 1
            continue
        out_treatments.append(st_t)
        stats["preserved"] += 1

    inc_doc["treatments"] = out_treatments
    return stats


def diff_events(old_doc, new_doc, events):
    """Diferència per entitat: el que canvia és el que s'audita."""
    keys = ("pens", "administrations", "plans", "health", "costs")
    old_t = {t.get("id"): t for t in _treatments(old_doc) if t.get("id")}
    new_t = {t.get("id"): t for t in _treatments(new_doc) if t.get("id")}

    def same(a, b):
        return json.dumps(a, sort_keys=True, ensure_ascii=False) == json.dumps(
            b, sort_keys=True, ensure_ascii=False)

    for tid, t_new in new_t.items():
        t_old = old_t.get(tid)
        for key in keys:
            new_rows = _rows(t_new, key)
            old_rows = _rows(t_old, key) if t_old is not None else {}
            for rid, row in new_rows.items():
                if rid not in old_rows:
                    events.append({"action": "create", "treatment_id": tid,
                                   "entity": key, "before": None, "after": row})
                    continue
                prev = old_rows[rid]
                if same(prev, row):
                    continue
                tombstoned = not _is_deleted(prev, "deletedAt" if key != "pens" else "status") \
                    and _is_deleted(row, "deletedAt" if key != "pens" else "status")
                events.append({
                    "action": "delete" if tombstoned else "update",
                    "treatment_id": tid, "entity": key, "before": prev, "after": row,
                })
            for rid, row in old_rows.items():
                if rid not in new_rows:
                    events.append({"action": "delete", "treatment_id": tid,
                                   "entity": key, "before": row, "after": None})
    for tid, t_old in old_t.items():
        if tid not in new_t:
            events.append({"action": "delete", "treatment_id": tid, "entity": "treatment",
                           "before": t_old, "after": None})


def audit_flush(con, actor, patient_id, events):
    """Escriu les files d'auditoria (append-only: no hi ha cap esborrat)."""
    if not events:
        return 0
    # Un primer contacte pot portar desenes d'entitats noves: en comptes
    # d'inundar el registre, es resumeix en una sola fila.
    if len(events) > 60:
        con.execute(
            "INSERT INTO audit_log (id, at, actor_id, actor_name, action, patient_id,"
            " entity, after_json) VALUES (?,?,?,?,?,?,?,?)",
            (uid("aud"), now(), actor.get("id", ""), actor.get("username", ""),
             "bulk", patient_id, "patient",
             json.dumps({"events": len(events)}, ensure_ascii=False)),
        )
        return 1
    written = 0
    for ev in events:
        con.execute(
            "INSERT INTO audit_log (id, at, actor_id, actor_name, action, patient_id,"
            " treatment_id, entity, entity_id, before_json, after_json)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (uid("aud"), now(), actor.get("id", ""), actor.get("username", ""),
             ev.get("action", "update"), patient_id, ev.get("treatment_id"),
             ev.get("entity"),
             (ev.get("after") or ev.get("before") or {}).get("id"),
             json.dumps(ev.get("before"), ensure_ascii=False)
             if ev.get("before") is not None else None,
             json.dumps(ev.get("after"), ensure_ascii=False)
             if ev.get("after") is not None else None),
        )
        written += 1
    return written


def reconcile(doc):
    """Inventari coherent + propostes vinculades després de cada pujada."""
    for t in _treatments(doc):
        recompute_balances(t)
        link_plans(t)


# ---------------------------------------------------------------- pacients
def patients_payload() -> dict:
    with _db_lock, connect() as con:
        rows = con.execute("SELECT data FROM patients ORDER BY code").fetchall()
        meta = con.execute("SELECT v FROM meta WHERE k='updatedAt'").fetchone()
    patients = [json.loads(r["data"]) for r in rows]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": meta["v"] if meta else None,
        "patients": patients,
    }


def _expired_tombstone(data: str) -> bool:
    """Una tomba (pacient esborrat) amb més de N dies es purga del servidor."""
    try:
        import datetime as dt

        doc = json.loads(data) if isinstance(data, str) else data
        deleted = doc.get("deletedAt") if isinstance(doc, dict) else None
        if not deleted:
            return False
        when = dt.datetime.strptime(str(deleted)[:19], "%Y-%m-%dT%H:%M:%S")
        return (dt.datetime.utcnow() - when).days >= TOMBSTONE_DAYS
    except Exception:
        return False


def merge_patients(incoming: list, actor: dict | None = None) -> dict:
    """Merge per pacient: guanya el `updatedAt` més recent (mai es perd dades).

    A més del merge, el servidor és AUTORITAT sobre l'inventari:
      - preserva les entitats que un dispositiu vell no envia (no són esborrats),
      - descarta duplicats d'administració (una dosi es consumeix UNA VEZ),
      - recalcula saldos i vincula propostes (inventari coherent),
      - audita cada canvi (append-only) i purga les tombes velles.
    Tot dins de la mateixa transacció de la pujada.
    """
    if not isinstance(incoming, list):
        raise ValueError("patients ha de ser una llista")
    actor = actor or {"id": "", "username": ""}
    created = updated = kept = duplicates = preserved = 0
    audited = 0
    with _db_lock, connect() as con:
        # purga: tombes velles (pacients esborrats fa més de N dies)
        for row in con.execute("SELECT id, data FROM patients").fetchall():
            if _expired_tombstone(row["data"]):
                con.execute("DELETE FROM patients WHERE id = ?", (row["id"],))

        for p in incoming:
            if not isinstance(p, dict) or not p.get("id"):
                raise ValueError("pacient sense id")
            if _expired_tombstone(p):
                con.execute("DELETE FROM patients WHERE id = ?", (p["id"],))
                continue
            existing = con.execute(
                "SELECT updated_at, data FROM patients WHERE id = ?", (p["id"],)
            ).fetchone()
            incoming_at = p.get("updatedAt") or p.get("createdAt") or now()
            if existing is None:
                normalise_doc(p)
                # amb buit com a base: descarta duplicats interns i purga tombes
                events = []
                merge_entities(p, {"treatments": []}, events)
                reconcile(p)
                diff_events({}, p, events)
                audited += audit_flush(con, actor, p["id"], events)
                con.execute(
                    "INSERT INTO patients (id, code, updated_at, data, version) "
                    "VALUES (?,?,?,?,1)",
                    (p["id"], p.get("code", ""), incoming_at, json.dumps(p, ensure_ascii=False)),
                )
                created += 1
                continue
            if existing["updated_at"] > str(incoming_at):
                kept += 1  # el servidor té una versió més nova; es conserva
                continue
            # 1) Client vell? → hereta primer els camps v3 que ell no coneix
            #    (abans de normalitzar, perquè sinó la normalització els ompliria
            #    amb els per defecte i no es distingiria "absent" de "en blanc").
            prev = json.loads(existing["data"]) if existing["data"] else None
            if prev is not None:
                inherit_v3(p, prev)
                normalise_doc(prev)
            normalise_doc(p)

            events = []
            stats = {"preserved": 0, "duplicates": 0, "purged": 0}
            if prev is not None:
                # 2) entitats: preservar el que el client no envia + duplicats
                stats = merge_entities(p, prev, events)
                # 3) inventari coherent (saldos) i propostes vinculades
                reconcile(p)
                # 4) el que ha canviat, a l'auditoria
                diff_events(prev, p, events)
            audited += audit_flush(con, actor, p["id"], events)
            duplicates += stats["duplicates"]
            preserved += stats["preserved"]
            con.execute(
                "UPDATE patients SET code = ?, updated_at = ?, data = ?, "
                "version = version + 1 WHERE id = ?",
                (p.get("code", ""), incoming_at, json.dumps(p, ensure_ascii=False), p["id"]),
            )
            updated += 1
        con.execute(
            "INSERT OR REPLACE INTO meta (k, v) VALUES ('updatedAt', ?)", (now(),)
        )
        con.commit()
    return {
        "created": created,
        "updated": updated,
        "kept": kept,
        "duplicates": duplicates,
        "preserved": preserved,
        "audited": audited,
    }


# ---------------------------------------------------------------- fàrmacs
def drugs_payload() -> dict:
    with _db_lock, connect() as con:
        rows = con.execute("SELECT id, data, updated_at FROM drugs ORDER BY id").fetchall()
        meta = con.execute("SELECT v FROM meta WHERE k='drugsUpdatedAt'").fetchone()
    return {
        "updatedAt": meta["v"] if meta else None,
        "drugs": [json.loads(r["data"]) for r in rows],
    }


def save_drugs(drugs: list) -> dict:
    if not isinstance(drugs, list):
        raise ValueError("drugs ha de ser una llista")
    with _db_lock, connect() as con:
        con.execute("DELETE FROM drugs")
        for d in drugs:
            if not isinstance(d, dict) or not d.get("id"):
                raise ValueError("fàrmac sense id")
            con.execute(
                "INSERT INTO drugs (id, updated_at, data) VALUES (?,?,?)",
                (d["id"], now(), json.dumps(d, ensure_ascii=False)),
            )
        con.execute(
            "INSERT OR REPLACE INTO meta (k, v) VALUES ('drugsUpdatedAt', ?)", (now(),)
        )
        con.commit()
    return {"count": len(drugs)}


# ---------------------------------------------------------------- usuaris/tokens
def list_users() -> list:
    with _db_lock, connect() as con:
        rows = con.execute(
            "SELECT id, username, is_admin, disabled, created_at FROM users ORDER BY username"
        ).fetchall()
    return [
        {
            "id": r["id"],
            "username": r["username"],
            "is_admin": bool(r["is_admin"]),
            "disabled": bool(r["disabled"]),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def create_user(payload: dict) -> dict:
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not username or len(username) < 2:
        raise ValueError("Nom d'usuari massa curt")
    if len(password) < 8:
        raise ValueError("La contrasenya ha de tenir com a mínim 8 caràcters")
    is_admin = 1 if payload.get("is_admin") else 0
    user_id = uid("usr")
    with _db_lock, connect() as con:
        if con.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise ValueError("Ja existeix un usuari amb aquest nom")
        con.execute(
            "INSERT INTO users (id, username, pw_hash, is_admin, disabled, created_at) "
            "VALUES (?,?,?,?,0,?)",
            (user_id, username, hash_password(password), is_admin, now()),
        )
        con.commit()
    return {"id": user_id, "username": username, "is_admin": bool(is_admin), "disabled": False}


def patch_user(user_id: str, payload: dict) -> dict | None:
    with _db_lock, connect() as con:
        row = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            return None
        if "password" in payload and payload["password"]:
            password = str(payload["password"])
            if len(password) < 8:
                raise ValueError("La contrasenya ha de tenir com a mínim 8 caràcters")
            con.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (hash_password(password), user_id))
        if "is_admin" in payload:
            con.execute(
                "UPDATE users SET is_admin = ? WHERE id = ?",
                (1 if payload["is_admin"] else 0, user_id),
            )
        if "disabled" in payload:
            con.execute(
                "UPDATE users SET disabled = ? WHERE id = ?",
                (1 if payload["disabled"] else 0, user_id),
            )
        if payload.get("disabled"):
            con.execute("UPDATE tokens SET revoked = 1 WHERE user_id = ?", (user_id,))
        if "password" in payload and payload["password"]:
            con.execute("DELETE FROM meta WHERE k = 'adminPasswordDefault'")
        con.commit()
        row = con.execute(
            "SELECT id, username, is_admin, disabled, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return {
        "id": row["id"],
        "username": row["username"],
        "is_admin": bool(row["is_admin"]),
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
    }


def list_tokens(user_id: str | None = None) -> list:
    query = (
        "SELECT t.id, t.label, t.created_at, t.last_used_at, t.revoked, u.username "
        "FROM tokens t JOIN users u ON u.id = t.user_id"
    )
    args: tuple = ()
    if user_id:
        query += " WHERE t.user_id = ?"
        args = (user_id,)
    query += " ORDER BY t.created_at DESC, t.rowid DESC"  # desempata pel més recent
    with _db_lock, connect() as con:
        rows = con.execute(query, args).fetchall()
    return [
        {
            "id": r["id"],
            "label": r["label"],
            "username": r["username"],
            "created_at": r["created_at"],
            "last_used_at": r["last_used_at"],
            "revoked": bool(r["revoked"]),
        }
        for r in rows
    ]


# ---------------------------------------------------------------- HTTP
class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "glp1-api/" + APP_VERSION
    protocol_version = "HTTP/1.1"

    # -- helpers ----------------------------------------------------------
    def _json(self, status: int, payload: dict | list) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError(400, "Cos JSON no vàlid")
        if not isinstance(data, dict):
            raise ApiError(400, "El cos ha de ser un objecte JSON")
        return data

    def _user(self, admin: bool = False) -> dict:
        user = authenticate(self.headers.get("Authorization") or self.headers.get("X-API-Token"))
        if user is None:
            raise ApiError(401, "Token no vàlid o caducat")
        if admin and not user["is_admin"]:
            raise ApiError(403, "Cal permís d'administració")
        return user

    def _route(self, method: str) -> tuple[str, dict]:
        parsed = self.path.split("?", 1)
        path = parsed[0].rstrip("/") or "/"
        query = {}
        if len(parsed) > 2:
            pass
        if "?" in self.path:
            from urllib.parse import parse_qs

            query = {k: v[0] for k, v in parse_qs(self.path.split("?", 1)[1]).items()}
        return path, query

    def log_message(self, fmt: str, *args) -> None:  # menys soroll
        pass

    # -- verbs ------------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch("PUT")

    def do_PATCH(self) -> None:  # noqa: N802
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        try:
            payload = self._read_body() if method in {"POST", "PUT", "PATCH"} else {}
            status, body = self._handle(method, payload)
            self._json(status, body)
        except ApiError as exc:
            self._json(exc.status, {"error": exc.message})
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except BrokenPipeError:
            pass
        except Exception as exc:  # pragma: no cover
            self._json(500, {"error": f"Error intern: {exc}"})

    # -- rutes ------------------------------------------------------------
    def _handle(self, method: str, payload: dict) -> tuple[int, dict]:
        path, query = self._route(method)

        if path == "/api/health":
            info = patients_payload()
            return 200, {
                "ok": True,
                "app": "glp1-api",
                "version": APP_VERSION,
                "schemaVersion": SCHEMA_VERSION,
                "updatedAt": info["updatedAt"],
                "patients": len(info["patients"]),
                "capabilities": CAPABILITIES,
            }

        if path == "/api/auth/login" and method == "POST":
            return self._login(payload)

        if path == "/api/auth/logout" and method == "POST":
            user = self._user()
            token = (self.headers.get("Authorization") or self.headers.get("X-API-Token") or "").strip()
            if token.lower().startswith("bearer "):
                token = token[7:]
            with _db_lock, connect() as con:
                con.execute("UPDATE tokens SET revoked = 1 WHERE token_hash = ?", (hash_token(token),))
                con.commit()
            return 200, {"ok": True, "user": user["username"]}

        if path == "/api/me" and method == "GET":
            user = self._user()
            info = patients_payload()
            drugs = drugs_payload()
            with _db_lock, connect() as con:
                n_users = con.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
                default_pw = con.execute(
                    "SELECT 1 FROM meta WHERE k='adminPasswordDefault'"
                ).fetchone() is not None
            return 200, {
                "user": user,
                "schemaVersion": SCHEMA_VERSION,
                "capabilities": CAPABILITIES,
                "sync": {
                    "patients": len(info["patients"]),
                    "updatedAt": info["updatedAt"],
                    "drugsUpdatedAt": drugs["updatedAt"],
                    "users": n_users,
                },
                "passwordIsDefault": default_pw,
            }

        if path.startswith("/api/patients/") and path.endswith("/audit") and method == "GET":
            self._user(admin=True)
            patient_id = path[len("/api/patients/"):].rsplit("/", 1)[0]
            try:
                limit = max(1, min(int(query.get("limit") or 200), 1000))
            except ValueError:
                limit = 200
            with _db_lock, connect() as con:
                rows = con.execute(
                    "SELECT * FROM audit_log WHERE patient_id = ? "
                    "ORDER BY at DESC, rowid DESC LIMIT ?",
                    (patient_id, limit),
                ).fetchall()
            entries = []
            for r in rows:
                e = dict(r)
                for key in ("before_json", "after_json"):
                    raw = e.pop(key, None)
                    if raw:
                        try:
                            e[key[:-5]] = json.loads(raw)
                        except Exception:
                            e[key[:-5]] = None
                entries.append(e)
            return 200, {"patient": patient_id, "count": len(entries), "entries": entries}

        if path == "/api/patients" and method == "GET":
            self._user()
            return 200, patients_payload()

        if path == "/api/patients" and method == "DELETE":
            self._user(admin=True)
            with _db_lock, connect() as con:
                n = con.execute("SELECT COUNT(*) c FROM patients").fetchone()["c"]
                con.execute("DELETE FROM patients")
                con.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('updatedAt', ?)", (now(),))
                con.commit()
            return 200, {"ok": True, "deleted": n, **patients_payload()}

        if path == "/api/patients" and method == "PUT":
            actor = self._user()
            result = merge_patients(payload.get("patients"), actor=actor)
            return 200, {**result, **patients_payload()}

        if path == "/api/drugs" and method == "GET":
            self._user()
            return 200, drugs_payload()

        if path == "/api/drugs" and method == "PUT":
            self._user(admin=True)
            result = save_drugs(payload.get("drugs"))
            return 200, {**result, **drugs_payload()}

        if path == "/api/users" and method == "GET":
            self._user(admin=True)
            return 200, {"users": list_users()}

        if path == "/api/users" and method == "POST":
            self._user(admin=True)
            return 201, {"user": create_user(payload)}

        if path.startswith("/api/users/") and method == "DELETE":
            me = self._user(admin=True)
            user_id = path.rsplit("/", 1)[-1]
            if user_id == me["id"]:
                raise ApiError(400, "No et pots esborrar a tu mateix")
            with _db_lock, connect() as con:
                cur = con.execute("DELETE FROM users WHERE id = ?", (user_id,))
                if cur.rowcount == 0:
                    raise ApiError(404, "Usuari no trobat")
                con.execute("DELETE FROM tokens WHERE user_id = ?", (user_id,))
                con.commit()
            return 200, {"ok": True, "users": list_users()}

        if path.startswith("/api/users/") and method == "PATCH":
            self._user(admin=True)
            user_id = path.rsplit("/", 1)[-1]
            updated = patch_user(user_id, payload)
            if updated is None:
                raise ApiError(404, "Usuari no trobat")
            return 200, {"user": updated}

        if path == "/api/tokens" and method == "GET":
            user = self._user()
            uid_filter = query.get("user_id") or (None if user["is_admin"] else user["id"])
            if not user["is_admin"]:
                uid_filter = user["id"]
            return 200, {"tokens": list_tokens(uid_filter)}

        if path == "/api/tokens" and method == "POST":
            user = self._user()
            target = payload.get("user_id") or user["id"]
            if target != user["id"] and not user["is_admin"]:
                raise ApiError(403, "Cal permís d'administració")
            label = str(payload.get("label", "")).strip() or "API"
            token = create_token(target, label)
            tokens = list_tokens(target if user["is_admin"] else user["id"])
            return 201, {"token": token, "tokens": tokens}

        if path.startswith("/api/tokens/") and path.endswith("/revoke") and method == "POST":
            user = self._user()
            token_id = path.split("/")[3]
            with _db_lock, connect() as con:
                row = con.execute("SELECT user_id FROM tokens WHERE id = ?", (token_id,)).fetchone()
                if row is None:
                    raise ApiError(404, "Token no trobat")
                if row["user_id"] != user["id"] and not user["is_admin"]:
                    raise ApiError(403, "Cal permís d'administració")
                con.execute("UPDATE tokens SET revoked = 1 WHERE id = ?", (token_id,))
                con.commit()
            return 200, {"ok": True, "tokens": list_tokens(None if user["is_admin"] else user["id"])}

        raise ApiError(404, f"Ruta no trobada: {method} {path}")

    def _login(self, payload: dict) -> tuple[int, dict]:
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        if not username or not password:
            raise ApiError(400, "Falten les credencials")
        with _db_lock, connect() as con:
            row = con.execute(
                "SELECT * FROM users WHERE username = ?", (username,)
            ).fetchone()
        if row is None or not verify_password(password, row["pw_hash"]):
            time.sleep(0.4)  # frena els intents de força bruta
            raise ApiError(401, "Usuari o contrasenya incorrectes")
        if row["disabled"]:
            raise ApiError(403, "Usuari desactivat")
        token = create_token(row["id"], label="sessió")
        return 200, {
            "token": token,
            "user": {
                "id": row["id"],
                "username": row["username"],
                "is_admin": bool(row["is_admin"]),
            },
        }


def main() -> None:
    init_db()
    host = os.environ.get("GLP1_API_HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, PORT), Handler)
    server.daemon_threads = True
    print(f"glp1-api {APP_VERSION} escoltant a {host}:{PORT} · BD {DB_PATH}")
    print(f"Admin inicial: {ADMIN_USER} (contrasenya definida per GLP1_ADMIN_PASSWORD)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
