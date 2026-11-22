# Device tests (Maestro)

Flows live in `.maestro/<module>/` and start with their case ID, for example `wallet/WAL-001-modes.yaml`. Run them only on a laptop with the phone plugged in; never on the VPS. The `device-tester` agent (`.claude/agents/device-tester.md`) runs them.

Maestro is installed at `~/.maestro/bin/maestro`.

## Weekly build and test (Sundays, and when a big group of issues merges)

Always test the latest `main`.

1. **Build.** From `apps/hybrid-expo`, make a preview APK. It is installable and has no dev launcher that would block Maestro. It uses the live API at `api.myboon.tech`, so it only shows what is merged in the app *and* deployed on the server. The cloud build uses Expo build minutes (check the plan's limit).

   ```bash
   npx eas-cli build -p android --profile preview
   ```

2. **Install** the downloaded APK on the phone:

   ```bash
   adb install -r path/to/the.apk
   ```

3. **Test.** Plug the phone in, unlock it, USB debugging on, and ask the `device-tester` agent to run the cases for what merged this week. It first checks the build is not behind `main`, then runs the `agent` cases and hands you a checklist for the `bibhu` cases.
4. **Your checklist.** Anything with balances, signing or money is yours. Tell the agent when each is done.
5. **Record.** Each case gets pass or fail, the date and the build's commit. Every failure becomes an issue. Compare the passes against the acceptance sections in the module's wiki page to see whether the docs are up to date.

## Rules

- Case owner is `agent` or `bibhu`. Money, balances and signing are `bibhu`. An unmarked case counts as `bibhu`.
- Run only the cases tied to the issue or week. Not the whole suite.
- Screenshots, logs and UI dumps go in a temp folder outside the repo and are deleted afterwards.
- Never start Metro or any server without asking.
