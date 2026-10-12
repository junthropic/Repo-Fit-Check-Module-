"""Static checks on the page: AC-10 notice, no HTML injection paths, no third-party requests."""
import re
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

    def test_snapshot_is_ignored_by_git(self):
        lines = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("site/stars.json", [l.strip() for l in lines], "the workflow builds stars.json; it is not committed")


class WorkflowSafety(unittest.TestCase):
    """The workflow has never run, so its structure is checked here."""

    text = (ROOT / ".github" / "workflows" / "daily.yml").read_text(encoding="utf-8")

    def test_default_permissions_are_read_only_and_only_deploy_can_publish(self):
        top = self.text.split("jobs:")[0]
        self.assertRegex(top, r"(?m)^permissions:\s+contents: read\s*$")
        self.assertNotIn("pages: write", top)
        test_job, deploy_job = self.text.split("  deploy:")
        self.assertNotIn("pages: write", test_job)
        self.assertNotIn("id-token", test_job)
        self.assertIn("pages: write", deploy_job)
        self.assertIn("id-token: write", deploy_job)

    def test_the_skill_is_pinned_to_a_commit(self):
        self.assertRegex(self.text, r"(?m)^  SKILL_REF: [0-9a-f]{40}$")
        self.assertIn("ref: ${{ env.SKILL_REF }}", self.text)

    def test_checkouts_do_not_keep_the_token(self):
        self.assertEqual(self.text.count("actions/checkout@"), self.text.count("persist-credentials: false"))

    def test_a_running_deployment_is_never_cancelled(self):
        self.assertIn("cancel-in-progress: false", self.text)
        self.assertNotIn("cancel-in-progress: true", self.text)

    def test_jobs_have_time_limits_and_no_untrusted_trigger(self):
        self.assertEqual(self.text.count("timeout-minutes:"), 2)
        self.assertNotIn("pull_request_target", self.text)
        self.assertNotIn("workflow_run", self.text)

    def test_an_empty_list_cannot_be_deployed(self):
        self.assertIn('--min-count "$MIN_COUNT"', self.text)
        self.assertIn("needs: test", self.text)


if __name__ == "__main__":
    unittest.main()
