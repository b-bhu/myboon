// Price ticker data schema. One file per episode: episodes/<slug>/ticker.json
// Data is supplied by Bibhu each episode. Never invent real numbers.
import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";

export type TickerItem = { symbol: string; price: number; changePct: number };
export type TickerFile = { items: TickerItem[] };

export const isTickerFile = (x: unknown): x is TickerFile =>
  !!x && Array.isArray((x as TickerFile).items) &&
  (x as TickerFile).items.every((i) => typeof i.symbol === "string" && typeof i.price === "number" && typeof i.changePct === "number");

export const formatPrice = (p: number) =>
  "$" + p.toLocaleString("en-US", { minimumFractionDigits: p < 10 ? 4 : 2, maximumFractionDigits: p < 10 ? 4 : 2 });
export const formatChange = (c: number) => `${Math.abs(c).toFixed(2)}%`;

/** Loads episodes/<slug>/ticker.json (served via public/episodes symlink). */
export const useTickerData = (slug: string): TickerItem[] | null => {
  const [items, setItems] = useState<TickerItem[] | null>(null);
  const [handle] = useState(() => delayRender(`ticker ${slug}`));
  useEffect(() => {
    fetch(staticFile(`episodes/${slug}/ticker.json`))
      .then((r) => r.json())
      .then((j) => {
        if (!isTickerFile(j)) throw new Error(`episodes/${slug}/ticker.json does not match TickerFile schema`);
        setItems(j.items);
        continueRender(handle);
      });
  }, [slug, handle]);
  return items;
};
