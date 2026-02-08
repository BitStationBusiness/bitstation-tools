"""
Ejemplo de integración del DeltaUpdater en un PCWorker.

Este script muestra cómo un worker puede:
1. Verificar su versión instalada
2. Actualizar a una nueva versión
3. Verificar elegibilidad para trabajos de red
4. Ejecutar Flash GPU
"""

import json
import sys
import zipfile
from pathlib import Path
from typing import Optional

# Importar el updater
sys.path.insert(0, str(Path(__file__).parent))
from delta_updater import DeltaUpdater, UpdateStats


class PCWorker:
    """
    Simulación simplificada de un PCWorker con actualización diferencial.
    """
    
    def __init__(self, tools_base: Path):
        """
        Args:
            tools_base: Directorio base donde están instaladas las tools
        """
        self.tools_base = tools_base
        self.updaters = {}  # {tool_id: DeltaUpdater}
    
    def get_updater(self, tool_id: str) -> DeltaUpdater:
        """Obtiene o crea un updater para una tool."""
        if tool_id not in self.updaters:
            tool_root = self.tools_base / tool_id
            tool_root.mkdir(parents=True, exist_ok=True)
            self.updaters[tool_id] = DeltaUpdater(tool_root)
        return self.updaters[tool_id]
    
    def check_tool_status(self, tool_id: str) -> dict:
        """
        Verifica el estado de una tool instalada.
        
        Returns:
            {
                "installed": bool,
                "version": str | None,
                "manifest_hash": str | None
            }
        """
        updater = self.get_updater(tool_id)
        manifest = updater.get_current_manifest()
        
        if not manifest:
            return {
                "installed": False,
                "version": None,
                "manifest_hash": None
            }
        
        return {
            "installed": True,
            "version": manifest["tool_version"],
            "manifest_hash": manifest["manifest_hash"]
        }
    
    def update_tool(self, tool_id: str, zip_path: Path) -> UpdateStats:
        """
        Actualiza una tool desde un ZIP.
        
        Args:
            tool_id: ID de la tool
            zip_path: Ruta al ZIP de la nueva versión
        
        Returns:
            UpdateStats con resultados de la actualización
        """
        print(f"\n{'='*60}")
        print(f"ACTUALIZANDO TOOL: {tool_id}")
        print(f"{'='*60}")
        
        # Extraer manifiesto del ZIP
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                manifest_data = zf.read("manifest.json")
                target_manifest = json.loads(manifest_data.decode('utf-8'))
            except KeyError:
                raise ValueError(f"ZIP no contiene manifest.json: {zip_path}")
        
        # Verificar que el tool_id coincide
        if target_manifest["tool_id"] != tool_id:
            raise ValueError(
                f"Tool ID mismatch: esperado={tool_id}, "
                f"manifest={target_manifest['tool_id']}"
            )
        
        # Ejecutar actualización diferencial
        updater = self.get_updater(tool_id)
        stats = updater.update_from_zip(zip_path, target_manifest)
        
        return stats
    
    def check_network_eligibility(
        self,
        tool_id: str,
        required_version: str,
        required_hash: str
    ) -> str:
        """
        Verifica si el worker es elegible para trabajos de red.
        
        Returns:
            "ELIGIBLE" | "OUTDATED" | "NO_INSTALLATION"
        """
        updater = self.get_updater(tool_id)
        return updater.get_network_eligibility(required_version, required_hash)
    
    def flash_gpu(self, tool_id: str) -> bool:
        """
        Ejecuta Flash GPU (warmup) para una tool.
        No requiere versión de red sincronizada.
        """
        print(f"\n{'='*60}")
        print(f"FLASH GPU: {tool_id}")
        print(f"{'='*60}")
        
        updater = self.get_updater(tool_id)
        return updater.flash_gpu()
    
    def report_status(self, tool_id: str):
        """Imprime reporte de estado de una tool."""
        print(f"\n{'='*60}")
        print(f"ESTADO DE TOOL: {tool_id}")
        print(f"{'='*60}")
        
        status = self.check_tool_status(tool_id)
        
        if status["installed"]:
            print(f"✓ Instalada")
            print(f"  Versión:       {status['version']}")
            print(f"  Manifest Hash: {status['manifest_hash'][:16]}...")
        else:
            print(f"✗ No instalada")
        
        print(f"{'='*60}")


