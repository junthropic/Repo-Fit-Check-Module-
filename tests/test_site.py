"""Static checks on the page: AC-10 notice, no HTML injection paths, no third-party requests."""
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"


class SiteStructure(unittest.TestCase):
    def test_ac10_notice_is_in_the_static_page(self):
        html = (SITE / "index.html").read_text(encoding="utf-8")
        self.assertIn("후보 목록이며 적합성 판정이 아닙니다", html)
        notice = re.search(r'<p id="notice"[^>]*>', html)
        self.assertIsNotNone(notice)
        self.assertNotIn("hidden", notice.group(0))

    def test_data_is_never_written_as_html(self):
        # The banned patterns below are plain strings searched for in the source; nothing is evaluated.
        for name in ("app.js", "search.js"):
            src = (SITE / name).read_text(encoding="utf-8")
            for banned in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
                self.assertNotIn(banned, src, f"{name} uses {banned}")

    def test_links_only_go_to_github_repositories(self):
        src = (SITE / "app.js").read_text(encoding="utf-8")
        hrefs = re.findall(r"\.href\s*=\s*([^;]+);", src)
        self.assertEqual(len(hrefs), 1)
        self.assertIn("'https://github.com/' + repo.full_name", hrefs[0])
        self.assertIn("noopener noreferrer", src)

    def test_page_loads_nothing_from_other_hosts(self):
        html = (SITE / "index.html").read_text(encoding="utf-8")
        for attr in re.findall(r'(?:src|href)="([^"]+)"', html):
            self.assertFalse(re.match(r"^(https?:)?//", attr), f"external resource: {attr}")
        for name in ("app.js", "style.css"):
            src = (SITE / name).read_text(encoding="utf-8")
            self.assertNotRegex(src, r"https?://(?!github\.com/)", f"{name} references another host")

    def test_snapshot_is_not_committed(self):
        ignored = subprocess.run(["git", "check-ignore", "site/stars.json"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(ignored.returncode, 0, "site/stars.json must be in .gitignore (the workflow builds it)")


if __name__ == "__main__":
    unittest.main()
