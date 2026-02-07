import argparse
import json
import logging
import sys
import traceback
from pathlib import Path

# Adjust path to import core modules
sys.path.append(str(Path(__file__).parent))

from core.metadata_handler import extract_metadata, AlbumMetadata
from core.builder import BMBuilder
from core.demucs_handler import load_demucs_model

# Configure logging to file to avoid messing up stdout/stderr which might be captured by the runner
# Or simpler: Log to stderr, leaving stdout clean for manual debugging if needed, 
# although our communication happens via json files.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stderr)]
)
logger = logging.getLogger(__name__)

def fail(msg: str, code: int = 1):
    logger.error(f"FAILURE: {msg}")
    error_response = {"ok": False, "error": msg}
    # We should still try to write to output file if possible, or just exit
    # The runner expects an output file.
    return error_response

def run_persistent_mode():
    """
    Run in persistent mode treating stdin/stdout as communication channel.
    Input: JSON lines with job data.
    Output: JSON lines with result data.
    """
    # Load model once on startup
    logger.info("Initializing Persistent Mode (Flash)...")
    try:
        model, device = load_demucs_model(device_str="cuda")
        logger.info(f"Model loaded on {device}")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        # Fatal error, we can't run
        print(json.dumps({"error": f"Failed to initialize: {e}"}))
        sys.exit(1)

    # Prepare directories
    base_dir = Path(__file__).parent.parent
    temp_dir = base_dir / "temp"
    output_storage_dir = base_dir / "output"
    temp_dir.mkdir(exist_ok=True)
    output_storage_dir.mkdir(exist_ok=True)

    builder = BMBuilder(output_storage_dir, temp_dir)

    def progress_logger(job_id, percent, msg):
        # We could send progress updates to stdout if the protocol supports it
        # For now just log
        logger.info(f"[{job_id}] {percent}% {msg}")

    # Signal readiness
    print(json.dumps({"status": "ready"}))
    sys.stdout.flush()

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break # EOF

            line = line.strip()
            if not line: continue

            job = json.loads(line)
            job_id = job.get("id", "unknown")
            action = job.get("action")
            
            result = {"id": job_id, "ok": True}
            
            try:
                if action == "analyze":
                    # Reuse analyze logic
                    files = job.get("files", [])
                    analyzed = []
                    for f in files:
                        p = Path(f)
                        if p.exists():
                            analyzed.append(extract_metadata(p).dict())
                    result["analyzed_songs"] = analyzed
                
                elif action == "build":
                    album_data_raw = job.get("album_data")
                    album_data = AlbumMetadata(**album_data_raw)
                    
                    bm_path = builder.build_album(
                        album_data, 
                        job_id, 
                        progress_callback=progress_logger,
                        model=model,
                        device=device
                    )
                    result["bm_file_path"] = str(bm_path)
                    
                else:
                    result["ok"] = False
                    result["error"] = f"Unknown action: {action}"

            except Exception as e:
                logger.error(f"Job {job_id} failed: {e}")
                result["ok"] = False
                result["error"] = str(e)
            
            # Send result
            print(json.dumps(result))
            sys.stdout.flush()

        except KeyboardInterrupt:
            break
        except Exception as e:
            logger.error(f"Loop error: {e}")
            # Try to keep alive?

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", help="Path to input json")
    parser.add_argument("--output", help="Path to output json")
    parser.add_argument("--persistent", action="store_true", help="Run in persistent mode (stdin/stdout)")
    args = parser.parse_args()

    if args.persistent:
        run_persistent_mode()
        return

    if not args.input or not args.output:
        parser.print_help()
        sys.exit(1)

    input_path = Path(args.input)
    output_path = Path(args.output)
    
    # Verify input exists
    if not input_path.exists():
        logger.error(f"Input file not found: {input_path}")
        # Cannot write to output if we don't know where it is or if it's safe, 
        # but we have args.output.
        with open(output_path, "w", encoding="utf-8") as f:
             json.dump({"ok": False, "error": f"Input file not found: {input_path}"}, f)
        sys.exit(1)

    try:
        with open(input_path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except Exception as e:
        logger.error(f"Failed to read input json: {e}")
        with open(output_path, "w", encoding="utf-8") as f:
             json.dump({"ok": False, "error": f"Invalid JSON: {e}"}, f)
        sys.exit(1)

    action = data.get("action")
    result = {"ok": True}

    try:
        if action == "analyze":
            files = data.get("files", [])
            analyzed_songs = []
            for file_path_str in files:
                file_path = Path(file_path_str)
                if not file_path.exists():
                    logger.warning(f"File not found: {file_path}")
                    continue
                
                # Extract metadata
                # We reuse the logic from metadata_handler.extract_metadata
                meta = extract_metadata(file_path)
                analyzed_songs.append(meta.dict())
            
            result["analyzed_songs"] = analyzed_songs

        elif action == "build":
            album_data_raw = data.get("album_data")
            if not album_data_raw:
                raise ValueError("album_data is required for build action")

            # Parse into Pydantic model to validate
            album_data = AlbumMetadata(**album_data_raw)
            
            # Setup directories
            # We can use a temp dir relative to the tool or a system temp.
            # For now, let's use a 'temp' folder in the backend dir.
            base_dir = Path(__file__).parent.parent
            temp_dir = base_dir / "temp"
            output_storage_dir = base_dir / "output" # Where .bm files are stored
            
            temp_dir.mkdir(exist_ok=True)
            output_storage_dir.mkdir(exist_ok=True)


            logger.info("Starting build process...")
            builder = BMBuilder(output_storage_dir, temp_dir)
            
            # Since this is a CLI tool, we might not need real-time progress updates via callback 
            # in the same way, but we can log them.
            def progress_logger(job_id, percent, msg):
                logger.info(f"[{percent}%] {msg}")

            # Job ID can be random for this execution
            job_id = "cli_build_" + str(hash(str(album_data_raw)))[:8]

            bm_path = builder.build_album(
                album_data, 
                job_id, 
                progress_callback=progress_logger
            )
            
            result["bm_file_path"] = str(bm_path)

        else:
            raise ValueError(f"Unknown action: {action}")

    except Exception as e:
        logger.error(f"Error processing action '{action}': {e}")
        traceback.print_exc()
        result = {"ok": False, "error": str(e)}

    # Write output
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
    except Exception as e:
         logger.error(f"Failed to write output: {e}")
         sys.exit(1)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.critical(f"Unhandled exception: {e}")
        # Last resort error write
        try:
             # Try to parse args manually to find output
             pass
        except:
            pass
        sys.exit(1)
