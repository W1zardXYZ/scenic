# Indexing: feedback and plan

November 2026. Collects the feedback on scanning, scene grouping, variants and tagging, what causes each problem, and what to build.

## How indexing works today

1. **Walk.** Every library folder is read recursively. Zips are read by their table of contents only; an unchanged zip is skipped on later scans. Files are filtered by type (images and `.dd2vtt`/`.uvtt`/`.df2vtt`), by folder name (`Tokens`, `Music`, `Handouts`, `Art`, `PDFs`…) and by file name (`preview`, `thumbnail`, `cover`, `promo`, `logo`…). Both lists are fixed in the code.
2. **Read names.** Grid or gridless, `70ppi`, `30x20` squares, labelled, version, day/night, weather and level words.
3. **Pair VTT files** with the image of the same name, so they supply grid and walls instead of becoming maps.
4. **Analyse** each new file, one at a time with `SCENIC_WORKERS=1`: copy out of the zip, decode, write two thumbnails, record colours, build a 32×32 edge fingerprint, decode again to look for grid lines or a repeating pattern. Images under 800 px are dropped only after all of that.
5. **Group into scenes** within one creator or project, when names match apart from grid and label markers, differ only by condition words (time, weather, level, `roof`, `exterior`), or the fingerprints match.
6. **Measure squares** from the most trusted source: manual, grid lines in the image, VTT file, file name, floor pattern, guess. The best one in a scene is passed to its other variants.

Measured on a Mac, an 11200×7700 PNG inside a zip takes about 2.2 s: 1.8 s of it is decoding, 0.2 s grid detection, 0.25 s unzipping. The N100 will be roughly 3–4× slower (not measured). Grouping and grid detection are cheap; decoding files that are then thrown away is the waste.

## Problems and causes

| # | Problem | Cause |
|---|---|---|
| 1 | Roof and interior become separate scenes | `interior` is not a condition word, and the two pictures look too different to match. Day and night exteriors look alike, so those merge. |
| 2 | Stat blocks and other handouts are imported | They are 800 px or larger and their name and folder are not on the skip list. Example: `CzePeku Maps/Smuggler's Fen [28x33] - $5 Rewards/Questiary Monsters/Siren Grass/22-1_1_SirenGrass_statblock.png`, shown as a 21×16 square map. **Fixed:** `statblock` and `stat block` in a file name are now skipped, including in zips that were already indexed. The `Questiary Monsters` folder still needs the scan rules from phase 1. |
| 3 | Creator thumbnails show up as a lower-resolution variant | The picture matches the full map, so it groups; nothing recognises it as a preview. |
| 4 | Scanning is slow | Two full decodes per map, at one map at a time, including files that are then dropped. |
| 5 | Square sizes sometimes feel off | Unknown without examples: one of the six sources is misfiring. |
| 6 | The scan words are fixed | Grid, label, skip and condition words are written into the code. A creator who writes `gridded` or files stat blocks under `Monsters` cannot be taught. |
| 7 | Numbered series (A1, A2, A3) are hard to rename | Renaming is one scene at a time, inside the Edit dialog. |
| 8 | Most maps have no tags | Tags come only from words in the name and path, which rarely say what is on the map. |
| 9 | Variants with two dimensions make no sense | A variant has exactly one type. 2-Minute Tabletop's tavern has day/night *and* exterior/interior: four files that need two axes, but each can be only "Lighting" or "Level". Setting the exterior to Level 1 says nothing about which lighting it is, and the night exterior gets no part of that edit. |
| 10 | Manual grouping is hard to find | It exists (map → Edit → Belongs to scene, Type, Height) but works on one map at a time and is buried. |
| 11 | No way to see what the container is doing | Errors go to `docker logs` as plain text; there are no scan timings, no disk usage figures and nothing to hand over when something goes wrong. |

## Plan

### Phase 1: Scan rules and a faster scan

**Scan rules in Settings.** One section, every list prefilled with today's built-in words so nothing changes until you edit it:

- **Skip folders** and **skip files**: words or patterns. New defaults add `Monsters`, `Stat blocks`, `NPCs`, `Handouts` (folder) and `stat block`, `statblock`, `stats`, `character sheet`, `card` (file).
- **Always include**: folders or files to keep even when a skip rule matches, for the exceptions.
- **Words that mean**: gridded, gridless, labelled, unlabelled, and each variant value (Day, Night, Interior, Exterior, Roof, Rain…). Add `gridded` to "gridded" and every creator's naming is understood from then on.

Changing a rule reruns steps 1, 2, 5 and 6 only. Those read names, not pixels, so a change takes seconds and never re-decodes the library. Files a new skip rule removes keep their edits, in case the rule is undone.

