import hashlib
import logging
from typing import List, Optional, Union
from pathlib import Path

from pydantic import BaseModel
import mutagen

logger = logging.getLogger(__name__)


class SongMetadata(BaseModel):
    filename: str
    title: str
    artist: str
    album: str
    year: Union[str, int]
    genre: str
    duration: float
    duration_ms: int = 0
    track_number: Union[str, int]
    disc_number: Union[str, int]
    format: str
    quality: str
    path: str
    sha256: str = ""
    lrc_file: Optional[str] = None


class AlbumMetadata(BaseModel):
    album_artist: str
    album_name: str
    year: Union[str, int]
    genre: str
    release_date: Union[str, int] = ""
    total_tracks: int
    total_discs: int = 1
    songs: List[SongMetadata]
    cover_image_path: Optional[str] = None
    disc_covers: Optional[dict] = None


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _get_tag(tags, *keys, default=""):
    """Try multiple tag keys, return first found value as string."""
    if not tags:
        return default
    for key in keys:
        val = tags.get(key)
        if val is not None:
            if isinstance(val, list):
                return str(val[0]) if val else default
            return str(val)
    return default


def extract_metadata(file_path: Path) -> SongMetadata:
    """Extract metadata from an audio file using mutagen."""
    try:
        audio = mutagen.File(file_path, easy=False)
        if audio is None:
            raise ValueError(f"Mutagen could not parse: {file_path}")

        title = file_path.stem
        artist = "Unknown Artist"
        album = "Unknown Album"
        year = ""
        genre = ""
        track_number = ""
        disc_number = "1/1"

        tags = audio.tags
        if tags is not None:
            tag_class = type(tags).__name__

            if tag_class in ("ID3", "MP4Tags"):
                # MP3 / M4A / AAC
                title = _get_tag(tags, "TIT2", "\xa9nam", default=title)
                artist = _get_tag(tags, "TPE1", "TPE2", "\xa9ART", "aART", default=artist)
                album = _get_tag(tags, "TALB", "\xa9alb", default=album)
                year = _get_tag(tags, "TDRC", "TYER", "\xa9day", default=year)
                genre = _get_tag(tags, "TCON", "\xa9gen", default=genre)
                track_number = _get_tag(tags, "TRCK", "trkn", default=track_number)
                disc_number = _get_tag(tags, "TPOS", "disk", default=disc_number)
            else:
                # FLAC / OGG Vorbis / Opus use VorbisComment-style tags (lowercase)
                title = _get_tag(tags, "title", default=title)
                artist = _get_tag(tags, "artist", "albumartist", default=artist)
                album = _get_tag(tags, "album", default=album)
                year = _get_tag(tags, "date", "year", default=year)
                genre = _get_tag(tags, "genre", default=genre)
                track_number = _get_tag(tags, "tracknumber", default=track_number)
                disc_number = _get_tag(tags, "discnumber", default=disc_number)

        duration = audio.info.length if audio.info else 0.0
        duration_ms = int(duration * 1000)

        file_format = file_path.suffix.lstrip(".").lower()
        sample_rate = getattr(audio.info, "sample_rate", 0)
        bit_depth = getattr(audio.info, "bits_per_sample", 16)
        bitrate = getattr(audio.info, "bitrate", 0)

        if file_format == "flac":
            quality = f"{bit_depth}bit/{sample_rate / 1000:.1f}kHz"
        elif file_format in ("mp3", "aac", "m4a"):
            quality = f"{int(bitrate / 1000)}kbps" if bitrate else "Unknown"
        elif sample_rate:
            quality = f"{sample_rate / 1000:.1f}kHz"
        else:
            quality = "Unknown"

        file_hash = ""
        try:
            file_hash = _sha256_file(file_path)
        except Exception:
            pass

        lrc_path = file_path.with_suffix(".lrc")
        lrc_file = str(lrc_path) if lrc_path.exists() else None

        return SongMetadata(
            filename=file_path.name,
            title=str(title),
            artist=str(artist),
            album=str(album),
            year=str(year),
            genre=str(genre),
            duration=duration,
            duration_ms=duration_ms,
            track_number=str(track_number),
            disc_number=str(disc_number),
            format=file_format,
            quality=quality,
            path=str(file_path),
            sha256=file_hash,
            lrc_file=lrc_file,
        )

    except Exception as e:
        logger.error(f"Error extracting metadata from {file_path}: {e}")
        return SongMetadata(
            filename=file_path.name,
            title=file_path.stem,
            artist="Unknown",
            album="Unknown",
            year="",
            genre="",
            duration=0.0,
            duration_ms=0,
            track_number="",
            disc_number="1/1",
            format=file_path.suffix.lstrip(".").lower(),
            quality="Unknown",
            path=str(file_path),
        )
