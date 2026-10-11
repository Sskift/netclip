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
