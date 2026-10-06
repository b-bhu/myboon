# Native evidence — October 6, 2026

Read the [S01–S20 report](../../issue-305.md) for scenario status and limits. Captures are physical Android pixels; XML is a freshly dumped native UI tree where supplied. UIAutomator was not run while TalkBack was active.

The main interaction GIF uses the disposable development fixture, reusing the production controller and Wallet panel. It is approximately 2.6 frames/second without audio. Android screenrecord is blocked on this handset. This is sufficient to see UI outcomes; it does not prove fine animation timing, audible accessibility labels, real wallet SDK approval or chain settlement.

Captures were made with the existing ADB/Metro/API processes. No server was manually launched/restarted. The original hosted API setting, TalkBack, font and animation settings were restored. The Metro USB bridge remains.

## Capture commands

`adb -s <device> exec-out screencap -p > <name>.png`

`adb -s <device> shell uiautomator dump /sdcard/myboon-305-window.xml`

`adb -s <device> pull /sdcard/myboon-305-window.xml <name>.xml`

Native tap/input operations used fresh visible control bounds from the accessibility tree. Real-wallet checks stopped before confirmation/signing. A separate execution helper allowed the confirmation gesture only when the disposable-fixture banner, whitelisted case and disposable review route were all visible.

The frame recorder repeatedly captured screencap pixels with wall-clock timestamps; GIF delays reflect those timestamps. Input timing JSON is distinct from rendered frame timing. No screenshot was fabricated from HTML.

## Evidence selection

Only useful captures and supporting logs are included. Superseded recordings, failed capture attempts, stale XML/pixel pairs and misleadingly named captures were removed from this review set. The raw run was backed up locally before selection. The baseline capture is after the original implementation: no historical pre-redesign native image exists.

The final confirmation retest is 133; it follows the fixture totals/refresh instrumentation repairs. The 59 confirmation recording predates those repairs. It documents the native confirmation interaction only; use 133 for the final result/counters.

No API keys, private keys or transaction bytes are included. The public connected account appears in read-only evidence; signing/execution fixtures use disposable keys and memory-only pending state.
