#!/usr/bin/env python3
"""
Weekly health check of a deployed pi-intercom-wake. Prints ONE JSON object and always exits 0, so a scheduler
can decide what to report:
  - end-to-end wake checks of the deployed code against the installed PI WEB (isolated daemon and broker, see
    scripts/e2e/run.sh; nothing live is touched);
  - whether upstream pi-intercom moved (GitHub main and the npm release);
  - the installed PI WEB session daemon version, for the report.
Usage: weekly-check.py --deploy <deployed fork dir> --known-upstream <sha> --known-npm <version>
"""
import argparse, json, os, subprocess, urllib.request

p = argparse.ArgumentParser()
p.add_argument("--deploy", required=True)
p.add_argument("--known-upstream", required=True)
p.add_argument("--known-npm", required=True)
p.add_argument("--sessiond-socket", default=os.path.expanduser("~/.pi-web/sessiond.sock"))
a = p.parse_args()

def run(args, timeout):
    try:
        r = subprocess.run(args, cwd=a.deploy, capture_output=True, text=True, timeout=timeout)
        out = (r.stdout + r.stderr).strip().splitlines()
        return r.returncode, out
    except subprocess.TimeoutExpired:
        return 124, ["timeout"]
    except Exception as e:  # noqa: BLE001 - report, never crash
        return 1, [f"{type(e).__name__}: {e}"]

def e2e(scenario, success_marker):
    rc, out = run(["/bin/sh", "scripts/e2e/run.sh", scenario], 1200)
    ok = rc == 0 and any(success_marker in line for line in out)
    fails = [line for line in out if line.startswith("FAIL")]
    return {"ok": ok, "rc": rc, "summary": out[-1] if out else "", "fails": fails[:10], **({} if ok else {"tail": out[-15:]})}

def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pi-intercom-wake-weekly-check", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

result = {"wake": e2e("wake", "checks passed"), "busy": e2e("busy", "all expectations met")}
if result["wake"]["ok"]:
    result["wake"]["ok"] = result["wake"]["summary"].split("/")[0] == result["wake"]["summary"].split("/")[1].split(" ")[0]

notes = []
try:
    sha = get_json("https://api.github.com/repos/nicobailon/pi-intercom/commits/main")["sha"]
    result["upstream"] = {"sha": sha, "changed": sha != a.known_upstream}
except Exception as e:  # noqa: BLE001
    result["upstream"] = {"error": str(e)[:200], "changed": False}
    notes.append("upstream GitHub unreachable")
try:
    version = get_json("https://registry.npmjs.org/pi-intercom/latest")["version"]
    result["npm"] = {"version": version, "changed": version != a.known_npm}
except Exception as e:  # noqa: BLE001
    result["npm"] = {"error": str(e)[:200], "changed": False}
    notes.append("npm registry unreachable")
rc, out = run(["curl", "-s", "--max-time", "5", "--unix-socket", a.sessiond_socket, "http://localhost/health"], 15)
try:
    result["piWeb"] = json.loads("\n".join(out)).get("version", {}).get("runtimeVersion")
except Exception:  # noqa: BLE001
    result["piWeb"] = None

ok = result["wake"]["ok"] and result["busy"]["ok"]
changed = result["upstream"].get("changed") or result["npm"].get("changed")
result["ok"] = ok
result["attention"] = (not ok) or bool(changed) or bool(notes)
lines = []
if not ok:
    lines.append("End-to-end wake checks FAILED with PI WEB " + str(result["piWeb"]) + ". Wakes may be refused (fail-closed, no harm) until this is fixed.")
    for name in ("wake", "busy"):
        if not result[name]["ok"]:
            lines.append(f"- {name}: {result[name]['summary']} " + "; ".join(result[name]["fails"][:5]))
if result["upstream"].get("changed"):
    lines.append(f"Upstream pi-intercom: new commit on main ({result['upstream']['sha'][:7]}) to merge into the fork.")
if result["npm"].get("changed"):
    lines.append(f"Upstream pi-intercom: new npm release {result['npm']['version']}.")
lines.extend(f"Note: {n}." for n in notes)
result["message"] = "\n".join(lines) if lines else f"All good (PI WEB {result['piWeb']}, wake and busy checks passed, nothing new upstream)."
print(json.dumps(result))