def example_update_workflow():
    """
    Ejemplo de flujo completo de actualización.
    """
    # Configuración
    tools_base = Path("D:/BitStation/Tools")  # Ajustar según necesidad
    tool_id = "z-image-turbo"
    zip_path = Path("dist/tool_z-image-turbo_0.5.2.zip")  # Ajustar según necesidad
    
    # Crear worker
    worker = PCWorker(tools_base)
    
    # 1. Verificar estado inicial
    worker.report_status(tool_id)
    
    # 2. Actualizar tool
    if zip_path.exists():
        stats = worker.update_tool(tool_id, zip_path)
        
        # Mostrar reporte (CHECKPOINT WORKER-UPDATE-DELTA-1)
        print("\n" + stats.report())
    else:
        print(f"\n⚠️  ZIP no encontrado: {zip_path}")
        print(f"   Ejecuta primero: python build/pack_tools.py")
        return
    
    # 3. Verificar estado después de actualización
    worker.report_status(tool_id)
    
    # 4. Verificar elegibilidad para red
    status = worker.check_tool_status(tool_id)
    if status["installed"]:
        eligibility = worker.check_network_eligibility(
            tool_id,
            required_version=status["version"],
            required_hash=status["manifest_hash"]
        )
        print(f"\n🌐 Elegibilidad de Red: {eligibility}")
    
    # 5. Flash GPU (opcional)
    flash_success = worker.flash_gpu(tool_id)
    print(f"\n⚡ Flash GPU: {'✓ Exitoso' if flash_success else '✗ Fallido'}")


def example_version_mismatch_scenario():
    """
    Ejemplo: Worker con versión antigua, HQ requiere versión nueva.
    """
    tools_base = Path("D:/BitStation/Tools")
    tool_id = "z-image-turbo"
    
    worker = PCWorker(tools_base)
    
    # Simular que HQ requiere versión 0.5.2
    required_version = "0.5.2"
    required_hash = "a1b2c3d4e5f6789012345678901234567890123456789012345678901234"
    
    print(f"\n{'='*60}")
    print(f"ESCENARIO: Version Mismatch")
    print(f"{'='*60}")
    print(f"HQ requiere: v{required_version}")
    print(f"Hash requerido: {required_hash[:16]}...")
    
    eligibility = worker.check_network_eligibility(
        tool_id,
        required_version,
        required_hash
    )
    
    print(f"\nEstado: {eligibility}")
    
    if eligibility == "ELIGIBLE":
        print("✓ Worker puede aceptar trabajos de red")
    elif eligibility == "OUTDATED":
        print("⚠️  Worker está desactualizado")
        print("   Acción: Actualizar antes de aceptar trabajos de red")
        print("   Mientras tanto: Puede ejecutar trabajos locales")
    else:
        print("✗ No hay instalación")
        print("   Acción: Instalar tool antes de operar")


def main():
    """
    Punto de entrada principal.
    """
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Ejemplo de integración del DeltaUpdater en PCWorker"
    )
    parser.add_argument(
        "scenario",
        choices=["update", "mismatch"],
        help="Escenario a ejecutar: 'update' para flujo completo, 'mismatch' para demo de versión desactualizada"
    )
    
    args = parser.parse_args()
    
    if args.scenario == "update":
        example_update_workflow()
    elif args.scenario == "mismatch":
        example_version_mismatch_scenario()


if __name__ == "__main__":
    # Si se ejecuta sin argumentos, mostrar ambos ejemplos
    if len(sys.argv) == 1:
        print("="*60)
        print("EJEMPLO 1: Flujo Completo de Actualización")
        print("="*60)
        example_update_workflow()
        
        print("\n\n")
        
        print("="*60)
        print("EJEMPLO 2: Escenario de Version Mismatch")
        print("="*60)
        example_version_mismatch_scenario()
    else:
        main()
