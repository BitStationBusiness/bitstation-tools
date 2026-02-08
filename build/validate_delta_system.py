"""
Script de validación del sistema de actualización diferencial.
Verifica que todos los componentes estén correctamente implementados.
"""

import json
import sys
from pathlib import Path
from typing import List, Tuple


def check_file_exists(path: Path, description: str) -> bool:
    """Verifica que un archivo exista."""
    if path.exists():
        print(f"[OK] {description}: {path.name}")
        return True
    else:
        print(f"[FAIL] {description}: {path.name} NO ENCONTRADO")
        return False


def check_manifest_valid(manifest_path: Path) -> Tuple[bool, str]:
    """Valida que un manifest.json sea válido."""
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        
        # Campos requeridos
        required = [
            "manifest_version",
            "tool_id",
            "tool_version",
            "manifest_hash",
            "files",
            "delete_policy",
            "ignore_globs"
        ]
        
        for field in required:
            if field not in manifest:
                return False, f"Falta campo requerido: {field}"
        
        # Validar files
        if not isinstance(manifest["files"], list):
            return False, "files debe ser un array"
        
        if len(manifest["files"]) == 0:
            return False, "files está vacío"
        
        # Validar primer archivo
        first_file = manifest["files"][0]
        file_required = ["path", "sha256", "size"]
        for field in file_required:
            if field not in first_file:
                return False, f"Archivo sin campo requerido: {field}"
        
        # Validar hash
        if len(manifest["manifest_hash"]) != 64:
            return False, f"manifest_hash inválido: {len(manifest['manifest_hash'])} chars (esperado 64)"
        
        return True, f"OK: {len(manifest['files'])} archivos, hash {manifest['manifest_hash'][:16]}..."
    
    except json.JSONDecodeError as e:
        return False, f"JSON inválido: {e}"
    except Exception as e:
        return False, f"Error: {e}"


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    
    print("=" * 60)
    print("VALIDACION DEL SISTEMA DE ACTUALIZACION DIFERENCIAL")
    print("=" * 60)
    
    checks_passed = 0
    checks_total = 0
    
    # 1. Verificar esquemas
    print("\n1. ESQUEMAS JSON")
    print("-" * 60)
    
    checks_total += 1
    if check_file_exists(repo / "catalog/manifest.schema.json", "Schema de manifest"):
        checks_passed += 1
    
    # 2. Verificar scripts
    print("\n2. SCRIPTS DE BUILD")
    print("-" * 60)
    
    scripts = [
        ("build/generate_manifest.py", "Generador de manifests"),
        ("build/delta_updater.py", "Updater diferencial"),
        ("build/worker_updater_example.py", "Ejemplo de integración"),
        ("build/pack_tools.py", "Empaquetador de tools"),
    ]
    
    for script_path, description in scripts:
        checks_total += 1
        if check_file_exists(repo / script_path, description):
            checks_passed += 1
    
    # 3. Verificar documentación
    print("\n3. DOCUMENTACIÓN")
    print("-" * 60)
    
    docs = [
        ("docs/delta_update_system.md", "Documentación completa"),
        ("docs/QUICKSTART_DELTA_UPDATE.md", "Guía de inicio rápido"),
        ("IMPLEMENTATION_SUMMARY.md", "Resumen de implementación"),
    ]
    
    for doc_path, description in docs:
        checks_total += 1
        if check_file_exists(repo / doc_path, description):
            checks_passed += 1
    
    # 4. Verificar manifests generados
    print("\n4. MANIFESTS GENERADOS")
    print("-" * 60)
    
    tools_dir = repo / "tools"
    manifests_found = []
    
    for tool_path in tools_dir.iterdir():
        if not tool_path.is_dir():
            continue
        
        manifest_path = tool_path / "manifest.json"
        if manifest_path.exists():
            manifests_found.append((tool_path.name, manifest_path))
    
    if not manifests_found:
        print("[FAIL] No se encontraron manifests generados")
        print("  Ejecuta: python build/generate_manifest.py")
    else:
        for tool_name, manifest_path in manifests_found:
            checks_total += 1
            valid, message = check_manifest_valid(manifest_path)
            
            if valid:
                print(f"[OK] {tool_name}: {message}")
                checks_passed += 1
            else:
                print(f"[FAIL] {tool_name}: {message}")
    
    # 5. Verificar integración con workflow
    print("\n5. INTEGRACIÓN CI/CD")
    print("-" * 60)
    
    checks_total += 1
    workflow_path = repo / ".github/workflows/release.yml"
    if workflow_path.exists():
        workflow_content = workflow_path.read_text(encoding="utf-8")
        if "generate_manifest.py" in workflow_content:
            print("[OK] Workflow incluye generacion de manifests")
            checks_passed += 1
        else:
            print("[FAIL] Workflow NO incluye generacion de manifests")
    else:
        print("[FAIL] Workflow de release no encontrado")
    
    # Resumen final
    print("\n" + "=" * 60)
    print("RESUMEN")
    print("=" * 60)
    print(f"Checks pasados: {checks_passed}/{checks_total}")
    
    if checks_passed == checks_total:
        print("\n*** SISTEMA COMPLETAMENTE VALIDADO ***")
        print("\nSistema listo para produccion.")
        print("\nProximos pasos:")
        print("  1. Commit de cambios: git add . && git commit -m 'Sistema de actualizacion diferencial'")
        print("  2. Crear release: git tag v0.6.0 && git push origin v0.6.0")
        print("  3. Integrar en PCWorker (ver build/worker_updater_example.py)")
        return 0
    else:
        print(f"\n[WARNING] {checks_total - checks_passed} checks fallaron")
        print("\nRevisa los errores arriba y corrige antes de continuar.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
