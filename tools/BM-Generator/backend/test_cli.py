import json
import subprocess
import os
import sys
from pathlib import Path

# Paths
TOOL_DIR = Path(__file__).parent.parent
RUNNER = TOOL_DIR / "runner" / "run.ps1"
AUDIO_FILE = TOOL_DIR / "backend" / "test_audio.wav"
INPUT_JSON = TOOL_DIR / "backend" / "test_input.json"
OUTPUT_JSON = TOOL_DIR / "backend" / "test_output.json"

def run_powershell(script_path, input_path, output_path):
    cmd = ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script_path), "--input", str(input_path), "--output", str(output_path)]
    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    print("STDOUT:", result.stdout)
    print("STDERR:", result.stderr)
    return result.returncode

def test_analyze():
    print("\n--- Testing Analyze Action ---")
    data = {
        "action": "analyze",
        "files": [str(AUDIO_FILE.resolve())]
    }
    with open(INPUT_JSON, "w") as f:
        json.dump(data, f)
    
    if OUTPUT_JSON.exists(): OUTPUT_JSON.unlink()

    code = run_powershell(RUNNER, INPUT_JSON, OUTPUT_JSON)
    if code != 0:
        print("Analyze failed with code", code)
        return False
    
    try:
        with open(OUTPUT_JSON, "r") as f:
            res = json.load(f)
        print("Result:", json.dumps(res, indent=2))
        return res.get("ok") and len(res.get("analyzed_songs", [])) > 0
    except Exception as e:
        print(f"Failed to read output: {e}")
        return False

def test_build():
    print("\n--- Testing Build Action ---")
    # Read metadata from previous step or create dummy
    song_meta = {
        "filename": "test_audio.wav",
        "title": "CLI Test Song",
        "artist": "CLI Artist",
        "album": "CLI Album",
        "year": "2024",
        "genre": "Test",
        "duration": 3.0,
        "track_number": "1",
        "disc_number": "1/1",
        "format": "wav",
        "quality": "CD",
        "path": str(AUDIO_FILE.resolve())
    }

    album_data = {
        "album_artist": "CLI Artist",
        "album_name": "CLI Album",
        "year": "2024",
        "genre": "Test",
        "release_date": "2024-01-01",
        "total_tracks": 1,
        "total_discs": 1,
        "songs": [song_meta],
        "cover_image_path": None
    }

    data = {
        "action": "build",
        "album_data": album_data
    }
    
    with open(INPUT_JSON, "w") as f:
        json.dump(data, f)
    
    if OUTPUT_JSON.exists(): OUTPUT_JSON.unlink()

    code = run_powershell(RUNNER, INPUT_JSON, OUTPUT_JSON)
    if code != 0:
        print("Build failed with code", code)
        return False
    
    try:
        with open(OUTPUT_JSON, "r") as f:
            res = json.load(f)
        print("Result:", json.dumps(res, indent=2))
        bm_path = res.get("bm_file_path")
        if bm_path and os.path.exists(bm_path):
            print(f"Confirmed BM file exists: {bm_path}")
            return True
        else:
            print("BM file path missing or invalid")
            return False
    except Exception as e:
        print(f"Failed to read output: {e}")
        return False

if __name__ == "__main__":
    # Create dummy audio first
    subprocess.run(["python", str(TOOL_DIR / "backend" / "create_dummy_wav.py"), str(AUDIO_FILE)])
    
    if test_analyze():
        test_build()
    else:
        print("Skipping build test due to analyze failure")
