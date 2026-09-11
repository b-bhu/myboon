import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const input = resolve(
  process.cwd(),
  "public/final-submission/captions/pitch-raw.json",
);
const output = resolve(
  process.cwd(),
  "public/final-submission/captions/pitch.json",
);

const raw = JSON.parse(readFileSync(input, "utf8"));

const replacements = new Map([
  [3, " Bibhu,"],
  [9, " myboon."],
  [10, " Solana"],
  [12, " users"],
  [16, " act:"],
  [17, " swap"],
  [18, " tokens,"],
  [19, " trade"],
  [20, " perpetuals,"],
  [33, " X,"],
  [34, " Telegram,"],
  [36, " dashboards."],
  [37, " Users"],
  [47, " myboon"],
  [65, " and"],
  [66, " market,"],
  [85, " Solana"],
  [88, " speed,"],
  [89, " liquidity,"],
  [90, " protocols,"],
  [109, " frontend"],
  [113, " data-heavy"],
  [146, " myboon's"],
  [148, " app,"],
  [149, " backend,"],
  [150, " research"],
  [153, " experience,"],
  [156, " integrations"],
  [157, " end to end."],
  [200, " myboon"],
  [211, " connected,"],
]);

const corrected = [];

for (let index = 0; index < raw.length; index += 1) {
  const caption = raw[index];

  if (index === 114) {
    continue;
  }

  if (index === 26 || index === 55) {
    const articleDuration = 90;

    corrected.push({
      ...caption,
      text: " the",
      endMs: caption.startMs + articleDuration,
      timestampMs: caption.startMs,
    });

    corrected.push({
      ...caption,
      text: " market",
      startMs: caption.startMs + articleDuration,
      timestampMs: caption.startMs + articleDuration,
    });

    continue;
  }

  if (index === 113) {
    corrected.push({
      ...caption,
      text: replacements.get(index),
      endMs: raw[114].endMs,
    });
    continue;
  }

  corrected.push({
    ...caption,
    text: replacements.get(index) ?? caption.text,
  });
}

writeFileSync(output, `${JSON.stringify(corrected, null, 2)}\n`);
console.log(`Wrote ${corrected.length} corrected pitch captions to ${output}`);
