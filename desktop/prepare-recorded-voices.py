"""Local transcription/editing helper; original recording is never modified."""
import argparse
import json
from pathlib import Path
import sys
import subprocess
import wave
import hashlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.runtime/audio-tools'))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--transcribe', action='store_true')
    parser.add_argument('--edit', action='store_true')
    parser.add_argument('--verify-speech', action='store_true')
    args = parser.parse_args()
    if args.transcribe:
        from faster_whisper import WhisperModel
        model = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=8,
                             download_root=str(ROOT / '.runtime/audio-models'))
        segments, info = model.transcribe(str(args.source), language='ja', beam_size=5,
                                          vad_filter=True, word_timestamps=True,
                                          condition_on_previous_text=False)
        result = []
        for segment in segments:
            item = {'start': segment.start, 'end': segment.end, 'text': segment.text,
                    'words': [{'start': w.start, 'end': w.end, 'text': w.word} for w in segment.words or []]}
            result.append(item)
            print(f'{segment.start:.2f}-{segment.end:.2f} {segment.text}', flush=True)
        (ROOT / '.runtime/voice-transcript.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.edit:
        import imageio_ffmpeg
        import numpy as np
        manifest = json.loads((ROOT / 'public/assets/voices/recorded-manifest.json').read_text(encoding='utf-8'))
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        report = {'sourceSha256': hashlib.sha256(args.source.read_bytes()).hexdigest(), 'clips': []}
        for clip in manifest['clips']:
            if clip.get('source', manifest['source']) != args.source.name:
                continue
            destination = ROOT / 'public/assets/voices' / clip['file']
            duration = clip['end'] - clip['start']
            # Preserve original speed/pitch. Short fades avoid cut clicks; normalization
            # targets -20 LUFS with a -3 dB true-peak ceiling for notification playback.
            filters = f'highpass=f=70,loudnorm=I=-20:TP=-3:LRA=7,afade=t=in:d=0.025,afade=t=out:st={duration-0.06:.3f}:d=0.06'
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(clip['start']),
                            '-i', str(args.source), '-t', str(duration), '-af', filters,
                            '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', str(destination)], check=True)
            with wave.open(str(destination), 'rb') as wav:
                seconds = wav.getnframes() / wav.getframerate()
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(float) / 32768
                peak = float(np.max(np.abs(samples)))
                rms = float(np.sqrt(np.mean(samples**2)))
                assert 0.5 < seconds < 6 and 0.01 < peak < 0.9 and rms > 0.005, (destination, seconds, peak, rms)
                report['clips'].append({'file': clip['file'], 'seconds': round(seconds, 3), 'peak': round(peak, 4), 'rms': round(rms, 4)})
        (ROOT / '.runtime/voice-edit-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2), flush=True)
    if args.verify_speech:
        from faster_whisper import WhisperModel
        model = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=8,
                             download_root=str(ROOT / '.runtime/audio-models'))
        for clip in json.loads((ROOT / 'public/assets/voices/recorded-manifest.json').read_text(encoding='utf-8'))['clips']:
            if clip.get('source', '붕괴 스타레일 토오사카 린 모든 음성(일본어) - Honkai Star Rail.mp3') != args.source.name:
                continue
            segments, _ = model.transcribe(str(ROOT / 'public/assets/voices' / clip['file']), language='ja',
                                            beam_size=5, condition_on_previous_text=False)
            print(clip['file'], ''.join(s.text for s in segments), flush=True)

if __name__ == '__main__':
    main()
