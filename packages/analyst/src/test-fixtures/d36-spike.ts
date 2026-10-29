/**
 * #504 fixtures from spike v5 (spike/analyst-one-file @ 7a261b4e): six real scout signals, the v5 outputs
 * (Jev answers + targets), and the subset of atlas.shelves (read-only snapshot, Oct 29 2026) they touch.
 */
export type SpikeCase = {
  signal: { signal_id: string; source: string | null; text: string; link: string | null };
  v5: {
    summary: string; decision: 'keep' | 'ignore' | 'unclear'; reason: string;
    targets: { entity: string; kind: 'existing' | 'new'; type: string; angle: string; note: string }[];
    jev: { question: string; choices: string[]; answer: string; probabilities: Record<string, number> }[];
  };
};
export type SpikeShelf = { slug: string; name: string; type: string; aliases: string[] };

export const spikeShelves: SpikeShelf[] = [
 {
  "slug": "base",
  "name": "Base",
  "type": "protocol",
  "aliases": [
   "Base",
   "Base chain",
   "Coinbase Base",
   "Base blockchain",
   "Base L2"
  ]
 },
 {
  "slug": "coinbase",
  "name": "Coinbase",
  "type": "organization",
  "aliases": [
   "Coinbase",
   "Coinbase Global, Inc.",
   "COIN",
   "Coinbase UK"
  ]
 },
 {
  "slug": "elon-musk",
  "name": "Elon Musk",
  "type": "person",
  "aliases": [
   "Elon Musk",
   "Elon Reeve Musk",
   "@elonmusk",
   "Musk",
   "Elon",
   "elon-musk"
  ]
 },
 {
  "slug": "hyperliquid",
  "name": "Hyperliquid",
  "type": "protocol",
  "aliases": [
   "Hyperliquid",
   "HyperEVM",
   "Hyperliquid Foundation",
   "HIP-3",
   "HyperliquidX",
   "Hyperliquid L1",
   "Hyperliquid HIP 3",
   "AQAv2 framework",
   "AQAv2 protocol",
   "AQAv2",
   "Aligned Quote Asset v2 (AQAv2)"
  ]
 },
 {
  "slug": "kalshi",
  "name": "Kalshi",
  "type": "organization",
  "aliases": [
   "Kalshi",
   "Kalshi Inc.",
   "KalshiEX",
   "Kalshi, Inc."
  ]
 },
 {
  "slug": "solana",
  "name": "Solana",
  "type": "asset",
  "aliases": [
   "Solana",
   "SOL",
   "@Solana"
  ]
 },
 {
  "slug": "tokenization-rwa",
  "name": "Tokenization of real-world assets",
  "type": "topic",
  "aliases": [
   "Tokenization of Traditional Markets",
   "RWA tokenization",
   "Real-World Asset Tokenization",
   "Tokenized Markets",
   "24/7 Blockchain Markets",
   "Onchain Traditional Markets",
   "Tokenized Real World Assets",
   "Tokenized RWAs",
   "Tokenized RWA sector",
   "On-chain real world assets",
   "Tokenized RWA market",
   "Tokenized Equities",
   "Tokenized Equities",
   "onchain equities",
   "tokenized stocks",
   "tokenized equity market",
   "Tokenized asset market",
   "BNB Chain tokenized shares and ETFs market",
   "Tokenized bank deposits",
   "tokenized deposits",
   "tokenized dollars",
   "Tokenization of real-world assets"
  ]
 },
 {
  "slug": "intercontinental-exchange-ice",
  "name": "Intercontinental Exchange (ICE)",
  "type": "organization",
  "aliases": [
   "Intercontinental Exchange (ICE)",
   "ICE",
   "Intercontinental Exchange"
  ]
 },
 {
  "slug": "trade-xyz",
  "name": "Trade.XYZ",
  "type": "protocol",
  "aliases": [
   "Trade.XYZ",
   "TradeXYZ",
   "TradeXYZ"
  ]
 },
 {
  "slug": "backpack",
  "name": "Backpack",
  "type": "organization",
  "aliases": [
   "Backpack",
   "@Backpack",
   "Backpack Exchange",
   "Backpack 🎒"
  ]
 },
 {
  "slug": "hyperliquid-strategies",
  "name": "Hyperliquid Strategies",
  "type": "organization",
  "aliases": [
   "Hyperliquid Strategies"
  ]
 },
 {
  "slug": "polymarket",
  "name": "Polymarket",
  "type": "organization",
  "aliases": [
   "Polymarket",
   "polymarket.com",
   "Polymarket Markets"
  ]
 }
];

