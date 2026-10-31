import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CALF_STRETCH_CYCLE, formatExerciseNameForSpeech } from '../src/engine/timerEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const sheetDataPath = path.join(rootDir, 'data', 'sheet-data.json');
const outJsonPath = path.join(rootDir, 'data', 'speech-pack.json');
const outM4aPath = path.join(rootDir, 'data', 'speech-pack.m4a');

const SAMPLE_RATE = 16000;
const INTER_CLIP_PAD_SAMPLES = Math.round(SAMPLE_RATE * 0.08); // 80ms silence separator

function toPronounceableTtsText(phrase) {
  return phrase
    .replace(/\b6-6-6\b/g, '6, 6, 6')
    .replace(/\bI-Y-Ts\b/g, 'I, Y, Tees')
    .replace(/\bgastrox\b/gi, 'gastroc');
}

function parseWavInt16Mono(buf) {
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const start = offset + 8;
      const end = Math.min(buf.length, start + chunkSize);
      const count = Math.floor((end - start) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        samples[i] = buf.readInt16LE(start + i * 2);
      }
      return samples;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error('WAV data chunk not found');
}

function trimAndNormalizeSamples(rawSamples) {
  const threshold = 200;
  let firstIdx = 0;
  while (firstIdx < rawSamples.length && Math.abs(rawSamples[firstIdx]) < threshold) {
    firstIdx++;
  }
  let lastIdx = rawSamples.length - 1;
  while (lastIdx > firstIdx && Math.abs(rawSamples[lastIdx]) < threshold) {
    lastIdx--;
  }

  if (firstIdx >= lastIdx) {
    return new Int16Array(Math.round(SAMPLE_RATE * 0.25));
  }

  const leadPad = Math.round(SAMPLE_RATE * 0.012);
  const trailPad = Math.round(SAMPLE_RATE * 0.024);
  const start = Math.max(0, firstIdx - leadPad);
  const end = Math.min(rawSamples.length, lastIdx + trailPad + 1);
  const len = end - start;

  let peak = 1;
  for (let i = start; i < end; i++) {
    const abs = Math.abs(rawSamples[i]);
    if (abs > peak) peak = abs;
  }

  const targetPeak = Math.round(32767 * 0.85);
  const scale = Math.min(3.0, targetPeak / peak);
  const out = new Int16Array(len);

  const fadeInLen = Math.min(leadPad, Math.floor(len / 4));
  const fadeOutLen = Math.min(trailPad, Math.floor(len / 4));

  for (let i = 0; i < len; i++) {
    let env = 1.0;
    if (fadeInLen > 0 && i < fadeInLen) {
      env = i / fadeInLen;
    } else if (fadeOutLen > 0 && i >= len - fadeOutLen) {
      env = (len - 1 - i) / fadeOutLen;
    }
    const scaled = Math.round(rawSamples[start + i] * scale * env);
    out[i] = Math.max(-32768, Math.min(32767, scaled));
  }

  return out;
}

function writeWavInt16Mono(filePath, samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

function main() {
  const sheetData = JSON.parse(fs.readFileSync(sheetDataPath, 'utf8'));
  const baseNames = new Set();

  for (const ex of sheetData.exercises) {
    const formatted = formatExerciseNameForSpeech(ex.name);
    if (formatted) baseNames.add(formatted);
  }
  for (const item of CALF_STRETCH_CYCLE) {
    const formatted = formatExerciseNameForSpeech(item.label);
    if (formatted) baseNames.add(formatted);
  }
  for (const extra of ['Work', 'Curls', 'Bench Press', 'Squats', 'Push-Ups', 'Plank', 'Burpees']) {
    baseNames.add(formatExerciseNameForSpeech(extra));
  }

  const phrases = [
    { key: '3', tts: '3', rate: 205 },
    { key: '2', tts: '2', rate: 205 },
    { key: '1', tts: '1', rate: 205 },
    { key: 'in', tts: 'in', rate: 185 }
  ];

  for (const name of Array.from(baseNames).sort()) {
    phrases.push({
      key: name,
      tts: toPronounceableTtsText(name),
      rate: 182
    });
    phrases.push({
      key: `${name} in`,
      tts: `${toPronounceableTtsText(name)} in`,
      rate: 182
    });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workout-speech-pack-'));
  console.log(`Synthesizing ${phrases.length} voice clips using Samantha @ ${SAMPLE_RATE}Hz...`);

  try {
    const rendered = [];
    let totalSamples = INTER_CLIP_PAD_SAMPLES;

    for (let idx = 0; idx < phrases.length; idx++) {
      const p = phrases[idx];
      const wavFile = path.join(tmpDir, `clip-${idx}.wav`);
      execFileSync('/usr/bin/say', [
        '-v',
        'Samantha',
        '-r',
        String(p.rate),
        '-o',
        wavFile,
        `--data-format=LEI16@${SAMPLE_RATE}`,
        p.tts
      ]);
      const raw = parseWavInt16Mono(fs.readFileSync(wavFile));
      const trimmed = trimAndNormalizeSamples(raw);
      rendered.push({ key: p.key, samples: trimmed });
      totalSamples += trimmed.length + INTER_CLIP_PAD_SAMPLES;
    }

    const masterSamples = new Int16Array(totalSamples);
    const clipsMeta = {};
    let cursor = INTER_CLIP_PAD_SAMPLES;

    for (const item of rendered) {
      masterSamples.set(item.samples, cursor);
      const offsetSec = Number((cursor / SAMPLE_RATE).toFixed(4));
      const durationSec = Number((item.samples.length / SAMPLE_RATE).toFixed(4));
      const durationMs = Math.round((item.samples.length / SAMPLE_RATE) * 1000);
      clipsMeta[item.key] = { offsetSec, durationSec, durationMs };
      cursor += item.samples.length + INTER_CLIP_PAD_SAMPLES;
    }

    const masterWavPath = path.join(tmpDir, 'master.wav');
    writeWavInt16Mono(masterWavPath, masterSamples, SAMPLE_RATE);

    if (fs.existsSync(outM4aPath)) {
      fs.unlinkSync(outM4aPath);
    }
    execFileSync('/usr/bin/afconvert', [
      '-f',
      'm4af',
      '-d',
      'aac',
      '-b',
      '32000',
      '-c',
      '1',
      masterWavPath,
      outM4aPath
    ]);

    const packJson = {
      version: 1,
      sampleRate: SAMPLE_RATE,
      totalDurationSec: Number((totalSamples / SAMPLE_RATE).toFixed(3)),
      clipCount: rendered.length,
      clips: clipsMeta
    };
    fs.writeFileSync(outJsonPath, JSON.stringify(packJson, null, 2) + '\n', 'utf8');

    const m4aBytes = fs.statSync(outM4aPath).size;
    console.log(
      `Done! Wrote ${rendered.length} clips (${packJson.totalDurationSec}s) -> ${(m4aBytes / 1024).toFixed(1)} KB (${outM4aPath})`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
