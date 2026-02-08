"""
Tests del sistema de actualización diferencial.

Casos de prueba requeridos:
1. 0 cambios → descarga 0 archivos
2. 1 archivo cambia → descarga 1 archivo
3. 1 archivo eliminado → borra 1 archivo
4. Hash mismatch → aborta y no activa
"""

import json
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Dict, Any

from delta_updater import DeltaUpdater, UpdateStats
from file_downloader import MockDownloader


def create_test_manifest(tool_id: str, version: str, files: list) -> Dict[str, Any]:
    """Crea un manifest de prueba."""
    manifest = {
        "manifest_version": "1.0",
        "tool_id": tool_id,
        "tool_version": version,
        "created_at": "2026-02-05T00:00:00Z",
        "files": files,
        "delete_policy": "safe",
        "ignore_globs": ["venv/**", "cache/**"],
        "manifest_hash": "test_hash_placeholder"
    }
    
    # Calcular manifest_hash real
    from delta_updater import DeltaUpdater
    import hashlib
    normalized = json.dumps(
        {k: v for k, v in manifest.items() if k not in ["manifest_hash", "created_at"]},
        sort_keys=True,
        ensure_ascii=False,
        separators=(',', ':')
    )
    manifest["manifest_hash"] = hashlib.sha256(normalized.encode('utf-8')).hexdigest()
    
    return manifest


