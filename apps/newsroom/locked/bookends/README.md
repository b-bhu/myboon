# locked/bookends

Locked intro, sign-off and end card assets.

LOCKED assets are made once, approved, and reused every episode. Never regenerated per episode.

## Intro (v1, locked, approved Nov 1, 2026)
| File | What | In git |
|---|---|---|
| intro_voice.mp3 | "Good morning, and welcome to MyBoon News. I'm Hank Walsh. Here's what's moving." Grok TTS orion @1.1x, 4.75 s, -14.0 LUFS, -1.6 dBTP | yes |
| intro_v1.mp4 | 1920x1080, 30 fps, 5.05 s. Grok Imagine image-to-video from locked/hosts/hank_master_center_wide_v1.jpg (generated mute-equivalent; take audio replaced with intro_voice.mp3, voice at 0.00 s, ~0.3 s tail) | yes |

Raw take, frames and contact sheet: /workspace/myboon-news/intro_tests/

## Sign-off (v1, awaiting approval)
| File | What | In git |
|---|---|---|
| signoff_voice.mp3 | "This is MyBoon News." Grok TTS orion @1.1x, 1.54 s, gain + limiter to -13.9 LUFS, -2.2 dBTP | yes |
| signoff_v1.mp4 | 1920x1080, 30 fps, 3.0 s. One Grok Imagine take from locked/hosts/hank_master_center_mcu_v1.jpg, locked-off camera; take audio replaced with signoff_voice.mp3 at 0.00 s (take speech starts 0.10 s) | yes |

Raw take, frames and contact sheets: /workspace/myboon-news/signoff_tests/

## End card (v1, awaiting approval)
| File | What | In git |
|---|---|---|
| endcard_v1.mp4 | 1920x1080, 30 fps, 3.0 s, silent. Remotion composition `EndCard` (src/components/EndCard.tsx): walletCore #031F2C, wordmark (630 px wide) fades up over 0.5 s, then holds. No glow, gradient, tagline or SFX | yes |

Re-render: `npx remotion render src/index.ts EndCard locked/bookends/endcard_v1.mp4`
