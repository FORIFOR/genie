#!/usr/bin/env python3
"""Run a command under a memory budget and stop it before the machine gets tight.

The command itself is not changed: no gate is skipped and no threshold is loosened.
A stop by this guard is an interrupted run (exit 75), never a pass.

  memguard.py --log gate.log --report mem.json -- bash scripts/verify-all.sh
"""
import argparse, datetime, json, os, re, signal, subprocess, sys, time

EXIT_GUARD = 75  # EX_TEMPFAIL: stopped by the guard, result is not a verification


def sysctl(key):
    out = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, timeout=3)
    return out.stdout.strip() if out.returncode == 0 else ""


def sample():
    level = sysctl("kern.memorystatus_vm_pressure_level")  # 1 normal, 2 warning, 4 critical
    free = sysctl("kern.memorystatus_level")  # system-wide free percentage
    swap = re.search(r"used = ([0-9.]+)M", sysctl("vm.swapusage"))
    return {
        "level": int(level) if level.isdigit() else None,
        "freePercent": int(free) if free.isdigit() else None,
        "swapUsedMB": float(swap.group(1)) if swap else None,
    }


def breach(now, start, args):
    if now["level"] != 1:
        return f"memory pressure level {now['level']} (not normal)"
    if now["freePercent"] is None or now["freePercent"] < args.min_free:
        return f"free memory {now['freePercent']}% < {args.min_free}%"
    if now["swapUsedMB"] is None or start["swapUsedMB"] is None:
        return "swap usage could not be read"
    if now["swapUsedMB"] - start["swapUsedMB"] > args.max_swap_growth_mb:
        return f"swap grew {now['swapUsedMB'] - start['swapUsedMB']:.0f} MB > {args.max_swap_growth_mb} MB"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-free", type=int, default=40, help="stop below this free percentage")
    ap.add_argument("--start-free", type=int, default=55, help="do not start below this free percentage")
    ap.add_argument("--max-swap-growth-mb", type=float, default=512)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--log", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--stage-pattern", default=r"^== (.+) ==$", help="log line that names the running stage")
    ap.add_argument("command", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        ap.error("command required after --")

    start = sample()
    if start["level"] != 1 or start["freePercent"] is None or start["freePercent"] < args.start_free:
        print(f"MEMGUARD_NOT_STARTED: {start} (need level 1 and free >= {args.start_free}%)")
        return EXIT_GUARD

    stage_re = re.compile(args.stage_pattern)
    stages, order, stage, reason = {}, [], "(before first stage)", None
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open(args.log, "w") as out, open(args.log, "r", errors="replace") as tail:
        proc = subprocess.Popen(command, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        while True:
            done = proc.poll() is not None
            for line in tail.readlines():
                found = stage_re.match(line.strip())
                if found:
                    stage = found.group(1)
            now = sample()
            if stage not in stages:
                order.append(stage)
                stages[stage] = {"samples": 0, "minFreePercent": None, "maxSwapUsedMB": None, "maxLevel": None}
            entry = stages[stage]
            entry["samples"] += 1
            for key, field, pick in (("freePercent", "minFreePercent", min), ("swapUsedMB", "maxSwapUsedMB", max), ("level", "maxLevel", max)):
                if now[key] is not None:
                    entry[field] = now[key] if entry[field] is None else pick(entry[field], now[key])
            if done:
                break
            reason = breach(now, start, args)
            if reason:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                break
            time.sleep(args.interval)
        code = proc.wait()

    report = {
        "startedAt": started,
        "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "command": command,
        "limits": {"minFreePercent": args.min_free, "startFreePercent": args.start_free, "maxSwapGrowthMB": args.max_swap_growth_mb},
        "atStart": start,
        "guardStopped": reason is not None,
        "guardReason": reason,
        "stageAtStop": stage if reason else None,
        "commandExitCode": code,
        "stages": [{"stage": name, **stages[name]} for name in order],
    }
    with open(args.report, "w") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    if reason:
        print(f"MEMGUARD_STOPPED at stage '{stage}': {reason}. Unfinished stages are not verified.")
        return EXIT_GUARD
    worst = min((s for s in report["stages"] if s["minFreePercent"] is not None), key=lambda s: s["minFreePercent"], default=None)
    if worst:
        print(f"MEMGUARD_DONE exit {code}; lowest free {worst['minFreePercent']}% during '{worst['stage']}'")
    return code


if __name__ == "__main__":
    sys.exit(main())
