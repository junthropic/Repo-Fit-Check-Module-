"""AC-4: a private repository stops the build. Also: only the fields the site needs are published."""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_snapshot as B  # noqa: E402


def raw(name="o/r", **kw):
    base = {
        "full_name": name, "private": False, "visibility": "public", "description": "desc",
        "stargazers_count": 5, "pushed_at": "2026-10-01T00:00:00Z", "license": {"spdx_id": "MIT", "key": "mit"},
        "archived": False, "fork": False, "language": "Python", "topics": ["a", "b"],
        "html_url": "https://github.com/" + name, "id": 123,
        "owner": {"login": "o", "email": "someone@example.com", "id": 9},
        "permissions": {"admin": True},
    }
    base.update(kw)
    return base


class Snapshot(unittest.TestCase):
    def test_private_repository_fails_the_build(self):
        with self.assertRaises(B.PrivateRepoError):
            B.build([raw("a/ok"), raw("a/secret", private=True)], "u")
        with self.assertRaises(B.PrivateRepoError):
            B.build([raw("a/secret", private=False, visibility="private")], "u")

    def test_main_exits_3_and_writes_nothing_on_private(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "raw.json", Path(d) / "stars.json"
            src.write_text(json.dumps([raw("a/ok"), raw("a/secret", private=True)]), encoding="utf-8")
            code = B.main(["--user", "u", "--from-file", str(src), "--out", str(out)])
            self.assertEqual(code, 3)
            self.assertFalse(out.exists())

    def test_only_whitelisted_fields_are_published(self):
        snap = B.build([raw()], "u", now=datetime(2026, 10, 12, 9, 0, 0, tzinfo=timezone.utc))
        self.assertEqual(set(snap["repos"][0]), {"full_name", "description", "stars", "pushed_at", "license",
                                                  "archived", "fork", "language", "topics"})
        text = json.dumps(snap)
        for leaked in ("someone@example.com", "html_url", "permissions", '"id"'):
            self.assertNotIn(leaked, text)
        self.assertEqual(snap["generated_at"], "2026-10-12T09:00:00Z")
        self.assertEqual(snap["count"], 1)

    def test_text_is_cleaned_and_limited(self):
        r = B.normalize(raw(description="a\x00b\x1fc" + "x" * 500, topics=["ok", "t\x07x"]))
        self.assertNotRegex(r["description"], r"[\x00-\x1f]")
        self.assertEqual(len(r["description"]), B.MAX_DESCRIPTION)
        self.assertEqual(r["topics"], ["ok", "t x"])

    def test_missing_license_stays_empty(self):
        self.assertIsNone(B.normalize(raw(license=None))["license"])

    def test_odd_repository_names_are_rejected(self):
        with self.assertRaises(ValueError):
            B.normalize(raw("not a/name"))
        with self.assertRaises(ValueError):
            B.normalize(raw('a/"><script>'))

    def test_main_writes_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "raw.json", Path(d) / "sub" / "stars.json"
            src.write_text(json.dumps([raw("a/one"), raw("a/two")]), encoding="utf-8")
            self.assertEqual(B.main(["--user", "u", "--from-file", str(src), "--out", str(out)]), 0)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual((data["user"], data["count"]), ("u", 2))


if __name__ == "__main__":
    unittest.main()
