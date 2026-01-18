import argparse
import json
import sys
from pathlib import Path

def fail(msg: str, code: int = 2) -> None:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Path a input.json")
    ap.add_argument("--output", required=True, help="Path a output.json")
    args = ap.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output)

    if not in_path.exists():
        fail(f"input not found: {in_path}")

    try:
        data = json.loads(in_path.read_text(encoding="utf-8-sig"))
    except Exception as e:
        fail(f"invalid json input: {e}")

    if not isinstance(data, dict):
        fail("input must be a JSON object")

    if "a" not in data or "b" not in data:
        fail("missing required fields: a, b")

    a = data["a"]
    b = data["b"]

    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        fail("fields a and b must be numbers")

    result = float(a) + float(b)

    out = {"ok": True, "result": result}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())