def create_test_file(path: Path, content: str) -> Dict[str, Any]:
    """Crea un archivo de prueba y retorna su info para manifest."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    
    import hashlib
    sha256 = hashlib.sha256(content.encode('utf-8')).hexdigest()
    
    return {
        "path": path.name,
        "sha256": sha256,
        "size": len(content.encode('utf-8')),
        "url": f"https://test.local/files/{path.name}"
    }


def create_test_zip(zip_path: Path, files: Dict[str, str], manifest: Dict):
    """Crea un ZIP de prueba con archivos y manifest."""
    with zipfile.ZipFile(zip_path, 'w') as zf:
        # Agregar manifest
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        
        # Agregar archivos
        for filename, content in files.items():
            zf.writestr(filename, content)


def test_case_1_no_changes():
    """
    Test Caso 1: 0 cambios → descarga 0 archivos
    """
    print("\n" + "="*60)
    print("TEST CASO 1: Sin cambios (debe descargar 0 archivos)")
    print("="*60)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_root = Path(tmpdir) / "test_tool"
        tool_root.mkdir()
        
        # Crear instalación inicial
        v1_dir = tool_root / "releases" / "v1.0.0"
        v1_dir.mkdir(parents=True)
        
        file1 = create_test_file(v1_dir / "file1.txt", "content1")
        file2 = create_test_file(v1_dir / "file2.txt", "content2")
        
        manifest_v1 = create_test_manifest("test", "1.0.0", [file1, file2])
        (v1_dir / "manifest.json").write_text(json.dumps(manifest_v1, indent=2))
        
        # Marcar como current
        (tool_root / "current.txt").write_text("v1.0.0")
        
        # Crear ZIP con misma versión (sin cambios)
        zip_path = Path(tmpdir) / "test_1.0.0.zip"
        create_test_zip(zip_path, {
            "file1.txt": "content1",
            "file2.txt": "content2"
        }, manifest_v1)
        
        # Actualizar
        updater = DeltaUpdater(tool_root)
        stats = updater.update_from_zip(zip_path, manifest_v1)
        
        # Verificar
        assert stats.files_downloaded == 0, f"Esperado 0 descargados, obtenido {stats.files_downloaded}"
        assert stats.files_verified > 0, "Debe verificar archivos existentes"
        assert stats.files_skipped == 2, f"Esperado 2 skipped, obtenido {stats.files_skipped}"
        
        print("[OK] Test Caso 1 PASADO")
        print(f"  Descargados: {stats.files_downloaded}")
        print(f"  Verificados: {stats.files_verified}")
        print(f"  Skipped: {stats.files_skipped}")
        return True


def test_case_2_one_file_changed():
    """
    Test Caso 2: 1 archivo cambia → descarga 1 archivo
    """
    print("\n" + "="*60)
    print("TEST CASO 2: 1 archivo cambiado (debe descargar 1 archivo)")
    print("="*60)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_root = Path(tmpdir) / "test_tool"
        tool_root.mkdir()
        
        # Crear fixtures directory
        fixtures_dir = Path(tmpdir) / "fixtures"
        fixtures_dir.mkdir()
        
        # Crear instalación v1.0.0
        v1_dir = tool_root / "releases" / "v1.0.0"
        v1_dir.mkdir(parents=True)
        
        file1_v1 = create_test_file(v1_dir / "file1.txt", "content1")
        file2_v1 = create_test_file(v1_dir / "file2.txt", "content2")
        
        manifest_v1 = create_test_manifest("test", "1.0.0", [file1_v1, file2_v1])
        (v1_dir / "manifest.json").write_text(json.dumps(manifest_v1, indent=2))
        (tool_root / "current.txt").write_text("v1.0.0")
        
        # Crear fixture para file1 modificado
        modified_content = "content1_modified!!"
        (fixtures_dir / "file1.txt").write_text(modified_content, encoding='utf-8')
        
        # Calcular hash del archivo modificado
        import hashlib
        file1_v2_sha256 = hashlib.sha256(modified_content.encode('utf-8')).hexdigest()
        
        # Crear v1.1.0 con file1 modificado
        file1_v2 = {
            "path": "file1.txt",
            "sha256": file1_v2_sha256,
            "size": len(modified_content.encode('utf-8')),
            "url": "https://test.local/files/file1.txt"
        }
        file2_v2 = file2_v1.copy()  # Sin cambios
        
        manifest_v2 = create_test_manifest("test", "1.1.0", [file1_v2, file2_v2])
        
        zip_path = Path(tmpdir) / "test_1.1.0.zip"
        create_test_zip(zip_path, {
            "file1.txt": modified_content,
            "file2.txt": "content2"
        }, manifest_v2)
        
        # Actualizar con MockDownloader
        mock_downloader = MockDownloader(fixtures_dir)
        updater = DeltaUpdater(tool_root, downloader=mock_downloader)
        stats = updater.update_from_zip(zip_path, manifest_v2)
        
        # Verificar
        assert stats.files_downloaded == 1, f"Esperado 1 descargado, obtenido {stats.files_downloaded}"
        assert stats.files_skipped == 1, f"Esperado 1 skipped (file2), obtenido {stats.files_skipped}"
        
        print("[OK] Test Caso 2 PASADO")
        print(f"  Descargados: {stats.files_downloaded}")
        print(f"  Skipped: {stats.files_skipped}")
        return True


def test_case_3_one_file_deleted():
    """
    Test Caso 3: 1 archivo eliminado → borra 1 archivo
    """
    print("\n" + "="*60)
    print("TEST CASO 3: 1 archivo eliminado (debe borrar 1 archivo)")
    print("="*60)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_root = Path(tmpdir) / "test_tool"
        tool_root.mkdir()
        
        # Crear instalación v1.0.0 con 2 archivos
        v1_dir = tool_root / "releases" / "v1.0.0"
        v1_dir.mkdir(parents=True)
        
        file1_v1 = create_test_file(v1_dir / "file1.txt", "content1")
        file2_v1 = create_test_file(v1_dir / "file2.txt", "content2")
        
        manifest_v1 = create_test_manifest("test", "1.0.0", [file1_v1, file2_v1])
        (v1_dir / "manifest.json").write_text(json.dumps(manifest_v1, indent=2))
        (tool_root / "current.txt").write_text("v1.0.0")
        
        # Crear v1.1.0 sin file2 (eliminado)
        manifest_v2 = create_test_manifest("test", "1.1.0", [file1_v1])  # Solo file1
        
        zip_path = Path(tmpdir) / "test_1.1.0.zip"
        create_test_zip(zip_path, {
            "file1.txt": "content1"  # file2 eliminado
        }, manifest_v2)
        
        # Actualizar
        updater = DeltaUpdater(tool_root)
        stats = updater.update_from_zip(zip_path, manifest_v2)
        
        # Verificar
        assert stats.files_deleted > 0, f"Esperado archivos eliminados, obtenido {stats.files_deleted}"
        assert stats.files_skipped == 1, "file1 debe ser skipped (sin cambios)"
        
        print("[OK] Test Caso 3 PASADO")
        print(f"  Eliminados: {stats.files_deleted}")
        print(f"  Skipped: {stats.files_skipped}")
        return True


def test_case_4_hash_mismatch():
    """
    Test Caso 4: Hash mismatch → aborta y no activa
    """
    print("\n" + "="*60)
    print("TEST CASO 4: Hash mismatch (debe abortar sin activar)")
    print("="*60)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_root = Path(tmpdir) / "test_tool"
        tool_root.mkdir()
        
        # Crear fixtures directory
        fixtures_dir = Path(tmpdir) / "fixtures"
        fixtures_dir.mkdir()
        
        # Crear instalación v1.0.0
        v1_dir = tool_root / "releases" / "v1.0.0"
        v1_dir.mkdir(parents=True)
        
        file1_v1 = create_test_file(v1_dir / "file1.txt", "content1")
        manifest_v1 = create_test_manifest("test", "1.0.0", [file1_v1])
        (v1_dir / "manifest.json").write_text(json.dumps(manifest_v1, indent=2))
        (tool_root / "current.txt").write_text("v1.0.0")
        
        # Crear fixture con contenido real
        actual_content = "modified"
        (fixtures_dir / "file1.txt").write_text(actual_content, encoding='utf-8')
        
        # Crear v1.1.0 pero manifest tiene hash incorrecto
        file1_v2 = {
            "path": "file1.txt",
            "sha256": "wrong_hash_0000000000000000000000000000000000000000000000000000000000",
            "size": 8,
            "url": "https://test.local/files/file1.txt"
        }
        manifest_v2 = create_test_manifest("test", "1.1.0", [file1_v2])
        
        zip_path = Path(tmpdir) / "test_1.1.0.zip"
        create_test_zip(zip_path, {
            "file1.txt": actual_content
        }, manifest_v2)
        
        # Intentar actualizar con MockDownloader
        mock_downloader = MockDownloader(fixtures_dir)
        updater = DeltaUpdater(tool_root, downloader=mock_downloader)
        
        try:
            stats = updater.update_from_zip(zip_path, manifest_v2)
            
            # No debe llegar aquí - debe abortar
            assert False, "Debió abortar por hash mismatch"
        
        except RuntimeError as e:
            # Verificar que abortó por verificación
            assert "integridad" in str(e).lower()
            
            # Verificar que NO activó (current debe seguir en v1.0.0)
            current = (tool_root / "current.txt").read_text()
            assert current == "v1.0.0", f"Current deberia ser v1.0.0, es {current}"
            
            # Verificar que v1.1.0 NO está activado
            assert not (tool_root / "releases" / "v1.1.0").exists() or \
                   (tool_root / "releases" / ".staging").exists()
            
            print("[OK] Test Caso 4 PASADO")
            print(f"  Aborto correctamente: {e}")
            return True


def run_all_tests():
    """Ejecuta todos los tests de delta update."""
    print("\n" + "="*60)
    print("SUITE DE TESTS: DELTA UPDATE")
    print("="*60)
    
    tests = [
        ("Caso 1: Sin cambios", test_case_1_no_changes),
        ("Caso 2: 1 archivo cambiado", test_case_2_one_file_changed),
        ("Caso 3: 1 archivo eliminado", test_case_3_one_file_deleted),
        ("Caso 4: Hash mismatch", test_case_4_hash_mismatch),
    ]
    
    passed = 0
    failed = 0
    
    for test_name, test_func in tests:
        try:
            if test_func():
                passed += 1
            else:
                failed += 1
                print(f"[FAIL] {test_name} FALLIDO")
        except Exception as e:
            failed += 1
            print(f"[FAIL] {test_name} ERROR: {e}")
            import traceback
            traceback.print_exc()
    
    print("\n" + "="*60)
    print("RESUMEN DE TESTS")
    print("="*60)
    print(f"Pasados: {passed}/{len(tests)}")
    print(f"Fallidos: {failed}/{len(tests)}")
    
    if failed == 0:
        print("\n*** TODOS LOS TESTS PASARON ***")
        return 0
    else:
        print(f"\n*** {failed} TESTS FALLARON ***")
        return 1


if __name__ == "__main__":
    import sys
    sys.exit(run_all_tests())
