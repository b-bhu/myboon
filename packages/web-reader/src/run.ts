/**
 * CLI entry: run the web reader once against the atlas database, then exit.
 * The WEB_READER_ENABLED gate (off by default) wraps everything: when off, no
 * config is parsed and no Pool, socket or network is ever opened.
 * WEB_READER_DATABASE_URL is read from the environment and NEVER logged; it
 * comes from DB Guy's migration PR (web_reader_worker role) on this repo.
 */
import { webReaderEntry } from './reader.js';

webReaderEntry().catch((e: unknown) => {
  // Config errors name the key; fetch/Hermes errors name exit/signal identity. No values.
  console.error(`web-reader: run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
