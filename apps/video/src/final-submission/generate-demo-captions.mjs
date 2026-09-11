import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SOURCE_TRIM_MS = 600;

const segments = [
  [626, 2692, "Hey, I am Bibhu, and this is myboon."],
  [3473, 6279, "Crypto users receive market information from everywhere."],
  [7175, 11979, "One signal appears on X, another comes from Telegram or a news article."],
  [12522, 17562, "The price is on a chart and the place to trade is in another application."],
  [18171, 26386, "The problem is not a lack of information. The problem is connecting all of it and understanding what is actually happening."],
  [27022, 28885, "myboon brings their journey together."],
  [29177, 33714, "Using myboon starts like any Solana application. The user connects their wallet."],
  [34236, 47765, "Once connected, the home screen brings together three things the user normally keeps separate: the market feed, the place where they can act, and their positions across the markets."],
  [48685, 51437, "Let's start with the feed."],
  [51697, 55484, "Think of the feed as your market analyst. It turns incoming signals into researched updates."],
  [55903, 61082, "Related updates are organized into developing stories in chronological order."],
  [61402, 64937, "So you can see how each narrative takes shape."],
  [65762, 69713, "Below that, you get the latest updates from across the market."],
  [70302, 73463, "The calendar shows the key dates you should watch."],
  [73728, 80112, "Suppose Bitcoin is moving. The feed shows the latest development and everything that happened before it."],
  [81282, 84519, "So the user is not acting on one isolated headline."],
  [85149, 88659, "They can understand how the complete story has developed."],
  [89395, 93681, "Once you understand the story, you can tap Take Action."],
  [94346, 98536, "For example, myboon opens the BTC perpetual market on Phoenix."],
  [99508, 105043, "From here, you can check the live market, choose your direction, and place an order."],
  [106563, 109277, "Think of myboon as your Solana action center."],
  [109597, 117211, "You can trade perpetuals, swap tokens, access liquidity products, and see your positions together in one wallet."],
  [117854, 121167, "Those actions normally live across different applications."],
  [121542, 125333, "myboon brings them into one consistent mobile experience."],
  [126451, 135531, "This is myboon: a single mobile experience for understanding what is moving, acting through Solana markets, and tracking what you own."],
  [136095, 141650, "myboon tells you why the market moved and lets you act on it in the same app."],
];

const cleanLength = (word) => Math.max(1, word.replace(/[^a-zA-Z0-9]/g, "").length);

const captions = [];

for (const [sourceStartMs, sourceEndMs, sentence] of segments) {
  const startMs = Math.max(0, sourceStartMs - SOURCE_TRIM_MS);
  const endMs = sourceEndMs - SOURCE_TRIM_MS;
  const words = sentence.split(/\s+/);
  const weights = words.map((word) => Math.max(1, Math.sqrt(cleanLength(word))));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = startMs;

  words.forEach((word, index) => {
    const isLast = index === words.length - 1;
    const duration = ((endMs - startMs) * weights[index]) / totalWeight;
    const wordEnd = isLast ? endMs : Math.round(cursor + duration);

    captions.push({
      text: `${index === 0 ? "" : " "}${word}`,
      startMs: Math.round(cursor),
      endMs: wordEnd,
      timestampMs: Math.round(cursor),
      confidence: null,
    });

    cursor = wordEnd;
  });
}

const output = resolve(
  process.cwd(),
  "public/final-submission/captions/demo.json",
);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(captions, null, 2)}\n`);
console.log(`Wrote ${captions.length} caption tokens to ${output}`);
