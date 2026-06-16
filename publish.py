"""Publish a static dashboard snapshot for GitHub Pages.

Run this ON THE CENTRAL SERVER (where the monitoring DB lives). It reuses the
central backend to build the exact same payloads the live API serves, bundles
them into one JSON, and writes ./data/dashboard.json — which the static frontend
(index.html/app.js) fetches. Optionally commits & pushes so GitHub Pages serves
the fresh snapshot.

    python3 publish.py                       # write ./data/dashboard.json
    python3 publish.py --central /path/to/aidas-ai-monitoring
    python3 publish.py --push                # also git add/commit/push
    python3 publish.py --redact              # mask account emails (for PUBLIC repos)

Secrets (ingest api_key, email password) are NEVER written to the snapshot.

Auto-publish every 5 min on the central server (cron):
    */5 * * * * cd /home/yunseok/Workspace/aidas-ai-monitoring-dashboard && \
        /mnt/data/miniconda3/bin/python3 publish.py --push >> data/publish.log 2>&1
"""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
import re
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOWS = ["1h", "5h", "1d", "7d"]


def _mask_email(e):
    if not isinstance(e, str) or "@" not in e:
        return e
    user, dom = e.split("@", 1)
    return (user[:1] + "***") + "@" + dom


def _redact(bundle):
    """Mask account emails everywhere (for publishing to a PUBLIC repo)."""
    for a in bundle["summary"].get("accounts", []):
        a["email"] = _mask_email(a.get("email"))
        for k in ("org_name", "display_name"):
            if isinstance(a.get(k), str) and "@" in a[k]:
                a[k] = _mask_email(a[k].split("'")[0]) + (" …" if "'" in a[k] else "")
    for s in bundle.get("sessions", []):
        s["account_email"] = _mask_email(s.get("account_email"))
    for al in bundle.get("alerts", []):
        al["account"] = _mask_email(al.get("account"))
    cfg = bundle.get("config", {})
    tr = cfg.get("tracking", {})
    if isinstance(tr.get("allowed_accounts"), list):
        tr["allowed_accounts"] = [_mask_email(x) for x in tr["allowed_accounts"]]
    if isinstance(tr.get("account_status"), dict):
        masked = {}
        for k, v in tr["account_status"].items():
            if ":" in k:
                prov, em = k.split(":", 1)
                masked[prov + ":" + _mask_email(em)] = v
            else:
                masked[_mask_email(k)] = v
        tr["account_status"] = masked
    em = cfg.get("email", {})
    for k in ("username", "from"):
        if k in em:
            em[k] = _mask_email(em[k])
    if isinstance(em.get("to"), list):
        em["to"] = [_mask_email(x) for x in em["to"]]
    return bundle


def _mask_owner(name):
    if not isinstance(name, str) or not name:
        return name
    if not name.isascii():          # "미분류" and other labels stay readable
        return name
    return name[:1] + "***"


def apply_people_policy(bundle, mode):
    """Gate per-person attribution out of the PUBLIC snapshot.

    This repo is served publicly, and named per-person cost attribution is a
    different kind of disclosure than the aggregate account cards. Default is
    therefore to withhold it; set PUBLISH_PEOPLE in .env to opt in.

      exclude  (default) - drop the people array and the attribution rules
      initials           - keep the numbers, mask the names ("y***")
      full               - publish as-is
    """
    summary = bundle.get("summary") or {}
    people = summary.get("people") or []
    cfg_people = (bundle.get("config") or {}).get("people") or {}
    if mode == "full":
        summary["people_policy"] = "full"
        return bundle
    if mode == "initials":
        for p in people:
            p["owner"] = _mask_owner(p.get("owner"))
        summary["people_policy"] = "initials"
    else:
        summary["people"] = []
        summary["people_policy"] = "excluded"
    # nodes[].os_user / sender_root identify a person and their filesystem, so
    # they follow the same policy as the per-person data.
    for n in summary.get("nodes") or []:
        n["os_user"] = _mask_owner(n.get("os_user")) if mode == "initials" else None
        for field in ("sender_root", "fqdn", "ip"):
            n.pop(field, None)
    # The session table's 담당자 column is per-person attribution too; without
    # this the names would reappear there after being withheld everywhere else.
    for s in bundle.get("sessions") or []:
        s["owner"] = _mask_owner(s.get("owner")) if mode == "initials" else None
    # The rules/overrides carry the same names — scrub them either way.
    cfg_people["rules"] = []
    cfg_people["sessions"] = {}
    return bundle


