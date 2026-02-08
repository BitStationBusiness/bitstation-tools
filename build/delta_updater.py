"""
Sistema de actualización diferencial para BitStation Tools.
Implementa actualización basada en manifiestos con verificación de hash y activación atómica.

CHECKPOINT WORKER-UPDATE-DELTA-1:
El updater reporta estadísticas detalladas: archivos descargados, verificados, eliminados.
"""

import hashlib
import json
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.request import urlretrieve, urlopen
from urllib.error import URLError, HTTPError

# Importar downloader inyectable
try:
    from file_downloader import FileDownloader, HTTPDownloader
except ImportError:
    # Fallback si se ejecuta standalone
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from file_downloader import FileDownloader, HTTPDownloader


@dataclass
class UpdateStats:
    """Estadísticas de actualización (CHECKPOINT WORKER-UPDATE-DELTA-1)."""
    files_downloaded: int = 0
    files_verified: int = 0
    files_deleted: int = 0
    files_skipped: int = 0
    bytes_downloaded: int = 0
    errors: List[str] = field(default_factory=list)
    
    def report(self) -> str:
        """Genera reporte legible de la actualización."""
        lines = [
            "========================================================",
            "  REPORTE DE ACTUALIZACION DIFERENCIAL",
            "========================================================",
            f"  [DL]  Archivos descargados:  {self.files_downloaded}",
            f"  [OK]  Archivos verificados:  {self.files_verified}",
            f"  [DEL] Archivos eliminados:   {self.files_deleted}",
            f"  [SKIP] Archivos sin cambios:  {self.files_skipped}",
            f"  [DATA] Datos descargados:     {self._format_bytes(self.bytes_downloaded)}",
        ]
        
        if self.errors:
            lines.append(f"  [WARN] Errores:               {len(self.errors)}")
            for err in self.errors[:3]:  # Mostrar solo primeros 3
                lines.append(f"     - {err}")
        
        lines.append("═══════════════════════════════════════════════════════")
        return "\n".join(lines)
    
    @staticmethod
    def _format_bytes(size: int) -> str:
        """Formatea bytes en unidades legibles."""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024.0:
                return f"{size:.2f} {unit}"
            size /= 1024.0
        return f"{size:.2f} TB"


@dataclass
class FileStatus:
    """Estado de un archivo en el proceso de actualización."""
    path: str
    status: str  # 'download', 'verify', 'skip', 'delete'
    current_hash: Optional[str] = None
    target_hash: Optional[str] = None
    size: int = 0


