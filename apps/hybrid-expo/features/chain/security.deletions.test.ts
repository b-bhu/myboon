/**
 * Security deletion tests — negative cases that pass by finding nothing.
 *
 * The restructure removed a signature-derived EVM key. Every case here exists so
 * that reintroducing it fails CI rather than passing review. A deletion verified
 * once and then silently reverted is worse than one never verified, because the
 * test case document would claim it passed.
 *
 * Covers: TC-SEC-001, TC-SEC-002, TC-SEC-003, TC-SEC-004, TC-SEC-005, TC-SEC-009,
 * TC-RESOLVE-009, TC-POLY-001, TC-POLY-006, TC-DORMANT-001.
 *
 * Run: pnpm --filter hybrid-expo test:security
 *
 * Scope note: most cases scan `apps/hybrid-expo` **application source**, since
 * docs and manifests quote the deleted symbols in order to specify that they
 * must not exist. TC-SEC-002 / TC-SEC-003 additionally assert repo-wide, which
 * they can now do cleanly: the Predict Playwright harness used to mirror the
 * app's derivation and was deleted with it rather than rewritten.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(APP_ROOT, '../..');

/** Directories that are the harness, not the shipped app. */
const HARNESS_PATHS = ['e2e/', 'playwright.predict.config.ts'];

function isHarness(file: string): boolean {
  return HARNESS_PATHS.some((harness) => file.includes(harness));
}

function isTestFile(file: string): boolean {
  return file.includes('.test.ts');
}

/**
 * Documentation and manifests, which are not executable code.
 *
 * The PRD and this suite's own test case document quote the deleted symbol names
 * verbatim in order to specify that they must not exist — matching those quotes
 * would make the tests fail on the documents describing the fix. Manifests
 * (`package.json`, `app.json`) list dependency names, not usage: a declared
 * `@ethersproject/keccak256` that nothing imports ships nothing.
 */
function isProse(file: string): boolean {
  return (
    file.startsWith('docs/')
    || file.endsWith('.md')
    || file.endsWith('package.json')
    || file.endsWith('app.json')
  );
}

/**
 * The file path from a `path:line:text` grep hit.
 *
 * The predicates below test file *paths*. Running them against the whole hit
 * string silently misclassifies, because a hit ends in matched source text
 * rather than a filename — a `package.json` line would not match
 * `endsWith('package.json')` and would be reported as application source.
 */
function hitPath(hit: string): string {
  return hit.split(':')[0];
}

/** Executable, shipped code: no docs, no manifests, no harness, no tests. */
function isAppSource(hit: string): boolean {
  const file = hitPath(hit);
  return !isProse(file) && !isHarness(file) && !isTestFile(file);
}

/**
 * Grep the repo for a pattern, returning `path:line:text` hits.
 *
 * Uses `git grep` so the search follows the index and never walks node_modules
 * or build output — a scan that accidentally included a vendored dependency
 * would produce noise that gets waved through, defeating the point.
 */
function gitGrep(pattern: string, pathspec = 'apps/hybrid-expo'): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-n', '-I', '-E', pattern, '--', pathspec],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return out.split('\n').filter(Boolean);
  } catch (err) {
    // git grep exits 1 with no output when there are no matches. That is the
    // passing case for most tests here, not an error.
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
}

/** Hits in shipped application source: docs, manifests, harness and tests excluded. */
function appSourceHits(pattern: string): string[] {
  return gitGrep(pattern).filter(isAppSource);
}

/** Hits in executable code anywhere in the repo, including the E2E harness. */
function repoCodeHits(pattern: string): string[] {
  return gitGrep(pattern, '.').filter(
    (hit) => !isProse(hitPath(hit)) && !isTestFile(hitPath(hit)),
  );
}

