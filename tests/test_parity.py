"""AC-6: the site's JS ranking gives the same results as repo-fit-check's discover.py.

Both implementations get the same repositories, the same queries and the same clock. The top
lists, scores (3 decimals), matched fields and counts must be identical. If this fails after a
rule change, change the other implementation too.

The skill is looked up next to this project (../repo-fit-check). Set REPO_FIT_CHECK_DIR to use
another checkout. A missing skill is an error here, never a skip.
"""
import json
import os
import random
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = Path(os.environ.get("REPO_FIT_CHECK_DIR", ROOT.parent / "repo-fit-check"))
if not (SKILL / "scripts" / "discover.py").is_file():
    raise ImportError(f"repo-fit-check not found at {SKILL}; set REPO_FIT_CHECK_DIR")
sys.path.insert(0, str(SKILL / "scripts"))
import discover as D  # noqa: E402

NOW = datetime(2026, 10, 12, tzinfo=timezone.utc)
GLOSSARY = json.loads((ROOT / "site" / "glossary.json").read_text(encoding="utf-8"))

CASES = [
    {"purpose": "한국 노동 법령 준수 점검"},
    {"purpose": "한국 노동법 준수를 점검하는 도구 찾고 있어"},
    {"purpose": "labor law compliance"},
    {"purpose": "PDF 번역 translation tool"},
    {"purpose": "회계 ERP invoice"},
    {"purpose": "scraper crawler platform"},
    {"purpose": "가나다라마바사"},
    {"purpose": "문서 작성 방법 pdf"},
    {"purpose": "법인 회계 invoice"},
    {"purpose": "불법 스크래핑 scraper"},
    {"purpose": "방법"},
    {"purpose": "근로기준법 준수 점검"},
    {"terms": "korea|korean, law|statute"},
    {"terms": "labor|employment, compliance", "allowed": ["MIT", "Apache-2.0"], "avoid": ["AGPL", "GPL"]},
    {"terms": "pdf, translate|translation|translator"},
    {"terms": "labor, law", "allowed": ["MIT"]},  # unknown and unlisted licenses are both penalised
    {"terms": "labor, law", "allowed": D.PERMISSIVE, "avoid": ["GPL"]},
    {"terms": "mcp-server, search"},
    {"terms": "노동, law"},
    # what the audit found: English sentences, filler, odd characters, absent words, short words
    {"purpose": "I am looking for a tool that can help me translate PDF documents into Korean"},
    {"purpose": "Can you find me a good MCP server for searching the web?"},
    {"purpose": "3D printing"},
    {"purpose": "C# parser"},
    {"purpose": "R language"},
    {"purpose": "law. labor."},
    {"purpose": "pdf please xyzzy"},
    {"purpose": "as is its news ios js"},
    {"purpose": "alpha beta gamma delta epsilon zeta eta theta"},
    {"purpose": "PDF 번역 도구"},
    {"purpose": "인사이트 분석 도구"},
    {"purpose": "pdf 렌더링"},
    {"purpose": "노무현 연설문"},
    {"purpose": "labor" + chr(0x1c) + "law"},
    {"purpose": chr(0xfeff) + "labor law" + chr(0x85)},
    # position based glossary matching, fallback and omitted words, characters outside the BMP
    {"purpose": "노동법 준수 방법"},
    {"purpose": "법인 노동법"},
    {"purpose": "데이터베이스 데이터"},
    {"purpose": "한국어 맞춤법 검사"},
    {"purpose": "ERPNext"},
    {"purpose": "회계 ERP invoice"},
    {"purpose": "project management"},
    {"purpose": "IT service management"},
    {"purpose": "help desk software"},
    {"purpose": "who is"},
    {"purpose": "labor law " + chr(0x20000)},
    {"purpose": "labor law " + chr(0xbd) * 2},
    {"purpose": "labor law " + chr(0x20000) + chr(0x20000)},
    {"terms": "law|law, law"},
    {"terms": "pdf, translation, xyzzy"},
    {"terms": "as, is"},
    {"terms": "a,b,c,d,e,f,g,h"},
    {"terms": "law," + chr(0x1c)},
    {"terms": "law," + chr(0xfeff)},
    {"terms": "law," + chr(0x85)},
    {"terms": "  ,  "},
]

VOCAB = ["korea", "korean", "labor", "labour", "law", "laws", "statute", "compliance", "check", "checker", "audit",
         "mcp", "server", "pdf", "translate", "translation", "translator", "scraper", "crawler", "invoice", "erp",
         "accounting", "search", "platform", "tool", "agent", "skill", "docs", "parser", "mcp-server"]
