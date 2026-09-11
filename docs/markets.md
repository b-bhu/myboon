# myboon Markets

Status: current product note (August 29, 2026)
Scope: what Markets is in myboon, what is integrated now, and what is planned next

## What Markets Is

Markets is the action layer of myboon.

The Feed helps users understand what changed in the market. Markets gives users a
place to inspect the related market, venue, or action surface inside the app.

```text
Feed explains what changed -> Markets shows the related action surface
```

Markets is not meant to be a generic trading terminal. It exists because an
explanation becomes more useful when the user can move from the developing
story to a clear market surface without jumping across many apps.

The role of Markets is to connect market intelligence to places where the user
can inspect, compare, understand, or act.

## How Markets Fits Into myboon

myboon helps users understand why a market moved and act from the same mobile
app. Markets is the product layer that completes the loop between a researched
story, a relevant action, and the position that follows.

```text
signal -> Feed context -> Markets surface -> user inspection or action
```

The Feed is responsible for noticing and explaining important market changes.
Markets is responsible for making the relevant market or venue available inside
the app in a useful way.

Markets can include prediction markets, perps venues, swaps, liquidity apps, and
other market surfaces where users may want to inspect data or take action.

## Market Categories

Markets are grouped by category so product work and agent research can stay
scoped.

```text
Prediction markets -> Polymarket
Perps              -> Pacifica, Phoenix
LP / Liquidity     -> Meteora, Raydium, Orca
```

Category notes:

- [`markets/categories/prediction.md`](markets/categories/prediction.md)
- [`markets/categories/perps.md`](markets/categories/perps.md)
- [`markets/categories/lp.md`](markets/categories/lp.md)

## Current Integrated Markets

The current beta contains product surfaces for:

```text
Polymarket
Pacifica
Phoenix
Meteora
Jupiter-routed spot swaps
```

The strongest demonstrated bridge is currently a Bitcoin Story that opens the
Phoenix BTC perpetual market and carries researched event markers onto its
chart. Other story-to-market routes should be treated as beta work, not as a
fully generalized system.

## Next Pipeline

The next Markets pipeline is focused on improving reliability and consistency
across the existing surfaces, then expanding liquidity coverage through:

```text
Raydium
Orca
```

These are expected to expand the liquidity category beyond the existing Meteora
surface.

## Future Dedicated Market Docs

This file should stay high-level.

Detailed notes for individual market integrations should live in dedicated docs,
for example:

```text
docs/markets/polymarket.md
docs/markets/pacifica.md
docs/markets/phoenix.md
docs/markets/meteora.md
docs/markets/raydium.md
docs/markets/orca.md
```

Those dedicated docs can explain the intention, implementation, user experience,
open questions, and roadmap for each market surface.

## Direction

Markets should become the product layer where myboon users can go from market
intelligence to relevant market surfaces.

Near-term, that means strengthening:

```text
Polymarket
Pacifica
Phoenix
Meteora
Spot swaps
```

Next, it means researching and adding:

```text
Raydium
Orca
```

The long-term direction is a mobile Markets layer that helps users understand not
just that something moved, but where the related market action is happening.

## References

- [`VISION.md`](VISION.md)
- [`FEED.md`](FEED.md)
