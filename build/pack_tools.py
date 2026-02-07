import hashlib
import json
import os
import zipfile
from datetime import datetime
from pathlib import Path

EXCLUDE_NAMES = {".git", "__pycache__", ".venv", "venv", "dist", "models", "Models for z image turbo temp"}

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
        if not meta_path.exists():
            print(f"[pack] SKIP: {tdir.name} (no tool.json)")
            continue
            
        meta = json.loads(meta_path.read_text(encoding="utf-8"))

        tool_id = meta["tool_id"]
        version = meta["version"]
        
        # Leer manifest.json (debe existir previamente)
        manifest_path = tdir / "manifest.json"
        manifest_hash = None
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest_hash = manifest["manifest_hash"]
            print(f"[pack] Tool: {tool_id} v{version} (manifest_hash: {manifest_hash[:16]}...)")
        else:
            print(f"[pack] WARN: {tool_id} sin manifest.json - ejecuta primero generate_manifest.py")
        
        asset_name = f"tool_{tool_id}_{version}.zip"
        asset_path = dist_dir / asset_name

        # build zip (incluye manifest.json si existe)
        if asset_path.exists():
            try:
                asset_path.unlink()
            except PermissionError:
                print(f"[pack] WARN: No se puede eliminar {asset_name} (en uso), saltando...")
                continue

        print(f"[pack] Empaquetando {asset_name}...")
        with zipfile.ZipFile(asset_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            add_dir_to_zip(zf, tdir, tdir)

        digest = sha256_file(asset_path)
        print(f"[pack]   SHA256: {digest[:16]}...")

        tool_entry = {
            "tool_id": tool_id,
            "name": meta["name"],
            "latest": version,
            "asset_name": asset_name,
            "sha256": digest,
            "platforms": meta["platforms"],
            "category": meta.get("category", "uncategorized")
        }
        
        if manifest_hash:
            tool_entry["manifest_hash"] = manifest_hash
        
        tools.append(tool_entry)

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