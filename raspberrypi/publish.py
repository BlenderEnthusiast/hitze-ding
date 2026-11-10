#!/usr/bin/env python3
"""Publish a complete gateway snapshot to a GitHub data branch. Python 3.9+."""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
UTC = timezone.utc
ID = re.compile(r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$")


def iso(dt):
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def instant(value):
    if not isinstance(value, str):
        raise ValueError("received_at must be an ISO timestamp with a timezone")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("received_at needs Z or a timezone offset")
    return dt.astimezone(UTC)


def number(value, lo, hi, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    if not math.isfinite(value) or not lo <= value <= hi:
        raise ValueError(f"{name} must be between {lo} and {hi}")
    return round(value, 2)


def registry(path):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    sensors = doc["sensors"]
    seen = set()
    if not sensors:
        raise ValueError("The sensor registry is empty")
    for sensor in sensors:
        sid = sensor["id"]
        if not ID.fullmatch(sid) or sid in seen:
            raise ValueError(f"Invalid or duplicate sensor ID: {sid}")
        seen.add(sid)
    return sensors


def demo_reading(sensor, now):
    """Correlated school-day heating and RH at roughly conserved water content."""
    seed = sum((i + 1) * ord(c) for i, c in enumerate(sensor["id"]))
    local = now.astimezone(ZoneInfo("Europe/Berlin"))
    hour = local.hour + local.minute / 60 + local.second / 3600
    day = now.timestamp() / 86400
    phase = seed % 19 / 19 * math.tau
    occupied = local.weekday() < 5 and 7 <= hour < 18
    temp = (21.1 + 1.2 * math.sin((hour - 10) / 24 * math.tau)
            + 0.65 * math.sin(day / 365.2425 * math.tau - 1.1)
            + (seed % 7 - 3) * 0.38 + (0.9 if occupied else -0.5)
            + 0.22 * math.sin(day * 11.3 + phase)
            + 0.1 * math.sin(day * 37 + phase))
    if sensor["id"].endswith("004"):
        temp += 4.5
    water = 8.9 + 0.55 * math.sin(day / 9 + phase) + (0.6 if occupied else 0)
    saturation = 6.112 * math.exp(17.62 * temp / (243.12 + temp))
    humidity = max(22, min(72, water * (273.15 + temp) / (216.7 * saturation) * 100))
    outage = sensor["id"].endswith("008") and int(now.timestamp() // 1800) % 7 == 0
    return {"sensor_id": sensor["id"], "online": not outage,
            "received_at": iso(now) if not outage else None,
            "temperature": round(temp, 2) if not outage else None,
            "humidity": round(humidity, 2) if not outage else None}


def normalize(doc, sensors, now, stale_seconds):
    """Treat the input as the gateway's full snapshot, not a partial patch."""
    if not isinstance(doc, dict):
        raise ValueError("Input must be a JSON object")
    rows = doc.get("sensors")
    if not isinstance(rows, list):
        raise ValueError("Input must contain a sensors array")
    known = {s["id"] for s in sensors}
    indexed = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Each sensor entry must be a JSON object")
        sid = row.get("sensor_id")
        if sid not in known or sid in indexed:
            raise ValueError(f"Unknown or duplicate sensor_id: {sid}")
        if not isinstance(row.get("online"), bool):
            raise ValueError(f"{sid}: online must be true or false")
        received = row.get("received_at")
        stamp = instant(received) if received is not None else None
        if stamp and (stamp - now).total_seconds() > 300:
            raise ValueError(f"{sid}: received_at is in the future")
        online = row["online"]
        if online:
            if stamp is None:
                raise ValueError(f"{sid}: online readings require received_at")
            temp = number(row.get("temperature"), -80, 100, "temperature")
            hum = number(row.get("humidity"), 0, 100, "humidity")
            online = (now - stamp).total_seconds() <= stale_seconds
        indexed[sid] = {"sensor_id": sid, "online": online,
                        "received_at": iso(stamp) if stamp else None,
                        "temperature": temp if online else None,
                        "humidity": hum if online else None}
    return [indexed.get(s["id"], {"sensor_id": s["id"], "online": False,
            "received_at": None, "temperature": None, "humidity": None}) for s in sensors]


def encoded(doc):
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"


def append_row(archive, sid, row, bucket=900):
    rows = archive.setdefault("sensors", {}).setdefault(sid, [])
    stamp = instant(row[0]).timestamp()
    if rows:
        last = rows[-1]
        last_stamp = instant(last[0]).timestamp()
        if stamp <= last_stamp:
            return False
        # Keep the first real observation in each 15-minute bucket. Record status
        # changes immediately, so a disconnect remains a real break in the graph.
        if int(stamp // bucket) == int(last_stamp // bucket) and ((row[1] is None) == (last[1] is None)):
            return False
    rows.append(row)
    return True


def build_files(readings, now, source, gateway, stale, load, sensors, seed_days=0):
    base = f"data/history/{source}"
    index = load(base + "/index.json") or {"months": []}
    months = set(index.get("months", []))
    archives = {}
    changed = set()

    def archive(month):
        if month not in archives:
            archives[month] = load(base + f"/{month}.json") or {
                "schema_version": 1, "source": source, "month": month, "sensors": {}}
        return archives[month]

    # Optional one-off simulated backfill. Existing archive observations win.
    if seed_days:
        start = (now - timedelta(days=seed_days)).replace(minute=0, second=0, microsecond=0)
        t = start
        buckets = {}
        while t < now:
            month = t.strftime("%Y-%m")
            group = buckets.setdefault(month, {})
            for sensor in sensors:
                v = demo_reading(sensor, t)
                group.setdefault(v["sensor_id"], []).append([iso(t), v["temperature"], v["humidity"]])
            t += timedelta(hours=1)
        for month, groups in buckets.items():
            a = archive(month)
            for sid, rows in groups.items():
                combined = {r[0]: r for r in rows}
                combined.update({r[0]: r for r in a["sensors"].get(sid, [])})
                a["sensors"][sid] = sorted(combined.values(), key=lambda r: instant(r[0]))
            changed.add(month)

    previous = load("data/live.json") or {}
    old = {v["sensor_id"]: v for v in previous.get("sensors", [])} if previous.get("source") == source else {}
    for value in readings:
        if value["online"]:
            stamp = value["received_at"]
            row = [stamp, value["temperature"], value["humidity"]]
        else:
            # A repeated offline state adds no redundant observations.
            if not old.get(value["sensor_id"], {}).get("online", False):
                continue
            stamp = iso(now)
            row = [stamp, None, None]
        month = stamp[:7]
        if append_row(archive(month), value["sensor_id"], row):
            changed.add(month)
    months.update(changed)
    snapshot = {"schema_version": 1, "updated_at": iso(now), "source": source,
                "gateway_id": gateway, "stale_after_seconds": stale,
                "history": {"base": base, "months": sorted(months), "revision": iso(now)},
                "sensors": readings}
    files = {"data/live.json": encoded(snapshot)}
    for month in sorted(changed):
        files[base + f"/{month}.json"] = encoded(archives[month])
    if months != set(index.get("months", [])):
        files[base + "/index.json"] = encoded({"schema_version": 1, "months": sorted(months)})
    return files


class GitHubError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(f"GitHub HTTP {status}: {message}")
        self.status = status


class GitHub:
    def __init__(self, repo, token, branch="sensor-data", site_branch="main"):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
            raise ValueError("--repo must be OWNER/REPO")
        for b in (branch, site_branch):
            if not re.fullmatch(r"[A-Za-z0-9_./-]+", b) or ".." in b or b.endswith(("/", ".", ".lock")):
                raise ValueError("Invalid branch name")
        if branch == site_branch:
            raise ValueError("Use a separate sensor-data branch; the website stays on main")
        self.base = "https://api.github.com/repos/" + repo
        self.token, self.branch, self.site_branch = token, branch, site_branch

    def request(self, method, path, data=None, raw=False):
        headers = {"Authorization": "Bearer " + self.token,
                   "Accept": "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "Stratum-Sensor-Gateway/1.0"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = Request(self.base + path, data=encoded(data).encode() if data is not None else None,
                      method=method, headers=headers)
        try:
            with urlopen(req, timeout=45) as response:
                return json.loads(response.read())
        except HTTPError as exc:
            try:
                detail = json.loads(exc.read()).get("message", "Request failed")
            except (ValueError, AttributeError):
                detail = "Request failed"
            # Never log request headers, tokens, or complete request objects.
            raise GitHubError(exc.code, str(detail)[:220]) from None

    def head(self):
        try:
            return self.request("GET", "/git/ref/heads/" + quote(self.branch, safe=""))["object"]["sha"]
        except GitHubError as exc:
            if exc.status != 404:
                raise
        base = self.request("GET", "/git/ref/heads/" + quote(self.site_branch, safe=""))["object"]["sha"]
        try:
            self.request("POST", "/git/refs", {"ref": "refs/heads/" + self.branch, "sha": base})
            return base
        except GitHubError as exc:
            if exc.status != 422:
                raise
            return self.request("GET", "/git/ref/heads/" + quote(self.branch, safe=""))["object"]["sha"]

    def load(self, path, ref):
        try:
            return self.request("GET", "/contents/" + quote(path, safe="/") + "?" + urlencode({"ref": ref}), raw=True)
        except GitHubError as exc:
            if exc.status == 404:
                return None
            raise

    def publish(self, readings, now, source, gateway, stale, sensors, seed_days=0):
        # Pin reads to a commit; retry the entire merge after a branch-head race.
        for attempt in range(3):
            parent = self.head()
            commit = self.request("GET", "/git/commits/" + parent)
            files = build_files(readings, now, source, gateway, stale,
                                lambda p: self.load(p, parent), sensors, seed_days)
            tree = self.request("POST", "/git/trees", {"base_tree": commit["tree"]["sha"], "tree": [
                {"path": path, "mode": "100644", "type": "blob", "content": content}
                for path, content in files.items()]})
            new = self.request("POST", "/git/commits", {"message": f"Sensors: {source} {iso(now)}",
                    "tree": tree["sha"], "parents": [parent]})
            try:
                self.request("PATCH", "/git/refs/heads/" + quote(self.branch, safe=""),
                             {"sha": new["sha"], "force": False})
                return new["sha"]
            except GitHubError as exc:
                if exc.status not in (409, 422) or attempt == 2:
                    raise
        raise RuntimeError("Unable to advance data branch")


def local_publish(root, readings, now, source, gateway, stale, sensors, seed_days):
    root = Path(root).resolve()

    def load(path):
        file = root / path
        return json.loads(file.read_text(encoding="utf-8")) if file.exists() else None

    files = build_files(readings, now, source, gateway, stale, load, sensors, seed_days)
    # Make archives visible before the manifest that references them.
    for path in sorted(files, key=lambda p: p == "data/live.json"):
        file = root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        temp = file.with_suffix(file.suffix + ".tmp")
        temp.write_text(files[path], encoding="utf-8")
        os.replace(temp, file)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--demo", action="store_true", help="Publish clearly labelled simulated readings")
    mode.add_argument("--input", type=Path, help="Your receiver's complete JSON snapshot")
    mode.add_argument("--offline", action="store_true", help="Publish every registered sensor as offline")
    p.add_argument("--repo", default=os.getenv("STRATUM_REPO"), help="GitHub OWNER/REPO")
    p.add_argument("--branch", default=os.getenv("STRATUM_BRANCH", "sensor-data"))
    p.add_argument("--site-branch", default="main")
    p.add_argument("--registry", type=Path, default=ROOT / "data/sensors.json")
    p.add_argument("--interval", type=int, default=300, help="Seconds between snapshots (default: 300)")
    p.add_argument("--stale-seconds", type=int, default=900)
    p.add_argument("--gateway", default="pi-01")
    p.add_argument("--seed-days", type=int, default=0, help="One-off demo history, 0..366 days, hourly")
    p.add_argument("--once", action="store_true")
    p.add_argument("--local", type=Path, help="Write to a local repo folder instead of GitHub")
    args = p.parse_args(argv)
    if args.interval < (1 if args.local else 60):
        p.error("Use at least 60 seconds for GitHub (300 seconds recommended)")
    if args.stale_seconds < args.interval * 2:
        p.error("--stale-seconds must be at least twice --interval")
    if not 0 <= args.seed_days <= 366 or (args.seed_days and not args.demo):
        p.error("--seed-days is for --demo only, between 0 and 366")
    sensors = registry(args.registry)
    github = None
    if not args.local:
        token = os.getenv("GITHUB_TOKEN", "").strip()
        if not args.repo or not token:
            p.error("Set GITHUB_TOKEN locally and provide --repo OWNER/REPO, or use --local PATH")
        github = GitHub(args.repo, token, args.branch, args.site_branch)
    source = "simulated" if args.demo else "real"
    seed_days = args.seed_days
    try:
        while True:
            try:
                now = datetime.now(UTC)
                if args.demo:
                    doc = {"sensors": [demo_reading(s, now) for s in sensors]}
                elif args.offline:
                    doc = {"sensors": []}
                else:
                    doc = json.loads(args.input.read_text(encoding="utf-8"))
                values = normalize(doc, sensors, now, args.stale_seconds)
                if github:
                    github.publish(values, now, source, args.gateway, args.stale_seconds, sensors, seed_days)
                else:
                    local_publish(args.local, values, now, source, args.gateway, args.stale_seconds, sensors, seed_days)
                seed_days = 0
                online = sum(v["online"] for v in values)
                print(f"{iso(now)} | {source} | {online}/{len(values)} online | published", flush=True)
                if args.once:
                    return 0
            except (ValueError, KeyError, OSError, GitHubError, URLError) as exc:
                print(f"Publish failed: {exc}", file=sys.stderr, flush=True)
                if args.once:
                    return 1
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("Stopped. Sensors will expire automatically without further updates.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
