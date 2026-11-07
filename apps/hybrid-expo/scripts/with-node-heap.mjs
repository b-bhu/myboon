import { spawn } from 'node:child_process';

// cross-env is not a dependency. Spawn via Node so NODE_OPTIONS is set the
// same way on macOS, Linux, and Windows. Metro workers inherit the env, so
// the larger heap applies to the process that deserializes the cache.
const HEAP_FLAG = '--max-old-space-size=8192';

function withHeap(existing) {
  const stripped = (existing ?? '')
    .replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped ? `${stripped} ${HEAP_FLAG}` : HEAP_FLAG;
}

const nodeOptions = withHeap(process.env.NODE_OPTIONS);
const env = { ...process.env, NODE_OPTIONS: nodeOptions };
const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error('usage: with-node-heap.mjs <command> [...args]');
  process.exit(1);
}

console.log(`[heap] NODE_OPTIONS=${nodeOptions}`);

const child = spawn(command, args, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`[heap] Failed to start ${command}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});