def load_dotenv(path):
    """Tiny .env parser (no dependency). KEY=VALUE per line, # comments."""
    env = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def _resolve(path):
    """Make a path absolute relative to this repo if it isn't already."""
    path = os.path.expanduser(path)
    return path if os.path.isabs(path) else os.path.join(HERE, path)


def build_bundle(central):
    sys.path.insert(0, central)
    from backend import config as C          # noqa: E402
    from backend.server import App           # noqa: E402

    cfg = C.load_config()
    app = App(cfg)                            # opens DB read-only; starts no threads
    now = int(time.time() * 1000)

    timeseries = {}
    for w in WINDOWS:
        try:
            span = C.window_seconds(w)
        except ValueError:
            continue
        bucket = max(60, span // 120)
        timeseries[w] = {
            "window": w, "bucket": bucket,
            "series": app.store.timeseries(now - span * 1000, bucket, group_by="host"),
        }

    # public config: drop secrets entirely
    pub_cfg = json.loads(json.dumps(cfg))
    pub_cfg.pop("server", None)               # contains ingest api_key
    em = pub_cfg.get("email") or {}
    if em.get("password"):
        em["password"] = "***set***"

    return {
        "schema": 1,
        "generated_at": now,
        "summary": app.summary(),
        # App.sessions() (not store.sessions) so the snapshot carries the
        # per-session owner the dashboard's 담당자 column needs.
        "sessions": app.sessions(),
        "alerts": app.store.recent_alerts(50),
        "timeseries": timeseries,
        "config": pub_cfg,
    }


def main(argv=None):
    # settings & secrets come from .env (gitignored); CLI flags override
    env = load_dotenv(os.path.join(HERE, ".env"))

    p = argparse.ArgumentParser(description="Publish static dashboard snapshot")
    p.add_argument("--central",
                   default=env.get("CENTRAL_DIR") or os.path.join(os.path.dirname(HERE), "aidas-ai-monitoring"),
                   help="path to the central aidas-ai-monitoring repo")
    p.add_argument("--out", default=env.get("OUT") or os.path.join(HERE, "data", "dashboard.json"))
    p.add_argument("--redact", action="store_true", help="mask account emails (public repo)")
    p.add_argument("--push", action="store_true", help="git add/commit/push the snapshot")
    args = p.parse_args(argv)

    redact = args.redact or str(env.get("REDACT", "")).lower() in ("1", "true", "yes")
    out = _resolve(args.out)
    central = os.path.abspath(_resolve(args.central))
    if not os.path.isdir(os.path.join(central, "backend")):
        print(f"[publish] central backend not found at {central} — set CENTRAL_DIR in .env "
              f"or pass --central <path>", file=sys.stderr)
        return 1

    bundle = build_bundle(central)
    if redact:
        bundle = _redact(bundle)
    people_mode = (env.get("PUBLISH_PEOPLE") or "exclude").strip().lower()
    if people_mode not in ("full", "initials", "exclude"):
        people_mode = "exclude"
    bundle = apply_people_policy(bundle, people_mode)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, out)
    n_acc = len(bundle["summary"].get("accounts", []))
    print(f"[publish] wrote {out} ({os.path.getsize(out):,} bytes) accounts={n_acc} "
          f"sessions={len(bundle['sessions'])} people={people_mode}"
          f"{' [REDACTED]' if redact else ''}")

    if args.push:
        def git(*a):
            return subprocess.run(["git", "-C", HERE, *a], capture_output=True, text=True)
        git("add", "-A")
        # Which paths changed since the previous snapshot commit? The Pages
        # workflow ignores data/** on push, so a data-only publish must not
        # deploy — but a source change has to go live now, not whenever the
        # hourly schedule happens to fire (GitHub delays those, and we saw a
        # two-hour gap). Compute this BEFORE amending, while HEAD is still the
        # previous snapshot.
        changed = [l for l in git("diff", "--cached", "--name-only",
                                  "HEAD").stdout.split("\n") if l.strip()]
        source_changed = any(not c.startswith("data/") for c in changed)
        # Roll the snapshot into ONE tip commit (amend) + force-push, so the
        # 5-min publishes do NOT pile up hundreds of commits a day. History
        # stays a single rolling snapshot commit.
        git("commit", "--amend", "-m",
            f"AIDAS dashboard · snapshot {time.strftime('%Y-%m-%d %H:%M:%S')}")
        # token (from .env) if provided, else the repo's stored credential.
        token, remote = env.get("GITHUB_TOKEN"), env.get("GIT_REMOTE")
        push = None
        if token and remote and remote.startswith("https://"):
            url = "https://x-access-token:" + token + "@" + remote[len("https://"):]
            push = git("push", "--force", url, "HEAD:main")
            # A revoked or expired token must not take the site down: the machine
            # usually also has a working credential in the git helper. Retry with
            # it rather than failing every five minutes until someone notices —
            # one dead token once stalled the published snapshot for 21 hours.
            if push.returncode != 0 and _is_auth_failure(push):
                print("[publish] GITHUB_TOKEN rejected — "
                      "falling back to the stored git credential. "
                      "Replace the token in .env.")
                push = git("push", "--force-with-lease")
                token = _git_credential_token()   # keep the dispatch working
        else:
            push = git("push", "--force-with-lease")
        ok = push.returncode == 0
        print("[publish] git push (amend):",
              "ok" if ok else (push.stderr or push.stdout).strip()[:200])
        if ok and source_changed:
            print("[publish] source changed:",
                  ", ".join(c for c in changed if not c.startswith("data/"))[:120])
            print("[publish] pages deploy:", _dispatch_pages(token, remote))
    return 0


