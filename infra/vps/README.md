# infra/vps

VPS deployment and operations material for the Myboon server. Everything here
is repo documentation; nothing in this directory installs or changes anything
without a deliberate step (see deploy.sh / install-systemd.sh).

## Log rotation

PM2 app logs (`~/.pm2/logs/*.log` and per-app error logs) rotate via the
pm2-logrotate module, decided settings (max_size 50M, retain 7, compress):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

Check the active values afterwards with `pm2 conf pm2-logrotate`.
