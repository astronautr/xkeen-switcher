"""JSONC with position-preserving comments and strict duplicate-key handling."""
import json

def scan(text: str) -> tuple[str, list[tuple[int, int, str]]]:
    chars = list(text)
    comments = []
    i = 0
    while i < len(text):
        if text[i] == '"':
            i += 1
            while i < len(text):
                if text[i] == "\\":
                    i += 2
                elif text[i] == '"':
                    i += 1
                    break
                else:
                    i += 1
        elif text[i:i + 2] in ("//", "/*"):
            start = i
            if text[i:i + 2] == "//":
                end = text.find("\n", i)
                end = len(text) if end < 0 else end
                label = text[i + 2:end].strip()
            else:
                end = text.find("*/", i + 2)
                if end < 0:
                    raise ValueError("Unterminated JSONC comment")
                label = text[i + 2:end].strip()
                end += 2
            comments.append((start, end, label))
            for pos in range(start, end):
                if chars[pos] not in "\r\n":
                    chars[pos] = " "
            i = end
        else:
            i += 1
    return "".join(chars), comments

def strip_comments(text: str) -> str:
    return scan(text)[0]

def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result

def loads(text: str):
    def bad_constant(value):
        raise ValueError(f"Invalid JSON value: {value}")
    return json.loads(strip_comments(text), object_pairs_hook=_pairs, parse_constant=bad_constant)

def rule_titles(text: str) -> list[str]:
    """Locate objects directly inside routing.rules, never nested objects."""
    clean, comments = scan(text)
    decoder = json.JSONDecoder()
    titles = []
    def walk(pos, path):
        while pos < len(clean) and clean[pos].isspace():
            pos += 1
        if clean[pos] == "{":
            pos += 1
            while True:
                while clean[pos].isspace() or clean[pos] == ",": pos += 1
                if clean[pos] == "}": return pos + 1
                key, pos = decoder.raw_decode(clean, pos)
                while clean[pos].isspace() or clean[pos] == ":": pos += 1
                pos = walk(pos, path + [key])
        if clean[pos] == "[":
            pos += 1
            boundary = pos
            while True:
                while clean[pos].isspace() or clean[pos] == ",": pos += 1
                if clean[pos] == "]": return pos + 1
                if path == ["routing", "rules"]:
                    preceding = [c[2] for c in comments if boundary <= c[0] and c[1] <= pos]
                    titles.append(preceding[-1] if preceding else "")
                pos = walk(pos, path + [len(titles)])
                boundary = pos
        return decoder.raw_decode(clean, pos)[1]
    # loads must have validated the syntax before this traversal.
    walk(0, [])
    return titles