class DeltaUpdater:
    """
    Updater diferencial basado en manifiestos.
    
    Estructura de carpetas:
    tools/<tool_id>/
      releases/
        v2.4.1/           (release activo)
          manifest.json
          payload/        (archivos de la tool)
        .staging/         (área temporal para nuevas releases)
      current.txt         (apunta a la versión activa, ej: "v2.4.1")
      venv/               (NO se toca)
      cache/              (NO se toca)
      user_data/          (NO se toca)
      logs/               (NO se toca)
    """
    
    PROTECTED_DIRS = {"venv", ".venv", "cache", "user_data", "logs"}
    
    def __init__(self, tool_root: Path, downloader: Optional[FileDownloader] = None):
        """
        Args:
            tool_root: Raíz de la tool
            downloader: Downloader inyectable (si None, usa HTTPDownloader por default)
        """
        self.tool_root = tool_root
        self.releases_dir = tool_root / "releases"
        self.staging_dir = self.releases_dir / ".staging"
        self.current_file = tool_root / "current.txt"
        self.downloader = downloader or HTTPDownloader()
        
    def get_current_version(self) -> Optional[str]:
        """Obtiene la versión actualmente instalada."""
        if not self.current_file.exists():
            return None
        return self.current_file.read_text(encoding="utf-8").strip()
    
    def get_current_manifest(self) -> Optional[Dict]:
        """Carga el manifiesto de la versión actual."""
        current_ver = self.get_current_version()
        if not current_ver:
            return None
        
        manifest_path = self.releases_dir / current_ver / "manifest.json"
        if not manifest_path.exists():
            return None
        
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    
    def sha256_file(self, path: Path) -> str:
        """Calcula SHA256 de un archivo."""
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    
    def compute_diff(self, current_manifest: Optional[Dict], target_manifest: Dict) -> List[FileStatus]:
        """
        Calcula diferencias entre versión actual y objetivo.
        Retorna lista de FileStatus indicando qué hacer con cada archivo.
        """
        diff = []
        
        # Crear índice de archivos actuales
        current_files = {}
        if current_manifest:
            for f in current_manifest.get("files", []):
                current_files[f["path"]] = f["sha256"]
        
        # Analizar archivos del target
        for target_file in target_manifest.get("files", []):
            path = target_file["path"]
            target_hash = target_file["sha256"]
            size = target_file["size"]
            
            if path in current_files:
                if current_files[path] == target_hash:
                    # Archivo sin cambios
                    diff.append(FileStatus(
                        path=path,
                        status="skip",
                        current_hash=current_files[path],
                        target_hash=target_hash,
                        size=size
                    ))
                else:
                    # Archivo modificado
                    diff.append(FileStatus(
                        path=path,
                        status="download",
                        current_hash=current_files[path],
                        target_hash=target_hash,
                        size=size
                    ))
            else:
                # Archivo nuevo
                diff.append(FileStatus(
                    path=path,
                    status="download",
                    target_hash=target_hash,
                    size=size
                ))
        
        # Archivos a eliminar (existen en current pero no en target)
        if current_manifest:
            target_paths = {f["path"] for f in target_manifest.get("files", [])}
            for current_file in current_manifest.get("files", []):
                path = current_file["path"]
                if path not in target_paths:
                    diff.append(FileStatus(
                        path=path,
                        status="delete",
                        current_hash=current_file["sha256"]
                    ))
        
        return diff
    
    def download_file_from_url(
        self,
        url: str,
        target_path: Path,
        expected_sha256: Optional[str] = None,
        expected_size: Optional[int] = None
    ) -> bool:
        """
        Descarga un archivo individual desde una URL usando el downloader inyectable.
        
        Args:
            url: URL del archivo
            target_path: Ruta destino
            expected_sha256: Hash esperado (para verificación)
            expected_size: Tamaño esperado (para progreso)
        
        Returns:
            True si exitoso, False si falla
        """
        # Progress callback
        def progress(downloaded: int, total: int):
            if total > 0:
                pct = (downloaded / total) * 100
                if downloaded == total:
                    print(f"[updater]     {target_path.name}: 100% ({downloaded} bytes)")
        
        # Usar downloader inyectable (con resume support)
        return self.downloader.download(
            url=url,
            target_path=target_path,
            expected_sha256=expected_sha256,
            resume=True,  # Siempre intentar resume
            progress_callback=progress if expected_size and expected_size > 10*1024*1024 else None
        )
    
    def download_from_zip(self, zip_path: Path, target_dir: Path, file_list: List[str]) -> int:
        """
        Extrae archivos específicos de un ZIP a un directorio.
        Retorna número de archivos extraídos.
        
        NOTA: Este método es fallback para modo ZIP. El modo preferido
        es descargar archivos individuales desde URLs.
        """
        extracted = 0
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for file_path in file_list:
                try:
                    # Extraer archivo
                    zf.extract(file_path, target_dir)
                    extracted += 1
                except KeyError:
                    print(f"[updater] WARN: {file_path} no encontrado en ZIP")
        
        return extracted
    
    def verify_file(self, path: Path, expected_hash: str) -> bool:
        """Verifica que el hash de un archivo coincida con el esperado."""
        if not path.exists():
            return False
        actual_hash = self.sha256_file(path)
        return actual_hash == expected_hash
    
    def update_from_zip(self, zip_path: Path, target_manifest: Dict) -> UpdateStats:
        """
        Actualiza la tool desde un ZIP usando el manifiesto objetivo.
        Implementa actualización diferencial con staging y activación atómica.
        
        CHECKPOINT WORKER-UPDATE-DELTA-1: Retorna estadísticas detalladas.
        """
        stats = UpdateStats()
        
        tool_id = target_manifest["tool_id"]
        target_version = target_manifest["tool_version"]
        
        print(f"\n[updater] Iniciando actualización diferencial")
        print(f"[updater] Tool: {tool_id}")
        print(f"[updater] Versión objetivo: {target_version}")
        
        # Obtener manifiesto actual
        current_manifest = self.get_current_manifest()
        current_version = self.get_current_version() or "ninguna"
        print(f"[updater] Versión actual: {current_version}")
        
        # Calcular diff
        print(f"[updater] Calculando diferencias...")
        diff = self.compute_diff(current_manifest, target_manifest)
        
        to_download = [f for f in diff if f.status == "download"]
        to_skip = [f for f in diff if f.status == "skip"]
        to_delete = [f for f in diff if f.status == "delete"]
        
        print(f"[updater]   Archivos a descargar: {len(to_download)}")
        print(f"[updater]   Archivos sin cambios: {len(to_skip)}")
        print(f"[updater]   Archivos a eliminar: {len(to_delete)}")
        
        # Crear staging directory
        staging_release = self.staging_dir / f"v{target_version}"
        if staging_release.exists():
            shutil.rmtree(staging_release)
        staging_release.mkdir(parents=True, exist_ok=True)
        
        print(f"[updater] Staging: {staging_release}")
        
        try:
            # FASE 1: Descargar archivos necesarios a staging
            print(f"\n[updater] FASE 1: Descarga de archivos individuales")
            
            if to_download:
                # Intentar descarga individual desde URLs si están disponibles
                use_individual_urls = all(
                    any(f.get("url") for f in target_manifest.get("files", []) if f["path"] == status.path)
                    for status in to_download
                )
                
                if use_individual_urls:
                    print(f"[updater]   Modo: Descarga individual por URL (delta update real)")
                    downloaded = 0
                    for status in to_download:
                        # Buscar URL del archivo en manifest
                        file_info = next(
                            (f for f in target_manifest["files"] if f["path"] == status.path),
                            None
                        )
                        
                        if file_info and file_info.get("url"):
                            target_path = staging_release / status.path
                            # Descargar con verificación de hash y resume support
                            if self.download_file_from_url(
                                file_info["url"],
                                target_path,
                                expected_sha256=file_info.get("sha256"),
                                expected_size=file_info.get("size")
                            ):
                                downloaded += 1
                                stats.bytes_downloaded += status.size
                            else:
                                stats.errors.append(f"No se pudo descargar: {status.path}")
                        else:
                            stats.errors.append(f"Sin URL para: {status.path}")
                    
                    stats.files_downloaded = downloaded
                    print(f"[updater]   [OK] {downloaded} archivos descargados individualmente")
                
                else:
                    # Fallback: extraer desde ZIP
                    print(f"[updater]   Modo: Extracción desde ZIP (fallback)")
                    files_to_extract = [f.path for f in to_download]
                    extracted = self.download_from_zip(zip_path, staging_release, files_to_extract)
                    stats.files_downloaded = extracted
                    stats.bytes_downloaded = sum(f.size for f in to_download)
                    print(f"[updater]   [OK] {extracted} archivos extraidos del ZIP")
            
            # FASE 2: Copiar archivos sin cambios desde current
            print(f"\n[updater] FASE 2: Verificación de archivos sin cambios")
            
            if current_manifest and to_skip:
                current_version = self.get_current_version()
                current_release_dir = self.releases_dir / current_version
                
                for file_status in to_skip:
                    src = current_release_dir / file_status.path
                    dst = staging_release / file_status.path
                    
                    if src.exists():
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(src, dst)
                        stats.files_skipped += 1
                
                print(f"[updater]   [OK] {stats.files_skipped} archivos copiados desde version actual")
            
            # FASE 3: Verificar todos los archivos en staging
            print(f"\n[updater] FASE 3: Verificación de integridad")
            
            verification_failed = []
            for target_file in target_manifest["files"]:
                file_path = staging_release / target_file["path"]
                expected_hash = target_file["sha256"]
                
                if self.verify_file(file_path, expected_hash):
                    stats.files_verified += 1
                else:
                    error_msg = f"Verificación fallida: {target_file['path']}"
                    verification_failed.append(error_msg)
                    stats.errors.append(error_msg)
            
            if verification_failed:
                print(f"[updater]   [FAIL] {len(verification_failed)} archivos fallaron verificacion")
                for err in verification_failed[:5]:
                    print(f"[updater]     - {err}")
                raise RuntimeError("Verificacion de integridad fallida")
            
            print(f"[updater]   [OK] {stats.files_verified} archivos verificados correctamente")
            
            # FASE 4: Guardar manifiesto en staging
            manifest_path = staging_release / "manifest.json"
            manifest_path.write_text(
                json.dumps(target_manifest, ensure_ascii=False, indent=2),
                encoding="utf-8"
            )
            
            # FASE 5: Activación atómica
            print(f"\n[updater] FASE 4: Activación atómica")
            
            final_release_dir = self.releases_dir / f"v{target_version}"
            if final_release_dir.exists():
                shutil.rmtree(final_release_dir)
            
            shutil.move(str(staging_release), str(final_release_dir))
            
            # Actualizar current.txt
            self.current_file.write_text(f"v{target_version}", encoding="utf-8")
            
            print(f"[updater]   [OK] Release activado: v{target_version}")
            
            # FASE 6: Limpieza segura
            print(f"\n[updater] FASE 5: Limpieza de archivos obsoletos")
            
            if to_delete and current_version != "ninguna":
                # Solo eliminar si hay versión anterior
                old_release_dir = self.releases_dir / current_version
                
                # Eliminar release anterior completo (seguro porque está en releases/)
                if old_release_dir.exists():
                    shutil.rmtree(old_release_dir)
                    stats.files_deleted = len(to_delete)
                    print(f"[updater]   [OK] Release anterior eliminado: {current_version}")
            
            # Limpiar staging
            if self.staging_dir.exists():
                shutil.rmtree(self.staging_dir)
            
            print(f"\n[updater] [OK] Actualizacion completada exitosamente")
            
            # Verificar manifest_hash final
            final_manifest = json.loads((final_release_dir / "manifest.json").read_text(encoding="utf-8"))
            if final_manifest["manifest_hash"] == target_manifest["manifest_hash"]:
                print(f"[updater] [OK] manifest_hash verificado: {final_manifest['manifest_hash'][:16]}...")
            else:
                stats.errors.append("manifest_hash no coincide con el requerido")
            
            return stats
            
        except Exception as e:
            stats.errors.append(str(e))
            print(f"\n[updater] [FAIL] ERROR: {e}")
            
            # Rollback: eliminar staging
            if staging_release.exists():
                shutil.rmtree(staging_release)
            
            raise
    
    def flash_gpu(self) -> bool:
        """
        Ejecuta operación Flash GPU (warmup local).
        No requiere versión de red sincronizada.
        """
        current_manifest = self.get_current_manifest()
        
        if not current_manifest:
            print("[updater] Flash GPU: No hay versión instalada")
            return False
        
        flash_config = current_manifest.get("flash_gpu_config", {})
        
        if not flash_config.get("enabled"):
            print("[updater] Flash GPU: No soportado por esta tool")
            return False
        
        print(f"[updater] Flash GPU: Iniciando warmup...")
        
        # TODO: Implementar lógica de warmup real
        # - Validar CUDA/DirectML
        # - Cargar modelos
        # - Compilar kernels
        # - Cachear artefactos
        
        print(f"[updater] Flash GPU: [OK] Completado (stub)")
        return True
    
    def get_network_eligibility(self, required_version: str, required_hash: str) -> str:
        """
        Determina si el worker es elegible para trabajos de red.
        
        Retorna:
        - "ELIGIBLE": versión y hash coinciden
        - "OUTDATED": versión/hash no coinciden
        - "NO_INSTALLATION": no hay versión instalada
        """
        current_manifest = self.get_current_manifest()
        
        if not current_manifest:
            return "NO_INSTALLATION"
        
        current_version = current_manifest["tool_version"]
        current_hash = current_manifest["manifest_hash"]
        
        if current_version == required_version and current_hash == required_hash:
            return "ELIGIBLE"
        else:
            return "OUTDATED"


