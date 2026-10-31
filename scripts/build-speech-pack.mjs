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

const SAMPLE_RATE = 24000;
const AAC_BITRATE = 64000;
const NEURAL_VOICE = 'en-US-AvaNeural';
const NEURAL_RATE = '+4%';
const INTER_CLIP_PAD_SAMPLES = Math.round(SAMPLE_RATE * 0.08); // 80ms silence separator

function toPronounceableTtsText(phrase) {
  return phrase
    .replace(/\(([^)]+)\)/g, ', $1')
    .replace(/\bAb\s+Wheel\b/gi, 'Abb wheel')
    .replace(/\b3\s+way\s+V\s+ups\b/gi, '3-way vee-ups')
    .replace(/\bV\s+ups\b/gi, 'Vee-ups')
    .replace(/\bV-Sit\b/gi, 'vee-sit')
    .replace(/\bPallof\b/gi, 'Pal-off')
    .replace(/\bFlys\b/gi, 'flies')
    .replace(/\b6-6-6\b/g, '6, 6, 6')
    .replace(/\bI-Y-Ts\b/gi, 'I, Y, Tees')
    .replace(/\bTRX\b/g, 'T-R-X')
    .replace(/\bRDL\b/g, 'R-D-L')
    .replace(/\b180s\b/g, 'one-eighties')
    .replace(/\bgastrox\b/gi, 'gastroc')
    .replace(/\bUp\s+Up\s+down\s+ups\b/gi, 'Up, up, down-ups')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
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
  const threshold = 65;
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

  const leadPad = Math.round(SAMPLE_RATE * 0.018);
  const trailPad = Math.round(SAMPLE_RATE * 0.042);
  const start = Math.max(0, firstIdx - leadPad);
  const end = Math.min(rawSamples.length, lastIdx + trailPad + 1);
  const len = end - start;

  let peak = 1;
  for (let i = start; i < end; i++) {
    const abs = Math.abs(rawSamples[i]);
    if (abs > peak) peak = abs;
  }

  const targetPeak = Math.round(32767 * 0.88);
  const scale = Math.min(2.6, targetPeak / peak);
  const out = new Int16Array(len);

  const fadeInLen = Math.min(Math.round(SAMPLE_RATE * 0.008), Math.floor(len / 4));
  const fadeOutLen = Math.min(Math.round(SAMPLE_RATE * 0.020), Math.floor(len / 4));

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

function findEdgeTtsPython() {
  const candidates = [
    process.env.EDGE_TTS_PYTHON,
    '/Users/joshal/.gemini/antigravity/brain/c0f17fdc-d6dd-435f-beaf-ea2a3251feec/scratch/tts-env/bin/python3',
    path.join(rootDir, '.tts-venv', 'bin', 'python3'),
    'python3'
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      execFileSync(bin, ['-c', 'import edge_tts'], { stdio: 'ignore' });
      return bin;
    } catch {}
  }
  return null;
}

