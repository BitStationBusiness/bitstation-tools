"""
bump_version.py - Incrementa la version de las tools modificadas.

Uso:
  python scripts/bump_version.py [--part patch|minor|major] [--tool TOOL_ID]
  
Si no se especifica --tool, incrementa la version de todas las tools
que tengan cambios (git diff) respecto a la ultima tag.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path


def parse_semver(v: str) -> tuple[int, int, int]:
    parts = v.split(".")
    if len(parts) != 3:
        raise ValueError(f"Version invalida: {v}")
    return int(parts[0]), int(parts[1]), int(parts[2])


def bump(v: str, part: str) -> str:
    major, minor, patch = parse_semver(v)
    if part == "major":
        return f"{major + 1}.0.0"
    elif part == "minor":
        return f"{major}.{minor + 1}.0"
    else:
        return f"{major}.{minor}.{patch + 1}"


def get_changed_tools(repo: Path) -> set[str]:
    """Detecta tools con cambios desde la ultima tag."""
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            capture_output=True, text=True, cwd=repo,
        )
        last_tag = result.stdout.strip()
        if not last_tag:
            return set()

        diff_result = subprocess.run(
            ["git", "diff", "--name-only", f"{last_tag}..HEAD"],
            capture_output=True, text=True, cwd=repo,
        )
        changed_files = diff_result.stdout.strip().split("\n")
    except Exception:
        return set()

    tools = set()
    for f in changed_files:
        if f.startswith("tools/"):
            parts = f.split("/")
            if len(parts) >= 2:
                tools.add(parts[1])
    return tools


def main() -> int:
    parser = argparse.ArgumentParser(description="Bump tool versions")
    parser.add_argument("--part", choices=["patch", "minor", "major"], default="patch")
    parser.add_argument("--tool", help="Specific tool_id to bump (otherwise auto-detect)")
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[1]
    tools_dir = repo / "tools"

    if args.tool:
        tool_ids = {args.tool}
    else:
        tool_ids = get_changed_tools(repo)
        if not tool_ids:
            print("[bump] No changed tools detected since last tag.")
            return 0

    bumped = 0
    for tool_name in sorted(tool_ids):
        tool_json = tools_dir / tool_name / "tool.json"
        if not tool_json.exists():
            print(f"[bump] SKIP: {tool_name} (no tool.json)")
            continue

        meta = json.loads(tool_json.read_text(encoding="utf-8"))
        old_ver = meta.get("version", "0.0.0")
        new_ver = bump(old_ver, args.part)
        meta["version"] = new_ver

        tool_json.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"[bump] {meta['tool_id']}: {old_ver} -> {new_ver}")
        bumped += 1

    print(f"[bump] Done. {bumped} tool(s) bumped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
