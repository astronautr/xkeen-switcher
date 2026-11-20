import copy
import json
import pytest
from xk_switcher import jsonc, routing
from xk_switcher.router import MOCK_ROUTING

def test_import_and_generate_preserve_fields_titles_and_semantics():
    raw=MOCK_ROUTING.replace(b'"domainStrategy":"AsIs"',b'"domainStrategy":"IPOnDemand","domainMatcher":"hybrid"')
    model=routing.parse(raw)
    assert len(model["groups"]) == 7
    assert model["groups"][0]["title"] == "Vulnerable UDP ports"
    assert not routing.validate(model)
    output=jsonc.loads(routing.generate(model).decode())
    assert output["routing"]["domainStrategy"] == "IPOnDemand"
    assert output["routing"]["domainMatcher"] == "hybrid"
    assert output["routing"]["rules"][0]["port"] == "135,137,138,139"

def test_unknown_rule_is_preserved_and_not_editable():
    doc=jsonc.loads(MOCK_ROUTING.decode())
    doc["routing"]["rules"][1].update(sourcePort="1234",outboundTag="custom",inboundTag=["custom"])
    model=routing.parse(json.dumps(doc).encode())
    assert not model["groups"][1]["editable"]
    model["groups"][3]["title"]="Renamed"
    assert jsonc.loads(routing.generate(model).decode())["routing"]["rules"][1] == doc["routing"]["rules"][1]

def test_client_cannot_change_hidden_fields():
    base=routing.parse(MOCK_ROUTING)
    supplied=copy.deepcopy(base)
    supplied["document"]["routing"]["domainStrategy"]="IPOnDemand"
    supplied["groups"][0]["rule"]["inboundTag"]=["different"]
    assert routing.edit_model(base,supplied)["groups"][0]["rule"]["inboundTag"] == routing.INBOUND_TAGS
    assert routing.edit_model(base,supplied)["document"] == base["document"]

@pytest.mark.parametrize("action,tag",[("direct","direct"),("proxy","vless-reality"),("block","block")])
def test_default_action_is_editable_generated_and_reimported(action,tag):
    base=routing.parse(MOCK_ROUTING);supplied=copy.deepcopy(base)
    supplied["groups"][-1].update(action=action,title="Остальной трафик")
    edited=routing.edit_model(base,supplied)
    assert not routing.validate(edited)
    raw=routing.generate(edited)
    assert jsonc.loads(raw.decode())["routing"]["rules"][-1]["outboundTag"]==tag
    imported=routing.parse(raw)
    assert not imported["issues"]
    assert imported["groups"][-1]["editable"] and imported["groups"][-1]["catch_all"]
    assert imported["groups"][-1]["action"]==action

def test_default_rule_can_be_moved_or_given_conditions_but_not_removed():
    base=routing.parse(MOCK_ROUTING)
    moved=copy.deepcopy(base);moved["groups"].insert(0,moved["groups"].pop())
    moved=routing.edit_model(base,moved)
    assert any(e["severity"]=="warning" and e.get("group_id")==base["groups"][-1]["id"] for e in routing.validate(moved))
    routing.generate(moved)
    removed=copy.deepcopy(base);removed["groups"].pop()
    with pytest.raises(routing.RoutingError,match="cannot be deleted"):
        routing.edit_model(base,removed)
    conditional=copy.deepcopy(base)
    conditional["groups"][-1]["matchers"]=[{"type":"domain-suffix","value":"example.org"}]
    conditional=routing.edit_model(base,conditional)
    assert not conditional["groups"][-1]["catch_all"]
    assert conditional["groups"][-1]["default_rule"]
    assert jsonc.loads(routing.generate(conditional).decode())["routing"]["rules"][-1]["domain"]==["domain:example.org"]

def test_client_cannot_clear_default_rule_deletion_guard():
    base=routing.parse(MOCK_ROUTING);supplied=copy.deepcopy(base)
    supplied["groups"][-1].update(default_rule=False,catch_all=False)
    edited=routing.edit_model(base,supplied)
    assert edited["groups"][-1]["default_rule"]
    deleted=copy.deepcopy(edited);deleted["groups"].pop()
    with pytest.raises(routing.RoutingError,match="cannot be deleted"):
        routing.edit_model(edited,deleted)

def test_exact_and_domain_are_distinct_and_ext_preserved():
    model=routing.parse(MOCK_ROUTING)
    model["groups"][1]["matchers"]=[{"type":"domain-exact","value":"a.example"},{"type":"domain-suffix","value":"b.example"},
                                     {"type":"domain-geosite","value":"ext:custom.dat:tag@attr"}]
    domains=jsonc.loads(routing.generate(model).decode())["routing"]["rules"][1]["domain"]
    assert domains == ["full:a.example","domain:b.example","ext:custom.dat:tag@attr"]

@pytest.mark.parametrize("matcher",[
    {"type":"port","value":"65536"},{"type":"port","value":"443-80"},{"type":"port","value":"0"},
    {"type":"source","value":"192.168.1.999"},{"type":"network","value":"icmp"},{"type":"protocol","value":"garbage"},
])
def test_invalid_matchers_block_generation(matcher):
    model=routing.parse(MOCK_ROUTING);model["groups"][1]["matchers"]=[matcher]
    with pytest.raises(routing.RoutingError):routing.generate(model)

def test_python_regex_is_not_used_as_xray_validator():
    model=routing.parse(MOCK_ROUTING);model["groups"][1]["matchers"]=[{"type":"domain-regexp","value":r"\p{Han}"}]
    assert not routing.validate(model)

def test_scalar_duplicates_are_errors_and_catch_all_order_is_a_warning():
    model=routing.parse(MOCK_ROUTING)
    model["groups"][0]["matchers"].append({"type":"port","value":"443"})
    with pytest.raises(routing.RoutingError):routing.generate(model)
    model["groups"][0]["matchers"]=[]
    assert any("has no conditions" in e["message"] and e["severity"]=="warning" for e in routing.validate(model))
    routing.generate(model)

def test_reorder_action_and_removed_values_in_diff():
    base=routing.parse(MOCK_ROUTING);target=copy.deepcopy(base)
    target["groups"][0],target["groups"][1]=target["groups"][1],target["groups"][0]
    changes=routing.diff(base,target)
    assert len(changes)==2 and all(c["moved"] for c in changes)
    target["groups"][0]["action"]="direct"
    target["groups"].pop(3)
    changes=routing.diff(base,target)
    assert any("action" in c["fields"] for c in changes)
    assert next(c for c in changes if c["kind"]=="removed")["before"]["matchers"]

def test_jsonc_comments_strings_duplicates_and_title_scope():
    text='// document\n{"routing":{/* note */"rules":[// first\n{"domain":["https://example/\\\"/*x*/"],"outboundTag":"direct"},\n// second\n{"outboundTag":"block"}]}}'
    assert jsonc.rule_titles(text)==["first","second"]
    assert "https://" in jsonc.loads(text)["routing"]["rules"][0]["domain"][0]
    assert len(jsonc.strip_comments(text)) == len(text)
    with pytest.raises(ValueError):jsonc.loads('{"x":1,"x":2}')
    with pytest.raises(ValueError):jsonc.loads('{"x":NaN}')
    with pytest.raises(ValueError):jsonc.loads('{} /* unterminated')

def test_reimport_keeps_unambiguous_ids():
    model=routing.parse(MOCK_ROUTING)
    again=routing.parse(MOCK_ROUTING,model)
    assert [g["id"] for g in again["groups"]]==[g["id"] for g in model["groups"]]