def _git_credential_token():
    """Token from the git credential store, used when .env's has gone bad.

    The machine that pushes already holds a working credential there; reusing it
    keeps the Pages dispatch alive instead of silently degrading to the hourly
    schedule whenever GITHUB_TOKEN expires.
    """
    try:
        with open(os.path.expanduser("~/.git-credentials"), encoding="utf-8") as f:
            for line in f:
                m = re.match(r"https://([^:]*):([^@]+)@(.+)", line.strip())
                if m and "github.com" in m.group(3):
                    return m.group(2)
    except OSError:
        pass
    return None


def _is_auth_failure(proc):
    """True when git refused on credentials rather than on refs or network."""
    out = ((proc.stderr or "") + (proc.stdout or "")).lower()
    return any(t in out for t in (
        "invalid username or token", "authentication failed", "bad credentials",
        "could not read username", "permission denied", "403 forbidden"))


def _dispatch_pages(token, remote):
    """Ask the Pages workflow to run now (source changed).

    The workflow's push trigger ignores data/**, and a force-pushed amend does
    not reliably surface changed paths to that filter — historically every run
    came from the hourly schedule. Dispatching explicitly is what makes a source
    change appear on the site immediately.
    """
    token = token or _git_credential_token()
    if not (token and remote):
        return "skipped (no usable token — wait for the hourly schedule)"
    m = re.search(r"github\.com[:/]+([^/]+/[^/.]+)", remote)
    if not m:
        return f"skipped (cannot parse repo from {remote!r})"
    req = urllib.request.Request(
        f"https://api.github.com/repos/{m.group(1)}/actions/workflows/"
        "pages.yml/dispatches",
        data=json.dumps({"ref": "main"}).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return "requested" if r.status == 204 else f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read().decode()[:120]}"
    except OSError as e:
        return f"failed: {e}"


if __name__ == "__main__":
    sys.exit(main())