LICENSES = ["MIT", "Apache-2.0", "BSD-3-Clause", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "MPL-2.0", "NOASSERTION",
            "OTHER", None, "ISC", "Unlicense", "CC0-1.0", "0BSD", "mit"]


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def make_fixture(n=320, seed=20261012):
    rng = random.Random(seed)
    repos = []
    for i in range(n):
        words = rng.sample(VOCAB, rng.randint(1, 3))
        name = rng.choice("-_.").join(words)
        if rng.random() < 0.2:
            name = name.upper()
        desc = None if rng.random() < 0.1 else " ".join(rng.sample(VOCAB, rng.randint(0, 6))).capitalize()
        pushed = None if rng.random() < 0.03 else iso(NOW - timedelta(days=rng.uniform(0, 900), seconds=rng.randint(0, 86399)))
        repos.append({
            "full_name": f"owner{rng.randint(1, 40)}/{name}", "description": desc,
            "stars": int(10 ** rng.uniform(0, 5)), "pushed_at": pushed, "license": rng.choice(LICENSES),
            "archived": rng.random() < 0.04, "fork": rng.random() < 0.04, "language": None,
            "topics": rng.sample(VOCAB, rng.randint(0, 4)),
        })
    # exact ties in score and stars: the order must follow the input order in both implementations
    for k in range(6):
        repos.append({"full_name": f"tie/labor-law-{k}", "description": "labor law compliance", "stars": 77,
                      "pushed_at": iso(NOW - timedelta(days=10)), "license": "MIT", "archived": False, "fork": False,
                      "language": None, "topics": ["labor"]})
    repos.append(dict(repos[3]))  # duplicate full_name
    return repos


def run_python(repos, cases):
    out = []
    for c in cases:
        try:
            interpretation = D.interpret(c.get("terms"), c.get("purpose"), GLOSSARY_FOR_PY)
        except ValueError as e:
            out.append({"error": "non_ascii" if str(e).startswith("non-English") else "no_terms"})
            continue
        groups = interpretation["groups"]
        scored, excluded = D.rank(repos, groups, c.get("allowed", []), c.get("avoid", []), min_rel=D.MIN_REL, now=NOW)
        main, small = D.select(scored, 10)
        pick = lambda r: {k: r[k] for k in ("full_name", "rel", "pop", "days", "lic_status", "score", "why")}
        out.append({"groups": groups, "dropped": interpretation["dropped"], "ignored": interpretation["ignored"], "omitted": interpretation["omitted"],
                    "main": [pick(r) for r in main], "small": [pick(r) for r in small],
                    "scored": len(scored), "excluded": len(excluded), "unmatched": D.unmatched_groups(repos, groups)})
    return out


GLOSSARY_FOR_PY = {k: v for k, v in GLOSSARY.items() if not k.startswith("_")}


def run_js(repos, cases):
    payload = json.dumps({"repos": repos, "cases": cases, "now": iso(NOW), "glossary": GLOSSARY}, ensure_ascii=False)
    p = subprocess.run(["node", str(ROOT / "tests" / "run_js.js")], input=payload, capture_output=True,
                       text=True, encoding="utf-8")
    if p.returncode != 0:
        raise AssertionError("node failed: " + p.stderr[:500])
    return json.loads(p.stdout)