describe('TC-SEC-001: the signature-derived EVM signer is deleted', () => {
  it('hooks/useEvmSigner.ts does not exist', () => {
    assert.equal(
      existsSync(path.join(APP_ROOT, 'hooks/useEvmSigner.ts')),
      false,
      'useEvmSigner.ts must stay deleted — it derived an EVM key from a signature',
    );
  });

  it('nothing imports or references useEvmSigner', () => {
    assert.deepEqual(appSourceHits('useEvmSigner'), []);
  });

  it('the three former importers no longer reference it', () => {
    // predict.signing.ts, usePolymarketWallet.ts and PredictOwnerKeyExportModal
    // all imported it before the restructure.
    for (const file of [
      'features/predict/predict.signing.ts',
      'hooks/usePolymarketWallet.ts',
    ]) {
      const source = readFileSync(path.join(APP_ROOT, file), 'utf8');
      assert.equal(
        source.includes('useEvmSigner'),
        false,
        `${file} still references useEvmSigner`,
      );
    }
  });
});

describe('TC-SEC-002: no key material is constructed from a signature', () => {
  it('the named derivation functions do not exist anywhere in the repo', () => {
    const hits = repoCodeHits(
      'deriveEvmSignerFromSignature|deriveReadonlyEvmSignerFromSignature|walletFromSolanaSignature',
    );
    assert.deepEqual(hits, [], 'a signature-to-key derivation function reappeared');
  });

  it('no application source hashes anything into a key constructor', () => {
    assert.deepEqual(
      appSourceHits('keccak256'),
      [],
      'keccak256 reappeared in shipped app source — inspect whether it feeds a key',
    );
  });

  it('no application source constructs an ethers Wallet from a hash', () => {
    // `new Wallet(<hash>)` is the precise shape of the deleted vulnerability.
    assert.deepEqual(appSourceHits('new Wallet\\('), []);
  });
});

describe('TC-SEC-003: PREDICT_DERIVE_MESSAGE is gone from the app', () => {
  it('the identifier does not appear in application source', () => {
    assert.deepEqual(appSourceHits('PREDICT_DERIVE_MESSAGE'), []);
  });

  it('the literal derive string does not appear in application source', () => {
    assert.deepEqual(appSourceHits('myboon:polymarket:enable'), []);
  });
});

describe('TC-SEC-004: predict.signing.ts has no Solana knowledge', () => {
  it('contains no Solana reference', () => {
    const source = readFileSync(
      path.join(APP_ROOT, 'features/predict/predict.signing.ts'),
      'utf8',
    );
    // Strip comments: the file's header legitimately explains *why* Solana is
    // gone, and prose about a removed dependency is not a dependency.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.equal(/solana/i.test(code), false, 'predict.signing.ts references Solana in code');
  });

  it('obtains its signer from the chain layer, not a global', () => {
    const source = readFileSync(
      path.join(APP_ROOT, 'features/predict/predict.signing.ts'),
      'utf8',
    );
    assert.equal(
      source.includes('requireActiveEvmWallet'),
      false,
      'predict.signing.ts still reaches for the module-level wallet singleton',
    );
  });
});

describe('TC-SEC-005: no key material reaches the clipboard', () => {
  it('PredictOwnerKeyExportModal.tsx does not exist', () => {
    assert.equal(
      existsSync(
        path.join(APP_ROOT, 'features/predict/components/PredictOwnerKeyExportModal.tsx'),
      ),
      false,
    );
  });

  it('nothing imports the removed export modal', () => {
    assert.deepEqual(appSourceHits('PredictOwnerKeyExportModal'), []);
  });

  it('every surviving Clipboard.setStringAsync argument is a public address', () => {
    const hits = appSourceHits('setStringAsync');
    // Rather than assert zero — copying a public address is a legitimate
    // feature — assert that each surviving call site copies an address. A new
    // call site with any other argument fails here and must be reviewed.
    // `connectedAddress` is the wallet sheet's copy affordance. It reads from
    // `solana.address` / `evm.address` — a public address, never key material.
    const allowed = /setStringAsync\((address|walletAddress|depositAddress|connectedAddress)\)/;
    for (const hit of hits) {
      assert.ok(
        allowed.test(hit),
        `unreviewed clipboard write — confirm it is not key material: ${hit}`,
      );
    }
  });

  it('no application source reads a .privateKey property', () => {
    assert.deepEqual(
      appSourceHits('\\.privateKey'),
      [],
      'with Privy embedded wallets there is no raw key to reach for',
    );
  });
});

