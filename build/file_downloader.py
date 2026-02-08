"""
Sistema de descarga de archivos con soporte de resume (HTTP Range).

Diseñado para ser inyectable/mockeable en tests.
"""

import hashlib
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional, Callable
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


class FileDownloader(ABC):
    """Interfaz abstracta para downloaders (permite mocking en tests)."""
    
    @abstractmethod
    def download(
        self,
        url: str,
        target_path: Path,
        expected_sha256: Optional[str] = None,
        resume: bool = True,
        progress_callback: Optional[Callable[[int, int], None]] = None
    ) -> bool:
        """
        Descarga un archivo desde URL.
        
        Args:
            url: URL del archivo
            target_path: Ruta destino
            expected_sha256: Hash esperado (verifica después de descargar)
            resume: Si True, intenta resumir descarga parcial
            progress_callback: callback(bytes_downloaded, total_bytes)
        
        Returns:
            True si exitoso, False si falla
        """
        pass


class HTTPDownloader(FileDownloader):
    """
    Downloader real con soporte de HTTP Range (resume).
    """
    
    def __init__(self, chunk_size: int = 8 * 1024 * 1024):
        """
        Args:
            chunk_size: Tamaño de bloque para descarga (default 8MB)
        """
        self.chunk_size = chunk_size
    
    def download(
        self,
        url: str,
        target_path: Path,
        expected_sha256: Optional[str] = None,
        resume: bool = True,
        progress_callback: Optional[Callable[[int, int], None]] = None
    ) -> bool:
        """
        Descarga archivo con soporte de resume.
        """
        try:
            # Crear directorio padre
            target_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Verificar si hay descarga parcial
            bytes_downloaded = 0
            if resume and target_path.exists():
                bytes_downloaded = target_path.stat().st_size
            
            # Construir request con Range header si hay descarga parcial
            headers = {}
            mode = 'wb'
            
            if bytes_downloaded > 0:
                headers['Range'] = f'bytes={bytes_downloaded}-'
                mode = 'ab'  # Append mode
            
            request = Request(url, headers=headers)
            
            # Abrir conexión
            with urlopen(request, timeout=30) as response:
                # Obtener tamaño total
                total_size = int(response.headers.get('Content-Length', 0))
                
                # Si server no soporta Range, empezar desde cero
                if response.status == 200 and bytes_downloaded > 0:
                    # Server no soportó Range, empezar de nuevo
                    bytes_downloaded = 0
                    mode = 'wb'
                
                # Calcular tamaño final esperado
                if response.status == 206:  # Partial Content
                    # Server soportó Range
                    expected_total = bytes_downloaded + total_size
                else:
                    expected_total = total_size
                
                # Descargar por chunks con hash incremental
                h = hashlib.sha256()
                
                # Si resumimos, hash el contenido existente primero
                if mode == 'ab' and bytes_downloaded > 0:
                    with target_path.open('rb') as f:
                        for chunk in iter(lambda: f.read(self.chunk_size), b""):
                            h.update(chunk)
                
                with target_path.open(mode) as f:
                    while True:
                        chunk = response.read(self.chunk_size)
                        if not chunk:
                            break
                        
                        f.write(chunk)
                        h.update(chunk)
                        bytes_downloaded += len(chunk)
                        
                        # Callback de progreso
                        if progress_callback:
                            progress_callback(bytes_downloaded, expected_total)
            
            # Verificar hash si se proporciona
            if expected_sha256:
                actual_sha256 = h.hexdigest()
                if actual_sha256 != expected_sha256:
                    print(f"[downloader] ERROR: Hash mismatch")
                    print(f"  Esperado: {expected_sha256}")
                    print(f"  Obtenido: {actual_sha256}")
                    target_path.unlink()  # Borrar archivo corrupto
                    return False
            
            return True
        
        except (URLError, HTTPError) as e:
            print(f"[downloader] ERROR descargando {url}: {e}")
            return False
        except Exception as e:
            print(f"[downloader] ERROR inesperado: {e}")
            return False


class MockDownloader(FileDownloader):
    """
    Mock downloader para tests (sin red).
    
    Lee archivos desde un directorio de fixtures locales.
    """
    
    def __init__(self, fixtures_dir: Path):
        """
        Args:
            fixtures_dir: Directorio con archivos de prueba
        """
        self.fixtures_dir = fixtures_dir
    
    def download(
        self,
        url: str,
        target_path: Path,
        expected_sha256: Optional[str] = None,
        resume: bool = True,
        progress_callback: Optional[Callable[[int, int], None]] = None
    ) -> bool:
        """
        "Descarga" copiando desde fixtures locales.
        """
        try:
            # Extraer nombre de archivo de URL
            filename = url.split('/')[-1]
            fixture_path = self.fixtures_dir / filename
            
            if not fixture_path.exists():
                print(f"[mock] Fixture no encontrado: {fixture_path}")
                return False
            
            # Crear directorio destino
            target_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Copiar archivo
            import shutil
            shutil.copy2(fixture_path, target_path)
            
            # Verificar hash si se proporciona
            if expected_sha256:
                h = hashlib.sha256()
                with target_path.open('rb') as f:
                    for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
                        h.update(chunk)
                
                actual_sha256 = h.hexdigest()
                if actual_sha256 != expected_sha256:
                    print(f"[mock] Hash mismatch: {filename}")
                    target_path.unlink()
                    return False
            
            return True
        
        except Exception as e:
            print(f"[mock] ERROR: {e}")
            return False


def create_downloader(mock: bool = False, fixtures_dir: Optional[Path] = None) -> FileDownloader:
    """
    Factory para crear downloader apropiado.
    
    Args:
        mock: Si True, usa MockDownloader (para tests)
        fixtures_dir: Directorio de fixtures (requerido si mock=True)
    
    Returns:
        FileDownloader instance
    """
    if mock:
        if fixtures_dir is None:
            raise ValueError("fixtures_dir requerido para MockDownloader")
        return MockDownloader(fixtures_dir)
    else:
        return HTTPDownloader()
