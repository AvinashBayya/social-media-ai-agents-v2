"""
One-time, offline conversion of Google's official YAMNet (Apache 2.0) into
an ONNX model this project vendors under models/yamnet/ — never fetched at
runtime, matching every other model in this service (see loaders.py).

Inputs (not committed — see this script's own header comments below for
where each comes from):
  - scripts/yamnet_src/{yamnet.py,params.py,features.py,yamnet_class_map.csv}
    — the OFFICIAL, unmodified source from
    https://github.com/tensorflow/models/tree/master/research/audioset/yamnet
    (Apache 2.0). Vendored as source (small, text files) so this conversion
    is reproducible from the repo alone.
  - yamnet.h5 — the official pretrained weights, downloaded once from
    https://storage.googleapis.com/audioset/yamnet.h5 (Google's own bucket,
    named directly in the official README). NOT committed (a binary weights
    file), same as grounding-dino-tiny/florence-2-large/insightface below it
    in models/ — see .gitignore.

This script needs tensorflow + tf_keras + tf2onnx, which are NOT in
requirements.txt: they exist only to run this ONE-TIME conversion, never as
a runtime dependency of the running service. Run it in a disposable venv,
then discard tensorflow entirely — the resulting ai-service serves audio
classification via onnxruntime alone, already a pinned dependency.

Usage:
    python -m venv /tmp/yamnet-convert-venv
    /tmp/yamnet-convert-venv/Scripts/pip install tensorflow tf-keras tf2onnx
    /tmp/yamnet-convert-venv/Scripts/python scripts/vendor_yamnet.py \
        --weights /path/to/yamnet.h5 --out models/yamnet
"""

import argparse
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR / "yamnet_src"))


def convert(weights_path: Path, out_dir: Path) -> None:
    # tflite_compatible=True swaps tf.signal.stft (which real-world tf2onnx
    # versions have historically had trouble with — STFT ops move between
    # opsets) for the official matmul/pad/frame-only reimplementation
    # Google itself ships in features.py for exactly this portability
    # reason. Same model, same weights, same 0.96s/0.48s framing — just an
    # ONNX-friendlier internal path, not an approximation.
    import params as params_lib  # yamnet_src/params.py
    import tensorflow as tf
    import tf2onnx
    import yamnet as yamnet_lib  # yamnet_src/yamnet.py

    params = params_lib.Params(tflite_compatible=True)
    model = yamnet_lib.yamnet_frames_model(params)
    model.load_weights(str(weights_path))
    print(f"Loaded official YAMNet weights from {weights_path}", file=sys.stderr)
    print(f"Model: {len(model.weights)} weight tensors, {model.count_params()} params", file=sys.stderr)

    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "yamnet.onnx"

    input_signature = [tf.TensorSpec([None], tf.float32, name="waveform")]
    model_proto, _ = tf2onnx.convert.from_keras(
        model, input_signature=input_signature, opset=13, output_path=str(onnx_path)
    )
    print(f"Wrote {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)

    class_map_src = SCRIPT_DIR / "yamnet_src" / "yamnet_class_map.csv"
    class_map_dst = out_dir / "yamnet_class_map.csv"
    shutil.copy(class_map_src, class_map_dst)
    print(f"Copied class map to {class_map_dst}", file=sys.stderr)

    _sanity_check(onnx_path)


def _sanity_check(onnx_path: Path) -> None:
    """Real inference on a real signal, not just a shape check — a
    silently-wrong conversion (transposed axes, wrong activation) is a
    worse failure than a missing model, because it looks like it works."""
    import numpy as np
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    print(f"ONNX inputs: {[(i.name, i.shape) for i in session.get_inputs()]}", file=sys.stderr)
    print(f"ONNX outputs: {[(o.name, o.shape) for o in session.get_outputs()]}", file=sys.stderr)

    sr = 16000
    duration_s = 3.0
    t = np.arange(int(sr * duration_s), dtype=np.float32) / sr
    # A pure 1kHz tone is not speech/music/animal/etc — this only proves the
    # graph runs end-to-end and outputs are real, finite sigmoid scores, not
    # that any specific class is correct (that needs a real labelled fixture,
    # done separately in ai-service/tests once the endpoint exists).
    tone = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)

    outputs = session.run(None, {session.get_inputs()[0].name: tone})
    predictions = outputs[0]
    print(f"predictions shape: {predictions.shape}", file=sys.stderr)
    assert predictions.ndim == 2 and predictions.shape[1] == 521, (
        f"expected (num_patches, 521), got {predictions.shape}"
    )
    assert np.isfinite(predictions).all(), "non-finite values in predictions — conversion is broken"
    assert (predictions >= 0).all() and (predictions <= 1).all(), (
        "predictions outside [0,1] — expected independent sigmoid scores, conversion is broken"
    )
    top_class = int(predictions.mean(axis=0).argmax())
    print(f"Sanity check passed. Top mean-scoring class index on a 1kHz tone: {top_class}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", required=True, type=Path, help="Path to the downloaded yamnet.h5")
    parser.add_argument("--out", required=True, type=Path, help="Output directory (e.g. models/yamnet)")
    args = parser.parse_args()
    convert(args.weights, args.out)
