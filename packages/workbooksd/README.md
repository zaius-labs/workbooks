# workbooksd — legacy

> **Status: legacy.** As of the 2026-05-04 pivot, `workbooksd` is no
> longer a primary surface of the workbooks product. The daemon still
> works, still ships signed builds for installed users, but it is **not
> the recommended path** for new authors or recipients.

## What this is

A small Rust daemon that brokers between a browser and the local
filesystem so a `.html` workbook can save edits back to disk. When a
user double-clicks a workbook, the OS routes the file to the daemon,
which mints a session token and opens the file in the user's default
browser. ⌘S in the browser writes new bytes back via the daemon.

The build pipeline, signing notes, macOS routing/quarantine workarounds,
and LaunchAgent quirks are still authoritative for installed users —
see the monorepo's `CLAUDE.md` for the pain-to-rediscover lessons.

## Why it's legacy

- The single-file `.html` artifact (built by `@work.books/cli`) is what
  most workbook authors actually want to ship. The CLI now embeds a
  gzipped source bundle inside every `.html` (`workbook unbundle` to
  recover), so artifact + source travel as one file. No daemon needed.
- The macOS install + Gatekeeper + LaunchServices routing + quarantine
  + OpenWith xattr dance is high-cost for low-value-to-most-users.
- Persistence-bearing workflows (login, per-user state, multi-recipient
  sharing) move to the hosted viewer at **workbooks.sh**, not a local
  daemon.

## Who should still use it

- Local power users who want save-in-place editing on their own machine.
- Existing deployments that already depend on the daemon's secrets
  vault, save scan, or per-file API key allowlist.
- Anyone hacking on the daemon itself.

## What's NOT happening

- New features.
- New install onboarding (the lander stopped advertising the daemon).
- New OS support.

Bug fixes for installed users are still welcome. So is making the build
pipeline easier for someone who wants to fork + run their own.

## How to build (still works)

```sh
# from the monorepo root
cd vendor/workbooks/packages/workbooksd/release/installer
./build.sh 0.3.7
```

See `release/installer/build.sh`, `release/release.sh`, and
`docs/SIGNING.md` upstream for the signing + notarization steps.

## Where to go instead

- **Author a workbook** → `npm install -g @work.books/cli && workbook init my-thing`
- **Ship a workbook** → `workbook build` produces a portable `.html`. Email it.
- **Persistent / multi-user** → upload to [workbooks.sh](https://workbooks.sh) for the hosted viewer.
