#!/usr/bin/env python3
"""Write site/stars.json from a GitHub user's *public* starred list.

Uses the public endpoint (users/<user>/starred), never the logged-in `user/starred`, because
that one can include private repositories. A starred repository can also be turned private (or
internal) by its owner later. Those are left out silently: the build goes on, they never reach
stars.json, and only their number (never their names) is printed.

  python scripts/build_snapshot.py --user junthropic
  python scripts/build_snapshot.py --from-file raw.json --user junthropic   # offline / tests

Needs the `gh` CLI (logged in, or GH_TOKEN set) unless --from-file is given.
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FULL_NAME = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
# Control characters, zero-width space and bidirectional marks (a U+202E can reverse how a description reads).
# The zero-width joiner and non-joiner stay: they hold emoji sequences and some scripts together.
CONTROL = re.compile(r"[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e-\u200f\u2028-\u202e\u2060-\u2069\ufeff]")
# GitHub timestamps only; anything else is stored as "no date" so the site never has to guess.
ISO_Z = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
# GitHub allows 350 characters. The whole text is kept so the site searches exactly what the skill searches.
MAX_DESCRIPTION = 1000
MAX_TOPICS = 30


def is_private(raw):
    return bool(raw.get("private")) or raw.get("visibility") in ("private", "internal")


def clean_text(text, limit):
    return CONTROL.sub(" ", text or "").strip()[:limit]


def normalize(raw):
    """Keep only the fields the site uses. Everything else (owner details, urls, ids) is dropped."""
    full_name = raw.get("full_name") or ""
    if not FULL_NAME.fullmatch(full_name):
        raise ValueError(f"unexpected repository name: {full_name!r}")
    lic = (raw.get("license") or {}).get("spdx_id")
    return {
        "full_name": full_name,
        "description": clean_text(raw.get("description"), MAX_DESCRIPTION),
        "stars": int(raw.get("stargazers_count") or 0),
        "pushed_at": raw.get("pushed_at") if ISO_Z.fullmatch(raw.get("pushed_at") or "") else None,
        "license": lic,
        "archived": bool(raw.get("archived")),
        "fork": bool(raw.get("fork")),
        "language": raw.get("language"),
        "topics": [clean_text(t, 50) for t in (raw.get("topics") or [])][:MAX_TOPICS],
    }


class EmptyListError(RuntimeError):
    pass


def build(raw_repos, user, now=None, min_count=1):
    """Return (snapshot, number_of_private_repositories_left_out)."""
    visible = [r for r in raw_repos if not is_private(r)]
    repos = [normalize(r) for r in visible]
    if len(repos) < min_count:
        raise EmptyListError(f"only {len(repos)} public repositories for {user} (minimum {min_count}); "
                             "refusing to publish an empty or truncated list")
    now = now or datetime.now(timezone.utc)
    snapshot = {
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "user": user,
        "count": len(repos),
        "repos": repos,
    }
    return snapshot, len(raw_repos) - len(visible)


def fetch(user):
    p = subprocess.run(["gh", "api", f"users/{user}/starred?per_page=100", "--paginate", "--slurp"],
                       capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip()[:300])
    return [r for page in json.loads(p.stdout) for r in page]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--user", required=True, help="GitHub account whose public stars are published")
    ap.add_argument("--out", default=str(ROOT / "site" / "stars.json"))
    ap.add_argument("--min-count", type=int, default=1,
                    help="fail instead of publishing fewer repositories than this (guards against an empty reply)")
    ap.add_argument("--from-file", help="read the raw API response from a file instead of calling gh")
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = json.load(open(args.from_file, encoding="utf-8")) if args.from_file else fetch(args.user)
        snapshot, left_out = build(raw, args.user, min_count=args.min_count)
    except (RuntimeError, ValueError, OSError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    note = f" ({left_out} private or internal left out)" if left_out else ""
    print(f"wrote {args.out}: {snapshot['count']} repositories for {args.user}{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
