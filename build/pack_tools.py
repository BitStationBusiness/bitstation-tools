import argparse
import hashlib
import json
import os
import zipfile
from datetime import datetime
from pathlib import Path

EXCLUDE_NAMES = {".git", "__pycache__", ".venv", "venv", "dist", "models", "Models for z image turbo temp"}

# GitHub repository for Release URLs
GITHUB_REPO = os.environ.get("GITHUB_REPOSITORY", "BitStationBusiness/bitstation-tools")

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
    parser = argparse.ArgumentParser(description="Empaqueta tools y genera catalog.json")
    parser.add_argument("--release-tag", default=None,
                        help="Tag del release (ej: v0.6.0). Se usa para construir URLs de assets.")
    args = parser.parse_args()

    release_tag = args.release_tag or os.environ.get("RELEASE_TAG")

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

        if release_tag:
            download_url = (
                f"https://github.com/{GITHUB_REPO}/releases/download/"
                f"{release_tag}/{asset_name}"
            )
        else:
            download_url = None

        tool_entry = {
            "tool_id": tool_id,
            "name": meta["name"],
            "latest": version,
            "asset_name": asset_name,
            "sha256": digest,
            "platforms": meta["platforms"],
            "category": meta.get("category", "uncategorized"),
        }
        if download_url:
            tool_entry["download_url"] = download_url
        
        if manifest_hash:
            tool_entry["manifest_hash"] = manifest_hash

        # --- Frontend packaging (frontend.zip separado) ---
        frontend_dir = tdir / "frontend"
        if frontend_dir.is_dir() and any(frontend_dir.iterdir()):
            frontend_zip_name = f"frontend_{tool_id}_{version}.zip"
            frontend_zip_path = dist_dir / frontend_zip_name
            
            if frontend_zip_path.exists():
                try:
                    frontend_zip_path.unlink()
                except PermissionError:
                    print(f"[pack] WARN: No se puede eliminar {frontend_zip_name}")
            
            print(f"[pack]   Empaquetando frontend: {frontend_zip_name}...")
            with zipfile.ZipFile(frontend_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as fz:
                for fp in frontend_dir.rglob("*"):
                    if fp.is_file() and not any(part in EXCLUDE_NAMES for part in fp.parts):
                        rel = fp.relative_to(frontend_dir).as_posix()
                        fz.write(fp, rel)
            
            frontend_sha = sha256_file(frontend_zip_path)
            print(f"[pack]   Frontend SHA256: {frontend_sha[:16]}...")
            
            # URL absoluta al asset del GitHub Release
            if release_tag:
                tool_entry["frontend_url"] = (
                    f"https://github.com/{GITHUB_REPO}/releases/download/"
                    f"{release_tag}/{frontend_zip_name}"
                )
            else:
                tool_entry["frontend_url"] = frontend_zip_name
            tool_entry["frontend_sha256"] = frontend_sha
            tool_entry["has_frontend"] = True
            tool_entry["api_contract"] = meta.get("api_contract", "toolbridge/1")
        else:
            tool_entry["has_frontend"] = False

        # --- Cover image URL (raw GitHub) ---
        icon_path = tdir / "icon.png"
        if icon_path.exists():
            tool_entry["image_url"] = (
                f"https://raw.githubusercontent.com/{GITHUB_REPO}/main/tools/{tdir.name}/icon.png"
            )
        
        tools.append(tool_entry)

    catalog = {
        "catalog_version": datetime.utcnow().strftime("%Y.%m.%d"),
        "release_tag": release_tag,
        "tools": tools,
    }

    (dist_dir / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[pack] wrote: {dist_dir / 'catalog.json'}")
    for t in tools:
        print(f"[pack] asset: {t['asset_name']} sha256={t['sha256']}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())