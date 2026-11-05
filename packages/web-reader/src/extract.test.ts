import { describe, expect, test } from 'vitest';

import { extractArticleText, htmlToText } from './extract.js';
import type { FetchedPage } from './fetch-article.js';

function page(overrides: Partial<FetchedPage>): FetchedPage {
  return { url: 'https://example.test/a', status: 200, contentType: 'text/html; charset=utf-8', text: '', ...overrides };
}

describe('extractArticleText (#582, copied readableArticle)', () => {
  test('extracts the article body from an HTML page', () => {
    const result = extractArticleText(page({
      text: `<!doctype html><html><head><title>T</title></head><body>
        <nav>Menu links here</nav>
        <article><h1>Headline</h1><p>First paragraph with enough words to matter.</p>
        <p>Second paragraph also carries the article's actual information content.</p></article>
        <footer>footer</footer>
        <script>var tracking = "junk";</script>
      </body></html>`,
    }));
    expect(result).toContain('First paragraph');
    expect(result).toContain('Second paragraph');
    expect(result).not.toContain('Menu links');
    expect(result).not.toContain('junk');
    expect(result).not.toContain('footer');
  });

  test('uses explicit articleBody sections when several exist', () => {
    const result = extractArticleText(page({
      text: `<html><body>
        <div class="entry-content"><p>Part one of the story.</p></div>
        <div class="entry-content"><p>Part two of the story.</p></div>
      </body></html>`,
    }));
    expect(result).toContain('Part one');
    expect(result).toContain('Part two');
  });

  test('plain text responses pass through raw', () => {
    const result = extractArticleText(page({ contentType: 'text/plain', text: 'just some plain text\n' }));
    expect(result).toBe('just some plain text');
  });

  test('non-textual content types yield no extract', () => {
    expect(extractArticleText(page({ contentType: 'application/pdf', text: '%PDF' }))).toBeNull();
  });

  test('html without readable text yields null, not an empty string', () => {
    expect(extractArticleText(page({ text: '<html><body><div></div></body></html>' }))).toBeNull();
  });
});

describe('htmlToText (copied)', () => {
  test('drops tags and decodes the entities the collectors copy handles', () => {
    expect(htmlToText('<p>Nifty &amp; Co &mdash; "quoted" &#39;single&#39;</p>')).toBe('Nifty & Co &mdash; "quoted" \'single\'');
    expect(htmlToText('a&nbsp;b&lt;x&gt;y&quot;z')).toBe('a b<x>y"z');
  });

  test('strips script/style/noscript/svg content, tags become spaces or newlines', () => {
    const out = htmlToText('before<style>.x{}</style>mid<noscript>ns</noscript>after<script>bad()</script>');
    expect(out).toBe('before mid after');
  });
});
