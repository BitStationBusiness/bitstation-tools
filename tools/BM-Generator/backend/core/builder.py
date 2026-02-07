import logging
import shutil
import json
import zipfile
import os
from pathlib import Path
from typing import List, Optional
from datetime import datetime

from .demucs_handler import run_demucs_separation
from .metadata_handler import AlbumMetadata, SongMetadata

# Configure logging
logger = logging.getLogger(__name__)

class BMBuilder:
    def __init__(self, output_dir: Path, temp_dir: Path):
        self.output_dir = output_dir
        self.temp_dir = temp_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    def build_album(self, album_data: AlbumMetadata, job_id: str, progress_callback=None, model=None, device=None):
        """
        Builds the .bm file from the provided album data.
        If model/device are provided, uses separate_audio (fast/persistent). 
        Otherwise uses run_demucs_separation (slow/one-off).
        """
        try:
            # 1. Create Directory Structure
            album_name_safe = "".join([c for c in album_data.album_name if c.isalnum() or c in (' ', '-', '_')]).strip()
            base_dir = self.temp_dir / job_id / album_name_safe
            if base_dir.exists():
                shutil.rmtree(base_dir)
            
            # Use separate_audio if model is provided, else import standard one
            from .demucs_handler import run_demucs_separation, separate_audio
            base_dir.mkdir(parents=True)

            songs_dir = base_dir / "Canciones"
            songs_dir.mkdir()

            # 2. Process Songs
            total_songs = len(album_data.songs)
            for index, song in enumerate(album_data.songs):
                if progress_callback:
                    progress_callback(job_id, 10 + int((index / total_songs) * 60), f"Processing {song.title}...")

                # Create song directory
                # Handle Disc Number if > 1
                if album_data.total_discs > 1:
                     # Parse disc number "1/2" -> 1
                    try:
                        disc_num = int(song.disc_number.split('/')[0])
                    except:
                        disc_num = 1
                    
                    song_folder_name = f"CD{disc_num} - {song.track_number} - {song.title}"
                else:
                    song_folder_name = f"{song.track_number} - {song.title}"
                
                song_safe_name = "".join([c for c in song_folder_name if c.isalnum() or c in (' ', '-', '_')]).strip()
                song_dir = songs_dir / song_safe_name
                song_dir.mkdir()

                # Copy Original File
                original_path = Path(song.path)
                dest_path = song_dir / original_path.name
                shutil.copy2(original_path, dest_path)

                # TODO: Handle .lrc file if provided (user didn't specify input for lrc in first pass, but good to have placeholder)
                # lrc_path = song_dir / f"{song.title}.lrc"
                # if lrc_exists: shutil.copy(lrc, lrc_path)

                # Create BSM folder (BitStation Music Stems)
                bsm_dir = song_dir / "BSM"
                bsm_dir.mkdir()
                
                # Run Demucs
                if progress_callback:
                    progress_callback(job_id, 10 + int((index / total_songs) * 60) + 5, f"Separating stems for {song.title}...")
                
                # We need to pass the full path to the song file in the new directory
                song_file_path_in_album = song_dir / Path(song.path).name
                
                if model and device:
                     separate_audio(song_file_path_in_album, bsm_dir, model, device, job_id, progress_callback)
                else:
                     run_demucs_separation(song_file_path_in_album, bsm_dir, job_id, progress_callback) 

                # Create Song Info (optional, but good for individual metadata)
                song_info = song.dict()
                with open(song_dir / "song_info.json", "w", encoding="utf-8") as f:
                    json.dump(song_info, f, indent=4)

            # 3. Handle Cover Art
            if album_data.cover_image_path:
                cover_src = Path(album_data.cover_image_path)
                cover_dest = base_dir / f"{album_name_safe}{cover_src.suffix}"
                shutil.copy2(cover_src, cover_dest)
            
            # 4. Generate Album Metadata
            # Create a comprehensive metadata file for the player
            album_info = album_data.dict()
            with open(base_dir / "album_info.json", "w", encoding="utf-8") as f:
                json.dump(album_info, f, indent=4)

            # 5. Zip into .bm file
            if progress_callback:
                progress_callback(job_id, 90, "Packaging .bm file...")
            
            bm_file_path = self.output_dir / f"{album_name_safe}.bm"
            with zipfile.ZipFile(bm_file_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                for root, dirs, files in os.walk(base_dir):
                    for file in files:
                        file_path = Path(root) / file
                        arcname = file_path.relative_to(base_dir)
                        zipf.write(file_path, arcname)

            if progress_callback:
                progress_callback(job_id, 100, f"Created {bm_file_path.name}")

            return str(bm_file_path)

        except Exception as e:
            logger.error(f"Builder error: {e}")
            raise e
        finally:
            # Cleanup temp dir for this job
            # shutil.rmtree(self.temp_dir / job_id, ignore_errors=True)
            pass
