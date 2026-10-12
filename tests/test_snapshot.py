"""AC-4: private repositories are left out of the snapshot silently. Also: only the fields the site needs are published."""
import contextlib
import io
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


def run_main(args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = B.main(args)
    return code, out.getvalue(), err.getvalue()


class Snapshot(unittest.TestCase):
    def test_private_and_internal_repositories_are_left_out(self):
        snap, left_out = B.build([raw("a/ok"), raw("a/secret", private=True),
                                  raw("a/hidden", visibility="private"), raw("a/corp", visibility="internal")], "u")
        self.assertEqual([r["full_name"] for r in snap["repos"]], ["a/ok"])
        self.assertEqual((snap["count"], left_out), (1, 3))

    def test_build_goes_on_and_never_prints_the_names_of_left_out_repositories(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "raw.json", Path(d) / "stars.json"
            src.write_text(json.dumps([raw("a/ok"), raw("owner/turned-private", private=True)]), encoding="utf-8")
            code, stdout, stderr = run_main(["--user", "u", "--from-file", str(src), "--out", str(out)])
            self.assertEqual(code, 0)
            self.assertIn("1 private or internal left out", stdout)
            self.assertNotIn("turned-private", stdout + stderr)  # CI logs of a public repo are public
            published = out.read_text(encoding="utf-8")
            self.assertNotIn("turned-private", published)
            self.assertEqual(json.loads(published)["count"], 1)

    def test_only_public_repositories_means_no_note(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "raw.json", Path(d) / "stars.json"
            src.write_text(json.dumps([raw("a/ok")]), encoding="utf-8")
            code, stdout, _ = run_main(["--user", "u", "--from-file", str(src), "--out", str(out)])
            self.assertEqual(code, 0)
            self.assertNotIn("left out", stdout)

    def test_only_whitelisted_fields_are_published(self):
        snap, _ = B.build([raw()], "u", now=datetime(2026, 10, 12, 9, 0, 0, tzinfo=timezone.utc))
        self.assertEqual(set(snap["repos"][0]), {"full_name", "description", "stars", "pushed_at", "license",
                                                  "archived", "fork", "language", "topics"})
        text = json.dumps(snap)
        for leaked in ("someone@example.com", "html_url", "permissions", '"id"'):
            self.assertNotIn(leaked, text)
        self.assertEqual(snap["generated_at"], "2026-10-12T09:00:00Z")
        self.assertEqual(snap["count"], 1)
        self.assertNotIn("left_out", text)  # the number of hidden repositories is not published either

    def test_text_is_cleaned_and_limited(self):
        r = B.normalize(raw(description="a\x00b\x1fc" + "x" * 1500, topics=["ok", "t\x07x"]))
        self.assertNotRegex(r["description"], r"[\x00-\x1f]")
        self.assertEqual(len(r["description"]), B.MAX_DESCRIPTION)
        self.assertEqual(r["topics"], ["ok", "t x"])

    def test_the_whole_github_description_is_kept(self):
        text = "word " * 70  # 350 characters is GitHub's own limit
        self.assertEqual(B.normalize(raw(description=text))["description"], text.strip())
        # so the site searches exactly what the skill searches (a term at the end of a long description is found)
        tail = "x" * 340 + " rotation"
        self.assertTrue(B.normalize(raw(description=tail))["description"].endswith("rotation"))

    def test_invisible_and_direction_control_characters_are_removed(self):
        for code in (0x85, 0x200b, 0x200e, 0x2028, 0x202e, 0x2066, 0xfeff):
            r = B.normalize(raw(description="x" + chr(code) + "evil", topics=["t" + chr(code)]))
            self.assertNotIn(chr(code), r["description"], hex(code))
            self.assertNotIn(chr(code), r["topics"][0], hex(code))

    def test_only_github_timestamps_are_stored(self):
        self.assertEqual(B.normalize(raw(pushed_at="2026-10-01T00:00:00Z"))["pushed_at"], "2026-10-01T00:00:00Z")
        for bad in ("garbage", "2026-10-01", "2026-10-01T00:00:00", "2026-10-01T00:00:00Z\n", None, ""):
            self.assertIsNone(B.normalize(raw(pushed_at=bad))["pushed_at"], repr(bad))

    def test_an_empty_or_all_private_list_is_not_published(self):
        with self.assertRaises(B.EmptyListError):
            B.build([], "u")
        with self.assertRaises(B.EmptyListError):
            B.build([raw("a/x", private=True)], "u")
        snap, _ = B.build([], "u", min_count=0)  # an explicit choice for a brand new account
        self.assertEqual(snap["count"], 0)

    def test_main_exits_1_and_writes_nothing_for_an_empty_reply(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "raw.json", Path(d) / "stars.json"
            src.write_text("[]", encoding="utf-8")
            code, _, stderr = run_main(["--user", "u", "--from-file", str(src), "--out", str(out)])
            self.assertEqual(code, 1)
            self.assertIn("refusing to publish", stderr)
            self.assertFalse(out.exists())

    def test_a_name_with_a_trailing_newline_is_rejected(self):
        with self.assertRaises(ValueError):
            B.normalize(raw("a/b\n"))

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
            code, _, _ = run_main(["--user", "u", "--from-file", str(src), "--out", str(out)])
            self.assertEqual(code, 0)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual((data["user"], data["count"]), ("u", 2))


if __name__ == "__main__":
    unittest.main()
