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
    em = cfg.get("email", {})
    for k in ("username", "from"):
        if k in em:
            em[k] = _mask_email(em[k])
    if isinstance(em.get("to"), list):
        em["to"] = [_mask_email(x) for x in em["to"]]
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
        "sessions": app.store.sessions(cfg["collect"]["session_live_seconds"]),
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

    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, out)
    n_acc = len(bundle["summary"].get("accounts", []))
    print(f"[publish] wrote {out} ({os.path.getsize(out):,} bytes) accounts={n_acc} "
          f"sessions={len(bundle['sessions'])}{' [REDACTED]' if redact else ''}")

    if args.push:
        def git(*a):
            return subprocess.run(["git", "-C", HERE, *a], capture_output=True, text=True)
        git("add", "-A")
        # Roll the snapshot into ONE tip commit (amend) + force-push, so the
        # 5-min publishes do NOT pile up hundreds of commits a day. History
        # stays a single rolling snapshot commit; GitHub Pages rebuilds on each
        # force-push just the same.
        git("commit", "--amend", "-m",
            f"AIDAS dashboard · snapshot {time.strftime('%Y-%m-%d %H:%M:%S')}")
        # token (from .env) if provided, else the repo's stored credential.
        token, remote = env.get("GITHUB_TOKEN"), env.get("GIT_REMOTE")
        if token and remote and remote.startswith("https://"):
            url = "https://x-access-token:" + token + "@" + remote[len("https://"):]
            push = git("push", "--force", url, "HEAD:main")
        else:
            push = git("push", "--force-with-lease")
        ok = push.returncode == 0
        print("[publish] git push (amend):",
              "ok" if ok else (push.stderr or push.stdout).strip()[:200])
    return 0


if __name__ == "__main__":
    sys.exit(main())