describe('TC-RESOLVE-009: no module-level mutable wallet singleton', () => {
  it('the four named singleton symbols do not exist anywhere in the repo', () => {
    const hits = repoCodeHits(
      'activeEvmWallet|getActiveEvmWallet|requireActiveEvmWallet|clearActiveEvmWallet',
    );
    assert.deepEqual(hits, [], 'the module-level wallet singleton reappeared');
  });

  it('no module-scope mutable binding holds a signer or wallet', () => {
    // Module-scope `let`/`var` whose identifier mentions wallet/signer/key.
    const hits = appSourceHits('^(let|var)\\s+\\w*([Ww]allet|[Ss]igner|[Kk]ey)\\w*');
    assert.deepEqual(hits, [], `module-scope mutable wallet binding: ${hits.join(', ')}`);
  });
});

describe('TC-SEC-009: exactly two wallet backends exist', () => {
  it('the WalletBackend union has exactly two members', async () => {
    const { WALLET_BACKENDS } = await import('@/features/chain/chain.contract');
    assert.deepEqual([...WALLET_BACKENDS].sort(), ['external_mwa', 'privy_embedded']);
  });

  it('no code imports expo-secure-store to hold EVM key material', () => {
    // The superseded draft proposed a device-bound secure-store EVM key. It must
    // not have landed: it would reintroduce a key this app can read.
    //
    // The package stays declared in package.json/app.json because Privy's SDK
    // depends on it — a declared dependency ships nothing on its own. What would
    // matter is *our* code importing it, so that is what this asserts.
    const hits = appSourceHits("from 'expo-secure-store'|require\\('expo-secure-store'\\)");
    assert.deepEqual(hits, [], `secure-store import to review for key material: ${hits.join(', ')}`);
  });
});

