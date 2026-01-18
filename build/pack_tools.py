import hashlib
import json
import os
import zipfile
from datetime import datetime
from pathlib import Path

EXCLUDE_NAMES = {".git", "__pycache__", ".venv", "venv", "dist"}

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def add_dir_to_zip(zf: zipfile.ZipFile, root: Path, base: Path) -> None:
    for p in root.rglob("*"):
        if any(part in EXCLUDE_NAMES for part in p.parts):
            continue
        if p.is_dir():
            continue
        rel = p.relative_to(base).as_posix()
        zf.write(p, rel)

def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    tools_dir = repo / "tools"
    dist_dir = repo / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)

    tools = []
    for tdir in sorted([p for p in tools_dir.iterdir() if p.is_dir() and p.name not in EXCLUDE_NAMES]):
        meta_path = tdir / "tool.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))

        tool_id = meta["tool_id"]
        version = meta["version"]
        asset_name = f"tool_{tool_id}_{version}.zip"
        asset_path = dist_dir / asset_name

        # build zip
        if asset_path.exists():
            asset_path.unlink()

        with zipfile.ZipFile(asset_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            add_dir_to_zip(zf, tdir, tdir)

        digest = sha256_file(asset_path)

        tools.append({
            "tool_id": tool_id,
            "name": meta["name"],
            "latest": version,
            "asset_name": asset_name,
            "sha256": digest,
            "platforms": meta["platforms"],
            "category": meta.get("category", "uncategorized")
        })

    catalog = {
        "catalog_version": datetime.utcnow().strftime("%Y.%m.%d"),
        "tools": tools
    }

    (dist_dir / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[pack] wrote: {dist_dir / 'catalog.json'}")
    for t in tools:
        print(f"[pack] asset: {t['asset_name']} sha256={t['sha256']}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())