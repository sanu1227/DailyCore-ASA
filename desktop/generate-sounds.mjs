import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'public', 'assets', 'sounds');
const sampleRate = 44_100;

function render(name, duration, notes) {
  const samples = Math.ceil(duration * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    const time = index / sampleRate;
    let mixed = 0;
    for (const note of notes) {
      const local = time - note.start;
      if (local < 0 || local >= note.length) continue;
      const attack = Math.min(1, local / 0.018);
      const release = Math.pow(Math.max(0, 1 - local / note.length), 2.2);
      const fundamental = Math.sin(2 * Math.PI * note.frequency * local);
      const shimmer = Math.sin(2 * Math.PI * note.frequency * 2 * local) * 0.16;
      mixed += (fundamental + shimmer) * attack * release * note.gain;
    }
    const fade = Math.min(1, time / 0.01, (duration - time) / 0.025);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mixed * fade)) * 20_000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(join(output, name), Buffer.concat([header, pcm]));
}

mkdirSync(output, { recursive: true });
render('rin-soft-chime.wav', 1.05, [
  { start: 0.00, length: 0.60, frequency: 659.25, gain: 0.31 },
  { start: 0.16, length: 0.72, frequency: 830.61, gain: 0.28 },
  { start: 0.32, length: 0.72, frequency: 987.77, gain: 0.25 },
]);
render('rin-priority-chime.wav', 1.34, [
  { start: 0.00, length: 0.42, frequency: 659.25, gain: 0.31 },
  { start: 0.14, length: 0.48, frequency: 783.99, gain: 0.30 },
  { start: 0.28, length: 0.58, frequency: 987.77, gain: 0.29 },
  { start: 0.72, length: 0.54, frequency: 783.99, gain: 0.25 },
  { start: 0.84, length: 0.48, frequency: 987.77, gain: 0.24 },
]);
render('rin-review-chime.wav', 1.25, [
  { start: 0.00, length: 0.72, frequency: 523.25, gain: 0.28 },
  { start: 0.20, length: 0.82, frequency: 659.25, gain: 0.25 },
  { start: 0.42, length: 0.80, frequency: 783.99, gain: 0.23 },
]);
