import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { notificationVoiceCategory } from '../app/notification-voice.cjs';

const voiceRoot = join(import.meta.dirname, '../public/assets/voices');
const manifest = JSON.parse(readFileSync(join(voiceRoot, 'recorded-manifest.json'), 'utf8'));

test('notification kinds keep shared categories for card and popup chimes', () => {
  const examples = [
    [{ key: 'briefing:today' }, 'greeting'],
    [{ key: 'class:lesson:30m' }, 'study'],
    [{ key: 'game:assignment:1', display: 'popup' }, 'priority'],
    [{ key: 'deadline-start:boot' }, 'priority'],
    [{ key: 'away:session:1' }, 'away'],
    [{ key: 'casual:today:1' }, 'casual'],
    [{ key: 'activity-break:today:1' }, 'break'],
    [{ key: 'health-check:today' }, 'break'],
    [{ key: 'routine:meal', title: 'ASA · 식사 챙겨' }, 'meal'],
    [{ key: 'routine:sleep', title: 'ASA · 잘 시간' }, 'bedtime'],
    [{ key: 'bedtime-game:today' }, 'bedtime'],
    [{ key: 'routine:exercise', title: 'ASA · 운동 시간' }, 'study'],
    [{ key: 'focus-end:today' }, 'success'],
    [{ key: 'evening-review:today', display: 'daily-review' }, 'review']
  ];
  for (const [candidate, expected] of examples) {
    const category = notificationVoiceCategory(candidate, new Date(2026, 8, 18, 9));
    assert.equal(category, expected);
  }
  assert.equal(notificationVoiceCategory({ key: 'briefing:today' }, new Date(2026, 8, 18, 20)), 'casual');
});

test('Seo-a playback uses chimes at configured volumes, never archived character speech', { skip: process.platform !== 'win32' }, () => {
  const script = join(import.meta.dirname, '../Play-RinSound.ps1');
  for (const [category, volume, expected] of [['soft', 0, 'soft'], ['priority', 35, 'priority'], ['review', 100, 'review'], ['bedtime', 70, 'soft']]) {
    const selected = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, category, '-ValidateOnly', '-Volume', String(volume)], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    assert.equal(selected, join(import.meta.dirname, '../public/assets/sounds', `rin-${expected}-chime.wav`));
  }
});

test('archived recordings remain intact and playable for later recovery', () => {
  const clips = new Map(manifest.clips.map(clip => [clip.file, clip]));
  for (const file of new Set(manifest.clips.map(clip => clip.file))) {
    const clip = clips.get(file);
    assert.ok(clip && clip.end > clip.start && clip.ja && clip.ko, file);
    const wav = readFileSync(join(voiceRoot, file));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    let pcm, rate, channels, bits;
    for (let i = 12; i + 8 <= wav.length;) {
      const name = wav.toString('ascii', i, i + 4), size = wav.readUInt32LE(i + 4);
      assert.ok(i + 8 + size <= wav.length);
      if (name === 'fmt ') {
        assert.equal(wav.readUInt16LE(i + 8), 1);
        channels = wav.readUInt16LE(i + 10); rate = wav.readUInt32LE(i + 12); bits = wav.readUInt16LE(i + 22);
      }
      if (name === 'data') pcm = wav.subarray(i + 8, i + 8 + size);
      i += 8 + size + (size % 2);
    }
    assert.equal(channels, 1); assert.equal(bits, 16); assert.equal(rate, 44100);
    const seconds = pcm.length / (rate * 2);
    assert.ok(seconds > 0.5 && seconds < 6, file);
    assert.ok(Math.abs(seconds - (clip.end - clip.start)) < 0.03, file);
    let peak = 0, power = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(i) / 32768;
      peak = Math.max(peak, Math.abs(sample)); power += sample * sample;
    }
    assert.ok(peak > 0.01 && peak < 0.9, file);
    assert.ok(Math.sqrt(power / (pcm.length / 2)) > 0.005, file);
  }
});
