import { describe, it, expect } from 'vitest';
import { fetchWalletTransactions } from '../rpc.js';
import { parseSingleTransaction } from '../parsers/transaction.js';
import { integrationTestsEnabled } from './fixtures.js';

describe.skipIf(!integrationTestsEnabled)('wallet analysis: 7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C', () => {
  it('analyzes transaction breakdown', async () => {
    const wallet = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C';
    const transactions = await fetchWalletTransactions(wallet, { count: 50 });
    
    let parsed = 0;
    const types: Record<string, number> = {};
    const unknown: Array<{sig: string, type: string, programs: string[]}> = [];
    
    for (const tx of transactions) {
      const result = parseSingleTransaction(tx);
      if (result && result.type !== 'unknown') {
        parsed++;
        types[result.type] = (types[result.type] || 0) + 1;
      } else {
        const instructions = tx.transaction.message.instructions || [];
        const programs = instructions.map((i: any) => i.programId?.toString().slice(0, 8) || 'unknown').slice(0, 5);
        unknown.push({ sig: result?.signature || 'no-sig', type: result?.type || 'no-type', programs });
      }
    }
    
    console.log('\n=== WALLET ANALYSIS ===');
    console.log(`Total: ${transactions.length}`);
    console.log(`Parsed: ${parsed} (${Math.round(parsed/transactions.length*100)}%)`);
    console.log(`Unknown: ${unknown.length} (${Math.round(unknown.length/transactions.length*100)}%)`);
    console.log('\nBreakdown:');
    for (const [type, count] of Object.entries(types)) {
      console.log(`  ${type}: ${count}`);
    }
    console.log('\nUnknown transactions with program hints:');
    unknown.slice(0, 5).forEach(u => console.log(`  ${u.sig.slice(0, 16)}... => ${u.programs.join(', ')}`));
    
    expect(transactions.length).toBeGreaterThan(0);
  });
});
