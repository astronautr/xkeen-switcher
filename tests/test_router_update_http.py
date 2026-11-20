from datetime import timedelta
import time
import uuid

from tests._helpers import _Client
from tests.ui_support.server import PASSWORD, fixture_server

def test_schedule_install_and_rollback_via_authenticated_dashboard_api(synthetic_ui_dist):
    with fixture_server(configured=True, ui_dist=synthetic_ui_dist) as fixture:
        api = "/api/router-updates"
        client = _Client(fixture.url)
        assert client.post("/api/auth/login", {"password": PASSWORD}).status_code == 200
        view = client.post(api + "/check").json()
        xray = view["components"]["xray"]
        original = xray["installed"]
        version = next(r["version"] for r in xray["releases"] if r["supported"])
        when = (fixture.service.router_updates.clock() + timedelta(days=2)).replace(hour=0, minute=0, second=0)
        schedule = client.put(api + "/schedule", {"component": "xray", "version": version, "at": when.isoformat()})
        assert schedule.status_code == 200, schedule.text
        assert schedule.json()["components"]["xray"]["schedule"]["version"] == version

        def run(action, target, **options):
            request = {"id": str(uuid.uuid4()), "component": "xray", "version": target, **options}
            result = client.post(api + "/" + action, request)
            assert result.status_code == 202, result.text
            for _ in range(100):
                current = client.get(api).json()
                if current["components"]["xray"]["installed"] == target and not current["operation"]:
                    return current
                time.sleep(.05)
            raise AssertionError(current)

        installed = run("install", version)
        xray = installed["components"]["xray"]
        assert xray["schedule"] is None
        assert xray["rollback"] == [{"component": "xray", "from": version, "to": original}]
        restored = run("rollback", original, plan=xray["rollback"], revision=installed["rollback_revision"])
        assert restored["components"]["xray"]["held"] == version
        assert not any(r["component"] == "xray" and r["version"] == version for r in restored["available"])

def test_combined_update_from_one_authenticated_request(synthetic_ui_dist):
    with fixture_server(configured=True, ui_dist=synthetic_ui_dist) as fixture:
        client = _Client(fixture.url)
        api = "/api/router-updates"
        batch = api + "/batch"
        versions = {"xkeen": "2.1", "xray": "26.10.31"}
        pair = {"id": str(uuid.uuid4()), "versions": versions}
        assert client.post(batch, pair).status_code == 401
        assert client.post("/api/auth/login", {"password": PASSWORD}).status_code == 200
        assert client.post(batch, pair, headers={"X-XK-Request": "0"}).status_code == 403
        assert client.post(api + "/check").status_code == 200
        when = fixture.service.router_updates.clock() + timedelta(days=1)
        response = client.post(batch, {**pair, "at": when.isoformat()})
        assert response.status_code == 202, response.text
        assert response.json()["pair"]["state"] == "pending"
        moved = {"id": pair["id"], "at": (when + timedelta(days=1)).isoformat()}
        assert client.put(batch, moved).json()["pair"]["state"] == "pending"
        assert client._req("DELETE", batch, {"id": pair["id"]}).json()["pair"]["state"] == "cancelled"

        pair["id"] = str(uuid.uuid4())
        assert client.post(batch, pair).status_code == 202
        for _ in range(200):
            status = client.get(api).json()
            if status["pair"]["state"] == "installed":
                break
            time.sleep(.05)
        assert status["pair"]["steps"] == {"xkeen": "installed", "xray": "installed"}, status["pair"]
        assert {name: item["installed"] for name, item in status["components"].items()} == versions
        assert [op["component"] for op in status["history"] if op["phase"] == "installed"] == ["xray", "xkeen"]
