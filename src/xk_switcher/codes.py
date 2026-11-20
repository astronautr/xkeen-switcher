"""Map a VLESS subscription entry name to a stable short code.

The code is used as a user-facing identifier that survives subscription
refreshes: provider-changed labels or edited emoji should still map to the
same code for a given country/region.
"""
import re

_FLAG_OFFSET = 0x1F1E6
_FLAG_RANGE_END = 0x1F1FF
_ALPHA_OFFSET = ord("A")
_AUTO_KEYWORDS = ("auto", "автовыбор")
_FALLBACK_LETTERS = 3
_UNKNOWN = "unknown"
_QUALIFIERS = ("alt",)

def code_for(name: str) -> str:
    lower = name.lower()
    if any(k in lower for k in _AUTO_KEYWORDS):
        return "auto"
    flag = _extract_flag(name)
    if flag:
        suffix = _extract_digit(name) or _extract_qualifier(name)
        return f"{flag}{suffix}" if suffix else flag
    letters = re.sub(r"[^A-Za-z]", "", name).lower()
    return letters[:_FALLBACK_LETTERS] or _UNKNOWN

def _extract_qualifier(s: str) -> str:
    lower = s.lower()
    for q in _QUALIFIERS:
        if re.search(rf"\b{q}\b", lower):
            return q
    return ""

def _extract_flag(s: str) -> str:
    picked = []
    for ch in s:
        o = ord(ch)
        if _FLAG_OFFSET <= o <= _FLAG_RANGE_END:
            picked.append(chr(o - _FLAG_OFFSET + _ALPHA_OFFSET))
            if len(picked) == 2:
                break
    return "".join(picked).lower() if len(picked) == 2 else ""

def _extract_digit(s: str) -> str:
    m = re.search(r"(?:^|\s)(\d)(?=\s|$)", s)
    return m.group(1) if m else ""
