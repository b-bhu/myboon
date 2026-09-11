import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  downloadWhisperModel,
  installWhisperCpp,
  toCaptions,
  transcribe,
} from "@remotion/install-whisper-cpp";

const whisperPath = resolve(process.cwd(), ".whisper-cpp");
const whisperCppVersion = "1.5.5";
const model = "base.en";
const inputPath = "/tmp/eternal-final-pitch.wav";
const captionsPath = resolve(
  process.cwd(),
  "public/final-submission/captions/pitch-raw.json",
);
const transcriptPath = resolve(
  process.cwd(),
  "public/final-submission/captions/pitch-whisper.json",
);

mkdirSync(dirname(captionsPath), { recursive: true });

await installWhisperCpp({
  to: whisperPath,
  version: whisperCppVersion,
});

await downloadWhisperModel({
  model,
  folder: whisperPath,
});

const whisperCppOutput = await transcribe({
  inputPath,
  whisperPath,
  whisperCppVersion,
  model,
  tokenLevelTimestamps: true,
  splitOnWord: true,
});

const { captions } = toCaptions({ whisperCppOutput });

writeFileSync(transcriptPath, `${JSON.stringify(whisperCppOutput, null, 2)}\n`);
writeFileSync(captionsPath, `${JSON.stringify(captions, null, 2)}\n`);

console.log(`Wrote ${captions.length} raw pitch captions to ${captionsPath}`);
