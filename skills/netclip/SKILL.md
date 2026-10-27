---
name: netclip
description: Use the Netclip CLI to read or send shared clipboard content, transfer and organize files in Netclip Drive, and bind Drive folders to local download directories. Use for Netclip tasks, not Google Drive or unrelated cloud storage.
---

# Netclip

Use the existing `netclip` CLI for clipboard and Drive operations. It supports `--json` for structured output, including errors on stderr and nonzero exit codes. Application development and deployment are separate repository work.

## Connection and execution host

- On first use, run `netclip config --json` to check the selected server. Use `netclip --help` for command details instead of inventing flags.
- The installed executable is `~/.local/bin/netclip` on the user's Mac and on `starpub-docker`. If it is missing from PATH, invoke that path. A repository checkout also provides `node cli/netclip.mjs`; the CLI needs Node 22+ and no npm dependencies.
- The user's service is `http://100.106.235.95:3210`, reachable through Tailscale. On starpub itself, the local endpoint is `http://127.0.0.1:3210`. Prefer the existing configuration; `--url URL` overrides it for a single command.
- Local source paths, download paths and bindings refer to the machine executing the command. Run on the intended sending or receiving device.
- If a request cannot reach the service, check the selected URL and Tailscale connection before retrying. File operations do not require a service redeployment or application password.

## Drive operations

Resolve the requested remote folder with `drive ls` or a scoped `drive tree`. Use returned paths or `id:123`; do not guess IDs. Quote paths containing spaces. Examples below use `/Projects` as a replaceable remote path:

```sh
netclip drive ls / --json
netclip drive tree /Projects --json
netclip drive mkdir /Projects/Notes --json
netclip drive upload ./report.pdf ./assets --to /Projects --json
netclip drive download /Projects/report.pdf /Projects/assets --to ./downloads --json
netclip drive rename /Projects/report.pdf final.pdf --json
netclip drive move /Projects/final.pdf --to /Projects/Notes --json
```

Uploads and downloads handle complete folder trees, including empty folders. Existing names receive numbered suffixes; these commands copy files rather than synchronize or overwrite an existing tree. If a batch fails, inspect its `completed` entries and retry only the remaining work to avoid duplicate uploads. `drive rm PATH...` permanently deletes the selected entries and folder contents; use it for the user's requested deletion, not as automatic transfer cleanup.

For a requested single ZIP, the web UI offers **Download ZIP**, and the API provides `GET /api/drive/download?ids=1,2,3` or `GET /api/drive/entries/123/download` for a folder. The CLI's `drive download` writes the folder tree directly rather than a ZIP.

On macOS, `netclip drive mount --json` exposes a read-only volume at `~/Netclip/Drive` using rclone's local NFS bridge with on-demand downloads. It needs the official rclone binary at `~/.local/bin/rclone`, on PATH, or in `NETCLIP_RCLONE`. Use `--to DIR` for another empty mount point, `drive status --json` to inspect the mount, helper and cache policy, `drive refresh` to invalidate the 30-second in-memory directory index, and `drive unmount` to eject, stop its helper and clear its temporary cache. Reconnect after reboot or ejecting the volume.

Finder Favorites must point to the local parent `~/Netclip`, with the mounted `Drive` inside it. A favorite pointing directly to the network volume can become an invalid alias after remounting. `drive mount` migrates the old default mount from `~/Netclip`; replace an old favorite with the local parent afterward. If Finder reports that the original item cannot be found, dismiss its Netclip error, inspect `drive status`, reconnect with `drive mount`, and repair only the Netclip favorite. Disk-space queries are local, and remote requests have short connection/idle timeouts. Do not claim offline file availability or automatically restart Finder when dismissing its error is sufficient.

Each mount starts a guard that probes root metadata every 5 seconds with a 3-second timeout. It detaches only that read-only volume after two consecutive failures or a stopped helper, and stops the helper and clears its cache after a Finder eject. This releases pending Finder requests. The local parent remains accessible; reconnect explicitly with `drive mount` when the connection returns. `drive status` includes `disconnectedReason`; do not claim that an empty, unmounted `Drive` folder means remote files were deleted.

Directory browsing fetches metadata. Only file bytes requested by applications enter the temporary content cache, with read-ahead disabled. Inactive data expires after 30 seconds with 10-second cleanup checks; 256 MiB is an eviction target, not a hard cap while files are in use. Finder previews may read bytes before selection, and applications can keep their own temporary files. Do not claim zero disk use or delete application caches automatically. Use `drive download` for an explicitly retained local copy and the UI or CLI for writes. Do not switch to Finder's direct WebDAV connection when this automatic-cleanup policy matters.

## Migrate an instance

For a user-requested migration of all Drive and history data, use:

~~~sh
netclip migrate --from old-server --to new-server --json
~~~

The hosts are SSH aliases or user@host; local means the execution device, and --from defaults to local. Run on the computer that can SSH into both endpoints. The command defaults to existing Docker containers named netclip, manages their stop/restart state, and checks transferred data before switching the target. Override names with --source-container / --target-container. For native deployments, stop their processes first and specify --source-dir / --target-dir with --stopped; these paths belong to the respective endpoints. Check netclip migrate --help for requirements.

Migration preserves the database and original IDs, files, history metadata and pins. Source data stays in place. A nonempty target is refused unless --replace is explicitly selected for the requested replacement; the old target data is retained at the reported backup path. This is whole-instance replacement, not a merge. Report the backup and any recovery errors; do not bypass migration locks or delete recovery data. Retention settings, client URL configuration and download bindings remain separate.

## Download directory bindings

```sh
netclip drive bindings --json
netclip drive bind /Projects "$HOME/Downloads/Projects" --json
netclip drive download /Projects --json
netclip drive unbind /Projects --json
```

Use the user's specified local destination, or an existing binding when none is specified. Bindings persist per execution device and server URL, keyed by remote folder ID, and survive remote renames/moves. Destination priority is `--to`, the nearest bound folder, then `~/Downloads/Netclip`. Binding `/` changes that server's default. Use the same server URL when reusing bindings.

With `--to DIR`, a selected folder is downloaded inside DIR; an exact folder binding receives that folder's contents directly. Downloading a folder keeps its whole tree together at that destination. A directly selected nested entry inherits the nearest binding. These bindings apply to CLI downloads; browser downloads follow browser settings.

## Shared clipboard

```sh
netclip clipboard list --query review --json
netclip clipboard get 123 --json
printf '%s' 'Ready for review' | netclip clipboard put --json
netclip clipboard upload ./screenshot.png --json
netclip clipboard download 123 --to ./downloads --json
netclip clipboard pin 123 --json
```

Replace IDs with actual list results. `get` returns full text, including content truncated in list previews; without `--json`, text is printed directly. `put` also accepts a text argument, and reads stdin when omitted. `unpin` and `rm` accept item IDs. Clipboard entries can expire; use Drive for durable file storage or pin clipboard content when the user asks to retain it.

Confirm the result using the CLI output and report the resulting remote path or local saved path. For partial failures, distinguish completed work from the entries still needing attention.
