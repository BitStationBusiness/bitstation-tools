import logging
from typing import List, Optional
from pydantic import BaseModel
import mutagen
from pathlib import Path

# Configure logging
logger = logging.getLogger(__name__)

class SongMetadata(BaseModel):
    filename: str
    title: str
    artist: str
    album: str
    year: str
    genre: str
    duration: float
    track_number: str # e.g. "1/12"
    disc_number: str # e.g. "1/2"
    format: str # mp3, flac, etc
    quality: str # e.g. "16bit/44.1kHz"
    path: str # Temporary path to uploaded file

class AlbumMetadata(BaseModel):
    album_artist: str
    album_name: str
    year: str
    genre: str
    release_date: str
    total_tracks: int
    total_discs: int
    songs: List[SongMetadata]
    cover_image_path: Optional[str] = None

def extract_metadata(file_path: Path) -> SongMetadata:
    """
    Extracts metadata from an audio file using mutagen.
    """
    try:
        audio = mutagen.File(file_path)
        if audio is None:
            raise Exception("Could not parse audio file")
        
        # Default values
        title = file_path.stem
        artist = "Unknown Artist"
        album = "Unknown Album"
        year = ""
        genre = ""
        track_number = ""
        disc_number = "1/1"
        
        # Extract based on tags (simplified for common formats)
        if audio.tags:
            title = audio.tags.get('TIT2', [title])[0] if 'TIT2' in audio.tags else \
                    audio.tags.get('title', [title])[0]
            
            artist = audio.tags.get('TPE1', [artist])[0] if 'TPE1' in audio.tags else \
                     audio.tags.get('artist', [artist])[0]
            
            album = audio.tags.get('TALB', [album])[0] if 'TALB' in audio.tags else \
                    audio.tags.get('album', [album])[0]

            year = str(audio.tags.get('TDRC', [year])[0]) if 'TDRC' in audio.tags else \
                   str(audio.tags.get('date', [year])[0])

            genre = audio.tags.get('TCON', [genre])[0] if 'TCON' in audio.tags else \
                    audio.tags.get('genre', [genre])[0]
            
            track_number = str(audio.tags.get('TRCK', [track_number])[0]) if 'TRCK' in audio.tags else \
                           str(audio.tags.get('tracknumber', [track_number])[0])

            disc_number = str(audio.tags.get('TPOS', [disc_number])[0]) if 'TPOS' in audio.tags else \
                          str(audio.tags.get('discnumber', [disc_number])[0])

        # Get Duration
        duration = audio.info.length

        # Get Format and Quality
        file_format = file_path.suffix.lstrip('.').lower()
        
        # Try to guess quality
        sample_rate = getattr(audio.info, 'sample_rate', 0)
        bit_depth = getattr(audio.info, 'bits_per_sample', 16) # Default to 16 if unknown
        bitrate = getattr(audio.info, 'bitrate', 0)

        if file_format == 'flac':
            quality = f"{bit_depth}bit/{sample_rate/1000:.1f}kHz"
        elif file_format == 'mp3':
            quality = f"{int(bitrate/1000)}kbps"
        else:
             quality = f"{sample_rate/1000:.1f}kHz"

        return SongMetadata(
            filename=file_path.name,
            title=str(title),
            artist=str(artist),
            album=str(album),
            year=str(year),
            genre=str(genre),
            duration=duration,
            track_number=str(track_number),
            disc_number=str(disc_number),
            format=file_format,
            quality=quality,
            path=str(file_path)
        )

    except Exception as e:
        logger.error(f"Error extracting metadata from {file_path}: {e}")
        # Return fallback with minimal info
        return SongMetadata(
            filename=file_path.name,
            title=file_path.stem,
            artist="Unknown",
            album="Unknown",
            year="",
            genre="",
            duration=0.0,
            track_number="",
            disc_number="1/1",
            format=file_path.suffix.lstrip('.').lower(),
            quality="Unknown",
            path=str(file_path)
        )
