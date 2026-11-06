/**
 * #582 article extraction. readableArticle and htmlToText are copied verbatim
 * from packages/collectors/src/research-engine/deterministic-retrieval.ts
 * (CTO decision 7: copy, do not move to shared and do not depend on
 * @myboon/collectors). Parsing is local only: jsdom's scripts and resource
 * fetching stay disabled.
 */
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';

import { mediaTypeOf, type FetchedPage } from './fetch-article.js';

export function readableArticle(html: string, url: string): string {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    dom.window.document.querySelectorAll('nav, footer, aside, form, script, style, noscript, svg').forEach(node => node.remove());
    // Some publishers explicitly mark the article body, including multiple
    // sections around ads. Preserve all such sections in document order rather
    // than letting a short article be joined to neighbouring recommendation cards.
    const bodies = [...dom.window.document.querySelectorAll('[itemprop="articleBody"], article.article-content, .entry-content, .document-body')];
    const outerBodies = bodies.filter(node => !bodies.some(other => other !== node && other.contains(node)));
    const bodyText = outerBodies.map(node => htmlToText(node.innerHTML)).filter(Boolean).join('\n\n');
    if (bodyText) return bodyText;
    const parsed = new Readability(dom.window.document, { charThreshold: 0, maxElemsToParse: 60_000 }).parse();
    return parsed?.content ? htmlToText(parsed.content) : htmlToText(dom.window.document.body.innerHTML);
  } finally { dom.window.close() }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|section|article|main|header|footer|h[1-6]|li|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Page text for one fetched page: HTML (or HTML-sniffed) goes through
 * readableArticle; other text/* responses are used raw; anything else (PDFs,
 * images, JSON APIs) yields no extract.
 */
export function extractArticleText(page: FetchedPage): string | null {
  const media = mediaTypeOf(page.contentType);
  if (media === 'text/html' || media === 'application/xhtml+xml' || /<html[\s>]/i.test(page.text)) {
    return readableArticle(page.text, page.url) || null;
  }
  if (media === null || media.startsWith('text/')) {
    return page.text.replace(/\u0000/g, '').trim() || null;
  }
  return null;
}