**Faster scan.**
- Read an image's size from its header before decoding; drop anything under 800 px at that point.
- Apply skip rules before copying anything out of a zip.
- Don't analyse a zipped file that also exists unzipped (already deduplicated for display, but still analysed).
- Recognise creator previews: a file that is the same picture as another in its scene at half the resolution or less is a preview, not a variant (fixes #3).
- Optionally `SCENIC_WORKERS=2` for the first scan, which roughly halves it.

**Better grouping defaults.**
- `interior`, `inside`, `outside`, `roofless`, `cutaway`, `open`, `closed` become condition words (fixes #1 for most names).
- Maps with exactly the same pixel size in the same folder or zip group together, so oddly named roof and interior exports still meet.

### Phase 2: Variants as a matrix

**Prototype built and working locally.** When a scene's variants differ both in where they are (floor or view: Cellar, Interior, Exterior, Floor 2…) and in how they look (Day, Night, Rain…), the map view shows a table instead of rows of thumbnails: **floors down the side, highest at the top, looks across the top**. The tavern shows Exterior and Interior as rows and Day and Night as columns. Arrow keys move left and right within a floor and up and down between floors, keeping the same column. A missing combination shows as an empty dashed cell. Scenes that vary only one way look as before.

It reads the existing variant names, so a hand-renamed variant ("Night Exterior") lands in the right cell too. `interior`, `inside` and `indoors` now count as floor words at ground level, which is also what groups an interior with its exterior.

Still to decide after trying it: whether the table is enough, or whether the later steps below (dimensions edited as a grid) are needed.

The fuller version replaces the single variant type with **dimensions**. Each file in a scene has a value on any of:

| Dimension | Example values |
|---|---|
| View | Exterior, Interior, Roof, Cutaway |
| Level | Cellar (−1), Ground (0), Upper (1)… |
| Lighting | Day, Dusk, Night |
| Weather | Clear, Rain, Snow, Fog |
| Grid | Grid, Gridless |
| Labels | Labelled, Unlabelled |

The scene view shows one switch per dimension that actually varies. The tavern shows **View: Exterior / Interior** and **Lighting: Day / Night**; picking Interior + Night shows that file. A scene with only a day and night version shows one switch, as today.

- **Detected from names** using the "words that mean" lists from phase 1, so most scenes need no editing.
- **Edited as a grid**: the Edit dialog shows every file in the scene as a row with a dropdown per dimension. Setting the tavern means four dropdown changes on one screen, not four trips through a dialog.
- **Missing combinations are fine**: a scene with a roof only by day still works; the switch shows Night as unavailable for Roof.
- **Migration**: existing Type/Height edits map onto the matching dimension (Level → Level with its height, Lighting → Lighting, and so on). Nothing is lost.

**Manual grouping and renaming in the gallery.**
- Select several scenes or maps and choose **Merge into one scene**.
- **Rename in place** from the gallery card, with Tab to move to the next card, so A1, A2, A3 can be renamed in one pass.
- A project-level **Rename series** for numbered sets: shows each scene's thumbnail next to an editable name.

### Phase 3: AI descriptions and tags (optional)

An **AI connection** in Settings, off by default:

- **Endpoint**: any OpenAI-compatible API, so either OpenRouter with a key, or a local server on your MacBook (LM Studio or Ollama running a Qwen vision model, set to listen on the local network).
- **What is sent**: the existing 640 px thumbnail of each scene's cover, one per scene, not per file. Nothing else.
- **What comes back**: one sentence describing the map and a handful of tags (setting, biome, notable features), stored as suggestions. Your own edits always win, and search covers both.
- **Runs after scanning** in the background, as a separate low-priority queue. If the MacBook is asleep or the key runs out, scenes stay queued and are retried; scanning never waits on it.
- **Cost shown before a run**: number of scenes and, for OpenRouter, the estimated price.
- **Privacy**: with OpenRouter, thumbnails leave your network; with the local model, they stay on it. Settings says which.

This adds tags (#8). It does not decide grouping: that stays deterministic, so a model's bad answer can never split or merge scenes.

### Diagnostics (alongside phase 1)

A **Diagnostics** page in Settings, plus better logs, so problems on the NAS can be found without guessing. Nothing is sent anywhere: it is all local, for you to read or hand over.

- **Storage**: database size; thumbnail count and size; unpacked-zip and print cache size against `SCENIC_CACHE_MB`; free space on `/data`. A **Clear cache** button.
- **Library**: maps found, analysed, failed (with the reason for each), dropped as too small, skipped per scan rule (which rule, how many files), grouped into how many scenes.
- **Scan timing**: how long each phase took on the last scan (walk, analyse, group), average time per map, the ten slowest files, and the worker count.
- **Server**: Scenic version and build, uptime, memory in use against the container limit, CPU load.
- **Logs**:
  - **Structured lines**: one line per event to `docker logs`, each with time, level and context (file, phase, duration), e.g. `2026-11-03T21:04:11Z info scan analysed file="Tavern Day.jpg" ms=2210`.
  - **Log level**: `SCENIC_LOG_LEVEL=debug` adds per-step detail.
  - **Last lines in the app**: the most recent 1000 lines, readable on the Diagnostics page.
- **Download diagnostics**: one file with all of the above and the recent logs, without passwords or API keys. Attach it to a conversation and it can be read directly.

From SSH, the same logs are available with `sudo docker logs --tail 500 scenic`.

### Still needed from you

- **Squares (#5)**: 2–3 maps where the size is wrong, and the size you expected for each.
- **Matrix**: try the tavern layout on real scenes and say whether rows of floors × columns of looks reads right.

## Order

1. Phase 1 with diagnostics: removes most wrong imports and wasted scan time, makes the rest teachable without code changes, and shows what the NAS is doing.
2. Phase 2: fixes the tavern-style scenes and makes manual fixes quick.
3. Phase 3: adds descriptions and tags once the library itself is right.
