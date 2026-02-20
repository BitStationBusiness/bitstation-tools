import logging
import shutil
import json
import zipfile
import hashlib
import os
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone

from .demucs_handler import separate_track, compute_stem_hashes, DEMUCS_STEMS
from .metadata_handler import AlbumMetadata

logger = logging.getLogger(__name__)

BM_SCHEMA_VERSION = "bm/1.0"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


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
        export_bm_path: Optional[str] = None,
        **kwargs,
    ) -> str:
        """
        Build a .bm bundle from album metadata.
        Each track is separated into 4 stems (drums, bass, vocals, other) via Demucs.
        """
        album_safe = self._safe_name(album_data.album_name)
        multi_disc = album_data.total_discs > 1

        workspace = self.temp_dir / job_id / album_safe
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.mkdir(parents=True)

        temp_demucs_out = self.temp_dir / job_id / "_demucs_raw"
        temp_demucs_out.mkdir(parents=True, exist_ok=True)

        cover_dir = workspace / "Portada"
        cover_dir.mkdir()

        total_songs = len(album_data.songs)
        manifest_tracks = []

        for idx, song in enumerate(album_data.songs):
            base_pct = 5 + int((idx / max(total_songs, 1)) * 75)
            if progress_callback:
                progress_callback(job_id, base_pct, f"Processing {song.title}...")

            # Determine disc and track numbers
            try:
                disc_num = int(str(song.disc_number).split("/")[0])
            except Exception:
                disc_num = 1

            try:
                track_num = int(str(song.track_number).split("/")[0])
            except Exception:
                track_num = idx + 1

            track_prefix = str(track_num).zfill(2)
            track_safe_title = self._safe_name(song.title)
            folder_name = f"{track_prefix} - {track_safe_title}"

            # Build directory structure
            if multi_disc:
                disc_dir = workspace / f"CD{disc_num}" / "Canciones"
            else:
                disc_dir = workspace / "Canciones"
            disc_dir.mkdir(parents=True, exist_ok=True)

            song_dir = disc_dir / folder_name
            song_dir.mkdir(exist_ok=True)

            # Copy source audio
            original = Path(song.path)
            if original.exists():
                dest = song_dir / original.name
                shutil.copy2(original, dest)
            else:
                logger.warning(f"Source file not found: {original}")
                dest = song_dir / song.filename

            # Copy LRC if exists
            lrc_src = None
            if song.lrc_file and Path(song.lrc_file).exists():
                lrc_src = Path(song.lrc_file)
            else:
                auto_lrc = original.with_suffix(".lrc")
                if auto_lrc.exists():
                    lrc_src = auto_lrc
            if lrc_src:
                shutil.copy2(lrc_src, song_dir / f"{track_prefix} - {track_safe_title}.lrc")

            # Demucs stem separation
            bsm_dir = song_dir / "BSM"
            bsm_dir.mkdir(exist_ok=True)

            stem_info = {}
            stem_hashes = {}
            try:
                if progress_callback:
                    progress_callback(job_id, base_pct + 2, f"Separating stems for {song.title}...")

                stems = separate_track(
                    input_path=dest if dest.exists() else original,
                    final_stems_dir=bsm_dir,
                    temp_demucs_out=temp_demucs_out,
                    job_id=f"{job_id}_t{idx}",
                    progress_callback=progress_callback,
                )
                stem_info = stems
                stem_hashes = compute_stem_hashes(bsm_dir)
            except Exception as e:
                logger.error(f"Stem separation failed for {song.title}: {e}")
                stem_info = {"error": str(e)}

            # Track hash
            file_hash = song.sha256
            if not file_hash and dest.exists():
                try:
                    file_hash = _sha256_file(dest)
                except Exception:
                    file_hash = ""

            # Internal paths relative to workspace root
            if multi_disc:
                track_internal = f"CD{disc_num}/Canciones/{folder_name}/{original.name}"
                stems_internal = f"CD{disc_num}/Canciones/{folder_name}/BSM"
                lrc_internal = f"CD{disc_num}/Canciones/{folder_name}/{track_prefix} - {track_safe_title}.lrc" if lrc_src else None
            else:
                track_internal = f"Canciones/{folder_name}/{original.name}"
                stems_internal = f"Canciones/{folder_name}/BSM"
                lrc_internal = f"Canciones/{folder_name}/{track_prefix} - {track_safe_title}.lrc" if lrc_src else None

            track_manifest = {
                "disc_number": disc_num,
                "track_number": track_num,
                "title": song.title,
                "artist": song.artist,
                "duration_ms": song.duration_ms or int(song.duration * 1000),
                "format": song.format,
                "quality": song.quality,
                "sha256": file_hash,
                "path": track_internal,
                "lrc_path": lrc_internal,
                "stems_path": stems_internal,
                "stems": {s: f"{stems_internal}/{s}.wav" for s in DEMUCS_STEMS},
                "stem_hashes": stem_hashes,
            }
            manifest_tracks.append(track_manifest)

        # --- Cover art ---
        cover_internal = None
        if album_data.cover_image_path:
            cover_src = Path(album_data.cover_image_path)
            if cover_src.exists():
                cover_name = f"{album_safe}{cover_src.suffix}"
                shutil.copy2(cover_src, cover_dir / cover_name)
                cover_internal = f"Portada/{cover_name}"

        disc_covers_internal = {}
        if multi_disc and album_data.disc_covers:
            for disc_key, disc_cover_path in album_data.disc_covers.items():
                dcp = Path(disc_cover_path)
                if dcp.exists():
                    disc_cover_name = f"{album_safe}_CD{disc_key}{dcp.suffix}"
                    shutil.copy2(dcp, cover_dir / disc_cover_name)
                    disc_covers_internal[disc_key] = f"Portada/{disc_cover_name}"

        # --- Build bm.json manifest ---
        if progress_callback:
            progress_callback(job_id, 88, "Building bm.json manifest...")

        # Collect unique album artists from tracks
        album_artists = list(set(t["artist"] for t in manifest_tracks if t.get("artist")))

        bm_manifest = {
            "schema_version": BM_SCHEMA_VERSION,
            "album_artist": album_data.album_artist,
            "album_artists": album_artists,
            "title": album_data.album_name,
            "year": album_data.year,
            "release_date": album_data.release_date or album_data.year,
            "genre": album_data.genre,
            "discs": album_data.total_discs,
            "total_tracks": album_data.total_tracks or len(manifest_tracks),
            "stems_model": "htdemucs",
            "stems_per_track": ["drums", "bass", "vocals", "other"],
            "cover": cover_internal,
            "disc_covers": disc_covers_internal if disc_covers_internal else None,
            "tracks": manifest_tracks,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        with open(workspace / "bm.json", "w", encoding="utf-8") as f:
            json.dump(bm_manifest, f, indent=2, ensure_ascii=False)

        # --- Package into .bm (ZIP) ---
        if progress_callback:
            progress_callback(job_id, 92, "Packaging .bm file...")

        if export_bm_path:
            bm_path = Path(export_bm_path)
            bm_path.parent.mkdir(parents=True, exist_ok=True)
        else:
            bm_path = self.output_dir / f"{album_safe}.bm"

        with zipfile.ZipFile(bm_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(workspace):
                for fname in files:
                    fpath = Path(root) / fname
                    arcname = fpath.relative_to(workspace).as_posix()
                    zf.write(fpath, arcname)

        if progress_callback:
            progress_callback(job_id, 100, f"Created {bm_path.name}")

        # Cleanup temp workspace
        shutil.rmtree(self.temp_dir / job_id, ignore_errors=True)

        return str(bm_path)
