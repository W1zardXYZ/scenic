# Scenic

A self-hosted battle map library and print studio. Point it at your map folders and it indexes, groups and analyses them, then tiles any map onto paper at true scale.

Your files are only read. Everything Scenic creates lives in its data folder.

## Run on a NAS

A ready-made image for amd64 and arm64 is at `ghcr.io/w1zardxyz/scenic:latest`, so a NAS can pull it without building. Mount your maps read-only at `/maps` and a writable folder at `/data`, and expose port 8420.

For TrueNAS, paste [`deploy/truenas/scenic.yaml`](deploy/truenas/scenic.yaml) into **Apps → Discover Apps → Custom App → Install via YAML**.

To build it yourself, edit the maps path in `docker-compose.yml`, then:

```bash
docker compose up -d --build
```

Open `http://<nas-address>:8420`, choose **Folders**, and add your maps. Packs in `.zip` files are read without unpacking them.

Scenic is built to be switched on when you need it:

```bash
docker compose stop
```

```bash
docker compose start
```

Each start looks for new or changed maps and analyses only those. Stopping during a scan is safe; it resumes where it left off.

Keep the data volume on the NAS's local disk rather than a network share, because SQLite is unreliable over NFS and SMB. The first scan decodes every map once, so allow a few seconds per map on a low-power NAS. Scans use up to `SCENIC_WORKERS` maps at a time.

Scenic has no user accounts and is meant for a home network. Set `SCENIC_PASSWORD` to require a login, and do not expose it directly to the internet.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCENIC_PASSWORD` | none | Basic auth password, user `scenic` |
| `SCENIC_WORKERS` | half the cores, 1–4 | Maps analysed at once |
| `SCENIC_CACHE_MB` | 8192 | Disk cache for unpacked maps and print files |
| `SCENIC_RESCAN_MINUTES` | 60 | How often to look for new maps |
| `SCENIC_PORT` | 8420 | HTTP port |

## What it reads

- **Images:** JPG, PNG, WebP, AVIF, TIFF, GIF
- **VTT files:** `.dd2vtt`, `.uvtt`, `.df2vtt`
- **Archives:** `.zip`

Other archive types, such as `.rar` and `.7z`, are skipped. Folders such as `Tokens` and `Music`, cover art, stat blocks and images under 800 px are ignored. **Settings → Scanning** edits these words: folders and files to skip or always include, extra words for gridded, gridless, labelled and unlabelled, and variant words. Saving rescans names only, so it never decodes maps again.

Files in a folder named `Overlays`, or with "overlay" in their name, are shown as overlays of the scene whose map name they continue, whatever their size. Print and VTT exports of the same map, such as `Maps - 300 DPI (Print)` beside a 72 DPI copy, are one scene with a version for each resolution.

## AI descriptions

**Settings → AI** connects any OpenAI-compatible API with a vision model: OpenRouter with a key, or LM Studio or Ollama on another computer (let it listen on the network and use that computer's address). It is off by default. Each scene's 640 px cover thumbnail is sent, nothing else, and one sentence and a few tags come back. They show on the map page and search finds them; they never change grouping or your own tags.

Runs start from the settings page, which shows how many scenes are waiting and, for OpenRouter, an estimated price. Turn on **Describe new scenes after each scan** to tag new maps automatically. With OpenRouter thumbnails leave your network; with a local server they stay on it. The key is stored in the data folder and never sent to the browser. To run a free model on a Mac on your network instead, see [`deploy/mac`](deploy/mac/README.md).

## Print settings and looks

The print studio keeps each map's settings as you change them (paper, scale, crop, hand-arranged sheets, tone, fog, export options), so a map opens as you left it. They are stored in the data folder and follow the file through rescans, moves and renames. **Saved** tab: save named copies of a map's settings, load one later, or **Load and create the export**, which makes the files again (they are cached, so repeating an earlier export is quick).

A **look** is the tonal part of the settings only: ink mode, levels, curve, tone ranges, colour ranges, colour selections and the edge fade. Never paper, scale, grid, fog or marks. Under **Look → Look profiles**, save the current look by name, apply it to any map, update or rename it, or make it the one new maps start with. Applying copies the values into the map, so tweaking them never changes the look, and changing the look later never changes maps that used it; the map only shows whether it still matches. Colour selections hold the colours you picked, not map positions, so on another map they change whatever pixels are close to those colours, and nothing if there are none.

Every settings section opens and closes from its header, remembers that in the browser, and shows a dot when it differs from the defaults, with a button to reset just that section.

## How the grid is found

Scenic uses the most reliable evidence available:

1. A grid you set yourself
2. Grid lines measured in the image
3. A `.dd2vtt` file, unless it contradicts the size in the file name
4. A size or ppi in the file name, such as `52x52` or `140ppi`
5. The same measurement from another version of the map
6. An estimate from common export sizes, flagged **Grid needs checking**

## Development

Requires Node 24 or newer.

```bash
npm install
npm run dev
```

The API runs on port 8420 and the Vite UI on 5173. `npm test` runs the unit tests and `npm run typecheck` checks types.

For a local production run, which rebuilds the UI first:

```bash
npm start
```

Stop a running server with `npm run stop`.

`shared/layout.ts` holds all page geometry, used by both the preview and the PDF generator.
