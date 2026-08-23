import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findAdb() {
  const fromPath = spawnSync('adb', ['version'], { encoding: 'utf8' });
  if (!fromPath.error) return 'adb';

  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') : undefined,
    process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'Android', 'Sdk') : undefined,
    process.platform === 'linux' ? join(homedir(), 'Android', 'Sdk') : undefined,
  ].filter(Boolean);

  return sdkRoots
    .map((root) => join(root, 'platform-tools', executable))
    .find(existsSync);
}

const adb = findAdb();

if (!adb) {
  console.log('[local-api] ADB is unavailable; web still uses http://localhost:3000.');
  process.exit(0);
}

const devicesResult = spawnSync(adb, ['devices'], { encoding: 'utf8' });

if (devicesResult.status !== 0) {
  console.log('[local-api] Could not inspect Android devices; continuing without port forwarding.');
  process.exit(0);
}

const deviceIds = devicesResult.stdout
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter(([, state]) => state === 'device')
  .map(([id]) => id);

if (deviceIds.length === 0) {
  console.log('[local-api] No Android device connected; web still uses http://localhost:3000.');
  process.exit(0);
}

let forwarded = 0;

for (const deviceId of deviceIds) {
  const result = spawnSync(
    adb,
    ['-s', deviceId, 'reverse', 'tcp:3000', 'tcp:3000'],
    { encoding: 'utf8' },
  );

  if (result.status === 0) {
    forwarded += 1;
  } else {
    console.log(`[local-api] Could not forward port 3000 for Android device ${deviceId}.`);
  }
}

if (forwarded > 0) {
  console.log(
    `[local-api] Forwarded http://localhost:3000 to ${forwarded} Android device${forwarded === 1 ? '' : 's'}.`,
  );
}
