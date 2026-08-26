const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Support monorepo: watch the whole root
config.watchFolders = [monorepoRoot];

// Resolve packages from both the app and monorepo root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Privy-recommended resolve overrides
const resolveRequestWithPackageExports = (context, moduleName, platform) => {
  // Workspace packages emit Node-compatible `.js` specifiers from TypeScript
  // source. During Expo development Metro consumes that source directly, so
  // resolve those relative specifiers back to their `.ts` modules.
  if (
    context.originModulePath.includes(path.join('packages', 'shared', 'src'))
    && moduleName.startsWith('.')
    && moduleName.endsWith('.js')
  ) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }

  // Node 'crypto' has no RN equivalent — alias to the native quick-crypto polyfill.
  // Native only: react-native-quick-crypto is a JSI/native module with no web build —
  // on web, Metro's default resolver already maps 'crypto' to Node's crypto/browserify shim.
  if (moduleName === 'crypto' && (platform === 'ios' || platform === 'android')) {
    return context.resolveRequest(context, 'react-native-quick-crypto', platform);
  }

  // isows (viem dep) — package exports incompatible
  if (moduleName === 'isows') {
    const ctx = { ...context, unstable_enablePackageExports: false };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  // zustand@4 — package exports incompatible
  if (moduleName.startsWith('zustand')) {
    const ctx = { ...context, unstable_enablePackageExports: false };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  // jose — force browser build (no Node crypto/zlib)
  if (moduleName === 'jose') {
    const ctx = { ...context, unstable_conditionNames: ['browser'] };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  // Privy packages — enable package exports
  if (moduleName.startsWith('@privy-io/')) {
    const ctx = { ...context, unstable_enablePackageExports: true };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.resolveRequest = resolveRequestWithPackageExports;

module.exports = config;
