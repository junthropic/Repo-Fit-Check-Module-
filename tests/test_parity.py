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
    {"terms": "korea|korean, law|statute"},
    {"terms": "labor|employment, compliance", "allowed": ["MIT", "Apache-2.0"], "avoid": ["AGPL", "GPL"]},
    {"terms": "pdf, translate|translation|translator"},
    {"terms": "mcp-server, search"},
    {"terms": "노동, law"},
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
            groups = D.parse_terms(c.get("terms"), c.get("purpose"), GLOSSARY_FOR_PY)
        except ValueError as e:
            out.append({"error": "non_ascii" if str(e).startswith("non-English") else "no_terms"})
            continue
        scored, excluded = D.rank(repos, groups, c.get("allowed", []), c.get("avoid", []), min_rel=0.34, now=NOW)
        main, small = D.select(scored, 10)
        pick = lambda r: {k: r[k] for k in ("full_name", "rel", "pop", "days", "lic_status", "score", "why")}
        out.append({"groups": groups, "main": [pick(r) for r in main], "small": [pick(r) for r in small],
                    "scored": len(scored), "excluded": len(excluded)})
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
