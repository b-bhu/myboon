# ADR: Deep research uses a transient systemd service

Status: proposed; implementation foundation is disabled by default and has not
been verified on the production VPS.

## Decision

Deep-research jobs run as transient **service** units created with
`systemd-run --wait --collect --pipe --unit=...`. They do not use
`systemd-run --scope`: a scope would leave lifecycle ownership with the caller,
while a service lets systemd own the complete control group and apply
`RuntimeMaxSec` and `KillMode=control-group`.

Every unit receives explicit CPU, memory, task, runtime, filesystem, privilege,
and address-family restrictions. Job/profile files live in a private temporary
directory. The coordinator does not release a timeout, cancellation, or output
limit result until `systemctl is-active --quiet <unit>` confirms inactivity.
It sends TERM to the entire unit, waits a bounded grace period, sends KILL when
still active, and retains registered metadata/temp state if the group survives.

`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` reduces the available socket
families but does **not** filter DNS names. Approved-domain enforcement belongs
to the registered browser/search/HTTP worker connectors. This design does not
claim systemd provides hostname allowlisting.

## Deployment verification

Before enabling Phase 6 on a VPS, an operator must inspect the generated unit
and run a disposable failure-injection job. Useful read-only checks include:

```bash
systemd-run --version
systemctl --version
systemctl show <unit.service> \
  --property=Type,CPUQuotaPerSecUSec,MemoryMax,TasksMax,RuntimeMaxUSec \
  --property=PrivateTmp,ProtectSystem,ProtectHome,NoNewPrivileges,KillMode \
  --property=RestrictAddressFamilies,ActiveState,SubState,ControlGroup
systemctl status <unit.service> --no-pager
```

The failure-injection procedure must demonstrate that timeout and cancellation
leave the unit inactive with no live PIDs in its `ControlGroup`, and that the
temporary/profile directory is removed. These checks are deployment
requirements; this ADR does not assert they have already passed on any host.