export const spikeCases: SpikeCase[] = [
 {
  "signal": {
   "signal_id": "test-standuquesne-2115777839622689036",
   "source": "x",
   "text": "I am excited to be an investor in trade(xyz) as they partner with ICE to bring 24/7 perpetual futures on Hyperliquid to the United States...",
   "link": "https://x.com/standuquesne/status/2115777839622689036"
  },
  "v5": {
   "summary": "An investor (standuquesne on X) announced they have invested in trade.xyz as the platform partners with Intercontinental Exchange (ICE) to bring 24/7 perpetual futures built on Hyperliquid to the United States. This is an investor's personal post relaying the news, not an official company statement, so the partnership details are secondhand. If accurate, it would mark a major traditional exchange operator (ICE) entering US crypto perpetuals through a Hyperliquid-based platform.",
   "decision": "keep",
   "reason": "All three mentions map to existing shelves. trade.xyz and ICE each get a new story: an investor's post claims a partnership bringing 24/7 Hyperliquid perps to the US, a first for both. Hyperliquid continues its existing story of US expansion via regulated partners. The signal is an investor's X post, so it's framed as talk/claim rather than official announcement.",
   "targets": [
    {
     "entity": "trade-xyz",
     "kind": "existing",
     "type": "protocol",
     "angle": "new_story",
     "note": "An investor in trade.xyz posted that the protocol is partnering with ICE to bring 24/7 perpetual futures on Hyperliquid to the United States — a claimed institutional tie-up opening a US market, though relayed by an investor rather than announced by the company itself."
    },
    {
     "entity": "intercontinental-exchange-ice",
     "kind": "existing",
     "type": "organization",
     "angle": "new_story",
     "note": "Per an investor's post, ICE is partnering with trade.xyz to offer 24/7 perpetual futures on Hyperliquid to US users — a reported first step for the legacy exchange operator into US crypto perps, pending official confirmation."
    },
    {
     "entity": "hyperliquid",
     "kind": "existing",
     "type": "protocol",
     "angle": "existing_story",
     "note": "Talk of a trade.xyz–ICE partnership would route Hyperliquid-based perpetual futures to US traders through regulated channels, another step in the ongoing story of Hyperliquid's push into the American market."
    }
   ],
   "jev": [
    {
     "question": "Signal summary: \"An investor (standuquesne on X) announced they have invested in trade.xyz as the platform partners with Intercontinental Exchange (ICE) to bring 24/7 perpetual futures built on Hyperliquid to the United States. This is an investor's personal post relaying the news, not an official company statement, so the partnership details are secondhand. If accurate, it would mark a major traditional exchange operator (ICE) entering US crypto perpetuals through a Hyperliquid-based platform.\". Would a crypto trader or market watcher care about this, even if it is only talk for now?",
     "choices": [
      "keep",
      "ignore"
     ],
     "answer": "keep",
     "probabilities": {
      "keep": 0.95,
      "ignore": 0.05
     }
    },
    {
     "question": "This signal touches \"trade.xyz\". Candidate existing entities: trade-xyz (Trade.XYZ, protocol). Does \"trade.xyz\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 0.99,
      "new": 0.01,
      "not_related": 0
     }
    },
    {
     "question": "This signal touches \"Intercontinental Exchange (ICE)\". Candidate existing entities: intercontinental-exchange-ice (Intercontinental Exchange (ICE), organization). Does \"Intercontinental Exchange (ICE)\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 1,
      "new": 0,
      "not_related": 0
     }
    },
    {
     "question": "This signal touches \"Hyperliquid\". Candidate existing entities: hyperliquid (Hyperliquid, protocol); hype (HYPE, asset); hyperliquid-strategies (Hyperliquid Strategies, organization). Does \"Hyperliquid\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 1,
      "new": 0,
      "not_related": 0
     }
    },
    {
     "question": "For \"trade.xyz\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "new_story",
     "probabilities": {
      "new_story": 0.91,
      "existing_story": 0.08,
      "plain_update": 0.01
     }
    },
    {
     "question": "For \"Intercontinental Exchange (ICE)\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "new_story",
     "probabilities": {
      "new_story": 0.63,
      "existing_story": 0.35,
      "plain_update": 0.02
     }
    },
    {
     "question": "For \"Hyperliquid\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "existing_story",
     "probabilities": {
      "new_story": 0.01,
      "existing_story": 0.98,
      "plain_update": 0.01
     }
    }
   ]
  }
 },
 {
  "signal": {
   "signal_id": "05d904405cc85501c44bd32ba7744b3217665245b7cf3431ed451af28f5b5b72",
   "source": "tokens_xyz",
   "text": "CROWDFUNDINSIDER: Coinbase backed Base Puts Apple, Alphabet, Microsoft and Amazon Onchain as Tokenized Stocks Reach $3.84B Amid Issuer Pushback",
   "link": "https://www.crowdfundinsider.com/2026/10/320810-coinbase-backed-base-puts-apple-alphabet-microsoft-and-amazon-onchain-as-tokenized-stocks-reach-3-84b-amid-issuer-pushback"
  },
  "v5": {
   "summary": "Crowdfund Insider reports that Base, the Coinbase-backed layer-2 network, has put Apple, Alphabet, Microsoft, and Amazon onchain as tokenized stocks, with the tokenized stock market reaching $3.84B. The report notes pushback from issuers over the tokenization of their shares. This matters because it shows major public equities moving onto crypto rails at scale while traditional issuers resist the trend.",
   "decision": "keep",
   "reason": "All three mentions continue existing stories: Base's tokenized equities rollout, Coinbase's tokenization strategy, and the broader RWA tokenization growth narrative, each now with the added tension of issuer pushback.",
   "targets": [
    {
     "entity": "base",
     "kind": "existing",
     "type": "protocol",
     "angle": "existing_story",
     "note": "Crowdfund Insider reports Base has put Apple, Alphabet, Microsoft and Amazon onchain as tokenized stocks, extending its ongoing tokenized equities expansion as the market hits $3.84B."
    },
    {
     "entity": "coinbase",
     "kind": "existing",
     "type": "organization",
     "angle": "existing_story",
     "note": "Per Crowdfund Insider, Coinbase's push to bring mega-cap public equities onchain through Base continues, now meeting reported pushback from the issuers themselves."
    },
    {
     "entity": "tokenization-rwa",
     "kind": "existing",
     "type": "topic",
     "angle": "existing_story",
     "note": "Crowdfund Insider reports tokenized stocks reaching $3.84B with mega-caps like Apple and Microsoft now onchain, continuing the sector's growth story amid rising issuer resistance."
    }
   ],
   "jev": [
    {
     "question": "Signal summary: \"Crowdfund Insider reports that Base, the Coinbase-backed layer-2 network, has put Apple, Alphabet, Microsoft, and Amazon onchain as tokenized stocks, with the tokenized stock market reaching $3.84B. The report notes pushback from issuers over the tokenization of their shares. This matters because it shows major public equities moving onto crypto rails at scale while traditional issuers resist the trend.\". Would a crypto trader or market watcher care about this, even if it is only talk for now?",
     "choices": [
      "keep",
      "ignore"
     ],
     "answer": "keep",
     "probabilities": {
      "keep": 0.97,
      "ignore": 0.03
     }
    },
    {
     "question": "This signal touches \"Base\". Candidate existing entities: base (Base, protocol). Does \"Base\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 1,
      "new": 0,
      "not_related": 0
     }
    },
    {
     "question": "This signal touches \"Coinbase\". Candidate existing entities: coinbase (Coinbase, organization); base (Base, protocol). Does \"Coinbase\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 1,
      "new": 0,
      "not_related": 0
     }
    },
    {
     "question": "This signal touches \"Tokenized stocks\". Candidate existing entities: tokenization-rwa (Tokenization of real-world assets, topic). Does \"Tokenized stocks\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 0.79,
      "new": 0.21,
      "not_related": 0
     }
    },
    {
     "question": "For \"Base\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "existing_story",
     "probabilities": {
      "new_story": 0,
      "existing_story": 0.99,
      "plain_update": 0.01
     }
    },
    {
     "question": "For \"Coinbase\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "existing_story",
     "probabilities": {
      "new_story": 0.01,
      "existing_story": 0.97,
      "plain_update": 0.02
     }
    },
    {
     "question": "For \"Tokenized stocks\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "existing_story",
     "probabilities": {
      "new_story": 0,
      "existing_story": 0.98,
      "plain_update": 0.02
     }
    }
   ]
  }
 },
 {
  "signal": {
   "signal_id": "3bed46f7813adab73db18d8e45a9e143bafd080b901f80cd064565821cc9233a",
   "source": "tokens_xyz",
   "text": "Elon Musk eyes Druckenmiller’s Hyperliquid move for US crypto derivatives",
   "link": "https://cryptobriefing.com/elon-musk-eyes-druckenmillers-hyperliquid-move-for-us-crypto-derivatives/"
  },
  "v5": {
   "summary": "Crypto Briefing reports that Elon Musk is eyeing Stanley Druckenmiller's move into Hyperliquid as a reference point for US crypto derivatives. The signal is a news report, not an announcement from Musk, Druckenmiller, or Hyperliquid themselves, so the claims remain at the report/talk level. It matters because it ties a prominent investor's Hyperliquid positioning to potential high-profile interest in US crypto derivatives markets.",
   "decision": "keep",
   "reason": "All three mentions kept per the decision tool: Musk and Hyperliquid as plain updates on existing shelves (reported interest, nothing announced), Druckenmiller as a new story since this signal introduces him.",
   "targets": [
    {
     "entity": "elon-musk",
     "kind": "existing",
     "type": "person",
     "angle": "plain_update",
     "note": "Reported (Crypto Briefing): Musk is eyeing Druckenmiller's Hyperliquid move as a reference for US crypto derivatives — reported interest, not an announcement from Musk."
    },
    {
     "entity": "stanley-druckenmiller",
     "kind": "new",
     "type": "person",
     "angle": "new_story",
     "note": "New story: Druckenmiller's reported move into Hyperliquid is drawing attention, with Crypto Briefing reporting that Musk is watching it for US crypto derivatives."
    },
    {
     "entity": "hyperliquid",
     "kind": "existing",
     "type": "protocol",
     "angle": "plain_update",
     "note": "Reported (Crypto Briefing): the protocol is again the venue of prominent-investor interest, now cited as the model Musk is eyeing for US crypto derivatives."
    }
   ],
   "jev": [
    {
     "question": "Signal summary: \"Crypto Briefing reports that Elon Musk is eyeing Stanley Druckenmiller's move into Hyperliquid as a reference point for US crypto derivatives. The signal is a news report, not an announcement from Musk, Druckenmiller, or Hyperliquid themselves, so the claims remain at the report/talk level. It matters because it ties a prominent investor's Hyperliquid positioning to potential high-profile interest in US crypto derivatives markets.\". Would a crypto trader or market watcher care about this, even if it is only talk for now?",
     "choices": [
      "keep",
      "ignore"
     ],
     "answer": "keep",
     "probabilities": {
      "keep": 0.84,
      "ignore": 0.16
     }
    },
    {
     "question": "This signal touches \"Elon Musk\". Candidate existing entities: elon-musk (Elon Musk, person). Does \"Elon Musk\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 1,
      "new": 0,
      "not_related": 0
     }
    },
    {
     "question": "This signal touches \"Stanley Druckenmiller\". The entity search found no existing entities for it. Does \"Stanley Druckenmiller\" need a new entity, or is it not related? Answer new or not_related.",
     "choices": [
      "new",
      "not_related"
     ],
     "answer": "new",
     "probabilities": {
      "new": 0.98,
      "not_related": 0.02
     }
    },
    {
     "question": "This signal touches \"Hyperliquid\". Candidate existing entities: hyperliquid (Hyperliquid, protocol); hype (HYPE, asset); hyperliquid-strategies (Hyperliquid Strategies, organization). Does \"Hyperliquid\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 1,
      "new": 0,
      "not_related": 0
     }
    },
    {
     "question": "For \"Elon Musk\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "plain_update",
     "probabilities": {
      "new_story": 0.02,
      "existing_story": 0.03,
      "plain_update": 0.95
     }
    },
    {
     "question": "For \"Stanley Druckenmiller\" (a new entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "new_story",
     "probabilities": {
      "new_story": 0.96,
      "existing_story": 0.03,
      "plain_update": 0.01
     }
    },
    {
     "question": "For \"Hyperliquid\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "plain_update",
     "probabilities": {
      "new_story": 0,
      "existing_story": 0.26,
      "plain_update": 0.74
     }
    }
   ]
  }
 },
 {
  "signal": {
   "signal_id": "0d4c3fb8ff4265b631a4859cf5594055e100972b1d336776aed0d11abff2a81b",
   "source": "tokens_xyz",
   "text": "BREAKING: Real-world assets on Solana just surpassed $5 billion, a new all-time high. https://t.co/cBFPnvEU6i",
   "link": "https://x.com/tokens/status/2115834550396047597"
  },
  "v5": {
   "summary": "The crypto data account tokens_xyz reported that real-world assets (RWAs) on Solana surpassed $5 billion in value, marking a new all-time high. This is a reported milestone, not an announcement from Solana itself. It matters because it signals accelerating tokenization of traditional assets on Solana, strengthening its position as a leading chain for RWAs.",
   "decision": "keep",
   "reason": "Both mentions continue existing stories: for Solana, the milestone extends the ongoing narrative of its RWA ecosystem growing; for the tokenization topic, it is a new data point in the sector's steady expansion. The signal is a reported milestone from a data account, not an announcement, so both notes are framed as reports within ongoing stories.",
   "targets": [
    {
     "entity": "solana",
     "kind": "existing",
     "type": "asset",
     "angle": "existing_story",
     "note": "Reported by tokens_xyz: real-world assets on Solana surpassed $5 billion, a new all-time high — another step in the ongoing growth of Solana's RWA ecosystem."
    },
    {
     "entity": "tokenization-rwa",
     "kind": "existing",
     "type": "topic",
     "angle": "existing_story",
     "note": "Solana's RWA value hitting a $5 billion all-time high, as reported by tokens_xyz, adds a fresh data point to the continuing expansion of real-world asset tokenization."
    }
   ],
   "jev": [
    {
     "question": "Signal summary: \"The crypto data account tokens_xyz reported that real-world assets (RWAs) on Solana surpassed $5 billion in value, marking a new all-time high. This is a reported milestone, not an announcement from Solana itself. It matters because it signals accelerating tokenization of traditional assets on Solana, strengthening its position as a leading chain for RWAs.\". Would a crypto trader or market watcher care about this, even if it is only talk for now?",
     "choices": [
      "keep",
      "ignore"
     ],
     "answer": "keep",
     "probabilities": {
      "keep": 0.98,
      "ignore": 0.02
     }
    },
    {
     "question": "This signal touches \"Solana\". Candidate existing entities: solana (Solana, asset); solana-dvp (Solana DvP, protocol); sunrise (Sunrise, protocol); jito (Jito, protocol). Does \"Solana\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 1,
      "new": 0,
      "not_related": 0
     }
    },
    {
     "question": "This signal touches \"Real-World Assets (RWA) on Solana\". Candidate existing entities: tokenization-rwa (Tokenization of real-world assets, topic). Does \"Real-World Assets (RWA) on Solana\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 0.74,
      "new": 0.26,
      "not_related": 0
     }
    },
    {
     "question": "For \"Solana\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "existing_story",
     "probabilities": {
      "new_story": 0,
      "existing_story": 0.99,
      "plain_update": 0.01
     }
    },
    {
     "question": "For \"Real-World Assets (RWA) on Solana\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "existing_story",
     "probabilities": {
      "new_story": 0,
      "existing_story": 0.93,
      "plain_update": 0.07
     }
    }
   ]
  }
 },
 {
  "signal": {
   "signal_id": "9b5c85c270f40b67a668a9ad1a8247d6452f56ad2f5cf57ff0fc90efcfa05410",
   "source": "tokens_xyz",
   "text": "Nearly 91% of tokenized stocks are issued outside the US, with Jersey, ADGM and BVI in front",
   "link": "https://cryptobriefing.com/tokenized-stocks-issued-outside-us-jersey-adgm-bvi/"
  },
  "v5": {
   "summary": "A Crypto Briefing report relayed by the tokens_xyz account says nearly 91% of tokenized stocks are issued outside the US, with Jersey, ADGM (Abu Dhabi Global Market) and the British Virgin Islands leading as issuance hubs. This points to tokenized-equity issuance clustering in offshore and crypto-friendly jurisdictions, likely reflecting US regulatory constraints. It matters for jurisdictions competing to attract tokenized securities business and for tracking the US's shrinking share of the emerging sector.",
   "decision": "keep",
   "reason": "The signal is a news report on tokenized stock issuance geography: it updates the existing tokenization/RWA topic with a market-structure statistic, and starts new stories for Jersey and ADGM as newly named tokenization hubs.",
   "targets": [
    {
     "entity": "tokenization-rwa",
     "kind": "existing",
     "type": "topic",
     "angle": "plain_update",
     "note": "A Crypto Briefing report (relayed by tokens_xyz) says nearly 91% of tokenized stocks are issued outside the US, with Jersey, ADGM and BVI in front — a data point on where tokenized equity issuance is actually landing."
    },
    {
     "entity": "jersey",
     "kind": "new",
     "type": "jurisdiction",
     "angle": "new_story",
     "note": "A Crypto Briefing report names Jersey as one of the leading jurisdictions for tokenized stock issuance, marking its emergence as a hub for tokenized equities."
    },
    {
     "entity": "adgm",
     "kind": "new",
     "type": "jurisdiction",
     "angle": "new_story",
     "note": "A Crypto Briefing report names ADGM (Abu Dhabi Global Market) as a leading venue for tokenized stock issuance, marking its emergence as a hub capturing issuance that avoids the US."
    }
   ],
   "jev": [
    {
     "question": "Signal summary: \"A Crypto Briefing report relayed by the tokens_xyz account says nearly 91% of tokenized stocks are issued outside the US, with Jersey, ADGM (Abu Dhabi Global Market) and the British Virgin Islands leading as issuance hubs. This points to tokenized-equity issuance clustering in offshore and crypto-friendly jurisdictions, likely reflecting US regulatory constraints. It matters for jurisdictions competing to attract tokenized securities business and for tracking the US's shrinking share of the emerging sector.\". Would a crypto trader or market watcher care about this, even if it is only talk for now?",
     "choices": [
      "keep",
      "ignore"
     ],
     "answer": "keep",
     "probabilities": {
      "keep": 0.97,
      "ignore": 0.03
     }
    },
    {
     "question": "This signal touches \"Tokenized stocks\". Candidate existing entities: tokenization-rwa (Tokenization of real-world assets, topic). Does \"Tokenized stocks\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 0.68,
      "new": 0.32,
      "not_related": 0
     }
    },
    {
     "question": "This signal touches \"Jersey\". The entity search found no existing entities for it. Does \"Jersey\" need a new entity, or is it not related? Answer new or not_related.",
     "choices": [
      "new",
      "not_related"
     ],
     "answer": "new",
     "probabilities": {
      "new": 0.94,
      "not_related": 0.06
     }
    },
    {
     "question": "This signal touches \"ADGM\". The entity search found no existing entities for it. Does \"ADGM\" need a new entity, or is it not related? Answer new or not_related.",
     "choices": [
      "new",
      "not_related"
     ],
     "answer": "new",
     "probabilities": {
      "new": 0.99,
      "not_related": 0.01
     }
    },
    {
     "question": "For \"Tokenized stocks\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "plain_update",
     "probabilities": {
      "new_story": 0,
      "existing_story": 0.11,
      "plain_update": 0.89
     }
    },
    {
     "question": "For \"Jersey\" (a new entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "new_story",
     "probabilities": {
      "new_story": 0.99,
      "existing_story": 0.01,
      "plain_update": 0
     }
    },
    {
     "question": "For \"ADGM\" (a new entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "new_story",
     "probabilities": {
      "new_story": 0.99,
      "existing_story": 0.01,
      "plain_update": 0
     }
    }
   ]
  }
 },
 {
  "signal": {
   "signal_id": "f89d45bbd398a54e02a11569426a5c7b171205d46823b41afbfe60fb027cd563",
   "source": "tokens_xyz",
   "text": "COINTELEGRAPH: Kalshi raises $1B at $40B valuation as non-sports revenue run rate tops $1B",
   "link": "https://cointelegraph.com/news/kalshi-closes-1b-funding-round-at-40b-valuation-as-non-sports-revenue-run-rate-tops-1b"
  },
  "v5": {
   "summary": "Cointelegraph reports that prediction market platform Kalshi has raised $1 billion in funding at a $40 billion valuation, with its non-sports revenue run rate surpassing $1 billion. The raise signals strong investor confidence in Kalshi's growth and its diversification beyond sports-related prediction markets. It underscores the rapid scaling of the prediction markets sector, where Kalshi is a leading player.",
   "decision": "keep",
   "reason": "The signal continues Kalshi's established growth narrative: a large funding round and revenue diversification milestone reported by a news outlet, fitting the existing story rather than starting a new one.",
   "targets": [
    {
     "entity": "kalshi",
     "kind": "existing",
     "type": "organization",
     "angle": "existing_story",
     "note": "Cointelegraph reports Kalshi raised $1B at a $40B valuation with non-sports revenue run rate topping $1B — another step in its ongoing scaling story, showing the push beyond sports markets is now generating revenue at scale."
    }
   ],
   "jev": [
    {
     "question": "Signal summary: \"Cointelegraph reports that prediction market platform Kalshi has raised $1 billion in funding at a $40 billion valuation, with its non-sports revenue run rate surpassing $1 billion. The raise signals strong investor confidence in Kalshi's growth and its diversification beyond sports-related prediction markets. It underscores the rapid scaling of the prediction markets sector, where Kalshi is a leading player.\". Would a crypto trader or market watcher care about this, even if it is only talk for now?",
     "choices": [
      "keep",
      "ignore"
     ],
     "answer": "keep",
     "probabilities": {
      "keep": 0.86,
      "ignore": 0.14
     }
    },
    {
     "question": "This signal touches \"Kalshi\". Candidate existing entities: kalshi (Kalshi, organization). Does \"Kalshi\" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.",
     "choices": [
      "existing",
      "new",
      "not_related"
     ],
     "answer": "existing",
     "probabilities": {
      "existing": 1,
      "new": 0,
      "not_related": 0
     }
    },
    {
     "question": "For \"Kalshi\" (an existing entity), what does this signal do there? new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.",
     "choices": [
      "new_story",
      "existing_story",
      "plain_update"
     ],
     "answer": "existing_story",
     "probabilities": {
      "new_story": 0,
      "existing_story": 1,
      "plain_update": 0
     }
    }
   ]
  }
 }
];
