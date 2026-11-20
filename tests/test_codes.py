from xk_switcher.codes import code_for

def test_flag_only_emits_iso_code():
    assert code_for("FIN 🇫🇮 1gbit⚡") == "fi"

def test_another_flag():
    assert code_for("GER 🇩🇪 1gbit⚡") == "de"

def test_flag_with_digit_suffix():
    assert code_for("RU 1 🇷🇺") == "ru1"
    assert code_for("RU 2 🇷🇺") == "ru2"
    assert code_for("RU 3 🇷🇺") == "ru3"

def test_alt_qualifier_distinguishes_same_country():
    assert code_for("FIN 🇫🇮 1gbit⚡") == "fi"
    assert code_for("FIN Alt 🇫🇮 1gbit⚡") == "fialt"

def test_auto_keyword_cyrillic_takes_priority():
    assert code_for("🇪🇺Автовыбор 🌍") == "auto"

def test_auto_keyword_latin():
    assert code_for("Auto selector") == "auto"

def test_no_flag_no_auto_fallback_to_letters():
    assert code_for("Custom 🛰") == "cus"

def test_empty_string_returns_unknown():
    assert code_for("") == "unknown"

def test_stable_across_calls():
    name = "FIN 🇫🇮 1gbit⚡"
    assert code_for(name) == code_for(name) == "fi"

def test_digit_only_without_flag_no_suffix_applied():
    assert code_for("Server 1") == "ser"
