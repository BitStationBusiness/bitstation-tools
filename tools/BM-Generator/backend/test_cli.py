import json
import subprocess
import os
from pathlib import Path

TOOL_DIR = Path(__file__).parent.parent
RUNNER = TOOL_DIR / "runner" / "run.ps1"
AUDIO_FILE = TOOL_DIR / "backend" / "test_audio.wav"
INPUT_JSON = TOOL_DIR / "backend" / "test_input.json"
OUTPUT_JSON = TOOL_DIR / "backend" / "test_output.json"


def run_powershell(script_path, input_path, output_path):
    cmd = [
        "powershell", "-ExecutionPolicy", "Bypass",
        "-File", str(script_path),
        "-InPath", str(input_path),
        "-OutPath", str(output_path),
    ]
    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    print("STDOUT:", result.stdout)
    if result.stderr:
        print("STDERR:", result.stderr)
    return result.returncode


def read_output():
    try:
        with open(OUTPUT_JSON, "r") as f:
            res = json.load(f)
        print("Result:", json.dumps(res, indent=2))
        return res
    except Exception as e:
        print(f"Failed to read output: {e}")
        return None


def test_analyze():
    print("\n=== Testing action=analyze ===")
    data = {"action": "analyze", "files": [str(AUDIO_FILE.resolve())]}
    with open(INPUT_JSON, "w") as f:
        json.dump(data, f)
    if OUTPUT_JSON.exists():
        OUTPUT_JSON.unlink()

    code = run_powershell(RUNNER, INPUT_JSON, OUTPUT_JSON)
    if code != 0:
        print(f"FAILED: exit code {code}")
        return False

    res = read_output()
    if not res:
        return False
    if res.get("ok") and len(res.get("analyzed_songs", [])) > 0:
        print("PASSED: analyze returned songs")
        return True
    print("FAILED: analyze did not return songs")
    return False


def test_demucs_split():
    print("\n=== Testing action=demucs_split ===")
    data = {
        "action": "demucs_split",
        "tracks": [
            {
                "file": str(AUDIO_FILE.resolve()),
                "track_number": 1,
                "title": "Test Track",
            }
        ],
        "output_dir": str((TOOL_DIR / "output").resolve()),
    }
    with open(INPUT_JSON, "w") as f:
        json.dump(data, f)
    if OUTPUT_JSON.exists():
        OUTPUT_JSON.unlink()

    code = run_powershell(RUNNER, INPUT_JSON, OUTPUT_JSON)
    res = read_output()
    if not res:
        return False

    demucs = res.get("demucs", {})
    tracks = demucs.get("tracks", [])
    if tracks and tracks[0].get("status") == "done":
        print("PASSED: demucs_split produced stems")
        return True
    print(f"NOTE: demucs_split status={tracks[0].get('status') if tracks else 'no tracks'}")
    return False


def test_build():
    print("\n=== Testing action=build_bm ===")
    song_meta = {
        "filename": "test_audio.wav",
        "title": "CLI Test Song",
        "artist": "CLI Artist",
        "album": "CLI Album",
        "year": "2024",
        "genre": "Test",
        "duration": 3.0,
        "duration_ms": 3000,
        "track_number": "1",
        "disc_number": "1/1",
        "format": "wav",
        "quality": "CD",
        "path": str(AUDIO_FILE.resolve()),
        "sha256": "",
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
        "cover_image_path": None,
    }

    data = {"action": "build_bm", "album_data": album_data}
    with open(INPUT_JSON, "w") as f:
        json.dump(data, f)
    if OUTPUT_JSON.exists():
        OUTPUT_JSON.unlink()

    code = run_powershell(RUNNER, INPUT_JSON, OUTPUT_JSON)
    res = read_output()
    if not res:
        return False

    bm_path = res.get("bm_file_path") or res.get("bm_path")
    if bm_path and os.path.exists(bm_path):
        print(f"PASSED: .bm file created at {bm_path}")
        return True
    print("FAILED: .bm file not found")
    return False


if __name__ == "__main__":
    dummy_script = TOOL_DIR / "backend" / "create_dummy_wav.py"
    if dummy_script.exists() and not AUDIO_FILE.exists():
        subprocess.run(["python", str(dummy_script), str(AUDIO_FILE)])

    results = {}
    results["analyze"] = test_analyze()

    if results["analyze"]:
        results["build_bm"] = test_build()
    else:
        print("\nSkipping build test due to analyze failure")

    print("\n=== Summary ===")
    for k, v in results.items():
        print(f"  {k}: {'PASS' if v else 'FAIL'}")
