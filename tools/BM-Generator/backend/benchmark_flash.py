import subprocess
import json
import time
import os
import sys
from pathlib import Path

# Config
TOOL_DIR = Path(__file__).parent
RUNNER = TOOL_DIR.parent / "runner" / "run.ps1"
DEMO_FILE = TOOL_DIR.parent / "demo.flac"
PYTHON_EXE = TOOL_DIR.parent / ".venv" / "Scripts" / "python.exe"
CLI_SCRIPT = TOOL_DIR / "cli.py"

INPUT_JSON = TOOL_DIR / "bench_input.json"
OUTPUT_JSON = TOOL_DIR / "bench_output.json"

if not DEMO_FILE.exists():
    # If demo file doesn't exist, create a dummy one
    print(f"Demo file {DEMO_FILE} not found. Creating dummy.")
    import create_dummy_wav
    create_dummy_wav.create_dummy_wav(str(DEMO_FILE), duration=10.0)

def prepare_album_data():
    return {
        "album_artist": "Bench Artist",
        "album_name": "Bench Album",
        "year": "2024",
        "genre": "Bench",
        "release_date": "2024-01-01",
        "total_tracks": 1,
        "total_discs": 1,
        "songs": [{
            "filename": DEMO_FILE.name,
            "title": "Bench Song",
            "artist": "Bench Artist",
            "album": "Bench Album",
            "year": "2024",
            "genre": "Bench",
            "duration": 10.0,
            "track_number": "1",
            "disc_number": "1/1",
            "format": "flac",
            "quality": "CD",
            "path": str(DEMO_FILE.resolve())
        }],
        "cover_image_path": None
    }

def run_normal_mode(mode_name="Normal"):
    print(f"\n--- Running {mode_name} ---")
    data = {
        "action": "build",
        "album_data": prepare_album_data()
    }
    with open(INPUT_JSON, "w") as f:
        json.dump(data, f)
    
    if OUTPUT_JSON.exists(): OUTPUT_JSON.unlink()
    
    start_time = time.time()
    # We call the CLI directly with python to better control env vars if needed (like forcing CPU)
    # But usually CPU mode is forced by hiding CUDA.
    
    env = os.environ.copy()
    if mode_name == "CPU":
        env["CUDA_VISIBLE_DEVICES"] = ""
    
    cmd = [str(PYTHON_EXE), str(CLI_SCRIPT), "--input", str(INPUT_JSON), "--output", str(OUTPUT_JSON)]
    result = subprocess.run(cmd, env=env, check=False, capture_output=True, text=True) # Don't check=True yet
    
    end_time = time.time()
    duration = end_time - start_time
    
    if result.returncode != 0:
        print(f"{mode_name} process failed with code {result.returncode}")
        print("STDOUT:", result.stdout)
        print("STDERR:", result.stderr)
        return 0
        
    try:
        with open(OUTPUT_JSON, "r") as f:
            res_json = json.load(f)
        if not res_json.get("ok"):
             print(f"{mode_name} logic failed: {res_json.get('error')}")
             # Print stderr to debug
             print("STDERR:", result.stderr)
             return 0
    except Exception as e:
        print(f"Failed to read output json: {e}")
        print("STDERR:", result.stderr)
        return 0

    print(f"Time: {duration:.2f}s")
    return duration

def run_flash_mode():
    print("\n--- Running GPU (Flash) ---")
    
    # Start process
    cmd = [str(PYTHON_EXE), str(CLI_SCRIPT), "--persistent"]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    
    # Wait for ready
    while True:
        line = proc.stdout.readline()
        if not line: break
        try:
            msg = json.loads(line)
            if msg.get("status") == "ready":
                print("Flash Worker Ready.")
                break
        except: pass
        
    start_time = time.time()
    
    # Send Job
    job = {
        "id": "bench_flash",
        "action": "build",
        "album_data": prepare_album_data()
    }
    proc.stdin.write(json.dumps(job) + "\n")
    proc.stdin.flush()
    
    # Wait for result
    while True:
        line = proc.stdout.readline()
        if not line: break
        try:
            res = json.loads(line)
            if res.get("id") == "bench_flash":
                print("Job Complete")
                break
        except: pass
    
    end_time = time.time()
    duration = end_time - start_time
    print(f"Time: {duration:.2f}s")
    
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except:
        proc.kill()
        
    return duration

def main():
    print("Starting Benchmark...")
    
    t_normal = run_normal_mode("GPU (Normal)")
    t_flash = run_flash_mode()
    t_cpu = run_normal_mode("CPU")
    
    print("\n=== Benchmark Results ===")
    print(f"GPU (Normal): {t_normal:.2f}s")
    print(f"GPU (Flash) : {t_flash:.2f}s")
    print(f"CPU         : {t_cpu:.2f}s")
    
    scale_flash = t_normal / t_flash if t_flash > 0 else 0
    scale_cpu = t_cpu / t_normal if t_normal > 0 else 0
    
    print(f"\nFlash is {scale_flash:.1f}x faster than Normal")
    print(f"CPU is {scale_cpu:.1f}x slower than GPU Normal")

if __name__ == "__main__":
    main()
