import subprocess
import json
import time
import sys
import os

def benchmark():
    # Comando para iniciar la tool en modo persistente
    cmd = [sys.executable, "src/main.py", "--persistent"]
    
    print(f"Iniciando proceso: {' '.join(cmd)}")
    process = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,  # Dejar pasar logs a stderr
        text=True,
        bufsize=1  # Line buffered
    )

    try:
        # Esperar señal de ready
        print("Esperando ready signal...")
        while True:
            line = process.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
                if msg.get("status") == "ready":
                    print("Tool lista!")
                    break
            except json.JSONDecodeError:
                continue

        # Enviar job
        prompt = "un ferrari rojo futurista a toda velocidad en una ciudad cyberpunk, 8k, photorealistic"
        job = {"prompt": prompt, "size": "S"}
        job_str = json.dumps(job) + "\n"
        
        print(f"\nEnviando job: {prompt[:50]}...")
        start_time = time.time()
        
        process.stdin.write(job_str)
        process.stdin.flush()
        
        # Esperar respuesta
        print("Esperando respuesta...")
        response_line = process.stdout.readline()
        end_time = time.time()
        
        duration = end_time - start_time
        print(f"\nRespuesta recibida en {duration:.4f} segundos")
        print(f"Respuesta raw: {response_line.strip()}")
        
        try:
            response = json.loads(response_line)
            if response.get("ok"):
                print("SUCCESS: Imagen generada correctamente")
                print(f"Path: {response.get('image_path')}")
                if "generation_time_ms" in response:
                    print(f"Gen time (interno): {response['generation_time_ms']} ms")
            else:
                print(f"ERROR: {response.get('error')}")
        except json.JSONDecodeError:
            print("ERROR: Respuesta no es JSON válido")

    except Exception as e:
        print(f"Excepción: {e}")
    finally:
        print("\nCerrando tool...")
        if process.stdin:
            process.stdin.close()
        process.wait()

if __name__ == "__main__":
    benchmark()
