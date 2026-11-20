import copy
import time
import pytest
from tests._helpers import make_test_server, _Client
from xk_switcher.state import State
from xk_switcher.routing import new_id

@pytest.fixture
def client(tmp_path):
    state=State(tmp_path);state.init({})
    httpd,client=make_test_server(state)
    yield client
    httpd.shutdown();httpd.server_close()


def test_routing_auth_and_strict_body(client):
    for path in ['/api/routing','/api/routing/history','/api/routing/draft','/api/routing/history/'+new_id()+'/download']:
        guest = _Client(client.base_url)
        assert guest.get(path).status_code==401
        assert guest.get(path, headers={'X-Token':'test-token'}).status_code==401
    assert client.put('/api/routing/draft',[]).status_code==400
    assert client.get('/api/routing/history/bad-id').status_code==400

def test_web_draft_preview_apply_history_download(client):
    info=client.get('/api/routing').json()
    info['model']['groups'][1]['title']='Changed via API'
    info['model']['groups'][-1]['action']='direct'
    draft=client.put('/api/routing/draft',{'model':info['model'],'base_hash':info['current']['sha256'],'expected_revision':None}).json()
    preview=client.post('/api/routing/preview',{'expected_current_hash':info['current']['sha256'],'draft_revision':draft['revision']})
    assert preview.status_code==200,preview.text
    applied=client.post('/api/routing/apply',{'preview_id':preview.json()['id'],'operation_id':new_id()})
    assert applied.status_code==202
    for _ in range(100):
        op=client.get('/api/routing/operations/'+applied.json()['id']).json()
        if op['phase']=='committed':break
        time.sleep(.01)
    assert op['phase']=='committed'
    history=client.get('/api/routing/history').json()
    original=next(m for m in history['snapshots'] if m['original'])
    download=client.get('/api/routing/history/'+original['id']+'/download')
    assert download.status_code==200 and download.text.startswith('// Local demo')
    assert 'attachment' in download.headers['Content-Disposition']
    assert client.get('/api/routing/draft').json()['draft'] is None
    current=client.get('/api/routing').json()
    assert current['model']['groups'][-1]['action']=='direct'
    assert current['model']['groups'][-1]['editable']
    current['model']['groups'].pop()
    removed=client.put('/api/routing/draft',{'model':current['model'],'base_hash':current['current']['sha256'],'expected_revision':None})
    assert removed.status_code==400 and 'cannot be deleted' in removed.json()['error']

@pytest.mark.parametrize("method,path", [
    ("POST", "/api/routing/preview"),
    ("POST", "/api/routing/apply"),
    ("POST", "/api/routing/reimport"),
    ("PUT", "/api/routing/draft"),
    ("DELETE", "/api/routing/draft"),
])
def test_routing_mutations_require_session_and_request_marker(client, method, path):
    guest = _Client(client.base_url)
    assert guest._req(method, path).status_code == 401
    assert client._req(method, path, headers={"X-XK-Request":""}).status_code == 403
    assert client._req(method, path, headers={"Origin":"http://foreign.invalid"}).status_code == 403
    assert client._req(method, path, headers={"Content-Type":"text/plain"}).status_code == 415

def test_discard_draft_uses_revision_and_cookie_session(client):
    info = client.get("/api/routing").json()
    info["model"]["groups"][1]["title"] = "Draft to discard"
    draft = client.put("/api/routing/draft", {
        "model": info["model"], "base_hash": info["current"]["sha256"],
        "expected_revision": None,
    }).json()
    assert client._req("DELETE", "/api/routing/draft", {"expected_revision":"stale"}).status_code == 409
    assert client._req("DELETE", "/api/routing/draft", {"expected_revision":draft["revision"]}).status_code == 200
    assert client.get("/api/routing/draft").json()["draft"] is None

def test_reverting_saved_rule_removes_pending_changes(client):
    info = client.get("/api/routing").json()
    model = copy.deepcopy(info["model"])
    model["groups"][-1]["action"] = "direct"
    body = {"model":model, "base_hash":info["current"]["sha256"], "expected_revision":None}
    draft = client.put("/api/routing/draft", body).json()
    body.update(model=info["model"], expected_revision=draft["revision"])
    reverted = client.put("/api/routing/draft", body)
    assert reverted.status_code == 200 and reverted.json() is None
    assert client.get("/api/routing/draft").json()["draft"] is None
    current = client.get("/api/routing").json()
    assert current["draft"] is None and current["current"] == info["current"]
    assert current["model"] == info["model"]
