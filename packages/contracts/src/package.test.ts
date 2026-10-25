import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  name: string;
  dependencies: Record<string, string>;
};

describe('package.json', () => {
  it('has zod as the only runtime dependency', () => {
    expect(packageJson.name).toBe('@myboon/contracts');
    expect(Object.keys(packageJson.dependencies).sort()).toEqual(['zod']);
    expect(packageJson.dependencies.zod).toBe('^4.3.6');
  });
});