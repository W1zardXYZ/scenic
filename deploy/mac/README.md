# A free vision model on a Mac

Scenic's AI descriptions can run on a Mac on the same network instead of a paid API. Thumbnails then never leave home.

## Model

`qwen3-vl:8b-instruct` on Ollama: a 6.2 GB download, about 8 GB of memory while loaded, and about 5 seconds per scene on an M3 Max (roughly 700 scenes an hour). Use the `-instruct` version. The plain `qwen3-vl` versions reason before answering, which takes three times as long. The 4B version is faster but tags terrain that isn't on the map.

```bash
brew install ollama
```

```bash
ollama pull qwen3-vl:8b-instruct
```

## Let the NAS reach it

Ollama listens only on the Mac itself unless told otherwise. [`com.scenic.ollama.plist`](com.scenic.ollama.plist) runs it at login, listening on the network, with a small context to save memory, and unloads the model 15 minutes after the last request.

Quit any other Ollama first: the Ollama app, a Raycast command or a `brew services` entry. Then:

```bash
cp deploy/mac/com.scenic.ollama.plist ~/Library/LaunchAgents/
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scenic.ollama.plist
```

Check it from the Mac, with the Mac's own network address (System Settings → Wi-Fi → Details):

```bash
curl http://192.168.0.248:11434/v1/models
```

To remove it again:

```bash
launchctl bootout gui/$(id -u)/com.scenic.ollama && rm ~/Library/LaunchAgents/com.scenic.ollama.plist
```

Ollama has no password, so anyone on the home network can use the model while it runs.

## Overnight

A MacBook must stay awake: keep it plugged in with the lid open (the screen may turn off), and before bed run:

```bash
caffeinate -i -t 36000
```

That keeps it awake for 10 hours, or until you press Ctrl+C.

## In Scenic

**Settings → AI**:

- **Address:** `http://192.168.0.248:11434/v1`. Use the Mac's IP address, not its `.local` name, which apps in Docker on a NAS often cannot resolve. Reserve that address for the Mac in your router so it does not change.
- **API key:** leave it empty.
- **Model:** `qwen3-vl:8b-instruct` (or press **List models**).

Save, switch on **Describe and tag scenes with AI**, and press **Describe N scenes**. The page should say thumbnails stay on your network. If the Mac sleeps or is off, the run stops with a message and the remaining scenes stay waiting for the next run.
