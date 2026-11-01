/**
 * Single voice function for MyBoon News (xAI TTS, POST /v1/tts).
 * Needs XAI_API_KEY in env:  source /home/box/secrets/xai.env
 * CLI: pnpm voice --host hank --text "This is MyBoon News." --out /tmp/x.mp3
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Host = "hank" | "marcus";

export const VOICES: Record<Host, { voice_id: string; speed: number }> = {
  hank: { voice_id: "orion", speed: 1.1 },
  marcus: { voice_id: "altair", speed: 1.1 },
};

export async function generateVoice({ host, text, out }: { host: Host; text: string; out: string }) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY not set (source /home/box/secrets/xai.env)");
  const v = VOICES[host];
  if (!v) throw new Error(`Unknown host: ${host}`);
  const res = await fetch("https://api.x.ai/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_id: v.voice_id,
      language: "en",
      speed: v.speed,
      output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 192000 },
    }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status} ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, buf);
  return { out, bytes: buf.length, voice: v.voice_id, speed: v.speed };
}

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

if (process.argv[1]?.endsWith("voice.ts")) {
  const host = arg("host") as Host;
  const text = arg("text");
  const out = arg("out");
  if (!host || !text || !out) {
    console.error('Usage: voice --host hank|marcus --text "..." --out path.mp3');
    process.exit(1);
  }
  generateVoice({ host, text, out })
    .then((r) => console.log(`Saved ${r.out} (${r.bytes} bytes, ${r.voice} @${r.speed}x)`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
