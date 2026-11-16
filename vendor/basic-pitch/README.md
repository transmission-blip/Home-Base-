# Basic Pitch (vendored)

Third-party code and model used by the Tab Transcriber for chords and fingerpicking.
Loaded only when a transcription needs it.

| File | What it is | Source | Licence |
| --- | --- | --- | --- |
| `model.json`, `group1-shard1of1.bin` | The Basic Pitch note-detection model | `@spotify/basic-pitch` 1.0.1 (npm) | Apache-2.0 |
| `basic-pitch.bundle.js` | Basic Pitch inference and note extraction, bundled with TensorFlow.js | `@spotify/basic-pitch` 1.0.1 and `@tensorflow/tfjs` 3.21.0 (npm) | Apache-2.0 |

Both are Copyright their respective authors (Spotify AB; Google LLC) and distributed under the
Apache License 2.0, included here as `LICENSE.txt`. Nothing in these files has been modified.

## Rebuilding the bundle

```sh
npm install @spotify/basic-pitch@1.0.1 esbuild
echo 'export class Midi {}' > stub.js   # MIDI file export is not used
cat > entry.js <<'JS'
import * as tf from "@tensorflow/tfjs";
import { BasicPitch } from "@spotify/basic-pitch/esm/inference.js";
import { outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } from "@spotify/basic-pitch/esm/toMidi.js";
export { tf, BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime };
JS
npx esbuild entry.js --bundle --minify --format=iife --global-name=BasicPitchLib \
  --alias:@tonejs/midi=./stub.js --target=es2019 --legal-comments=none \
  --outfile=basic-pitch.bundle.js
```
