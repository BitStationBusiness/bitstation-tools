"""
Benchmark para modo Flash con múltiples jobs consecutivos.
Mide el tiempo de cada job para verificar que el warmup acelera los siguientes.
"""
import subprocess
import json
import time
import sys

def benchmark_multi_job():
    cmd = [sys.executable, "src/main.py", "--persistent"]
    
    print("=" * 60)
    print("BENCHMARK MODO FLASH - MÚLTIPLES JOBS")
    print("=" * 60)
    print(f"\nIniciando proceso: {' '.join(cmd)}")
    
    process = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        text=True,
        bufsize=1
    )

    try:
        # Esperar señal de ready
        print("\n[1] Esperando que el modelo se cargue...")
        load_start = time.time()
        while True:
            line = process.stdout.readline()
            if not line:
                print("ERROR: Proceso terminó inesperadamente")
                return
            try:
                msg = json.loads(line)
                if msg.get("status") == "ready":
                    load_time = time.time() - load_start
                    print(f"[1] Modelo listo en {load_time:.2f}s")
                    break
            except json.JSONDecodeError:
                continue

        # Lista de prompts para probar (ASCII only para evitar encoding issues)
        prompts = [
            "a red ferrari in a cyberpunk city at night",
            "snowy mountains landscape at sunset",
            "humanoid robot in a futuristic laboratory",
        ]
        
        results = []
        
        print("\n" + "=" * 60)
        print("ENVIANDO JOBS...")
        print("=" * 60)
        
        for i, prompt in enumerate(prompts, 1):
            job = {"prompt": prompt, "size": "S"}
            job_str = json.dumps(job) + "\n"
            
            print(f"\n[Job {i}] Enviando: {prompt[:40]}...")
            start_time = time.time()
            
            process.stdin.write(job_str)
            process.stdin.flush()
            
            # Esperar respuesta
            response_line = process.stdout.readline()
            end_time = time.time()
            
            duration = end_time - start_time
            results.append(duration)
            
            try:
                response = json.loads(response_line)
                status = "✅ OK" if response.get("ok") else f"❌ ERROR: {response.get('error')}"
                gen_time = response.get("generation_time_ms", 0) / 1000
                print(f"[Job {i}] {status}")
                print(f"[Job {i}] Tiempo total: {duration:.2f}s (interno: {gen_time:.2f}s)")
            except json.JSONDecodeError:
                print(f"[Job {i}] ❌ Respuesta inválida")

        # Resumen
        print("\n" + "=" * 60)
        print("RESULTADOS")
        print("=" * 60)
        for i, t in enumerate(results, 1):
            print(f"  Job {i}: {t:.2f}s")
        
        if len(results) >= 2:
            speedup = (results[0] - results[1]) / results[0] * 100 if results[0] > 0 else 0
            print(f"\n  Mejora Job 2 vs Job 1: {speedup:.1f}%")
        
        if len(results) >= 3:
            avg_after_warmup = sum(results[1:]) / len(results[1:])
            print(f"  Promedio después de warmup: {avg_after_warmup:.2f}s")

    except Exception as e:
        print(f"Excepción: {e}")
        import traceback
        traceback.print_exc()
    finally:
        print("\nCerrando proceso...")
        if process.stdin:
            process.stdin.close()
        process.wait()
        print("Proceso terminado.")

if __name__ == "__main__":
    benchmark_multi_job()
