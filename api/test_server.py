"""Tests de l'API de dades de glp1 (stdlib: unittest + http.client).

Execució:
    cd glp1 && python3 -m unittest discover -s api -v
"""
from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

import server

ADMIN_PASSWORD = "admin1234-test"


class ApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="glp1-api-test-")
        server.DB_PATH = os.path.join(cls.tmp, "test.sqlite3")
        server.ADMIN_PASSWORD = ADMIN_PASSWORD
        server.ADMIN_USER = "admin"
        server.init_db()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    # -- helpers ----------------------------------------------------------
    def request(self, method: str, path: str, body: dict | None = None, token: str | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8")
        conn.close()
        data = json.loads(raw) if raw else {}
        return resp.status, data

    def login(self, username: str = "admin", password: str = ADMIN_PASSWORD) -> str:
        status, data = self.request("POST", "/api/auth/login", {"username": username, "password": password})
        self.assertEqual(status, 200, data)
        return data["token"]

    # -- tests ------------------------------------------------------------
    def test_01_health_no_auth(self):
        status, data = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["schemaVersion"], server.SCHEMA_VERSION)

    def test_02_patients_requires_token(self):
        status, _ = self.request("GET", "/api/patients")
        self.assertEqual(status, 401)
        status, _ = self.request("GET", "/api/patients", token="glp1_fals")
        self.assertEqual(status, 401)

    def test_03_login_and_me(self):
        token = self.login()
        status, data = self.request("GET", "/api/me", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["username"], "admin")
        self.assertTrue(data["user"]["is_admin"])
        self.assertEqual(data["schemaVersion"], server.SCHEMA_VERSION)

    def test_04_login_wrong_password(self):
        status, data = self.request("POST", "/api/auth/login", {"username": "admin", "password": "malament"})
        self.assertEqual(status, 401)
        self.assertIn("error", data)

    def test_05_push_and_pull_patients(self):
        token = self.login()
        payload = {
            "patients": [
                {"id": "p1", "code": "P-001", "updatedAt": "2026-11-24T10:00:00Z", "treatments": []},
                {"id": "p2", "code": "P-002", "updatedAt": "2026-11-24T10:00:00Z", "treatments": []},
            ]
        }
        status, data = self.request("PUT", "/api/patients", payload, token=token)
        self.assertEqual(status, 200)
        self.assertEqual(data["created"], 2)
        self.assertEqual(len(data["patients"]), 2)

        status, data = self.request("GET", "/api/patients", token=token)
        self.assertEqual(status, 200)
        self.assertEqual({p["code"] for p in data["patients"]}, {"P-001", "P-002"})

    def test_06_merge_keeps_server_version_when_incoming_is_older(self):
        token = self.login()
        stale = {"patients": [{"id": "p1", "code": "P-001-VELLA", "updatedAt": "2020-01-01T00:00:00Z"}]}
        status, data = self.request("PUT", "/api/patients", stale, token=token)
        self.assertEqual(status, 200)
        self.assertEqual(data["kept"], 1)
        codes = {p["id"]: p["code"] for p in data["patients"]}
        self.assertNotEqual(codes.get("p1"), "P-001-VELLA", "el servidor no perd la versió més nova")

    def test_07_merge_takes_newer_incoming(self):
        token = self.login()
        newer = {"patients": [{"id": "p1", "code": "P-001-NOVA", "updatedAt": "2099-01-01T00:00:00Z"}]}
        status, data = self.request("PUT", "/api/patients", newer, token=token)
        self.assertEqual(status, 200)
        self.assertEqual(data["updated"], 1)
        codes = {p["id"]: p["code"] for p in data["patients"]}
        self.assertEqual(codes["p1"], "P-001-NOVA")

    def test_07b_delete_all_patients_requires_admin(self):
        token = self.login()
        status, data = self.request("DELETE", "/api/patients", token=token)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["patients"], [])

    def test_07c_tombstones_se_propaguen_i_es_purguen(self):
        from datetime import datetime, timedelta

        token = self.login()
        recent = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        old = (datetime.utcnow() - timedelta(days=45)).strftime("%Y-%m-%dT%H:%M:%SZ")

        # tomba recent: es conserva (perquè els altres dispositius la vegin)
        status, data = self.request(
            "PUT", "/api/patients",
            {"patients": [{"id": "t_recent", "code": "P-R", "updatedAt": recent, "deletedAt": recent}]},
            token=token,
        )
        self.assertEqual(status, 200, data)
        self.assertIn("t_recent", [p["id"] for p in data["patients"]])

        # tomba vella: es purga (no acumula brossa al servidor)
        status, data = self.request(
            "PUT", "/api/patients",
            {"patients": [{"id": "t_vella", "code": "P-V", "updatedAt": old, "deletedAt": old}]},
            token=token,
        )
        self.assertEqual(status, 200, data)
        self.assertNotIn("t_vella", [p["id"] for p in data["patients"]])

    def test_07d_detecta_tombes_caducades(self):
        from datetime import datetime, timedelta

        vella = {"id": "x", "deletedAt": (datetime.utcnow() - timedelta(days=31)).strftime("%Y-%m-%dT%H:%M:%SZ")}
        recent = {"id": "y", "deletedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")}
        viva = {"id": "z"}
        self.assertTrue(server._expired_tombstone(vella))
        self.assertFalse(server._expired_tombstone(recent))
        self.assertFalse(server._expired_tombstone(viva))
        self.assertFalse(server._expired_tombstone("no-és-json"))

    def test_08_users_roles_and_drugs_permissions(self):
        token = self.login()
        status, data = self.request(
            "POST", "/api/users",
            {"username": "metge1", "password": "prova12345", "is_admin": False},
            token=token,
        )
        self.assertEqual(status, 201, data)
        user_token = self.login("metge1", "prova12345")

        # usuari normal: pot escriure pacients…
        status, _ = self.request(
            "PUT", "/api/patients",
            {"patients": [{"id": "p9", "code": "P-009", "updatedAt": "2026-11-24T12:00:00Z"}]},
            token=user_token,
        )
        self.assertEqual(status, 200)

        # …però no pot editar el catàleg ni llistar usuaris
        status, _ = self.request("PUT", "/api/drugs", {"drugs": []}, token=user_token)
        self.assertEqual(status, 403)
        status, _ = self.request("GET", "/api/users", token=user_token)
        self.assertEqual(status, 403)

        # l'admin sí que pot editar el catàleg
        status, data = self.request(
            "PUT", "/api/drugs",
            {"drugs": [{"id": "mounjaro", "label": "Mounjaro", "standardDosesMg": [2.5, 5, 7.5, 10, 12.5, 15]}]},
            token=token,
        )
        self.assertEqual(status, 200, data)
        self.assertEqual(data["count"], 1)
        status, data = self.request("GET", "/api/drugs", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(data["drugs"][0]["id"], "mounjaro")

    def test_08b_delete_user(self):
        token = self.login()
        status, data = self.request(
            "POST", "/api/users",
            {"username": "esborrable", "password": "prova12345", "is_admin": False},
            token=token,
        )
        self.assertEqual(status, 201, data)
        user_id = data["user"]["id"]

        # no et pots esborrar a tu mateix
        _, me = self.request("GET", "/api/me", token=token)
        status, data = self.request("DELETE", f"/api/users/{me['user']['id']}", token=token)
        self.assertEqual(status, 400, data)
        self.assertIn("tu mateix", data["error"])

        # esborrar l'usuari
        status, data = self.request("DELETE", f"/api/users/{user_id}", token=token)
        self.assertEqual(status, 200, data)
        self.assertNotIn("esborrable", [u["username"] for u in data["users"]])

        # els seus tokens deixen de funcionar i no pot entrar
        status, _ = self.request("POST", "/api/auth/login", {"username": "esborrable", "password": "prova12345"})
        self.assertEqual(status, 401, "l'usuari esborrat ja no pot entrar")

    def test_09_short_password_rejected(self):
        token = self.login()
        status, data = self.request("POST", "/api/users", {"username": "curt", "password": "123"}, token=token)
        self.assertEqual(status, 400)
        self.assertIn("8 caràcters", data["error"])

    def test_10_token_lifecycle(self):
        token = self.login()
        status, data = self.request("POST", "/api/tokens", {"label": "prova"}, token=token)
        self.assertEqual(status, 201)
        api_token = data["token"]
        self.assertTrue(api_token.startswith("glp1_"))

        status, _ = self.request("GET", "/api/patients", token=api_token)
        self.assertEqual(status, 200, "el token creat funciona")

        listed = [t for t in data["tokens"] if t["label"] == "prova"]
        token_id = listed[0]["id"]
        status, _ = self.request("POST", f"/api/tokens/{token_id}/revoke", {}, token=token)
        self.assertEqual(status, 200)

        status, _ = self.request("GET", "/api/patients", token=api_token)
        self.assertEqual(status, 401, "un token revocat deixa de funcionar")

    def test_11_logout_revokes_session(self):
        token = self.login()
        status, _ = self.request("POST", "/api/auth/logout", {}, token=token)
        self.assertEqual(status, 200)
        status, _ = self.request("GET", "/api/me", token=token)
        self.assertEqual(status, 401)

    def test_13_capacitats_i_versio(self):
        status, data = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(data["schemaVersion"], server.SCHEMA_VERSION)
        self.assertEqual(data["capabilities"]["appVersion"], server.APP_VERSION)
        self.assertIn("commands", data["capabilities"])
        self.assertIn("audit", data["capabilities"])

        token = self.login()
        status, data = self.request("GET", "/api/me", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(data["capabilities"]["appVersion"], server.APP_VERSION)

    def test_14_normalitzacio_v3_de_documents_vells(self):
        """Un client v2 envia un document sense els camps nous → el servidor els afegeix."""
        token = self.login()
        v2 = {"patients": [{
            "id": "v3_doc", "code": "P-V3", "updatedAt": "2099-01-01T00:00:00Z",
            "treatments": [{
                "id": "trt1", "drugId": "mounjaro", "startDate": "2026-11-01",
                "pens": [{"id": "pen1", "startDate": "2026-11-01"}],
                "administrations": [{"id": "adm1", "date": "2026-11-01", "penId": "pen1", "amount": 15}],
                "schedules": [{"id": "sch1", "startDate": "2026-11-01", "intervalDays": 7}],
                "plans": [{"id": "pln1", "date": "2026-11-08", "penId": "pen1", "amount": 15}],
                "health": [{"id": "hlh1", "date": "2026-11-01"}],
            }],
        }]}
        status, data = self.request("PUT", "/api/patients", v2, token=token)
        self.assertEqual(status, 200, data)
        doc = next(p for p in data["patients"] if p["id"] == "v3_doc")
        t = doc["treatments"][0]
        self.assertEqual(t["costs"], [])
        self.assertIsNone(t["pens"][0]["expiryDate"])
        self.assertEqual(t["pens"][0]["currency"], "EUR")
        self.assertIsNone(t["administrations"][0]["time"])
        self.assertEqual(t["administrations"][0]["source"], "manual")
        self.assertEqual(t["schedules"][0]["status"], "active")
        self.assertIsNone(t["schedules"][0]["endDate"])
        self.assertEqual(t["plans"][0]["status"], "planned")
        self.assertFalse(t["health"][0]["validated"])

    def test_15_client_vell_no_esborra_camps_v3(self):
        """Una pestanya amb JS vell no posa a zero la caducitat, els estats ni els costos."""
        token = self.login()
        full = {"patients": [{
            "id": "v3_keep", "code": "P-KEEP", "updatedAt": "2099-01-02T00:00:00Z",
            "treatments": [{
                "id": "trt2", "drugId": "mounjaro", "startDate": "2026-11-01",
                "pens": [{"id": "pen2", "startDate": "2026-11-01",
                          "expiryDate": "2027-06-30", "priceCents": 12900}],
                "plans": [{"id": "pln2", "date": "2026-11-08", "penId": "pen2",
                           "amount": 15, "status": "postponed", "reason": "viatge"}],
                "administrations": [], "schedules": [], "health": [],
                "costs": [{"id": "cst1", "date": "2026-11-01", "kind": "pen",
                           "amountCents": 12900}],
            }],
        }]}
        status, data = self.request("PUT", "/api/patients", full, token=token)
        self.assertEqual(status, 200, data)

        # client vell: reconstrueix els objectes sense els camps v3
        old_client = {"patients": [{
            "id": "v3_keep", "code": "P-KEEP", "updatedAt": "2099-01-03T00:00:00Z",
            "treatments": [{
                "id": "trt2", "drugId": "mounjaro", "startDate": "2026-11-01",
                "pens": [{"id": "pen2", "startDate": "2026-11-01"}],
                "plans": [{"id": "pln2", "date": "2026-11-08", "penId": "pen2", "amount": 15}],
                "administrations": [], "schedules": [], "health": [],
            }],
        }]}
        status, data = self.request("PUT", "/api/patients", old_client, token=token)
        self.assertEqual(status, 200, data)
        doc = next(p for p in data["patients"] if p["id"] == "v3_keep")
        pen = doc["treatments"][0]["pens"][0]
        self.assertEqual(pen["expiryDate"], "2027-06-30", "la caducitat es conserva")
        self.assertEqual(pen["priceCents"], 12900)
        plan = doc["treatments"][0]["plans"][0]
        self.assertEqual(plan["status"], "postponed", "l'estat es conserva")
        self.assertEqual(plan["reason"], "viatge")
        self.assertEqual(doc["treatments"][0]["costs"][0]["amountCents"], 12900)

        # client v3 que neteja la caducitat → guanya l'usuari (clau present)
        cleared = json.loads(json.dumps(old_client))
        cleared["patients"][0]["updatedAt"] = "2099-01-04T00:00:00Z"
        cleared["patients"][0]["treatments"][0]["pens"][0]["expiryDate"] = None
        status, data = self.request("PUT", "/api/patients", cleared, token=token)
        self.assertEqual(status, 200, data)
        doc = next(p for p in data["patients"] if p["id"] == "v3_keep")
        self.assertIsNone(doc["treatments"][0]["pens"][0]["expiryDate"],
                          "una clau present és una decisió explícita")

    # -- autoritat del servidor sobre l'inventari (fase 2) ----------------
    @staticmethod
    def _patient(pid, at, *, admins=None, plans=None, pens=None):
        return {
            "id": pid, "code": pid.upper(), "updatedAt": at,
            "treatments": [{
                "id": "trt_" + pid, "drugId": "mounjaro", "startDate": "2026-11-01",
                "pens": pens or [{
                    "id": "pen_" + pid, "seq": 1, "presentationMg": 5,
                    "startDate": "2026-11-01", "status": "active",
                    "capacityUnit": "clicks", "initialCapacity": 240,
                    "clicksPerDose": 60, "dosesPerPen": 4, "startUsed": 0,
                }],
                "administrations": admins or [],
                "plans": plans or [],
                "schedules": [], "health": [], "costs": [],
            }],
        }

    @staticmethod
    def _admin(aid, date, *, amount=30, pen="pen_p16", key=None, balance=None, time=None):
        row = {
            "id": aid, "date": date, "penId": pen, "mode": "clicks",
            "value": amount, "amount": amount, "unit": "clicks", "mg": 5,
            "createdAt": "2026-11-01T08:00:00.000Z",
        }
        if key:
            row["idempotencyKey"] = key
        if balance is not None:
            row["balanceBefore"], row["balanceAfter"] = balance
        if time:
            row["time"] = time
        return row

    def test_16_doble_registre_es_descarta(self):
        """La mateixa dosi pujada per dos dispositius es consumeix UNA sola vegada."""
        token = self.login()
        first = {"patients": [self._patient("p16", "2099-02-01T00:00:00Z",
                                            admins=[self._admin("a16", "2026-11-01", key="k-16",
                                                                pen="pen_p16")])]}
        status, data = self.request("PUT", "/api/patients", first, token=token)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["duplicates"], 0)

        # un altre dispositiu registra la MATEIXA dosi amb un id diferent
        second = {"patients": [self._patient("p16", "2099-02-02T00:00:00Z",
                                             admins=[self._admin("a16-bis", "2026-11-01",
                                                                 key="k-16-bis", pen="pen_p16")])]}
        status, data = self.request("PUT", "/api/patients", second, token=token)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["duplicates"], 1, "el segon registre es descarta")
        doc = next(p for p in data["patients"] if p["id"] == "p16")
        admins = doc["treatments"][0]["administrations"]
        self.assertEqual([a["id"] for a in admins], ["a16"], "es conserva el primer")
        self.assertEqual(admins[0]["balanceAfter"], 210, "un sol descompte")

        # reenviament amb la MATEIXA clau (doble clic / retry) → també descartat
        retry = {"patients": [self._patient("p16", "2099-02-03T00:00:00Z",
                                            admins=[self._admin("a16-retry", "2026-11-01",
                                                                key="k-16", pen="pen_p16")])]}
        status, data = self.request("PUT", "/api/patients", retry, token=token)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["duplicates"], 1, "mateixa clau d'idempotència")
        doc = next(p for p in data["patients"] if p["id"] == "p16")
        self.assertEqual(len(doc["treatments"][0]["administrations"]), 1)

    def test_17_dispositiu_vell_no_per_registres(self):
        """Un client vell que no envia una administració no l'esborra."""
        token = self.login()
        full = {"patients": [self._patient("p17", "2099-02-01T00:00:00Z",
                                           admins=[self._admin("a17", "2026-11-01", key="k-17",
                                                               pen="pen_p17")])]}
        status, data = self.request("PUT", "/api/patients", full, token=token)
        self.assertEqual(status, 200, data)

        stale = {"patients": [self._patient("p17", "2099-02-02T00:00:00Z", admins=[])]}
        status, data = self.request("PUT", "/api/patients", stale, token=token)
        self.assertEqual(status, 200, data)
        self.assertGreaterEqual(data["preserved"], 1, "es preserva el que el client no coneix")
        doc = next(p for p in data["patients"] if p["id"] == "p17")
        self.assertEqual([a["id"] for a in doc["treatments"][0]["administrations"]], ["a17"])

        # en canvi, una TOMBA sí que s'esborra (és una decisió explícita)
        tomb = {"patients": [self._patient("p17", "2099-02-03T00:00:00Z", admins=[
            {**self._admin("a17", "2026-11-01", key="k-17", pen="pen_p17"),
             "deletedAt": "2099-02-03T00:00:00.000Z"}])]}
        status, data = self.request("PUT", "/api/patients", tomb, token=token)
        self.assertEqual(status, 200, data)
        doc = next(p for p in data["patients"] if p["id"] == "p17")
        admin = doc["treatments"][0]["administrations"][0]
        self.assertTrue(admin["deletedAt"], "la tomba arriba i es conserva")

    def test_18_saldos_son_autoritat_del_servidor(self):
        """Un dispositiu amb saldos vells no els pot propagar: el servidor recalcua."""
        token = self.login()
        bad = {"patients": [self._patient("p18", "2099-02-01T00:00:00Z", admins=[
            self._admin("a18", "2026-11-01", amount=30, key="k-18", pen="pen_p18",
                        balance=(999, 999))])]}
        status, data = self.request("PUT", "/api/patients", bad, token=token)
        self.assertEqual(status, 200, data)
        doc = next(p for p in data["patients"] if p["id"] == "p18")
        admin = doc["treatments"][0]["administrations"][0]
        self.assertEqual(admin["balanceBefore"], 240, "corregit: capacitat − 0")
        self.assertEqual(admin["balanceAfter"], 210, "corregit: 240 − 30")

    def test_19_proposta_es_vincula_i_es_reobre(self):
        """Registrar tanca la proposta; tombar l'administració la torna a obrir."""
        token = self.login()
        plan = {"id": "pln19", "date": "2026-11-01", "penId": "pen_p19",
                "mode": "clicks", "value": 30, "amount": 30, "unit": "clicks",
                "mg": 5, "registeredAdminId": None, "status": "planned"}
        doc1 = self._patient("p19", "2099-02-01T00:00:00Z",
                             admins=[self._admin("a19", "2026-11-01", pen="pen_p19", key="k-19")],
                             plans=[plan])
        doc1["treatments"][0]["pens"][0]["id"] = "pen_p19"
        status, data = self.request("PUT", "/api/patients", {"patients": [doc1]}, token=token)
        self.assertEqual(status, 200, data)
        doc = next(p for p in data["patients"] if p["id"] == "p19")
        t = doc["treatments"][0]
        self.assertEqual(t["plans"][0]["registeredAdminId"], "a19", "vinculada")
        self.assertEqual(t["plans"][0]["status"], "administered")

        # esborrar l'administració (tomba) → la proposta torna a quedar pendent
        doc2 = json.loads(json.dumps(doc1))
        doc2["updatedAt"] = "2099-02-02T00:00:00Z"
        doc2["treatments"][0]["administrations"][0]["deletedAt"] = "2099-02-02T00:00:00Z"
        status, data = self.request("PUT", "/api/patients", {"patients": [doc2]}, token=token)
        self.assertEqual(status, 200, data)
        doc = next(p for p in data["patients"] if p["id"] == "p19")
        plan = doc["treatments"][0]["plans"][0]
        self.assertIsNone(plan["registeredAdminId"], "torna a estar pendent")
        self.assertEqual(plan["status"], "planned")

    def test_19b_enllac_amb_discrepancia_de_dosi(self):
        """Registrar una dosi diferent tanca igualment la proposta (P0)."""
        token = self.login()
        plan = {"id": "pln19b", "date": "2026-11-01", "penId": "pen_p19b",
                "mode": "clicks", "value": 15, "amount": 15, "unit": "clicks",
                "mg": 2.5, "registeredAdminId": None, "status": "planned"}
        doc = self._patient("p19b", "2099-03-01T00:00:00Z",
                            admins=[self._admin("a19b", "2026-11-01", amount=30, pen="pen_p19b", key="k-19b")],
                            plans=[plan])
        doc["treatments"][0]["pens"][0]["id"] = "pen_p19b"
        status, data = self.request("PUT", "/api/patients", {"patients": [doc]}, token=token)
        self.assertEqual(status, 200, data)
        t = next(p for p in data["patients"] if p["id"] == "p19b")["treatments"][0]
        self.assertEqual(t["plans"][0]["registeredAdminId"], "a19b", "es vincula malgrat la diferència")
        self.assertEqual(t["plans"][0]["amount"], 15, "la proposta conserva la dosi prescrita")
        self.assertEqual(t["administrations"][0]["amount"], 30, "l'administració conserva la dosi real")

    def test_19c_continuacio_auto_nomes_amb_consentiment(self):
        """`autoPlan` mai és `true` sense consentiment explícit (P0)."""
        token = self.login()
        # tractament heretat del valor per defecte: sense consentiment
        doc = self._patient("p19c", "2099-03-02T00:00:00Z")
        doc["treatments"][0]["autoPlan"] = True
        status, data = self.request("PUT", "/api/patients", {"patients": [doc]}, token=token)
        self.assertEqual(status, 200, data)
        t = next(p for p in data["patients"] if p["id"] == "p19c")["treatments"][0]
        self.assertFalse(t["autoPlan"], "sense consentiment queda aturada")
        self.assertFalse(t["autoPlanConsent"])

        # consentiment explícit des del client → es respecta
        doc2 = self._patient("p19d", "2099-03-03T00:00:00Z")
        doc2["treatments"][0]["autoPlan"] = True
        doc2["treatments"][0]["autoPlanConsent"] = True
        status, data = self.request("PUT", "/api/patients", {"patients": [doc2]}, token=token)
        self.assertEqual(status, 200, data)
        t2 = next(p for p in data["patients"] if p["id"] == "p19d")["treatments"][0]
        self.assertTrue(t2["autoPlan"], "amb consentiment es manté activada")

    def test_20_auditoria_registra_els_canvis(self):
        """Cada canvi queda al registre (append-only, amb actor)."""
        token = self.login()
        doc = self._patient("p20", "2099-02-01T00:00:00Z",
                            admins=[self._admin("a20", "2026-11-01", key="k-20", pen="pen_p20")])
        status, data = self.request("PUT", "/api/patients", {"patients": [doc]}, token=token)
        self.assertEqual(status, 200, data)
        self.assertGreaterEqual(data["audited"], 1)

        status, data = self.request("GET", "/api/patients/p20/audit", token=token)
        self.assertEqual(status, 200, data)
        actions = {e["action"] for e in data["entries"]}
        self.assertIn("create", actions, f"accions: {actions}")
        self.assertTrue(all(e["actor_name"] == "admin" for e in data["entries"]), "amb actor")
        entry = next(e for e in data["entries"] if e["entity"] == "administrations")
        self.assertEqual(entry["entity_id"], "a20")
        self.assertIn("after", entry)

        # un canvi posterior també s'audita (abans/després)
        doc2 = json.loads(json.dumps(doc))
        doc2["updatedAt"] = "2099-02-02T00:00:00Z"
        doc2["treatments"][0]["administrations"][0]["notes"] = "dolor al lloc"
        status, data = self.request("PUT", "/api/patients", {"patients": [doc2]}, token=token)
        self.assertEqual(status, 200, data)
        status, data = self.request("GET", "/api/patients/p20/audit", token=token)
        self.assertTrue(any(e["action"] == "update" for e in data["entries"]), "update auditat")

    def test_21_tombes_velles_es_purgen(self):
        """Les tombes de més de N dies desapareixen (i no acumulen brossa)."""
        token = self.login()
        from datetime import datetime, timedelta
        old = (datetime.utcnow() - timedelta(days=45)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        doc = self._patient("p21", "2099-02-01T00:00:00Z", admins=[
            {**self._admin("a21-vella", "2026-11-01", key="k-21", pen="pen_p21"),
             "deletedAt": old},
            self._admin("a21-viva", "2026-11-02", key="k-21b", pen="pen_p21"),
        ])
        status, data = self.request("PUT", "/api/patients", {"patients": [doc]}, token=token)
        self.assertEqual(status, 200, data)
        doc = next(p for p in data["patients"] if p["id"] == "p21")
        ids = [a["id"] for a in doc["treatments"][0]["administrations"]]
        self.assertNotIn("a21-vella", ids, "la tomba vella es purga")
        self.assertIn("a21-viva", ids)

    def test_22_esborrar_tractament_no_torna(self):
        """Una pujada posterior no ressuscita un tractament esborrat (tomba)."""
        token = self.login()
        doc = self._patient("p22", "2099-03-01T00:00:00Z")
        pick = lambda d: next(p for p in d["patients"] if p["id"] == "p22")  # noqa: E731

        status, data = self.request("PUT", "/api/patients", {"patients": [doc]}, token=token)
        self.assertEqual(status, 200, data)
        self.assertEqual(len(pick(data)["treatments"]), 1)

        # esborrat (tomba)
        tomb = json.loads(json.dumps(doc))
        tomb["updatedAt"] = "2099-03-02T00:00:00Z"
        tomb["treatments"][0]["deletedAt"] = "2099-03-02T00:00:00.000Z"
        status, data = self.request("PUT", "/api/patients", {"patients": [tomb]}, token=token)
        self.assertEqual(status, 200, data)
        trts = pick(data)["treatments"]
        self.assertEqual(len(trts), 1)
        self.assertTrue(trts[0]["deletedAt"], "la tomba es conserva (per sincronitzar)")

        # un dispositiu vell que no envia el tractament NO el ressuscita
        stale = json.loads(json.dumps(doc))
        stale["updatedAt"] = "2099-03-03T00:00:00Z"
        status, data = self.request("PUT", "/api/patients", {"patients": [stale]}, token=token)
        self.assertEqual(status, 200, data)
        trts = pick(data)["treatments"]
        self.assertEqual(len(trts), 1, "es preserva (client vell)")
        self.assertTrue(trts[0]["deletedAt"], "continua esborrat, no torna a estar actiu")

    def test_23b_pla_sense_ploma(self):
        """Un pla prescrit en mg pot no tenir ploma; en registrar, se li assigna (issue #2)."""
        token = self.login()
        plan = {"id": "pln23", "date": "2026-12-01", "penId": None,
                "mode": "standard", "value": 5, "amount": 5, "unit": "mg",
                "mg": 5, "registeredAdminId": None, "status": "planned"}
        doc = self._patient("p23", "2099-04-01T00:00:00Z", plans=[plan])
        status, data = self.request("PUT", "/api/patients", {"patients": [doc]}, token=token)
        self.assertEqual(status, 200, data)
        t = next(p for p in data["patients"] if p["id"] == "p23")["treatments"][0]
        saved = t["plans"][0]
        self.assertIsNone(saved["penId"], "el servidor conserva el pla sense ploma")
        self.assertIsNone(saved["registeredAdminId"])
        self.assertEqual(saved["status"], "planned")

        # registre real d'aquella data → s'enllaça i se li assigna la ploma
        doc2 = json.loads(json.dumps(doc))
        doc2["updatedAt"] = "2099-04-02T00:00:00Z"
        doc2["treatments"][0]["administrations"] = [
            self._admin("a23", "2026-12-01", amount=30, pen="pen_p23", key="k-23")]
        status, data = self.request("PUT", "/api/patients", {"patients": [doc2]}, token=token)
        self.assertEqual(status, 200, data)
        t = next(p for p in data["patients"] if p["id"] == "p23")["treatments"][0]
        saved = t["plans"][0]
        self.assertEqual(saved["penId"], "pen_p23", "la ploma s'assigna en registrar")
        self.assertEqual(saved["registeredAdminId"], "a23", "enllaçat")
        self.assertEqual(saved["amount"], 5, "la dosi prescrita es conserva")

    def test_12_invalid_json_and_unknown_route(self):
        token = self.login()
        status, _ = self.request("GET", "/api/que-shou", token=token)
        self.assertEqual(status, 404)
        status, _ = self.request("PUT", "/api/patients", token=token)  # sense cos
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