class Parity(unittest.TestCase):
    def compare(self, repos, label):
        py, js = run_python(repos, CASES), run_js(repos, CASES)
        self.assertEqual(len(py), len(js))
        for case, a, b in zip(CASES, py, js):
            with self.subTest(label=label, case=case):
                if "error" in a or "error" in b:
                    self.assertEqual(a, b)
                    continue
                self.assertEqual(a["groups"], b["groups"])
                self.assertEqual((a["dropped"], a["ignored"], a["omitted"], a["unmatched"]),
                                 (b["dropped"], b["ignored"], b["omitted"], b["unmatched"]))
                self.assertEqual((a["scored"], a["excluded"]), (b["scored"], b["excluded"]))
                for part in ("main", "small"):
                    self.assertEqual([r["full_name"] for r in a[part]], [r["full_name"] for r in b[part]])
                    for ra, rb in zip(a[part], b[part]):
                        for key in ("rel", "pop", "score"):
                            self.assertAlmostEqual(ra[key], rb[key], places=9, msg=f"{ra['full_name']} {key}")
                        self.assertEqual((ra["days"], ra["lic_status"], ra["why"]), (rb["days"], rb["lic_status"], rb["why"]))

    def test_synthetic_repositories(self):
        repos = make_fixture()
        py = run_python(repos, CASES)
        self.assertTrue(any(c.get("main") for c in py), "fixture produced no results; the test would prove nothing")
        self.compare(repos, "synthetic")

    def test_odd_push_dates_are_handled_the_same(self):
        odd = ["2026-10-01", "2026-10-01T00:00:00", "bad", "2026-13-45T00:00:00Z", "2026-02-30T00:00:00Z",
               "2026-01-01T24:00:00Z", "2026-10-01T00:00:60Z", "0001-01-01T00:00:00Z", "2099-01-01T00:00:00Z",
               "2026-10-01T00:00:00Z\n", "2024-02-29T12:00:00Z"]
        repos = [{"full_name": f"odd/labor-law-{i}", "description": "labor law", "stars": 10 + i, "pushed_at": d,
                  "license": "MIT", "archived": False, "fork": False, "language": None, "topics": []}
                 for i, d in enumerate(odd)]
        cases = [{"terms": "labor, law"}]
        py, js = run_python(repos, cases)[0], run_js(repos, cases)[0]
        self.assertEqual([r["days"] for r in py["main"]], [r["days"] for r in js["main"]])
        self.assertEqual([r["full_name"] for r in py["main"]], [r["full_name"] for r in js["main"]])
        by_name = {r["full_name"]: r["days"] for r in py["main"] + py["small"]}
        for i in (0, 1, 2, 3, 4, 5, 6, 7, 9):
            self.assertEqual(by_name[f"odd/labor-law-{i}"], 9999, odd[i])  # not a valid GitHub timestamp: no date
        self.assertEqual(by_name["odd/labor-law-8"], 0)  # a date in the future is "today", not an error

    def test_rounding_is_the_same_even_on_exact_ties(self):
        values = [0.8125, 0.0005, 0.1235, 0.9995, 1 / 3, 0.70 * 0.875 + 0.15 + 0.05, 0.0625, 0.4375, 0.5, 1.0, 0.0]
        p = subprocess.run(["node", str(ROOT / "tests" / "run_js.js")], input=json.dumps({"round3": values}),
                           capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(json.loads(p.stdout), [D.round3(v) for v in values])
        self.assertEqual(D.round3(0.8125), 0.813)  # the tie that Python's round() and JS toFixed() disagreed on

    def test_shared_constants_are_identical(self):
        js = run_js([], [])  # warm-up: node starts and handles an empty case list
        self.assertEqual(js, [])
        payload = json.dumps({"constants": True})
        p = subprocess.run(["node", str(ROOT / "tests" / "run_js.js")], input=payload, capture_output=True,
                           text=True, encoding="utf-8")
        consts = json.loads(p.stdout)
        self.assertEqual(consts["stopwords"], sorted(D.STOPWORDS))
        self.assertEqual(consts["generic"], sorted(D.GENERIC))
        self.assertEqual(consts["singleLetterOk"], sorted(D.SINGLE_LETTER_OK))
        self.assertEqual(consts["grammar"], sorted(D.GRAMMAR))
        self.assertEqual(consts["weak"], sorted(D.WEAK))
        self.assertEqual((consts["minRel"], consts["maxGroups"]), (D.MIN_REL, D.MAX_GROUPS))
        self.assertEqual(consts["permissive"], sorted(x.upper() for x in D.PERMISSIVE))

    def test_ties_keep_input_order(self):
        repos = make_fixture()
        js = run_js(repos, [{"terms": "labor, law, compliance"}])[0]
        ties = [r["full_name"] for r in js["main"] if r["full_name"].startswith("tie/")]
        self.assertEqual(ties, sorted(ties))

    def test_real_snapshot_when_present(self):
        snap = ROOT / "site" / "stars.json"
        if not snap.is_file():
            self.skipTest("site/stars.json not built (run scripts/build_snapshot.py); the synthetic test still ran")
        repos = json.loads(snap.read_text(encoding="utf-8"))["repos"]
        self.compare(repos, "real snapshot")

    def test_glossary_is_the_skills_glossary(self):
        skill = json.loads((SKILL / "references" / "ko_glossary.json").read_text(encoding="utf-8"))
        self.assertEqual(GLOSSARY, skill, "site/glossary.json drifted from repo-fit-check's ko_glossary.json")


if __name__ == "__main__":
    unittest.main()
