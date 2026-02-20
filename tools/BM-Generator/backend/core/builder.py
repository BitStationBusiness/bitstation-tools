import logging
import shutil
import json
import zipfile
import os
from pathlib import Path
from typing import Optional
from datetime import datetime

from .demucs_handler import separate_track
from .metadata_handler import AlbumMetadata

logger = logging.getLogger(__name__)


class BMBuilder:
    def __init__(self, output_dir: Path, temp_dir: Path):
        self.output_dir = output_dir
        self.temp_dir = temp_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _safe_name(name: str) -> str:
        return "".join(c for c in name if c.isalnum() or c in (" ", "-", "_")).strip()

    def build_album(
        self,
        album_data: AlbumMetadata,
        job_id: str,
        progress_callback=None,
        **kwargs,
    ) -> str:
        """
        Build a .bm bundle from album metadata.
        Each track is separated into 4 stems (drums, bass, vocals, other) via Demucs CLI.
        """
        album_safe = self._safe_name(album_data.album_name)
        base_dir = self.temp_dir / job_id / album_safe
        if base_dir.exists():
            shutil.rmtree(base_dir)
        base_dir.mkdir(parents=True)

        songs_dir = base_dir / "Canciones"
        songs_dir.mkdir()

        temp_demucs_out = self.temp_dir / job_id / "_demucs_raw"
        temp_demucs_out.mkdir(parents=True, exist_ok=True)

        total_songs = len(album_data.songs)
        track_stem_info = []

        for idx, song in enumerate(album_data.songs):
            base_pct = 5 + int((idx / total_songs) * 75)
            if progress_callback:
                progress_callback(job_id, base_pct, f"Processing {song.title}...")

            if album_data.total_discs > 1:
                try:
                    disc_num = int(song.disc_number.split("/")[0])
                except Exception:
                    disc_num = 1
                folder_name = f"CD{disc_num} - {song.track_number} - {song.title}"
            else:
                folder_name = f"{song.track_number} - {song.title}"

            song_safe = self._safe_name(folder_name)
            song_dir = songs_dir / song_safe
            song_dir.mkdir()

            original = Path(song.path)
            dest = song_dir / original.name
            shutil.copy2(original, dest)

            bm_stems_dir = song_dir / "BM"
            bm_stems_dir.mkdir()

            if progress_callback:
                progress_callback(
                    job_id, base_pct + 2,
                    f"Separating stems for {song.title}..."
                )

            stems = separate_track(
                input_path=dest,
                final_stems_dir=bm_stems_dir,
                temp_demucs_out=temp_demucs_out,
                job_id=f"{job_id}_t{idx}",
                progress_callback=progress_callback,
            )

            track_stem_info.append({
                "title": song.title,
                "stems": list(stems.keys()),
                "stems_dir": str(bm_stems_dir.relative_to(base_dir)),
            })

            song_info = song.dict()
            song_info["stems_dir"] = "BM"
            with open(song_dir / "song_info.json", "w", encoding="utf-8") as f:
                json.dump(song_info, f, indent=4)

        # Cover art
        if album_data.cover_image_path:
            cover_src = Path(album_data.cover_image_path)
            if cover_src.exists():
                shutil.copy2(cover_src, base_dir / f"{album_safe}{cover_src.suffix}")

        # Album manifest (bm.json)
        manifest = {
            "format": "bm",
            "version": "1.0",
            "album_artist": album_data.album_artist,
            "album_name": album_data.album_name,
            "year": album_data.year,
            "genre": album_data.genre,
            "total_tracks": album_data.total_tracks,
            "total_discs": album_data.total_discs,
            "stems_per_track": ["drums", "bass", "vocals", "other"],
            "created_at": datetime.utcnow().isoformat(),
            "tracks": track_stem_info,
        }
        with open(base_dir / "bm.json", "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=4)

        # Legacy album_info.json for compatibility
        with open(base_dir / "album_info.json", "w", encoding="utf-8") as f:
            json.dump(album_data.dict(), f, indent=4)

        # Package into .bm (ZIP)
        if progress_callback:
            progress_callback(job_id, 92, "Packaging .bm file...")

        bm_path = self.output_dir / f"{album_safe}.bm"
        with zipfile.ZipFile(bm_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(base_dir):
                for fname in files:
                    fpath = Path(root) / fname
                    zf.write(fpath, fpath.relative_to(base_dir))

        if progress_callback:
            progress_callback(job_id, 100, f"Created {bm_path.name}")

        # Cleanup
        shutil.rmtree(self.temp_dir / job_id, ignore_errors=True)

        return str(bm_path)