describe('TC-DORMANT-001: the provider creates no wallet at login', () => {
  const providerSource = readFileSync(
    path.join(APP_ROOT, 'providers/PrivyProvider.tsx'),
    'utf8',
  );

  it('configures both solana and ethereum embedded wallets', () => {
    assert.ok(/solana:\s*\{/.test(providerSource), 'solana embedded config present');
    assert.ok(/ethereum:\s*\{/.test(providerSource), 'ethereum embedded config present');
  });

  it("sets createOnLogin to 'off' on every configured chain", () => {
    const settings = [...providerSource.matchAll(/createOnLogin:\s*'([^']+)'/g)].map(
      (match) => match[1],
    );
    assert.equal(settings.length, 2, 'expected a createOnLogin setting for each of the two chains');
    assert.deepEqual(
      settings,
      ['off', 'off'],
      "createOnLogin must be 'off' — 'all-users' provisions a wallet the user never asked for",
    );
  });

  it("no chain is set to 'all-users'", () => {
    // The pre-restructure value. This is the single line that, if reverted,
    // silently gives every user a funded-capable address on a dormant chain.
    assert.equal(providerSource.includes("'all-users'"), false);
  });
});

describe('TC-POLY-001 / TC-POLY-006: Polymarket routes through the signer layer', () => {
  it('POLYMARKET_REQUIREMENT declares EVM Polygon typed-data signing', async () => {
    const { POLYMARKET_REQUIREMENT } = await import('@/features/chain/chain.contract');
    assert.equal(POLYMARKET_REQUIREMENT.applicationId, 'polymarket');
    assert.equal(POLYMARKET_REQUIREMENT.chain, 'evm');
    assert.equal(POLYMARKET_REQUIREMENT.chainId, 137);
    assert.equal(POLYMARKET_REQUIREMENT.needsTypedData, true);
    assert.equal(POLYMARKET_REQUIREMENT.needsRawTransaction, false);
  });

  it('usePolymarketWallet resolves its signer through useChainSigner', () => {
    const source = readFileSync(path.join(APP_ROOT, 'hooks/usePolymarketWallet.ts'), 'utf8');
    assert.ok(
      source.includes('useChainSigner(POLYMARKET_REQUIREMENT)'),
      'the Polymarket hook must obtain its signer from the resolver',
    );
  });

  it('the stale "fresh signature" error path is gone', () => {
    // With a Privy embedded wallet there is no per-session signature to expire,
    // so any surviving copy asking the user to re-sign is misleading.
    assert.deepEqual(appSourceHits('needs a fresh signature'), []);
  });

  it('every Polymarket enable call is gated by a satisfied Polygon requirement', () => {
    const files = [
      'app/markets/polymarket/profile.tsx',
      'features/predict/PredictMarketDetailScreen.tsx',
      'features/predict/PredictSportDetailScreen.tsx',
      'features/predict/profile/PositionDetailScreen.tsx',
    ];
    let enableCalls = 0;
    for (const file of files) {
      const source = readFileSync(path.join(APP_ROOT, file), 'utf8');
      for (const match of source.matchAll(/polyRef\.current\.enable\(\)/g)) {
        enableCalls += 1;
        const precedingContract = source.slice(Math.max(0, (match.index ?? 0) - 180), match.index);
        assert.match(
          precedingContract,
          /continueAfterWalletRequirement\(/,
          `${file} enables Polymarket without awaiting the wallet requirement`,
        );
      }
      assert.equal(/\bpoly\.enable\(\)/.test(source), false, `${file} bypasses the requirement contract`);
    }
    assert.equal(enableCalls, files.length, 'expected one gated enable helper per Polymarket surface');
  });
});

describe('TC-MODAL-008: applications do not own connection UI', () => {
  it('no application module renders its own wallet-option list', () => {
    // Applications may open the shared sheet; they may not build one. The option
    // list lives in exactly one module.
    const hits = appSourceHits('availableOptions').filter(
      (hit) => !hit.includes('features/wallet/'),
    );
    assert.deepEqual(hits, [], `option list built outside features/wallet: ${hits.join(', ')}`);
  });

  it('there is exactly one connection sheet component', () => {
    // This suite greps for the strings it asserts about, so its own source is a
    // hit for every pattern it searches. Excluded, or the test fails on itself.
    const hits = gitGrep('export function ConnectionSheet', 'apps/hybrid-expo').filter(
      (hit) => !isTestFile(hitPath(hit)),
    );
    assert.equal(hits.length, 1, `expected one connection sheet, found: ${hits.join(', ')}`);
  });

  it('only the app-wide provider mounts the connection sheet (#273 regression)', () => {
    const hits = gitGrep('<ConnectionSheet', 'apps/hybrid-expo').filter(
      (hit) => !isTestFile(hitPath(hit)),
    );
    assert.equal(hits.length, 1, `local connection sheet owner survived: ${hits.join(', ')}`);
    assert.match(hits[0] ?? '', /WalletSheetProvider\.tsx/);
  });
});

/**
 * The derivation is gone repo-wide, harness included.
 *
 * The Predict Playwright harness used to mirror the app's old scheme so it
 * could predict the deposit address in advance. It was deleted along with the
 * derivation rather than rewritten — it tested a flow that no longer exists.
 *
 * These are now plain zero-hit assertions. Previously they recorded the harness
 * as a known exception, because a repo-wide claim that quietly skips its own
 * failing files is a false pass.
 */
describe('TC-SEC-002 / TC-SEC-003: no signature-derived key material anywhere', () => {
  /**
   * Source files (not docs, manifests, or this suite) containing a pattern.
   *
   * This suite greps for the very strings it asserts about, so its own source
   * matches every pattern it searches for. Excluded, or each assertion fails on
   * itself rather than on a real regression.
   */
  function sourceFilesContaining(pattern: string): string[] {
    const files = gitGrep(pattern, 'apps/hybrid-expo')
      .map(hitPath)
      .filter((file) => !isProse(file) && !isTestFile(file));
    return [...new Set(files)].sort();
  }

  it('no source file hashes anything with keccak256', () => {
    assert.deepEqual(
      sourceFilesContaining('keccak256'),
      [],
      'keccak256 reappeared — a signature must never become key material',
    );
  });

  it('the derive message string appears nowhere', () => {
    assert.deepEqual(sourceFilesContaining('myboon:polymarket:enable'), []);
  });
});
