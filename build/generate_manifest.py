"""
Generador de manifiestos para releases de tools con actualización diferencial.
Calcula hashes SHA256 de cada archivo y genera manifest.json.

DISTRIBUCIÓN:
- Opción A (recomendada): HQ como mirror
  BASE_URL = "https://hq.bitstation.local/tools/{tool_id}/{version}/files/"
- Opción B: GitHub raw (solo para archivos en repo)
  BASE_URL = "https://raw.githubusercontent.com/user/repo/{tag}/tools/{tool_id}/"
"""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Any, Optional
from urllib.parse import quote

# Scopes explícitos (según recomendación)
EXCLUDE_NAMES = {".git", "__pycache__", ".venv", "venv", "dist", ".pytest_cache", "node_modules", "models"}
EXCLUDE_PATTERNS = {"*.pyc", ".DS_Store", "Thumbs.db", "*.tmp", "*.gguf", "*.safetensors", "*.bin", "*.pth", "*.ckpt"}

# IMPORTANTE: Los modelos/pesos DEBEN estar en el manifest para garantizar consistencia
# NO excluir .gguf, .safetensors, .bin, .pth, .ckpt si afectan el output

DEFAULT_IGNORE_GLOBS = [
    "venv/**",
    ".venv/**",
    "cache/**",
    "user_data/**",
    "logs/**",
    "*.log",
    ".env",
    "config.local.*",
    "__pycache__/**",
    "*.pyc"
]


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    """
    Calcula SHA256 de un archivo de forma eficiente por streaming.
    
    Args:
        path: Ruta al archivo
        chunk_size: Tamaño de bloque (default 8MB para eficiencia con archivos grandes)
    
    Returns:
        Hash SHA256 hexadecimal
    """
    h = hashlib.sha256()
    file_size = path.stat().st_size
    
    # Log para archivos grandes (>100MB)
    if file_size > 100 * 1024 * 1024:
        print(f"[manifest]   Hashing archivo grande: {path.name} ({file_size / (1024*1024):.1f} MB)...")
    
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    
    return h.hexdigest()


def sha256_string(text: str) -> str:
    """Calcula SHA256 de un string."""
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def should_exclude(path: Path, base: Path) -> bool:
    """
    Determina si un archivo debe excluirse del manifiesto.
    
    SCOPES:
    - release_scope/: Gestionado por updater (incluido en manifest)
    - runtime_scope/: venv/, cache/ (NUNCA en manifest, protegido)
    - user_scope/: user_data/ (NUNCA en manifest, protegido)
    """
    # Excluir por nombre de directorio (runtime_scope + user_scope)
    if any(part in EXCLUDE_NAMES for part in path.parts):
        return True
    
    # Excluir por patrón (archivos temporales/compilados)
    for pattern in EXCLUDE_PATTERNS:
        if path.match(pattern):
            return True
    
    # TODO: Si un archivo es un "modelo descargado dinámicamente",
    # considerar estrategia de model_registry.json + descarga lazy
    # Pero si el modelo es PARTE del release, DEBE estar hasheado aquí
    
    return False


def collect_files(tool_dir: Path, base_url: str, tool_id: str, version: str) -> List[Dict[str, Any]]:
    """
    Recolecta información de todos los archivos de una tool.
    
    Args:
        tool_dir: Directorio de la tool
        base_url: URL base para descargas (ej: "https://hq.bitstation.local/api/v1/tools/")
        tool_id: ID de la tool
        version: Versión de la tool
    
    GARANTÍAS:
    - Orden determinista: Ordenado por path normalizado
    - Paths normalizados: Siempre forward slash (/)
    - Hashing eficiente: Streaming para archivos grandes
    - URLs individuales: Para delta update real
    """
    files = []
    
    # Recolectar todos los archivos primero
    all_files = [p for p in tool_dir.rglob("*") if p.is_file() and not should_exclude(p, tool_dir)]
    
    # Ordenar por path relativo normalizado para determinismo
    all_files.sort(key=lambda p: p.relative_to(tool_dir).as_posix())
    
    for p in all_files:
        # Normalizar path: siempre forward slash
        rel_path = p.relative_to(tool_dir).as_posix()
        
        # Hash con streaming eficiente
        file_hash = sha256_file(p)
        file_size = p.stat().st_size
        
        # Construir URL individual para el archivo
        # HQ mirror: {base_url}/{tool_id}/{version}/files/{path}
        # GitHub raw: {base_url}/{tool_id}/{path}
        url_path = f"{tool_id}/{version}/files/{quote(rel_path, safe='/')}"
        file_url = f"{base_url.rstrip('/')}/{url_path}"
        
        file_info = {
            "path": rel_path,  # Normalizado
            "sha256": file_hash,
            "size": file_size,
            "url": file_url  # URL individual (requerido)
        }
        
        # Marcar scripts como ejecutables
        if p.suffix in {".ps1", ".sh", ".py"} or p.name in {"run", "setup"}:
            file_info["executable"] = True
        
        files.append(file_info)
    
    return files


