# Publisher startup — 6 October 2026

At the owner's request, the existing `myboon-publisher` PM2 process was started using `pm2 start ecosystem.config.cjs --only myboon-publisher`. It had been absent from the process list. The verified process list was saved with `pm2 save`.

Publisher runs live, every five minutes, with a batch size of ten. It reads eligible editor drafts from the existing SQLite store and publishes them through the existing `published_narratives` path. No V4 downstream integration or consumer adapter was added.

The first cycle completed at 13:39:20 UTC: zero drafts fetched, zero publications written, zero existing publications reconciled and zero skips. PM2 reported Publisher online, PID `2225249`, with zero restarts. No publication write was exercised because no eligible drafts were available.

`myboon-api` remained online with PID `1719088`, restart count `1` and unchanged uptime identity `1791000387540`. Collectors and Entity Manager retained their process identities. Research remained stopped; Editor remained absent. The pending article-fix migration was not applied, and those fixes were not activated by this startup.
