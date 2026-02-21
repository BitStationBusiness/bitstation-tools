import argparse
import json
import logging
import sys
import traceback
from pathlib import Path

sys.path.append(str(Path(__file__).parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
logger = logging.getLogger(__name__)


def preflight_check():
    """Verify critical imports before doing anything else."""
    errors = []
    for mod_name in ("pydantic", "mutagen"):
        try:
            __import__(mod_name)
        except ImportError as e:
            errors.append(f"{mod_name}: {e}")

    if errors:
        msg = "Preflight FAILED - missing critical packages:\n" + "\n".join(f"  - {e}" for e in errors)
        logger.critical(msg)
        logger.critical(f"Python executable: {sys.executable}")
        logger.critical(f"sys.path: {sys.path}")
        return False, msg
    return True, None


def _write_result(output_path: Path, result: dict):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)


def handle_analyze(data: dict) -> dict:
    from core.metadata_handler import extract_metadata

    files = data.get("files") or data.get("tracks") or []
    analyzed = []
    errors = []

    for item in files:
        fp = item if isinstance(item, str) else item.get("file", "")
        p = Path(fp)
        if not p.exists():
            errors.append(f"File not found: {fp}")
            continue
        try:
            meta = extract_metadata(p)
            analyzed.append(meta.model_dump())
        except Exception as e:
            errors.append(f"Error analyzing {fp}: {e}")

    result = {"ok": True, "action": "analyze", "analyzed_songs": analyzed}
    if errors:
        result["errors"] = errors
    return result


def handle_demucs_split(data: dict) -> dict:
    from core.demucs_handler import separate_track, check_cuda_availability, DEMUCS_MODEL

    tracks = data.get("tracks") or []
    output_dir = data.get("output_dir")
    if not output_dir:
        output_dir = str(Path("C:/BitStation/Gallery/bm-generator"))

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    temp_demucs = output_path / "_demucs_temp"
    temp_demucs.mkdir(parents=True, exist_ok=True)

    has_cuda, gpu_name = check_cuda_availability()
    track_results = []

    for t in tracks:
        fp = t if isinstance(t, str) else t.get("file", "")
        p = Path(fp)
        track_info = {"input": str(p), "status": "error", "error": None, "stems": {}, "stems_dir": ""}

        if not p.exists():
            track_info["error"] = f"File not found: {fp}"
            track_results.append(track_info)
            continue

        try:
            track_num = t.get("track_number", 1) if isinstance(t, dict) else 1
            title = t.get("title", p.stem) if isinstance(t, dict) else p.stem
            safe_name = f"{str(track_num).zfill(2)} - {title}"
            safe_name = "".join(c for c in safe_name if c.isalnum() or c in (" ", "-", "_", ".")).strip()

            stems_dir = output_path / "BM" / safe_name
            stems_dir.mkdir(parents=True, exist_ok=True)

            def progress_log(jid, pct, msg):
                logger.info(f"[{jid}] {pct}% {msg}")

            stems = separate_track(
                input_path=p,
                final_stems_dir=stems_dir,
                temp_demucs_out=temp_demucs,
                job_id=f"split_{safe_name}",
                progress_callback=progress_log,
            )

            track_info["status"] = "done"
            track_info["stems_dir"] = str(stems_dir)
            track_info["stems"] = stems
        except Exception as e:
            logger.error(f"Demucs split failed for {fp}: {e}")
            track_info["error"] = str(e)

        track_results.append(track_info)

    return {
        "ok": all(t["status"] == "done" for t in track_results),
        "action": "demucs_split",
        "demucs": {
            "model": DEMUCS_MODEL,
            "tracks": track_results,
        },
        "errors": [t["error"] for t in track_results if t["error"]],
    }


def handle_build_bm(data: dict) -> dict:
    from core.metadata_handler import AlbumMetadata
    from core.builder import BMBuilder

    album_raw = data.get("album_data")
    if not album_raw:
        return {"ok": False, "action": "build_bm", "errors": ["album_data is required"]}

    output_dir = data.get("output_dir")
    export_bm_path = data.get("export_bm_path")

    if output_dir:
        out = Path(output_dir)
    else:
        out = Path("C:/BitStation/Gallery/bm-generator")
    out.mkdir(parents=True, exist_ok=True)

    temp = Path("C:/BitStation/Gallery/bm-generator/_temp")
    temp.mkdir(parents=True, exist_ok=True)

    album = AlbumMetadata(**album_raw)
    builder = BMBuilder(out, temp)

    def progress_log(jid, pct, msg):
        logger.info(f"[{pct}%] {msg}")

    job_id = f"cli_{abs(hash(str(album_raw)))}"[:12]
    bm_path = builder.build_album(
        album, job_id,
        progress_callback=progress_log,
        export_bm_path=export_bm_path,
    )

    return {
        "ok": True,
        "action": "build_bm",
        "bm_file_path": bm_path,
        "bm_path": bm_path,
        "workspace": str(out),
    }


def run_persistent_mode():
    """Persistent (flash) mode: read JSON jobs from stdin, write JSON results to stdout."""
    logger.info("Initializing Persistent Mode...")

    ok, err = preflight_check()
    if not ok:
        print(json.dumps({"status": "error", "error": err}))
        sys.stdout.flush()
        sys.exit(1)

    logger.info("[FLASH] Pre-loading demucs model...")
    try:
        import torch
        from demucs.pretrained import get_model
        _flash_model = get_model("htdemucs")
        if torch.cuda.is_available():
            _flash_model = _flash_model.cuda()
            logger.info(f"[FLASH] Model loaded on GPU: {torch.cuda.get_device_name(0)}")
        else:
            logger.info("[FLASH] Model loaded on CPU")
    except Exception as e:
        logger.warning(f"[FLASH] Model preload failed (will load on first job): {e}")

    print(json.dumps({"status": "ready"}))
    sys.stdout.flush()

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break

            line = line.strip()
            if not line:
                continue

            job = json.loads(line)
            job_id = job.get("id", "unknown")
            action = job.get("action")
            result = {"id": job_id}

            try:
                if action == "analyze":
                    result.update(handle_analyze(job))
                elif action == "demucs_split":
                    result.update(handle_demucs_split(job))
                elif action in ("build", "build_bm"):
                    result.update(handle_build_bm(job))
                else:
                    result.update({"ok": False, "error": f"Unknown action: {action}"})
            except Exception as e:
                logger.error(f"Job {job_id} failed: {e}")
                result.update({"ok": False, "error": str(e)})

            print(json.dumps(result, ensure_ascii=False))
            sys.stdout.flush()

        except KeyboardInterrupt:
            break
        except Exception as e:
            logger.error(f"Loop error: {e}")


def main():
    parser = argparse.ArgumentParser(description="BM-Generator CLI")
    parser.add_argument("--input", help="Path to input JSON")
    parser.add_argument("--output", help="Path to output JSON")
    parser.add_argument("--persistent", action="store_true", help="Run in persistent mode")
    args = parser.parse_args()

    logger.info(f"Python: {sys.executable}")
    logger.info(f"Working dir: {Path.cwd()}")

    ok, err = preflight_check()
    if not ok:
        if args.output:
            _write_result(Path(args.output), {"ok": False, "error": err})
        sys.exit(1)

    logger.info("Preflight OK")

    if args.persistent:
        run_persistent_mode()
        return

    if not args.input or not args.output:
        parser.print_help()
        sys.exit(1)

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        logger.error(f"Input file not found: {input_path}")
        _write_result(output_path, {"ok": False, "error": f"Input not found: {input_path}"})
        sys.exit(1)

    try:
        with open(input_path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except Exception as e:
        _write_result(output_path, {"ok": False, "error": f"Invalid JSON: {e}"})
        sys.exit(1)

    action = data.get("action")
    logger.info(f"Action: {action}")

    try:
        if action == "analyze":
            result = handle_analyze(data)
        elif action == "demucs_split":
            result = handle_demucs_split(data)
        elif action in ("build", "build_bm"):
            result = handle_build_bm(data)
        else:
            result = {"ok": False, "action": action, "errors": [f"Unknown action: {action}"]}
    except Exception as e:
        logger.error(f"Error: {e}")
        traceback.print_exc()
        result = {"ok": False, "action": action, "errors": [str(e)]}

    _write_result(output_path, result)
    exit_code = 0 if result.get("ok") else 1
    sys.exit(exit_code)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.critical(f"Unhandled: {e}")
        traceback.print_exc()
        sys.exit(1)