def normalize_manifest_for_hash(manifest: Dict[str, Any]) -> str:
    """
    Normaliza el manifiesto para cálculo de hash (excluye el campo manifest_hash y created_at).
    """
    normalized = manifest.copy()
    normalized.pop("manifest_hash", None)
    normalized.pop("created_at", None)
    
    # Serializar de forma determinística
    return json.dumps(normalized, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def generate_manifest(tool_dir: Path, tool_meta: Dict[str, Any], base_url: Optional[str] = None) -> Dict[str, Any]:
    """
    Genera el manifiesto completo para una tool.
    
    Args:
        tool_dir: Directorio de la tool
        tool_meta: Metadata de tool.json
        base_url: URL base para descarga de archivos (si None, usa env var o default)
    """
    tool_id = tool_meta["tool_id"]
    tool_version = tool_meta["version"]
    
    # Obtener base_url (prioridad: parámetro > env var > default HQ)
    if base_url is None:
        base_url = os.environ.get(
            "BITSTATION_FILES_BASE_URL",
            "https://hq.bitstation.local/api/v1/tools/"
        )
    
    print(f"[manifest] Generando manifiesto para {tool_id} v{tool_version}...")
    print(f"[manifest]   Base URL: {base_url}")
    
    # Recolectar archivos con URLs individuales
    files = collect_files(tool_dir, base_url, tool_id, tool_version)
    print(f"[manifest]   {len(files)} archivos procesados")
    
    # Construir manifiesto base
    manifest = {
        "manifest_version": "1.0",
        "tool_id": tool_id,
        "tool_version": tool_version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "files": files,
        "delete_policy": "safe",
        "ignore_globs": DEFAULT_IGNORE_GLOBS.copy()
    }
    
    # Agregar configuración Flash GPU si la tool lo soporta
    if tool_meta.get("supports_gpu_persistence"):
        manifest["flash_gpu_config"] = {
            "enabled": True,
            "warmup_script": "src/main.py",
            "cache_artifacts": [
                "cache/**/*.gguf",
                "cache/**/*.safetensors",
                "cache/**/*.bin"
            ]
        }
    
    # Calcular manifest_hash (hash del manifest normalizado sin el hash mismo)
    normalized = normalize_manifest_for_hash(manifest)
    manifest["manifest_hash"] = sha256_string(normalized)
    
    print(f"[manifest]   manifest_hash: {manifest['manifest_hash'][:16]}...")
    
    return manifest


def generate_manifests_for_all_tools(repo_root: Path, base_url: str) -> Dict[str, Dict[str, Any]]:
    """
    Genera manifiestos para todas las tools en el repo.
    
    Args:
        repo_root: Raíz del repositorio
        base_url: URL base para descargas
    
    Returns:
        Diccionario {tool_id: manifest}
    """
    tools_dir = repo_root / "tools"
    manifests = {}
    
    for tool_path in sorted([p for p in tools_dir.iterdir() if p.is_dir() and p.name not in EXCLUDE_NAMES]):
        meta_path = tool_path / "tool.json"
        
        if not meta_path.exists():
            print(f"[manifest] SKIP: {tool_path.name} (no tool.json)")
            continue
        
        try:
            tool_meta = json.loads(meta_path.read_text(encoding="utf-8"))
            manifest = generate_manifest(tool_path, tool_meta, base_url)
            
            # Guardar manifest.json dentro de la tool
            manifest_path = tool_path / "manifest.json"
            
            # Verificar si hay problemas de escritura
            try:
                manifest_path.write_text(
                    json.dumps(manifest, ensure_ascii=False, indent=2),
                    encoding="utf-8"
                )
                print(f"[manifest]   Escrito: {manifest_path}")
                manifests[tool_meta["tool_id"]] = manifest
            except PermissionError as e:
                print(f"[manifest]   ERROR: No se puede escribir {manifest_path}")
                print(f"[manifest]   Razón: {e}")
                print(f"[manifest]   Verifica permisos o cierra editores que puedan tener el archivo abierto")
        
        except Exception as e:
            print(f"[manifest] ERROR procesando {tool_path.name}: {e}")
            continue
    
    return manifests


def main() -> int:
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Genera manifiestos para todas las tools con URLs individuales"
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("BITSTATION_FILES_BASE_URL", "https://hq.bitstation.local/api/v1/tools/"),
        help="Base URL para descargas (default: HQ mirror o env var BITSTATION_FILES_BASE_URL)"
    )
    parser.add_argument(
        "--github-release",
        action="store_true",
        help="Usar GitHub raw URLs (formato: https://github.com/{user}/{repo}/releases/download/{tag}/)"
    )
    
    args = parser.parse_args()
    
    repo = Path(__file__).resolve().parents[1]
    
    # Si se especifica GitHub release, construir base_url apropiada
    base_url = args.base_url
    if args.github_release:
        # TODO: Detectar user/repo del .git/config
        base_url = "https://github.com/BitStationX/bitstation-tools/releases/download/v{version}/"
        print("[manifest] Modo GitHub Release activado")
    
    print("[manifest] Generando manifiestos de release...")
    print(f"[manifest] Base URL: {base_url}")
    
    manifests = generate_manifests_for_all_tools(repo, base_url)
    
    print(f"\n[manifest] OK: {len(manifests)} manifiestos generados")
    
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
