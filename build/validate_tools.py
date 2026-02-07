import json
import sys
from pathlib import Path

REQUIRED_FIELDS = ["tool_id", "name", "version", "platforms", "entrypoint_windows", "io_schema"]

EXCLUDE_DIRS = {"__pycache__", ".venv", "venv", "dist", ".git", "Bit-Karaoke (demo, no oficial)"}

def die(msg: str, code: int = 2) -> None:
    print(f"[validate] ERROR: {msg}", file=sys.stderr)
    raise SystemExit(code)

def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    tools_dir = repo / "tools"
    if not tools_dir.exists():
        die("tools/ directory not found")

    tool_folders = [p for p in tools_dir.iterdir() if p.is_dir() and p.name not in EXCLUDE_DIRS]
    if not tool_folders:
        die("no tools found in tools/")

    ok_count = 0
    for tdir in sorted(tool_folders):
        tool_json = tdir / "tool.json"
        if not tool_json.exists():
            die(f"missing tool.json in {tdir}")

        try:
            meta = json.loads(tool_json.read_text(encoding="utf-8"))
        except Exception as e:
            die(f"invalid JSON in {tool_json}: {e}")

        for k in REQUIRED_FIELDS:
            if k not in meta:
                die(f"{tool_json} missing required field: {k}")

        entry = meta["entrypoint_windows"]
        entry_path = tdir / entry
        if not entry_path.exists():
            die(f"{tool_json} entrypoint not found: {entry} (expected: {entry_path})")

        # requirements.lock.txt recomendado
        req = tdir / "requirements.lock.txt"
        if not req.exists():
            die(f"{tdir} missing requirements.lock.txt (can be empty, but must exist)")

        ok_count += 1
        print(f"[validate] OK: {meta['tool_id']} v{meta['version']}")

    print(f"[validate] ALL OK. tools={ok_count}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())