# Reelframe

Reelframe is a fast, modern, and local-first media library designed for browsing, organizing, and viewing your photos and videos with a clean and distraction-free interface.

## Features

* Fast local media browsing.
* Modern and minimal user interface.
* Smooth image viewing with zoom and pan support.
* Video playback support.
* Lightweight and responsive design.
* Local-first workflow with no cloud dependency.
* Keyboard and mouse friendly navigation.

## Getting Started

### Clone the repository

```bash
git clone https://github.com/yourusername/reelframe.git
cd reelframe
```

### Run locally

If using a simple static setup:

```bash
python -m http.server 8000
```

Then open:

```
http://localhost:8000
```

If your project uses another development server, follow the instructions for your chosen framework or build system.

## NSFW detection — model files

Reelframe's optional NSFW detection feature (Settings → redeem a code to unlock it in beta) uses two on-device machine learning models. Neither ever sends your photos anywhere — both run entirely in your browser.

| Pass | Model | Where it loads from | Do you need to do anything? |
|---|---|---|---|
| Whole-image scan (badge + full blur) | [nsfwjs](https://github.com/infinitered/nsfwjs) (tfjs) | CDN (`cdn.jsdelivr.net`), fetched automatically | No — nothing to download, it just needs internet access the first time |
| Region scan (blurs just the flagged spot) | [NudeNet](https://github.com/notAI-tech/NudeNet) 320n (ONNX) | **Bundled in this repo** at `models/nudenet-320n.onnx` | No, if that file is present — see below if it's missing |

### If `models/nudenet-320n.onnx` is missing

It should already be committed to this repo, so normally you don't need to do anything. If you've cloned a copy where it's missing (e.g. it got excluded by a `.gitignore` rule, stripped by a host with binary-file limits, or you're setting the project up from scratch), you have two options:

**Option A — pip (simplest, and how the bundled copy was obtained):**

```bash
pip install nudenet
python3 -c "import nudenet, shutil, os; shutil.copy(os.path.join(os.path.dirname(nudenet.__file__), '320n.onnx'), 'models/nudenet-320n.onnx')"
```

**Option B — download the wheel directly, no `nudenet` install required:**

```bash
pip download nudenet --no-deps -d /tmp/nudenet_pkg
cd /tmp/nudenet_pkg && unzip -o nudenet-*.whl -d extracted
cp extracted/nudenet/320n.onnx /path/to/reelframe/models/nudenet-320n.onnx
```

Either way, the file should land at `models/nudenet-320n.onnx` (~12 MB) relative to `index.html`. That path is what `NUDENET_MODEL_URL` in `js/01-constants.js` points at — if you'd rather host it somewhere else (a CDN, a different folder), just update that constant to match.

The model is MIT-licensed by its original authors (a copy of the license is at `models/NUDENET-LICENSE.txt`) — safe to keep in this repo, including in a public one.

> Note: earlier notes in this codebase pointed `NUDENET_MODEL_URL` at NudeNet's GitHub release asset instead of a local file. That URL redirects to a github.com login page even for anonymous requests, so it wasn't actually reachable from a browser — hence the switch to bundling the file locally.

## Project Structure

```text
Reelframe/
├── css/
├── js/
├── models/          — bundled ML model(s) for NSFW region detection
├── assets/
├── favicon.svg
├── index.html
├── LICENSE
└── README.md
```

## Contributing

Contributions, suggestions, and bug reports are welcome. Feel free to open an issue or submit a pull request.

## License

This project is licensed under the MIT License. See the LICENSE file for details.