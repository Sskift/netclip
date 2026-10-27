# netclip

A shared clipboard and personal drive for your devices, hosted on your own machine.

This fork of [silentiris/netclip](https://github.com/silentiris/netclip) adds permanent file storage, folders, whole-folder imports, and a unified **Clipboard / Drive** workspace. Open the same address on your computer and phone to access your content.

Netclip has no login or password. Devices that can reach the instance share the same clipboard and drive, including permission to change or delete content. Run it on a trusted LAN or inside your Tailscale network.

## One workspace, two views

| | Clipboard | Drive |
|---|---|---|
| Use it for | Quickly sharing text, links, images, and attachments | Keeping and organizing files |
| Organization | Search, pinned items, chronological history | Nested folders, search within a folder, sorting, list/grid views |
| Retention | Unpinned text/files: 7 days; images: 3 days by default | Kept until you delete them |
| Upload limit | 25 MiB per clipboard upload | 512 MiB per file |

Switch between **Clipboard** and **Drive** at the top of `/`. Switching preserves your search and current folder without reloading the page. Older `/drive` bookmarks open the Drive tab in the same workspace.

The interface uses English throughout, with shared compact controls and menus, light/dark themes, and layouts for desktop and phone. Fonts are served locally: DM Sans for the interface, Libre Baskerville for headings, and Resource Han Rounded for Chinese content. Font licenses are included in [web/public/fonts](web/public/fonts).

### Clipboard

- Paste with **Cmd/Ctrl + V** while the Clipboard tab is active, or drag in files.
- Search your history, copy text, open links, download attachments, and pin items to keep them.
- On a phone, use **Add to netclip** to send content. Long-press images to use the browser's copy/save actions; image-copy buttons appear when supported.
- Pasted images show a local preview while uploading, then reuse the original local image for preview without downloading it again. The original file is preserved for other devices and downloads.
- Deleting a clipboard item offers a six-second undo window. Drive deletions are permanent and do not use this undo flow.
- Connected devices receive updates automatically.

### Drive

- Create folders and subfolders; rename, move, download, and delete entries.
- Use **Upload → Upload files** for individual files, or **Upload → Upload folder** for a complete folder.
- Drag files or folders directly into Drive to upload them to the folder you are viewing.
- Folder imports retain the top-level folder name and nested paths. Drag-and-drop also preserves empty folders; the system folder picker supplies files only, so empty directories are omitted.
- Uploading a name that already exists adds a numbered suffix instead of overwriting content. Re-importing a folder creates a separately numbered folder.
- Uploads show progress, and an in-progress file transfer can be cancelled. Drive files retain their original bytes and are separate from clipboard cleanup.
- Select multiple files or folders and choose **Download ZIP** to download them together. Folder menus also offer **Download ZIP**. Archives retain nested paths and empty folders, and stream directly to the browser without buffering all file contents in memory.

### Adjustable panes

On desktop, drag the divider between the clipboard list and preview, or the right edge of the Drive sidebar. Widths are remembered in the current browser and constrained to keep both sides usable.

Double-click a divider to reset it. With the divider focused, use **Left/Right** for 10 px adjustments, **Shift + Left/Right** for 40 px adjustments, **Home/End** for the width limits, and **Enter** to reset. Phones retain the single-column layout.

## CLI for agents and terminals

The standalone CLI uses **Node.js 22 or later** and has no package dependencies. The server still requires Node.js 24. From a clone, run `node cli/netclip.mjs --help`, or install the command on macOS/Linux:

```sh
mkdir -p ~/.local/bin
install -m 755 cli/netclip.mjs ~/.local/bin/netclip
# Add ~/.local/bin to PATH if it is not already there.
netclip config http://100.106.235.95:3210
netclip drive ls / --json
```

On Windows, use `node path\to\netclip\cli\netclip.mjs` with the same arguments. Connect to the server's Tailscale network when using its Tailscale address.

```sh
# Organize and transfer files, including complete folder trees.
netclip drive mkdir /Projects/Notes
netclip drive upload ./report.pdf ./assets --to /Projects --json
netclip drive tree /Projects --json
netclip drive download /Projects/report.pdf /Projects/assets --to ./downloads --json
netclip drive rename /Projects/report.pdf final.pdf
netclip drive move /Projects/final.pdf --to /Projects/Notes

# Clipboard commands, including piped text and image uploads.
printf 'Ready for review' | netclip clipboard put --json
netclip clipboard upload ./screenshot.png --json
netclip clipboard list --query review --json
netclip clipboard get 123
netclip clipboard download 123 --to ./downloads
```

Use `--json` for machine-readable success output and errors; failures return a nonzero exit code. Multi-file operations report completed entries if a later operation fails. Remote entries can be addressed by absolute paths or `id:123`. `netclip --help` lists all commands, including pin/unpin and deletion. `drive rm` deletes a folder and its contents.

### Migrate Drive and history over SSH

Run one command on a computer that can SSH into both hosts:

~~~sh
netclip migrate --from old-server --to new-server
# Source is this computer when --from is omitted.
netclip migrate --to user@new-server
~~~

Hosts can be aliases from your normal `~/.ssh/config`, `user@host`, or local. SSH must already work with a key or agent; the command uses batch mode and keeps normal host-key verification. Set custom ports, identity files and jump hosts in SSH config. Remote-to-remote data streams through the computer running the CLI, without saving a local archive; the two servers do not need to reach each other. Migration does not use the HTTP server URL.

By default, both endpoints are existing Docker containers named netclip. Create the target deployment first, using the same or a compatible Netclip version, and ensure the SSH account can run Docker without a sudo prompt. The command uses each container's own image and mounted data volume, so remote hosts do not need Node installed separately. Override container names when needed:

~~~sh
netclip migrate --from old-server --to new-server \
  --source-container old-netclip --target-container new-netclip

# Explicitly replace a target that already has content, keeping its old data.
netclip migrate --from old-server --to new-server --replace --json
~~~

The source is stopped while copying. The target keeps serving until the transfer has been verified, then stops briefly for the data switch. Containers that were running are restarted and checked through `/api/health`; containers that were stopped stay stopped. Each data directory must be one writable volume or bind mount owned by that instance, without nested mounts or another running container sharing it.

The transfer preserves the SQLite database (including any WAL), every history record, original IDs, pin states, copy counts, timestamps, Drive folders, file bytes, attachments and thumbnails. It checks per-file SHA-256, SQLite integrity, foreign keys and referenced file sizes before switching the target. Unfinished clipboard uploads in `tmp/` are excluded. The source data remains in place; writes to the source after it restarts are separate from the migrated copy.

An empty target, including a newly initialized empty Netclip database, works by default. A target with content requires `--replace`; this replaces its history and Drive together rather than merging them. Previous target data is kept under `.netclip-backup-<migration-id>-target` inside its data directory, and the exact path is printed in the result. Allow enough target disk space for both the incoming copy and existing data. Keep that backup until the new instance is confirmed.

For deployments running directly on the host, stop their server processes first, then provide absolute data-directory paths and `--stopped`. Directory endpoints need Node.js 22.13 or later on PATH and read/write access to their directories. Paths are interpreted on their respective hosts; quote a remote ~/ path to avoid expanding it on the controlling computer. Docker and directory endpoints can be mixed:

~~~sh
netclip migrate --from old-server --to new-server \
  --source-dir /srv/netclip/data --target-dir /srv/netclip/data --stopped

netclip migrate --to new-server --source-dir "$PWD/data" --stopped
~~~

On ordinary transfer or validation failures, staging is removed and the original data is retained. A failed target switch or startup restores the previous target data and running state. If a host becomes unreachable during recovery, or the command is forcibly killed, the error/remaining `.netclip-migration-lock` directory identifies an incomplete migration: keep the affected service stopped and preserve the staging directory, backup and lock journal until recovery is completed. Do not delete those directories to bypass a lock.

Deployment settings and local CLI configuration/bindings are not copied. The target keeps its own retention settings, so normal expiry and capacity cleanup apply when it starts. After choosing the target as your active instance, update clients with `netclip config http://NEW_HOST:3210`.

Migration tests use temporary fixture data and a local SSH transport shim:

~~~sh
npm run test:migrate
# Optional: real Docker lifecycle, data serving, backup and startup rollback.
docker build -t netclip:migration-test .
npm run test:migrate:docker
~~~

### Mount Drive in Finder

On macOS, `netclip drive mount` exposes Drive at `~/Netclip/Drive` with **on-demand file reads and automatic temporary-cache cleanup**. Finder and native Open/upload dialogs can browse this mount. The mount uses [rclone's NFS bridge](https://rclone.org/commands/rclone_nfsmount/) and the built-in macOS NFS client; no kernel extension or FUSE driver is needed.

Install the official [macOS rclone binary](https://rclone.org/install/#macos-installation) (tested with 1.75.2) at `~/.local/bin/rclone` or on PATH. `NETCLIP_RCLONE` can point to another executable. Then run:

```sh
netclip drive mount
netclip drive status --json
netclip drive refresh             # Refresh the directory index after a remote change.
netclip drive unmount             # Eject, stop the helper and remove its temporary cache.
# Add --to ~/AnotherEmptyFolder to any mount command for another mount point.
```

Add the local **`~/Netclip` folder** to Finder Favorites, then open **Drive** inside it. Keep the favorite on the local parent folder: a bookmark to the mounted network volume can stop resolving after an eject or remount and show "the original item can't be found". If upgrading from the old `~/Netclip` mount, `drive mount` moves it to `~/Netclip/Drive`; remove the old Netclip favorite and add the local parent folder again. No remote files are moved.

- Directory entries and file metadata are cached in memory for 30 seconds. Listing directories does not download their file contents. This index is rebuilt after restarting the mount.
- File bytes are downloaded only when an application reads them. The helper uses a sparse, on-demand VFS cache, with read-ahead disabled; it does not synchronize the whole Drive. Finder previews/thumbnails can request file bytes before the Open button is pressed.
- Inactive file data expires after **30 seconds**, checked every **10 seconds**. The cache has a **256 MiB eviction target**, with least-recently-used inactive files removed first. These are not hard limits: active file handles can retain data and temporarily exceed the size target until released. An idle closed file normally disappears within about 40 seconds.
- `drive unmount` removes this mount's temporary cache after stopping the helper; a fresh mount also clears leftovers from a prior interrupted run. Explicit `drive download` results and other applications' temporary files are separate and are not automatically deleted.
- The mount is read-only. Use the UI or CLI for uploads, renames and deletions; use `drive download` when you want a retained local copy. File access requires the server connection, including Tailscale when using a tailnet address.
- `drive status` reports the mount, helper process, cache policy and paths. Helper logs rotate at 1 MiB with one backup. Rerun `drive mount` after reboot or an ejected mount. Use `drive unmount` to stop a helper left running after a Finder eject.
- Disk-space queries are answered locally so Finder does not wait for the server merely to display a volume. Capacity shown by Finder is a placeholder. Remote requests use a 3-second connection timeout, a 10-second idle timeout and no low-level retries; unavailable files can still return an error, but unrelated Finder windows should remain usable.
- A small mount guard checks root metadata every 5 seconds, with a 3-second timeout. After two consecutive failures, or if the helper exits, it detaches the read-only volume and clears its temporary cache to release Finder's pending requests. The local Favorites folder remains accessible. Run `drive mount` after reconnecting; this does not automatically reconnect or download files. `drive status` reports why the mount was detached. Ejecting in Finder also stops the remaining helper and clears the cache.

The server's `/dav/` endpoint remains the transport. Do not use Finder's **Connect to Server** for this cache policy: Apple's direct WebDAV mount manages its own disk cache. The CLI migrates an older direct WebDAV mount at the chosen directory to the new mode.

### Agent skill

The lightweight [Netclip skill](skills/netclip/SKILL.md) teaches an agent to use the CLI, select the correct execution device, reuse download bindings, and handle partial batches. To install it for Codex:

```sh
mkdir -p ~/.codex/skills/netclip
cp -R skills/netclip/. ~/.codex/skills/netclip/
```

Invoke `$netclip` with a request such as “Upload this folder to Netclip Drive” or “Download my Projects folder using its saved local destination.” The skill uses the CLI above; it does not add a background service.

### Download directories per Drive folder

```sh
netclip drive bind /Projects ~/Downloads/Projects
netclip drive bind /Projects/Notes ~/Documents/Notes
netclip drive bindings --json
netclip drive download /Projects/Notes --json
netclip drive unbind /Projects/Notes
```

Bindings belong to the current computer and server, keyed by folder ID so remote renames and moves do not break them. For each selected entry, the CLI uses `--to` first, then the nearest bound folder, then `~/Downloads/Netclip`. Bind `/` to change that server's default download directory. A folder download keeps its complete tree together at the selected destination; a direct download from a subfolder uses the nearest binding for that subfolder. With `--to`, a selected folder is created inside that directory; downloading `/` writes its contents directly there.

Existing local files receive numbered suffixes. Symlinks are not included when importing a local tree. Bindings are saved in `~/.config/netclip/config.json` (or `$XDG_CONFIG_HOME/netclip/config.json`). Use `--config` / `NETCLIP_CONFIG` to select another config and `--url` / `NETCLIP_URL` to override the server for one command.

**These directory bindings apply to CLI/agent downloads.** Web downloads use the browser's download location or save dialog; the HTTP website cannot set an arbitrary local filesystem path.

## Run it

### Docker Compose on Linux

```sh
git clone https://github.com/Sskift/netclip.git
cd netclip
docker compose up -d --build
```

Open `http://<server-lan-ip>:3210` from your devices. **Open on phone** displays a QR code for the reachable address.

The supplied Compose file uses host networking and a persistent `netclip-data` volume. On Docker Desktop for macOS or Windows, replace `network_mode: host` with:

```yaml
ports:
  - "3210:3210"
```

Open the app using the host machine's reachable address rather than `localhost` when sharing its link with another device.

### From source

Requires **Node.js 24 or later**.

```sh
git clone https://github.com/Sskift/netclip.git
cd netclip
npm install
npm run build
npm start
```

The server defaults to port `3210`; data is stored in `./data`. Use a process manager to keep a source deployment running.

### Tailscale access

Run Netclip bound to loopback:

```sh
NETCLIP_BIND=127.0.0.1 npm start
```

For the supplied Linux Compose setup, add `NETCLIP_BIND: "127.0.0.1"` under the service's `environment` and recreate the container. With host networking, this binds to the host's loopback interface.

On that same host, forward the Tailscale TCP port:

```sh
tailscale serve --bg --tcp=3210 tcp://127.0.0.1:3210
tailscale serve status
```

Then open `http://<server-tailscale-ip>:3210` on devices connected to the same tailnet with permission to reach the server. This setup uses Tailscale access controls and does not require a Netclip password or Tailscale Funnel.

The example serves HTTP over Tailscale. Netclip does not terminate TLS itself; if you add HTTPS, keep the UI and API on the same origin. Browser clipboard capabilities are detected at runtime, with manual text copying and image long-press actions available as fallbacks.

## Storage and configuration

Re-adding content renews clipboard expiry. Text copy actions and clipboard attachment downloads also refresh retention. Pinned clipboard items do not expire and are excluded from capacity eviction. Unpinning starts a fresh retention period.

Cleanup also limits unpinned clipboard history to 500 items and evicts older unpinned images/files when clipboard storage exceeds 2 GiB. Recently added items have a five-minute grace period for capacity eviction. These limits do **not** apply to Drive: its files remain until explicitly deleted.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3210` | HTTP port |
| `NETCLIP_BIND` | `0.0.0.0` | Listening address |
| `NETCLIP_DATA_DIR` | `./data`; `/data` in Docker | Database and file storage |
| `NETCLIP_RETENTION_DAYS` | `7` | Unpinned clipboard text retention |
| `NETCLIP_IMAGE_RETENTION_DAYS` | `3` | Unpinned clipboard image retention |
| `NETCLIP_FILE_RETENTION_DAYS` | `7` | Unpinned clipboard attachment retention |
| `NETCLIP_MAX_ITEMS` | `500` | Unpinned clipboard item limit |
| `NETCLIP_MAX_TOTAL_MB` | `2048` | Clipboard capacity threshold, MiB |
| `NETCLIP_MAX_UPLOAD_MB` | `25` | Clipboard upload limit, MiB |
| `NETCLIP_DRIVE_MAX_UPLOAD_MB` | `512` | Drive limit per uploaded file, MiB |
| `NETCLIP_MAX_TEXT_KB` | `1024` | Clipboard text limit per item, KiB |
| `NETCLIP_SWEEP_MINUTES` | `5` | Clipboard cleanup interval |

Back up the **entire data directory**, not just the database:

```text
data/
  netclip.db       SQLite metadata and clipboard text
  netclip.db-wal   SQLite journal, when present
  netclip.db-shm   SQLite shared memory, when present
  blobs/          Clipboard images and attachments
  thumbs/         Clipboard image thumbnails
  drive/          Permanent Drive file contents
  tmp/            Temporary clipboard uploads
```

For a straightforward consistent backup, stop Netclip, copy the data directory or Docker volume, then restart it. Keep the persistent volume when rebuilding or upgrading the app.

## Keyboard shortcuts

These shortcuts apply to the desktop Clipboard view. **Mod** means **Cmd** on macOS and **Ctrl** elsewhere.

| Shortcut | Action |
|---|---|
| `Mod + V` | Send clipboard content |
| `Up / Down` | Select a clipboard item |
| `Enter` | Copy the selected text or download the selected image/file; send the search text if nothing matches |
| `Mod + Enter` | Send the search field's text |
| `Alt + P` | Pin or unpin the selected item |
| `Mod + G` | Show the item's QR code |
| `Mod + O` | Open a selected link |
| `Mod + S` | Download the selected item |
| `Mod + Backspace` | Delete the selected item |
| `Mod + Z` | Undo a pending clipboard deletion |
| `Mod + K` | Open the action menu |
| `Mod + F` | Focus and select the search field |
| `Escape` | Clear search or return to the newest item |

Menus support arrow-key navigation, **Enter** to choose, and **Escape** to close. Workspace tabs support **Left/Right** and **Home/End** when focused.

## Terminal and API

Send text to the clipboard:

```sh
printf 'Hello from another device' | curl --fail -T - http://localhost:3210/api/items

# macOS clipboard
pbpaste | curl --fail -T - http://localhost:3210/api/items
```

Upload a file to the root of Drive:

```sh
curl --fail -X POST http://localhost:3210/api/drive/upload \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Filename: archive.zip' \
  --data-binary @archive.zip
```

Replace `localhost` with the server address for remote access. URL-encode non-ASCII filenames in the `X-Filename` header.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/items?q=` | List/search clipboard items; small text bodies are included |
| `GET` | `/api/items/:id` | Read an item, including its full text content |
| `POST`, `PUT` | `/api/items` | Add plain text or JSON `{"text":"..."}` |
| `POST`, `PUT` | `/api/items/file` | Upload clipboard image/file bytes; accepts `Content-Type` and `X-Filename` |
| `PATCH` | `/api/items/:id` | Set or clear `pinned` |
| `POST` | `/api/items/:id/copy` | Record use and renew retention |
| `DELETE` | `/api/items/:id` | Delete a clipboard item |
| `DELETE` | `/api/items` | Delete unpinned clipboard items |
| `GET` | `/api/items/:id/raw?download=1` | Download clipboard content |
| `GET` | `/api/items/:id/thumb` | Read an image thumbnail |
| `GET` | `/api/drive/entries?parent=<id>&q=` | List a Drive folder; omit `parent` for the root |
| `POST` | `/api/drive/folders` | Create a folder with `{"name":"Photos","parentId":null}` |
| `POST` | `/api/drive/upload?parent=<id>` | Upload raw file bytes with `X-Filename`; omit `parent` for the root |
| `GET` | `/api/drive/entries/:id` | Read entry metadata and its parent breadcrumbs |
| `GET` | `/api/drive/entries/:id/download` | Download a file, or a folder as a ZIP |
| `GET` | `/api/drive/download?ids=1,2,3` | Download selected files/folders as one ZIP; overlapping selections are included once |
| `PATCH` | `/api/drive/entries/:id` | Rename with `name`, move with `parentId`, or both |
| `DELETE` | `/api/drive/entries/:id` | Permanently delete a file or folder and its contents |
| `GET` | `/api/events` | Receive live updates through server-sent events |
| `GET` | `/api/info` | Read clipboard configuration and connection information |
| `GET` | `/api/health` | Check server health |

Folder creation accepts `"autoRename":true` to add a suffix on a name conflict, as used by folder imports. Without it, a conflicting name returns `409`. API clients upload folder trees by creating parent folders first, then sending each file to its parent's ID.

## Development

```sh
npm install
npm run dev       # API on :3210, Vite on :3211
npm run build     # Emit server/public and run the existing image CSS check
```

For the existing test scripts, start a disposable instance in another terminal:

```sh
npm run test:serve # :3299, data in /tmp/netclip-test
npm test
```

The test scripts create and delete data. Use only the disposable instance, not your live deployment. Individual scripts are available as `test:migrate`, `test:server`, `test:ui`, and `test:layout`; the layout script requires a Chromium installation, with `CHROME_PATH` pointing to its executable.

The server uses Node's built-in HTTP server and SQLite, plus `sharp` for clipboard images. The frontend uses React, Vite, and CSS without a component framework.

| Path | Responsibility |
|---|---|
| `server/src/routes.js` | Clipboard and shared HTTP endpoints |
| `server/src/drive.js` | Permanent file storage and folder operations |
| `server/src/cleanup.js` | Clipboard expiry and capacity cleanup |
| `web/src/Workspace.jsx` | Shared shell and Clipboard/Drive switching |
| `web/src/Drive.jsx` | Drive interface and upload queue |
| `web/src/components/Menu.jsx` | Shared menu items and dropdowns |
| `web/src/components/ResizeHandle.jsx` | Adjustable pane boundaries |
| `web/src/lib/drive-import.js` | Folder traversal and parent-folder resolution |
| `web/src/lib/clipboard.js` | Browser clipboard handling and fallbacks |

Keep clipboard images as selectable `<img>` elements so native long-press actions remain available. The existing `check-css` build step checks that content styles do not disable them.
