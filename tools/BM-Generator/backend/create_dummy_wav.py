import wave
import math
import struct
import sys

def create_dummy_wav(filename, duration=1.0, frequency=440.0):
    sample_rate = 44100
    n_frames = int(duration * sample_rate)
    
    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        
        for i in range(n_frames):
            value = int(32767.0 * math.sin(2.0 * math.pi * frequency * i / sample_rate))
            data = struct.pack('<h', value)
            wav_file.writeframesraw(data)

if __name__ == "__main__":
    filename = sys.argv[1] if len(sys.argv) > 1 else "test_audio.wav"
    create_dummy_wav(filename, duration=3.0)
