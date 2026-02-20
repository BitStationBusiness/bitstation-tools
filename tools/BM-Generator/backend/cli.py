import argparse
import json
import logging
import sys
import traceback
from pathlib import Path

sys.path.append(str(Path(__file__).parent))

from core.metadata_handler import extract_metadata, AlbumMetadata
from core.builder import BMBuilder

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
logger = logging.getLogger(__name__)


def run_persistent_mode():
    """
    Persistent (flash) mode: read JSON jobs from stdin, write JSON results to stdout.
    """
    logger.info("Initializing Persistent Mode...")

    base_dir = Path(__file__).parent.parent
    temp_dir = base_dir / "temp"
    output_dir = base_dir / "output"
    temp_dir.mkdir(exist_ok=True)
    output_dir.mkdir(exist_ok=True)

    builder = BMBuilder(output_dir, temp_dir)

    def progress_logger(job_id, percent, msg):
        logger.info(f"[{job_id}] {percent}% {msg}")

    # Signal readiness
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
            result = {"id": job_id, "ok": True}

            try:
                if action == "analyze":
                    files = job.get("files", [])
                    analyzed = []
                    for f in files:
                        p = Path(f)
                        if p.exists():
                            analyzed.append(extract_metadata(p).dict())
                    result["analyzed_songs"] = analyzed

                elif action == "build":
                    album_data = AlbumMetadata(**job.get("album_data", {}))
                    bm_path = builder.build_album(
                        album_data, job_id,
                        progress_callback=progress_logger,
                    )
                    result["bm_file_path"] = str(bm_path)

                else:
                    result = {"id": job_id, "ok": False, "error": f"Unknown action: {action}"}

            except Exception as e:
                logger.error(f"Job {job_id} failed: {e}")
                result = {"id": job_id, "ok": False, "error": str(e)}

            print(json.dumps(result))
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
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({"ok": False, "error": f"Input not found: {input_path}"}, f)
        sys.exit(1)

    try:
        with open(input_path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except Exception as e:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({"ok": False, "error": f"Invalid JSON: {e}"}, f)
        sys.exit(1)

    action = data.get("action")
    result = {"ok": True}

    try:
        if action == "analyze":
            analyzed = []
            for fp in data.get("files", []):
                p = Path(fp)
                if p.exists():
                    analyzed.append(extract_metadata(p).dict())
            result["analyzed_songs"] = analyzed

        elif action == "build":
            album_raw = data.get("album_data")
            if not album_raw:
                raise ValueError("album_data is required for build")

            album = AlbumMetadata(**album_raw)
            base_dir = Path(__file__).parent.parent
            temp_dir = base_dir / "temp"
            output_dir = base_dir / "output"
            temp_dir.mkdir(exist_ok=True)
            output_dir.mkdir(exist_ok=True)

            builder = BMBuilder(output_dir, temp_dir)

            def progress_logger(jid, pct, msg):
                logger.info(f"[{pct}%] {msg}")

            job_id = f"cli_{abs(hash(str(album_raw)))}"[:12]
            bm_path = builder.build_album(album, job_id, progress_callback=progress_logger)
            result["bm_file_path"] = str(bm_path)

        else:
            raise ValueError(f"Unknown action: {action}")

    except Exception as e:
        logger.error(f"Error: {e}")
        traceback.print_exc()
        result = {"ok": False, "error": str(e)}

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.critical(f"Unhandled: {e}")
        sys.exit(1)