const EDGE_TTS_BATCH_PY = `
import asyncio
import json
import os
import subprocess
import sys
import wave
import array
import edge_tts

async def render_item(sem, item, tmp_dir, sample_rate, voice, rate):
    idx = item["idx"]
    mode = item["mode"]
    tts_text = item["tts"]
    mp3_path = os.path.join(tmp_dir, f"raw-{idx}.mp3")
    full_wav_path = os.path.join(tmp_dir, f"full-{idx}.wav")
    out_wav_path = os.path.join(tmp_dir, f"clip-{idx}.wav")

    async with sem:
        for attempt in range(4):
            try:
                word_events = []
                if mode == "contextual_in":
                    full_prompt = f"{tts_text}, in, 3, 2, 1."
                    comm = edge_tts.Communicate(full_prompt, voice, rate=rate, boundary="WordBoundary")
                else:
                    comm = edge_tts.Communicate(tts_text, voice, rate=rate)

                with open(mp3_path, "wb") as f:
                    async for chunk in comm.stream():
                        if chunk["type"] == "audio":
                            f.write(chunk["data"])
                        elif chunk["type"] == "WordBoundary":
                            word_events.append(chunk)
                break
            except Exception as err:
                if attempt == 3:
                    raise err
                await asyncio.sleep(0.6 * (attempt + 1))

    subprocess.run(
        ["/usr/bin/afconvert", "-f", "WAVE", "-d", f"LEI16@{sample_rate}", "-c", "1", mp3_path, full_wav_path],
        check=True
    )

    if mode != "contextual_in":
        os.replace(full_wav_path, out_wav_path)
        return

    with wave.open(full_wav_path, "rb") as wf:
        nframes = wf.getnframes()
        raw_bytes = wf.readframes(nframes)
    samples = array.array("h")
    samples.frombytes(raw_bytes)

    # Locate the "in" -> "3" word boundary in 100ns ticks and slice at minimum-energy zero-crossing
    three_idx = None
    for i in range(len(word_events) - 1, -1, -1):
        tok = word_events[i]["text"].strip(".,!?:; ").lower()
        if tok in ("3", "three"):
            three_idx = i
            break

    in_idx = None
    if three_idx is not None:
        for i in range(three_idx - 1, -1, -1):
            tok = word_events[i]["text"].strip(".,!?:; ").lower()
            if tok == "in":
                in_idx = i
                break

    if in_idx is not None and three_idx is not None:
        t_in_end = (word_events[in_idx]["offset"] + word_events[in_idx]["duration"]) / 10_000_000.0
        t_three_start = word_events[three_idx]["offset"] / 10_000_000.0
        s_lo = max(0, int((t_in_end - 0.025) * sample_rate))
        s_hi = min(len(samples), int((t_three_start + 0.008) * sample_rate))
    else:
        s_lo = max(0, int(len(samples) * 0.45))
        s_hi = min(len(samples), int(len(samples) * 0.72))

    win = max(64, int(0.010 * sample_rate))
    if s_hi - s_lo <= win:
        cut_idx = max(1, min(len(samples), (s_lo + s_hi) // 2))
    else:
        running = sum(abs(samples[k]) for k in range(s_lo, s_lo + win))
        best_sum = running
        best_pos = s_lo
        for pos in range(s_lo + 1, s_hi - win + 1):
            running += abs(samples[pos + win - 1]) - abs(samples[pos - 1])
            if running < best_sum:
                best_sum = running
                best_pos = pos
        center = best_pos + win // 2
        cut_idx = center
        for k in range(best_pos, min(len(samples) - 1, best_pos + win)):
            if (samples[k] <= 0 and samples[k + 1] >= 0) or (samples[k] >= 0 and samples[k + 1] <= 0):
                cut_idx = k
                break

    sliced = samples[:cut_idx]
    with wave.open(out_wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(sliced.tobytes())

async def main():
    manifest_path = sys.argv[1]
    with open(manifest_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    sem = asyncio.Semaphore(8)
    tasks = [
        render_item(sem, item, cfg["tmpDir"], cfg["sampleRate"], cfg["voice"], cfg["rate"])
        for item in cfg["items"]
    ]
    await asyncio.gather(*tasks)

asyncio.run(main())
`;

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
    { key: '3', tts: '3,', mode: 'direct', fallbackRate: 205 },
    { key: '2', tts: '2,', mode: 'direct', fallbackRate: 205 },
    { key: '1', tts: '1.', mode: 'direct', fallbackRate: 205 },
    { key: 'in', tts: 'in', mode: 'direct', fallbackRate: 185 }
  ];

  for (const name of Array.from(baseNames).sort()) {
    const pronounceable = toPronounceableTtsText(name);
    phrases.push({
      key: name,
      tts: `${pronounceable}.`,
      mode: 'direct',
      fallbackRate: 182
    });
    phrases.push({
      key: `${name} in`,
      tts: pronounceable,
      mode: 'contextual_in',
      fallbackRate: 182
    });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workout-speech-pack-'));
  const edgePython = findEdgeTtsPython();

  try {
    if (edgePython) {
      console.log(
        `Synthesizing ${phrases.length} neural voice clips using ${NEURAL_VOICE} @ ${SAMPLE_RATE}Hz (${AAC_BITRATE / 1000}kbps AAC)...`
      );
      const pyScriptPath = path.join(tmpDir, 'render_batch.py');
      const manifestPath = path.join(tmpDir, 'manifest.json');
      fs.writeFileSync(pyScriptPath, EDGE_TTS_BATCH_PY, 'utf8');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          tmpDir,
          sampleRate: SAMPLE_RATE,
          voice: NEURAL_VOICE,
          rate: NEURAL_RATE,
          items: phrases.map((p, idx) => ({
            idx,
            key: p.key,
            tts: p.tts,
            mode: p.mode
          }))
        }),
        'utf8'
      );
      execFileSync(edgePython, [pyScriptPath, manifestPath], { stdio: 'inherit' });
    } else {
      console.log(
        `edge-tts not found; falling back to macOS /usr/bin/say @ ${SAMPLE_RATE}Hz...`
      );
      for (let idx = 0; idx < phrases.length; idx++) {
        const p = phrases[idx];
        const wavFile = path.join(tmpDir, `clip-${idx}.wav`);
        const text = p.mode === 'contextual_in' ? `${p.tts} in` : p.tts;
        execFileSync('/usr/bin/say', [
          '-v',
          'Samantha',
          '-r',
          String(p.fallbackRate),
          '-o',
          wavFile,
          `--data-format=LEI16@${SAMPLE_RATE}`,
          text
        ]);
      }
    }

    const rendered = [];
    let totalSamples = INTER_CLIP_PAD_SAMPLES;

    for (let idx = 0; idx < phrases.length; idx++) {
      const p = phrases[idx];
      const wavFile = path.join(tmpDir, `clip-${idx}.wav`);
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
      String(AAC_BITRATE),
      '-c',
      '1',
      masterWavPath,
      outM4aPath
    ]);

    const packJson = {
      version: 2,
      voice: edgePython ? NEURAL_VOICE : 'Samantha',
      sampleRate: SAMPLE_RATE,
      totalDurationSec: Number((totalSamples / SAMPLE_RATE).toFixed(3)),
      clipCount: rendered.length,
      clips: clipsMeta
    };
    fs.writeFileSync(outJsonPath, JSON.stringify(packJson, null, 2) + '\n', 'utf8');

    const m4aBytes = fs.statSync(outM4aPath).size;
    console.log(
      `Done! Wrote ${rendered.length} clips (${packJson.totalDurationSec}s, ${packJson.voice}) -> ${(m4aBytes / 1024).toFixed(1)} KB (${outM4aPath})`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
