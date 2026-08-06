const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * `android.usesCleartextTraffic` in app.json is not a recognized Expo config
 * field (Expo silently drops it — no prebuild plugin reads it), so the
 * generated AndroidManifest.xml never got `usesCleartextTraffic="true"` on
 * any build. Every plain http:// request was refused by Android's network
 * stack before it left the device, with no log.
 *
 * Sets the attribute directly on the generated manifest's <application> tag,
 * the same way EAS's own prebuild would if the field were supported.
 */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application) {
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return config;
  });
};