def main() -> int:
    """
    Ejemplo de uso del DeltaUpdater.
    """
    import sys
    
    if len(sys.argv) < 3:
        print("Uso: python delta_updater.py <tool_root> <zip_path>")
        print("\nEjemplo:")
        print("  python delta_updater.py D:/Tools/z-image-turbo tool_z-image-turbo_0.5.2.zip")
        return 1
    
    tool_root = Path(sys.argv[1])
    zip_path = Path(sys.argv[2])
    
    if not tool_root.exists():
        print(f"Error: {tool_root} no existe")
        return 1
    
    if not zip_path.exists():
        print(f"Error: {zip_path} no existe")
        return 1
    
    # Extraer manifiesto del ZIP
    with zipfile.ZipFile(zip_path, 'r') as zf:
        manifest_data = zf.read("manifest.json")
        target_manifest = json.loads(manifest_data.decode('utf-8'))
    
    # Ejecutar actualización
    updater = DeltaUpdater(tool_root)
    stats = updater.update_from_zip(zip_path, target_manifest)
    
    # Mostrar reporte (CHECKPOINT WORKER-UPDATE-DELTA-1)
    print("\n" + stats.report())
    
    # Verificar elegibilidad de red
    eligibility = updater.get_network_eligibility(
        target_manifest["tool_version"],
        target_manifest["manifest_hash"]
    )
    print(f"\n[updater] Estado de red: {eligibility}")
    
    return 0 if not stats.errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
