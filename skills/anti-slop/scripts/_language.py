"""_language.py - shared language-detection tables and tokenizers for the
anti-slop scanner. Leaf module: scan_slop.py and low_density.py both import
from here so neither imports the other at module load (scan_slop still calls
into low_density at runtime, inside scan_lines). Stdlib only; Python 3.9+.
"""
from __future__ import annotations

import re

ID = re.compile(r"[A-Za-z_$][\w$]*")
TYPE_DECL = re.compile(r"\b(?:type|interface)\s+([A-Z][A-Za-z0-9_]*)\b")

METHOD_JS = re.compile(
    r"^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+"
    r"|get\s+|set\s+|override\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*"
    r"(?::\s*[^={;]+)?\s*\{"
)
METHOD_CSTYLE = re.compile(
    r"^\s*(?:(?:public|private|protected|internal|static|final|virtual|override"
    r"|abstract|async|sealed|unsafe)\s+)+[\w<>\[\].,?]+\s+([A-Za-z_]\w*)\s*"
    r"\([^;{]*\)\s*(?:where[^{]+)?\{"
)
NOT_METHOD = {
    "if", "for", "while", "switch", "catch", "return", "function", "do",
    "else", "with", "await", "new", "delete", "void", "yield", "case",
    "throw", "super", "typeof", "using", "lock", "fixed", "foreach",
}
FUNC_PATTERNS = {
    "js": [
        re.compile(r"(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\("),
        re.compile(r"(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>"),
        METHOD_JS,
    ],
    "py": [re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(")],
    "go": [re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(")],
    "rust": [re.compile(r"\bfn\s+([A-Za-z_]\w*)\s*[(<]")],
    "ruby": [re.compile(r"^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)")],
    "php": [re.compile(r"\bfunction\s+([A-Za-z_]\w*)\s*\(")],
    "cstyle": [METHOD_CSTYLE],
}

_STR_DQ = r'"(?:[^"\\\n]|\\.)*"'
_STR_SQ = r"'(?:[^'\\\n]|\\.)*'"
_STR_BT = r"`(?:[^`\\]|\\.)*`"
_STR_TRIPLE = r"'''(?s:.*?)'''|\"\"\"(?s:.*?)\"\"\""
_CMT_SLASH = r"//[^\n]*"
_CMT_HASH = r"#[^\n]*"
_CMT_BLOCK = r"/\*(?s:.*?)\*/"
_FAMILY_SYNTAX = {
    "py":   (f"{_STR_TRIPLE}|{_STR_DQ}|{_STR_SQ}", _CMT_HASH),
    "ruby": (f"{_STR_DQ}|{_STR_SQ}", _CMT_HASH),
    "php":  (f"{_STR_DQ}|{_STR_SQ}", f"{_CMT_SLASH}|{_CMT_BLOCK}|{_CMT_HASH}"),
    "bt":   (f"{_STR_BT}|{_STR_DQ}|{_STR_SQ}", f"{_CMT_SLASH}|{_CMT_BLOCK}"),
    "c":    (f"{_STR_DQ}|{_STR_SQ}", f"{_CMT_SLASH}|{_CMT_BLOCK}"),
}
_LANG_FAMILY = {"py": "py", "ruby": "ruby", "php": "php", "js": "bt", "go": "bt"}
_TOKEN_RX = {
    fam: re.compile(f"(?P<s>{strs})|(?P<c>{cmts})")
    for fam, (strs, cmts) in _FAMILY_SYNTAX.items()
}


def _strip_comments(text: str, lang: str, string_repl: str | None) -> str:
    """Drop comments for `lang`; keep strings verbatim (string_repl=None) or
    mask each one with string_repl."""
    rx = _TOKEN_RX[_LANG_FAMILY.get(lang, "c")]

    def repl(m: re.Match[str]) -> str:
        if m.lastgroup == "s":
            return m.group(0) if string_repl is None else string_repl
        return " "

    return rx.sub(repl, text)


def _mask_strings(text: str, lang: str) -> str:
    """Mask string-literal contents but KEEP comments. For detectors whose
    habitat is comments/code (residue phrases, boolean call args): a slop
    phrase *quoted in a string* is a fixture or UI copy - the model pass
    judges those in context, the scanner must not."""
    rx = _TOKEN_RX[_LANG_FAMILY.get(lang, "c")]
    return rx.sub(lambda m: "L" if m.lastgroup == "s" else m.group(0), text)


def lang_of(rel: str) -> str:
    ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else ""
    if ext == "py":
        return "py"
    if ext == "go":
        return "go"
    if ext == "rs":
        return "rust"
    if ext == "rb":
        return "ruby"
    if ext == "php":
        return "php"
    if ext in ("java", "kt", "kts", "cs", "scala"):
        return "cstyle"
    if ext in ("ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro"):
        return "js"
    return "other"
