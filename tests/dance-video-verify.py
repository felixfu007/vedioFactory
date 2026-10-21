#!/usr/bin/env python3
"""Content verification for "one photo -> dancing video" outputs (OPTIMIZATION_PLAN 6.4).

Usage:
    python tests/dance-video-verify.py --video <file> --source <photo>
        [--min-seconds 10] [--report out.json] [--quiet]

Exit codes: 0 = every check passed, 1 = at least one check failed,
            2 = usage / environment error (missing file, ffmpeg, deps, model).

Checks (thresholds are the module-level constants below):
  1. container      decodable, decoded duration >= min seconds, sane fps, short side >= 256 px
  2. frame_health   no black / blown-out / blank frames, no frozen run > 0.5 s
  3. person         pose (shoulders + hips + limbs) in >= 90 % of samples and in every second
  4. dancing        hip-relative, torso-normalised limb motion in every 2 s window + overall range
  5. identity       first frame matches the source photo; torso colours + face stay consistent
  6. seams          no consecutive-frame difference that is a large local outlier

Runs CPU only. Needs ffmpeg/ffprobe on PATH and the packages in tests/requirements-qa.txt.
If those packages are missing but the repo venv .venv-qa exists, the script re-runs itself
with that interpreter, so `python tests/dance-video-verify.py ...` works from npm scripts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")  # CPU only; never compete with ComfyUI for the GPU

# --------------------------------------------------------------------------------------
# Bootstrap: re-exec inside .venv-qa when the QA packages are not importable here.
# --------------------------------------------------------------------------------------
def _venv_python() -> Path:
    if os.name == "nt":
        return REPO_ROOT / ".venv-qa" / "Scripts" / "python.exe"
    return REPO_ROOT / ".venv-qa" / "bin" / "python"


try:
    import numpy as np
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_tasks
    from mediapipe.tasks.python import vision as mp_vision
except ImportError as _import_error:  # pragma: no cover - environment dependent
    _vp = _venv_python()
    if _vp.exists() and Path(sys.executable).resolve() != _vp.resolve() and not os.environ.get("DANCE_VERIFY_NO_REEXEC"):
        env = dict(os.environ, DANCE_VERIFY_NO_REEXEC="1")
        sys.exit(subprocess.call([str(_vp), str(Path(__file__).resolve()), *sys.argv[1:]], env=env))
    sys.stderr.write(
        f"[dance-verify] missing Python dependency: {_import_error}\n"
        "  python -m venv .venv-qa\n"
        "  .venv-qa\\Scripts\\python.exe -m pip install -r tests/requirements-qa.txt\n"
    )
    sys.exit(2)

# --------------------------------------------------------------------------------------
# Thresholds (tuned so that stills, black clips, short clips, camera-only motion,
# vanishing subjects, spliced jumps and wrong-source videos fail; see selftest).
# --------------------------------------------------------------------------------------
DEFAULT_MIN_SECONDS = 10.0
MIN_FPS = 8.0
MAX_FPS = 61.0
MIN_SHORT_SIDE_PX = 256
ANALYSIS_LONG_SIDE = 1280         # frames above this are downscaled for analysis (keep faces resolvable)
SMALL_LONG_SIDE = 160             # tiny copies for per-frame diff statistics

# frame health (values on 0..255 scale, measured on the small RGB copy)
BLACK_MAX_MEAN = 16.0             # mean luma below this AND
BLACK_MAX_STD = 10.0              #   luma std below this -> black frame
BLOWN_MIN_MEAN = 240.0            # mean luma above this AND std below BLACK_MAX_STD -> blown out
BLANK_MAX_STD = 4.0               # any frame this uniform is blank
MAX_BAD_FRAMES = 0
FREEZE_GRID = (8, 8)              # frame split into rows x cols cells for the freeze test
FREEZE_DIFF = 0.6                 # frozen if EVERY cell's mean |frame_i - frame_{i-1}| is below this
MAX_FROZEN_SECONDS = 0.5

# person presence
POSE_SAMPLE_FPS = 6.0
LANDMARK_MIN_VISIBILITY = 0.5
CORE_LANDMARKS = (11, 12, 23, 24)                      # shoulders, hips
LIMB_LANDMARKS = (13, 14, 15, 16, 25, 26, 27, 28)      # elbows, wrists, knees, ankles
MIN_LIMB_LANDMARKS = 4
MIN_PERSON_COVERAGE = 0.90
MIN_PER_SECOND_COVERAGE = 0.5

# dancing (units: torso lengths, coordinates relative to the hip centre)
MOTION_WINDOW_SECONDS = 2.0
MOTION_WINDOW_STEP = 1.0
MIN_WINDOW_SAMPLES = 4
MIN_WINDOW_EXCURSION = 0.15       # mean over limb points of the p10..p90 extent inside a window
MIN_OVERALL_RANGE = 0.35          # mean over limb points of the p5..p95 extent over the clip

# identity / source consistency
# First frame vs source is compared on the PERSON: the source is scaled+translated so its pose
# landmarks land on the first frame's, and SSIM / NCC / chroma histogram are computed on the padded
# person crop (generators such as Wan Animate re-centre / re-scale the person). The crop is compared at
# FIRST_FRAME_PERSON_LONG_SIDE px (long side), i.e. at person/outfit/pose scale: at 256 px SSIM mostly
# measures fine texture (floor grain, fabric) that a regenerating model does not preserve.
# Calibration 2026-10-19 (aligned SSIM / NCC at 256 -> 128 -> 96 px):
#   Wan Animate full pipeline d4f168e0 (same person, re-centred): 0.693/0.915 -> 0.764/0.932 -> 0.797/0.942
#   dance-animate-e2e: 0.793 -> 0.850 -> 0.875 ; real-photo controls (incl. shift 15 % + scale 0.9): >= 0.92
#   different person, same framing: 0.645/0.622 -> 0.633/0.629 -> 0.629/0.632
#   wrong_source_photo (cartoon): 0.750/0.703 -> 0.648/0.716 -> 0.623/0.728
# Thresholds unchanged (0.75 / 0.85 / 0.35); only the comparison scale moved from 256 to 96 px.
# Whole-frame numbers (best of cover/contain/stretch) are still reported, not gated.
FIRST_FRAME_PERSON_LONG_SIDE = 96
FIRST_FRAME_MIN_SSIM = 0.75
FIRST_FRAME_MIN_NCC = 0.85
SOURCE_TORSO_MAX_HIST_DIST = 0.35 # source photo clothing region vs. first video sample
FIRST_FRAME_MAX_HIST_DIST = 0.35  # Bhattacharyya distance of Lab (a*,b*) histograms
HIST_BINS = 32
TORSO_MAX_HIST_DIST = 0.40        # clothing region (torso + thighs), worst 2 s window median vs first sample
IDENTITY_WINDOW_SECONDS = 2.0
# Windowed identity statistics (clothing + face) use non-overlapping IDENTITY_WINDOW_SECONDS windows.
# A trailing remainder shorter than the window is merged into the previous window, and a window with
# fewer than this many usable samples is not judged on its own: it is reported as "insufficient" and
# folded into its neighbour (previous one, or next one for the first window).
IDENTITY_MIN_WINDOW_SAMPLES = 3
MIN_FACE_PRESENCE = 0.5           # enforced only if a face is detectable in the source photo

# face identity (OpenCV YuNet detector + SFace embedding, cosine similarity to the source face).
# SFace's documented same-person cosine threshold (0.363) is for well-resolved, aligned faces and
# is too lenient here. Calibration on 2026-10-17 (faces ~50-60 px wide in the video):
#   source photo -> resize + VP9, camera zoom/pan only (same person) : median 0.84-0.93
#   Wan TI2V-5B bench clip 00007 (visible drift: darker hair, changed features): median 0.50, worst 2 s window 0.41
#   Wan TI2V-5B bench clip 00008 (clearly a different-looking person)       : median 0.18, worst 2 s window 0.14
#   different person (face-swapped source, selftest)                          : ~0.1-0.2
FACE_ID_MIN_MEDIAN = 0.55
FACE_ID_MIN_WINDOW_MEDIAN = 0.45  # worst IDENTITY_WINDOW_SECONDS window median
FACE_ID_MIN_FACE_PX = 36          # face box width in native video pixels; smaller faces are skipped
FACE_ID_MAX_YAW = 0.35            # |nose offset from eye midpoint| / eye distance; larger = profile, skipped
FACE_ID_MIN_SHARPNESS = 40.0      # Laplacian variance of the 112x112 aligned face; lower = blurred, skipped
FACE_ID_MIN_SCORE = 0.80          # YuNet detection score
FACE_ID_MIN_USABLE_RATIO = 0.30   # usable faces / person samples; fewer -> cannot verify -> fail
FACE_ID_MIN_USABLE = 6
# Hair band (strip above the face box) CIE76 dE vs source is REPORTED ONLY, not gated: the band picks
# up background / frame edges. A same-person zoom/pan control scored dE 40, the drifting bench clip
# 00008 39-56 and 00007 5-9, so it does not separate same vs. different person.

# seams
SEAM_LOCAL_RADIUS = 12            # frames on each side used for the local median
SEAM_K = 4.0                      # outlier if diff > K * local median ...
SEAM_GLOBAL_K = 3.0               # ... and > GLOBAL_K * global median ...
SEAM_MIN_ABS = 2.5                # ... and > this absolute mean |diff|
MAX_SEAM_JUMPS = 0

# models (official Google storage, pinned version + sha256)
MODELS = {
    "pose": {
        "file": "pose_landmarker_full.task",
        "url": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
        "sha256": "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
    },
    "face": {
        "file": "blaze_face_short_range.tflite",
        "url": "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        "sha256": "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
    },
    # opencv_zoo (Apache-2.0), pinned to the commits that last touched each file
    "yunet": {
        "file": "face_detection_yunet_2023mar.onnx",
        "url": "https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    },
    "sface": {
        "file": "face_recognition_sface_2021dec.onnx",
        "url": "https://github.com/opencv/opencv_zoo/raw/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "sha256": "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    },
}
MODEL_DIR = Path(os.environ.get("DANCE_VERIFY_MODEL_DIR", REPO_ROOT / "tests" / ".cache" / "models"))


class EnvError(RuntimeError):
    pass


# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------
def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model(key: str) -> Path:
    spec = MODELS[key]
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_DIR / spec["file"]
    if path.exists() and sha256_of(path) == spec["sha256"]:
        return path
    tmp = path.with_suffix(path.suffix + ".part")
    try:
        with urllib.request.urlopen(spec["url"], timeout=120) as resp, open(tmp, "wb") as out:
            shutil.copyfileobj(resp, out)
    except Exception as exc:  # network failure
        raise EnvError(f"cannot download {spec['url']}: {exc}") from exc
    digest = sha256_of(tmp)
    if digest != spec["sha256"]:
        tmp.unlink(missing_ok=True)
        raise EnvError(f"sha256 mismatch for {spec['file']}: got {digest}, expected {spec['sha256']}")
    os.replace(tmp, path)
    return path


def read_image(path: Path) -> np.ndarray:
    """cv2.imread cannot open non-ASCII paths on Windows; decode from bytes instead. Returns RGB."""
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise EnvError(f"cannot decode image {path}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def fit_long_side(w: int, h: int, long_side: int) -> tuple[int, int]:
    scale = min(1.0, long_side / max(w, h))
    return max(2, int(round(w * scale / 2)) * 2), max(2, int(round(h * scale / 2)) * 2)


def parse_rate(text: str | None) -> float | None:
    if not text or text in ("0/0", "N/A"):
        return None
    try:
        if "/" in text:
            a, b = text.split("/", 1)
            return float(a) / float(b) if float(b) else None
        return float(text)
    except ValueError:
        return None


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True)


def r(x, nd=4):
    if x is None:
        return None
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return round(float(x), nd)


def luma(img: np.ndarray) -> np.ndarray:
    return img[..., 0] * 0.299 + img[..., 1] * 0.587 + img[..., 2] * 0.114


def ssim_gray(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    blur = lambda x: cv2.GaussianBlur(x, (7, 7), 1.5)
    mu_a, mu_b = blur(a), blur(b)
    s_aa = blur(a * a) - mu_a ** 2
    s_bb = blur(b * b) - mu_b ** 2
    s_ab = blur(a * b) - mu_a * mu_b
    num = (2 * mu_a * mu_b + c1) * (2 * s_ab + c2)
    den = (mu_a ** 2 + mu_b ** 2 + c1) * (s_aa + s_bb + c2)
    return float(np.mean(num / den))


def ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(np.float64).ravel()
    b = b.astype(np.float64).ravel()
    a -= a.mean()
    b -= b.mean()
    den = math.sqrt(float(a @ a) * float(b @ b))
    return float(a @ b / den) if den > 0 else 0.0


def color_hist(rgb: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    """Chroma histogram: CIE Lab (a*, b*) 32x32 bins, lightly smoothed across bins.

    a*/b* is used instead of HSV hue because hue is unstable for the near-grey pixels
    that dominate most backgrounds (codec noise flips them between distant hue bins).
    """
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    hist = cv2.calcHist([lab], [1, 2], mask, [HIST_BINS, HIST_BINS], [0, 256, 0, 256])
    hist = cv2.GaussianBlur(hist, (5, 5), 1.0)
    cv2.normalize(hist, hist, 1.0, 0.0, cv2.NORM_L1)
    return hist


def hist_dist(h1: np.ndarray, h2: np.ndarray) -> float:
    return float(cv2.compareHist(h1, h2, cv2.HISTCMP_BHATTACHARYYA))


def fit_source(src: np.ndarray, w: int, h: int, mode: str) -> np.ndarray:
    sh, sw = src.shape[:2]
    if mode == "stretch":
        return cv2.resize(src, (w, h), interpolation=cv2.INTER_AREA)
    if mode == "cover":
        scale = max(w / sw, h / sh)
        rs = cv2.resize(src, (max(w, round(sw * scale)), max(h, round(sh * scale))), interpolation=cv2.INTER_AREA)
        y0 = (rs.shape[0] - h) // 2
        x0 = (rs.shape[1] - w) // 2
        return rs[y0:y0 + h, x0:x0 + w]
    # contain (letterbox with black)
    scale = min(w / sw, h / sh)
    nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
    rs = cv2.resize(src, (nw, nh), interpolation=cv2.INTER_AREA)
    out = np.zeros((h, w, 3), np.uint8)
    y0, x0 = (h - nh) // 2, (w - nw) // 2
    out[y0:y0 + nh, x0:x0 + nw] = rs
    return out


def cell_max_diff(a: np.ndarray, b: np.ndarray) -> float:
    """Largest per-cell mean |a-b| over a FREEZE_GRID grid (local motion counts, not just global)."""
    d = np.abs(a.astype(np.int16) - b.astype(np.int16)).mean(axis=2)
    rows, cols = FREEZE_GRID
    h, w = d.shape
    best = 0.0
    for i in range(rows):
        for j in range(cols):
            c = d[i * h // rows:(i + 1) * h // rows, j * w // cols:(j + 1) * w // cols]
            if c.size:
                best = max(best, float(c.mean()))
    return best


ALIGN_LANDMARKS = (0, 11, 12, 23, 24, 25, 26, 27, 28)  # nose, shoulders, hips, knees, ankles
ALIGN_MIN_POINTS = 4


def person_aligned_compare(src: np.ndarray, src_lm, frame: np.ndarray, frame_lm) -> dict | None:
    """First-frame vs source comparison on the person, not the whole frame.

    Fits a scale + translation (no rotation) mapping the source's pose landmarks onto the frame's,
    warps the source into frame coordinates, crops the padded person box (from the frame's landmarks)
    out of both images and returns SSIM / NCC (grayscale, FIRST_FRAME_PERSON_LONG_SIDE) and the Lab chroma
    histogram distance on those crops. None when either pose is missing.
    """
    if src_lm is None or frame_lm is None:
        return None
    idx = [k for k in ALIGN_LANDMARKS
           if src_lm[k, 2] >= LANDMARK_MIN_VISIBILITY and frame_lm[k, 2] >= LANDMARK_MIN_VISIBILITY]
    if len(idx) < ALIGN_MIN_POINTS:
        return None
    p, q = src_lm[idx, :2], frame_lm[idx, :2]
    pc, qc = p.mean(axis=0), q.mean(axis=0)
    sp = float(np.sqrt(np.sum((p - pc) ** 2)))
    if sp < 1e-6:
        return None
    s = float(np.sqrt(np.sum((q - qc) ** 2))) / sp
    t = qc - s * pc
    h, w = frame.shape[:2]
    warped = cv2.warpAffine(src, np.array([[s, 0, t[0]], [0, s, t[1]]], np.float32), (w, h),
                            flags=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    vis = frame_lm[frame_lm[:, 2] >= LANDMARK_MIN_VISIBILITY, :2]
    torso = float(np.linalg.norm((frame_lm[11, :2] + frame_lm[12, :2]) / 2 - (frame_lm[23, :2] + frame_lm[24, :2]) / 2))
    x0 = int(max(0, vis[:, 0].min() - 0.35 * torso))
    x1 = int(min(w, vis[:, 0].max() + 0.35 * torso))
    y0 = int(max(0, vis[:, 1].min() - 0.6 * torso))
    y1 = int(min(h, vis[:, 1].max() + 0.25 * torso))
    if x1 - x0 < 16 or y1 - y0 < 16:
        return None
    a, b = warped[y0:y1, x0:x1], frame[y0:y1, x0:x1]
    gw, gh = fit_long_side(x1 - x0, y1 - y0, FIRST_FRAME_PERSON_LONG_SIDE)
    ga = cv2.resize(luma(a.astype(np.float32)), (gw, gh), interpolation=cv2.INTER_AREA)
    gb = cv2.resize(luma(b.astype(np.float32)), (gw, gh), interpolation=cv2.INTER_AREA)
    resid = float(np.sqrt(np.mean(np.sum((s * p + t - q) ** 2, axis=1)))) / max(torso, 1e-6)
    by_scale = {}
    for ls in (256, 128, 96):
        sw_, sh_ = fit_long_side(x1 - x0, y1 - y0, ls)
        a_ = cv2.resize(luma(a.astype(np.float32)), (sw_, sh_), interpolation=cv2.INTER_AREA)
        b_ = cv2.resize(luma(b.astype(np.float32)), (sw_, sh_), interpolation=cv2.INTER_AREA)
        by_scale[str(ls)] = {"ssim": r(ssim_gray(a_, b_)), "ncc": r(ncc(a_, b_))}
    return {"ssim": ssim_gray(ga, gb), "ncc": ncc(ga, gb), "hist_dist": hist_dist(color_hist(a), color_hist(b)),
            "alignment": {"scale": r(s, 4), "shift_px": [r(t[0], 1), r(t[1], 1)], "points": len(idx),
                          "ssim_ncc_by_long_side": by_scale,
                          "landmark_residual_torso": r(resid, 4), "crop_xyxy": [x0, y0, x1, y1]}}


def judged_windows(times: np.ndarray, duration: float, length: float, min_samples: int) -> list[dict]:
    """Partition [0, duration] into windows that are each judged on enough samples.

    1. Non-overlapping windows of `length` seconds; a trailing remainder shorter than `length`
       is merged into the previous window (so no window covers e.g. only the last 0.04 s).
    2. Any window holding fewer than `min_samples` samples is folded into its neighbour
       (previous; next for the first window) until every window has enough or only one is left.
    Returns [{"start_s", "end_s", "mask", "merged_insufficient": [start_s of folded windows]}].
    """
    times = np.asarray(times, dtype=np.float64)
    end_all = max(duration, float(times.max()) + 1e-6 if times.size else 0.0, 1e-6)
    n_full = max(1, int(math.floor(end_all / length + 1e-9)))
    bounds = [i * length for i in range(n_full)] + [end_all]  # remainder folded into the last full window
    wins = [{"start": bounds[i], "end": bounds[i + 1], "merged": []} for i in range(len(bounds) - 1)]

    def count(w):
        return int(np.sum((times >= w["start"]) & (times < w["end"] if w["end"] < end_all else times <= w["end"])))

    while len(wins) > 1:
        small = [i for i, w in enumerate(wins) if count(w) < min_samples]
        if not small:
            break
        i = small[0]
        j = i - 1 if i > 0 else i + 1
        a, b = sorted((i, j))
        merged = {"start": wins[a]["start"], "end": wins[b]["end"],
                  "merged": wins[a]["merged"] + wins[b]["merged"] + [r(wins[i]["start"], 2)]}
        wins[a:b + 1] = [merged]
    out = []
    for w in wins:
        m = (times >= w["start"]) & ((times < w["end"]) if w["end"] < end_all else (times <= w["end"]))
        out.append({"start_s": r(w["start"], 2), "end_s": r(w["end"], 3),
                    "mask": m, "merged_insufficient": w["merged"]})
    return out


def longest_run(flags: list[bool]) -> tuple[int, int]:
    """Return (length, start index) of the longest run of True."""
    best, best_start, cur, start = 0, -1, 0, 0
    for i, f in enumerate(flags):
        if f:
            if cur == 0:
                start = i
            cur += 1
            if cur > best:
                best, best_start = cur, start
        else:
            cur = 0
    return best, best_start


# --------------------------------------------------------------------------------------
# decoding
# --------------------------------------------------------------------------------------
def probe(video: Path) -> dict:
    p = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration,format_name",
             "-of", "json", str(video)])
    if p.returncode != 0:
        return {"error": p.stderr.decode("utf-8", "replace").strip()[-800:]}
    info = json.loads(p.stdout.decode("utf-8", "replace") or "{}")
    streams = info.get("streams") or []
    if not streams:
        return {"error": "no video stream"}
    st = streams[0]
    fmt = info.get("format") or {}
    ts = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
              "frame=best_effort_timestamp_time", "-of", "csv=p=0", str(video)])
    times = []
    for line in ts.stdout.decode("utf-8", "replace").splitlines():
        line = line.strip().rstrip(",")
        try:
            times.append(float(line))
        except ValueError:
            pass
    return {
        "codec": st.get("codec_name"),
        "format": fmt.get("format_name"),
        "width": int(st.get("width") or 0),
        "height": int(st.get("height") or 0),
        "r_frame_rate": parse_rate(st.get("r_frame_rate")),
        "avg_frame_rate": parse_rate(st.get("avg_frame_rate")),
        "header_duration": parse_rate(st.get("duration")) or parse_rate(fmt.get("duration")),
        "header_nb_frames": int(st["nb_frames"]) if str(st.get("nb_frames", "")).isdigit() else None,
        "frame_times": times,
        "probe_frame_errors": ts.stderr.decode("utf-8", "replace").strip()[-400:] if ts.returncode != 0 else "",
    }


def decode_frames(video: Path, w: int, h: int, keep: set[int]):
    """Stream-decode every frame at analysis size (w,h).

    Returns (frame count, small frames list, dict idx->analysis frame for idx in keep, stderr).
    """
    sw, sh = fit_long_side(w, h, SMALL_LONG_SIDE)
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(video), "-map", "0:v:0", "-an",
           "-fps_mode", "passthrough", "-vf", f"scale={w}:{h}:flags=area", "-pix_fmt", "rgb24",
           "-f", "rawvideo", "pipe:1"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = w * h * 3
    small, kept, n = [], {}, 0
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            small.append(cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA))
            if n in keep:
                kept[n] = frame.copy()
            n += 1
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode("utf-8", "replace")
        proc.wait()
    return n, small, kept, err.strip()[-800:]


# --------------------------------------------------------------------------------------
# pose / face
# --------------------------------------------------------------------------------------
class Detectors:
    def __init__(self):
        pose_path = ensure_model("pose")
        face_path = ensure_model("face")
        base = mp_tasks.BaseOptions(model_asset_path=str(pose_path), delegate=mp_tasks.BaseOptions.Delegate.CPU)
        self.pose = mp_vision.PoseLandmarker.create_from_options(mp_vision.PoseLandmarkerOptions(
            base_options=base, running_mode=mp_vision.RunningMode.IMAGE, num_poses=1,
            min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5))
        fbase = mp_tasks.BaseOptions(model_asset_path=str(face_path), delegate=mp_tasks.BaseOptions.Delegate.CPU)
        self.face = mp_vision.FaceDetector.create_from_options(mp_vision.FaceDetectorOptions(
            base_options=fbase, running_mode=mp_vision.RunningMode.IMAGE, min_detection_confidence=0.5))
        self.yunet = cv2.FaceDetectorYN.create(str(ensure_model("yunet")), "", (320, 320), 0.6, 0.3, 5000,
                                               cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
        self.sface = cv2.FaceRecognizerSF.create(str(ensure_model("sface")), "",
                                                 cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)

    def face_identity(self, rgb: np.ndarray, lm: np.ndarray | None, px_scale: float = 1.0) -> dict:
        """Detect + embed the face around the pose head landmarks (whole image if lm is None).

        Returns {"status": "ok"|"no_face"|"low_score"|"too_small"|"profile"|"blurred", ...}. When a face
        was detected the dict also has the SFace feature, face width in native pixels (input pixels x
        px_scale), yaw proxy, sharpness and the median Lab colour of the hair band above the face.
        """
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        if lm is not None:
            head = lm[0:11]
            cx, cy = head[0, 0], head[0, 1]
            torso = float(np.linalg.norm((lm[11, :2] + lm[12, :2]) / 2 - (lm[23, :2] + lm[24, :2]) / 2))
            size = max(3.0 * float(np.ptp(head[:, 0])), 0.9 * torso, 64.0)
            x0, y0 = int(max(0, cx - size / 2)), int(max(0, cy - size / 2))
            x1, y1 = int(min(w, cx + size / 2)), int(min(h, cy + size / 2))
            if x1 - x0 < 16 or y1 - y0 < 16:
                return {"status": "no_face"}
            crop = bgr[y0:y1, x0:x1]
        else:
            crop = bgr
        sc = 320.0 / max(crop.shape[:2])
        crop = cv2.resize(crop, (max(1, int(round(crop.shape[1] * sc))), max(1, int(round(crop.shape[0] * sc)))),
                          interpolation=cv2.INTER_CUBIC if sc > 1 else cv2.INTER_AREA)
        self.yunet.setInputSize((crop.shape[1], crop.shape[0]))
        _, faces = self.yunet.detect(crop)
        if faces is None or len(faces) == 0:
            return {"status": "no_face"}
        f = max(faces, key=lambda d: float(d[14]))
        score = float(f[14])
        width_px = float(f[2]) / sc
        le, re, nose = f[4:6], f[6:8], f[8:10]
        eye_d = float(np.linalg.norm(re - le))
        yaw = float(np.dot(nose - (le + re) / 2, (re - le) / max(eye_d, 1e-6)) / max(eye_d, 1e-6))
        aligned = self.sface.alignCrop(crop, f)
        sharp = float(cv2.Laplacian(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
        # hair band: strip above the face box, slightly wider than the face
        fx, fy, fw, fh = (float(v) for v in f[:4])
        hx0, hx1 = int(max(0, fx - 0.15 * fw)), int(min(crop.shape[1], fx + 1.15 * fw))
        hy0, hy1 = int(max(0, fy - 0.45 * fh)), int(max(0, fy + 0.05 * fh))
        hair = None
        if hx1 - hx0 > 4 and hy1 - hy0 > 4:
            lab = cv2.cvtColor(crop[hy0:hy1, hx0:hx1], cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float64)
            lab[:, 0] *= 100.0 / 255.0
            lab[:, 1:] -= 128.0
            hair = np.median(lab, axis=0)
        out = {"score": score, "width_px": width_px * px_scale, "yaw": yaw, "sharpness": sharp,
               "feature": self.sface.feature(aligned).copy(), "hair_lab": hair, "status": "ok"}
        if score < FACE_ID_MIN_SCORE:
            out["status"] = "low_score"
        elif width_px * px_scale < FACE_ID_MIN_FACE_PX:
            out["status"] = "too_small"
        elif abs(yaw) > FACE_ID_MAX_YAW:
            out["status"] = "profile"
        elif sharp < FACE_ID_MIN_SHARPNESS:
            out["status"] = "blurred"
        return out

    def cosine(self, a: np.ndarray, b: np.ndarray) -> float:
        return float(self.sface.match(a, b, cv2.FaceRecognizerSF_FR_COSINE))

    def close(self):
        self.pose.close()
        self.face.close()

    def landmarks(self, rgb: np.ndarray):
        """Return (33,3) array of pixel x, pixel y, visibility or None."""
        res = self.pose.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
        if not res.pose_landmarks:
            return None
        h, w = rgb.shape[:2]
        return np.array([[p.x * w, p.y * h, p.visibility if p.visibility is not None else 0.0]
                         for p in res.pose_landmarks[0]], dtype=np.float64)

    def face_in_head(self, rgb: np.ndarray, lm: np.ndarray) -> bool | None:
        """Run the face detector on a crop around the head landmarks (0..10)."""
        head = lm[0:11]
        if np.mean(head[:, 2]) < 0.3:
            return False
        cx, cy = head[0, 0], head[0, 1]
        torso = np.linalg.norm((lm[11, :2] + lm[12, :2]) / 2 - (lm[23, :2] + lm[24, :2]) / 2)
        span = np.ptp(head[:, 0]) if head.shape[0] else 0
        size = max(2.5 * span, 0.7 * torso, 48)
        h, w = rgb.shape[:2]
        x0, y0 = int(max(0, cx - size / 2)), int(max(0, cy - size / 2))
        x1, y1 = int(min(w, cx + size / 2)), int(min(h, cy + size / 2))
        if x1 - x0 < 8 or y1 - y0 < 8:
            return False
        crop = cv2.resize(rgb[y0:y1, x0:x1], (256, 256), interpolation=cv2.INTER_CUBIC)
        res = self.face.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(crop)))
        return bool(res.detections)


def pose_ok(lm: np.ndarray | None, w: int, h: int) -> bool:
    if lm is None:
        return False
    vis = lm[:, 2]
    if np.any(vis[list(CORE_LANDMARKS)] < LANDMARK_MIN_VISIBILITY):
        return False
    core = lm[list(CORE_LANDMARKS), :2]
    if np.any(core[:, 0] < -0.05 * w) or np.any(core[:, 0] > 1.05 * w) or np.any(core[:, 1] < -0.05 * h) or np.any(core[:, 1] > 1.05 * h):
        return False
    return int(np.sum(vis[list(LIMB_LANDMARKS)] >= LANDMARK_MIN_VISIBILITY)) >= MIN_LIMB_LANDMARKS


def torso_polygon(lm: np.ndarray, shrink: float = 0.75) -> np.ndarray:
    quad = lm[[11, 12, 24, 23], :2]
    c = quad.mean(axis=0)
    return (c + (quad - c) * shrink).astype(np.int32)


def clothing_mask(shape: tuple, lm: np.ndarray) -> np.ndarray:
    """Mask of the torso quad (shrunk) plus both thighs (hip->knee strokes) from pose landmarks.

    Thighs are included so trousers count: a white top on a grey wall has almost no chroma,
    the jeans usually do.
    """
    mask = np.zeros(shape[:2], np.uint8)
    cv2.fillPoly(mask, [torso_polygon(lm)], 255)
    torso = float(np.linalg.norm((lm[11, :2] + lm[12, :2]) / 2 - (lm[23, :2] + lm[24, :2]) / 2))
    thick = max(2, int(0.22 * torso))
    for hip, knee in ((23, 25), (24, 26)):
        if lm[knee, 2] >= LANDMARK_MIN_VISIBILITY:
            a = lm[hip, :2] + 0.15 * (lm[knee, :2] - lm[hip, :2])
            b = lm[hip, :2] + 0.85 * (lm[knee, :2] - lm[hip, :2])
            cv2.line(mask, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), 255, thick)
    return mask


# --------------------------------------------------------------------------------------
# main analysis
# --------------------------------------------------------------------------------------
def check(passed: bool, metrics: dict, thresholds: dict, details: dict | None = None, note: str = "") -> dict:
    out = {"passed": bool(passed), "metrics": metrics, "thresholds": thresholds}
    if details:
        out["details"] = details
    if note:
        out["note"] = note
    return out


def failed_skip(reason: str) -> dict:
    return {"passed": False, "skipped": True, "note": reason, "metrics": {}, "thresholds": {}}


def analyse(video: Path, source: Path, min_seconds: float) -> dict:
    report: dict = {
        "video": str(video), "source": str(source), "min_seconds": min_seconds,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "tool": {"python": sys.version.split()[0], "numpy": np.__version__, "opencv": cv2.__version__,
                 "mediapipe": mp.__version__, "models": {k: {"url": v["url"], "sha256": v["sha256"]} for k, v in MODELS.items()}},
        "checks": {},
    }
    checks = report["checks"]
    names = ["container", "frame_health", "person", "dancing", "identity", "seams"]

    # ---------- 1. container ----------
    info = probe(video)
    if "error" in info or info["width"] <= 0:
        checks["container"] = check(False, {"decodable": False}, {}, {"ffprobe_error": info.get("error", "bad stream")})
        for n in names[1:]:
            checks[n] = failed_skip("video not decodable")
        return report

    W, H = info["width"], info["height"]
    aw, ah = fit_long_side(W, H, ANALYSIS_LONG_SIDE)
    times = info["frame_times"]
    intervals = np.diff(np.array(times)) if len(times) > 1 else np.array([])
    intervals = intervals[intervals > 0]
    # average rate over the whole stream (robust to millisecond-rounded WebM timestamps)
    fps_pts = (len(times) - 1) / (times[-1] - times[0]) if (intervals.size and times[-1] > times[0]) else None
    fps = fps_pts or info["avg_frame_rate"] or info["r_frame_rate"]

    # sample indices for pose analysis need the frame count; use probe count first, verify after decode
    n_probe = len(times)
    keep = set()
    if fps and n_probe:
        dur_guess = n_probe / fps
        sample_times = np.arange(0.0, dur_guess, 1.0 / POSE_SAMPLE_FPS)
        keep = {min(n_probe - 1, int(round(t * fps))) for t in sample_times}
    keep.add(0)
    n, small, kept, dec_err = decode_frames(video, aw, ah, keep)

    decoded_duration = (n / fps) if (fps and n) else 0.0
    pts_span = (times[-1] - times[0] + (1.0 / fps)) if (len(times) > 1 and fps) else None
    duration = min(decoded_duration, pts_span) if pts_span else decoded_duration
    c_metrics = {
        "decodable": n > 0, "codec": info["codec"], "format": info["format"],
        "width": W, "height": H, "short_side_px": min(W, H),
        "decoded_frames": n, "probe_frames": n_probe, "header_nb_frames": info["header_nb_frames"],
        "fps": r(fps, 3), "fps_from_timestamps": r(fps_pts, 3), "header_avg_frame_rate": r(info["avg_frame_rate"], 3),
        "decoded_duration_s": r(decoded_duration, 3), "pts_span_s": r(pts_span, 3),
        "duration_s": r(duration, 3), "header_duration_s": r(info["header_duration"], 3),
    }
    c_thr = {"min_duration_s": min_seconds, "fps_range": [MIN_FPS, MAX_FPS], "min_short_side_px": MIN_SHORT_SIDE_PX}
    c_fail = []
    if n == 0:
        c_fail.append("no frames decoded")
    if duration + 1e-6 < min_seconds:
        c_fail.append(f"duration {duration:.3f}s < {min_seconds}s")
    if not fps or not (MIN_FPS <= fps <= MAX_FPS):
        c_fail.append(f"fps {fps} outside [{MIN_FPS}, {MAX_FPS}]")
    if min(W, H) < MIN_SHORT_SIDE_PX:
        c_fail.append(f"short side {min(W, H)} < {MIN_SHORT_SIDE_PX}")
    if n_probe and abs(n - n_probe) > 1:
        c_fail.append(f"decoded frame count {n} != probed {n_probe}")
    checks["container"] = check(not c_fail, c_metrics, c_thr, {"failures": c_fail, "decoder_stderr": dec_err} if (c_fail or dec_err) else None)
    if n == 0 or not fps:
        for nm in names[1:]:
            checks[nm] = failed_skip("no decodable frames")
        return report

    # ---------- 2. frame health ----------
    lum = [luma(f.astype(np.float32)) for f in small]
    means = np.array([float(l.mean()) for l in lum])
    stds = np.array([float(l.std()) for l in lum])
    black = np.where((means < BLACK_MAX_MEAN) & (stds < BLACK_MAX_STD))[0]
    blown = np.where((means > BLOWN_MIN_MEAN) & (stds < BLACK_MAX_STD))[0]
    blank = np.where(stds < BLANK_MAX_STD)[0]
    bad = sorted(set(black.tolist()) | set(blown.tolist()) | set(blank.tolist()))
    diffs = np.array([float(np.mean(np.abs(small[i].astype(np.int16) - small[i - 1].astype(np.int16)))) for i in range(1, n)])
    cell_max = np.array([cell_max_diff(small[i], small[i - 1]) for i in range(1, n)])
    frozen_flags = (cell_max < FREEZE_DIFF).tolist()
    run_len, run_start = longest_run(frozen_flags)
    frozen_seconds = (run_len / fps) if run_len else 0.0  # run of k identical transitions = k frame periods static
    h_metrics = {
        "black_frames": len(black), "blown_out_frames": len(blown), "blank_frames": len(blank),
        "bad_frames_total": len(bad), "longest_frozen_run_s": r(frozen_seconds, 3),
        "longest_frozen_run_start_frame": int(run_start) + 1 if run_len else None,
        "frozen_transition_ratio": r(float(np.mean(frozen_flags)) if frozen_flags else 0.0),
        "luma_mean_range": [r(means.min(), 2), r(means.max(), 2)], "luma_std_min": r(stds.min(), 2),
        "median_frame_diff": r(float(np.median(diffs)) if diffs.size else 0.0),
        "median_cell_max_diff": r(float(np.median(cell_max)) if cell_max.size else 0.0),
    }
    h_thr = {"black": f"mean<{BLACK_MAX_MEAN} & std<{BLACK_MAX_STD}", "blown_out": f"mean>{BLOWN_MIN_MEAN} & std<{BLACK_MAX_STD}",
             "blank": f"std<{BLANK_MAX_STD}", "max_bad_frames": MAX_BAD_FRAMES,
             "freeze_cell_diff": FREEZE_DIFF, "freeze_grid": list(FREEZE_GRID), "max_frozen_run_s": MAX_FROZEN_SECONDS}
    h_pass = len(bad) <= MAX_BAD_FRAMES and frozen_seconds <= MAX_FROZEN_SECONDS
    checks["frame_health"] = check(h_pass, h_metrics, h_thr, {"bad_frame_indices": bad[:50]} if bad else None)

    # ---------- 3. person ----------
    try:
        det = Detectors()
    except EnvError:
        raise
    try:
        samples = []  # dicts: idx, t, lm(or None), ok
        for idx in sorted(kept):
            if idx >= n:
                continue
            lm = det.landmarks(kept[idx])
            samples.append({"idx": idx, "t": idx / fps, "lm": lm, "ok": pose_ok(lm, aw, ah)})
        n_s = len(samples)
        ok_flags = [s["ok"] for s in samples]
        coverage = float(np.mean(ok_flags)) if n_s else 0.0
        n_secs = max(1, int(math.ceil(duration - 1e-6)))
        per_sec = []
        for sec in range(n_secs):
            in_sec = [s["ok"] for s in samples if sec <= s["t"] < sec + 1]
            per_sec.append(r(float(np.mean(in_sec)), 3) if in_sec else None)
        per_sec_valid = [v for v in per_sec if v is not None]
        min_sec = min(per_sec_valid) if per_sec_valid else 0.0
        missing = [s["idx"] for s in samples if not s["ok"]]
        p_metrics = {"samples": n_s, "sample_fps": POSE_SAMPLE_FPS, "coverage": r(coverage, 3),
                     "min_per_second_coverage": r(min_sec, 3), "per_second_coverage": per_sec}
        p_thr = {"min_coverage": MIN_PERSON_COVERAGE, "min_per_second_coverage": MIN_PER_SECOND_COVERAGE,
                 "core_landmarks": "shoulders+hips", "min_limb_landmarks": f"{MIN_LIMB_LANDMARKS}/8",
                 "min_visibility": LANDMARK_MIN_VISIBILITY}
        checks["person"] = check(coverage >= MIN_PERSON_COVERAGE and min_sec >= MIN_PER_SECOND_COVERAGE and n_s > 0,
                                 p_metrics, p_thr, {"frames_without_person": missing[:60]} if missing else None)

        # ---------- 4. dancing ----------
        valid = [s for s in samples if s["ok"]]
        rel = []  # (t, (8,2) hip-relative coords in torso lengths, NaN where not visible)
        abs_hip = []
        for s in valid:
            lm = s["lm"]
            hip = (lm[23, :2] + lm[24, :2]) / 2
            shoulder = (lm[11, :2] + lm[12, :2]) / 2
            torso = float(np.linalg.norm(shoulder - hip))
            if torso < 4:
                continue
            pts = (lm[list(LIMB_LANDMARKS), :2] - hip) / torso
            pts[lm[list(LIMB_LANDMARKS), 2] < LANDMARK_MIN_VISIBILITY] = np.nan
            rel.append((s["t"], pts))
            abs_hip.append((s["t"], hip / max(aw, ah), torso / max(aw, ah)))

        def extent(arr: np.ndarray, lo: float, hi: float) -> float:
            """mean over limb points of the 2-D percentile extent; arr (T,8,2)."""
            vals = []
            for j in range(arr.shape[1]):
                p = arr[:, j, :]
                p = p[~np.isnan(p).any(axis=1)]
                if len(p) < 3:
                    continue
                d = np.percentile(p, hi, axis=0) - np.percentile(p, lo, axis=0)
                vals.append(float(np.hypot(*d)))
            return float(np.mean(vals)) if vals else 0.0

        windows = []
        if rel:
            ts = np.array([t for t, _ in rel])
            arr = np.stack([p for _, p in rel])
            overall = extent(arr, 5, 95)
            # sliding full-length windows; the last one is aligned to the clip end, so none is short
            starts = list(np.arange(0.0, max(duration - MOTION_WINDOW_SECONDS, 0.0) + 1e-6, MOTION_WINDOW_STEP))
            if duration > MOTION_WINDOW_SECONDS and duration - MOTION_WINDOW_SECONDS - starts[-1] > 0.25:
                starts.append(duration - MOTION_WINDOW_SECONDS)
            for st in starts:
                m = (ts >= st) & (ts < st + MOTION_WINDOW_SECONDS)
                cnt = int(m.sum())
                ex = extent(arr[m], 10, 90) if cnt >= MIN_WINDOW_SAMPLES else 0.0
                windows.append({"start_s": r(st, 2), "samples": cnt, "excursion": r(ex),
                                "passed": cnt >= MIN_WINDOW_SAMPLES and ex >= MIN_WINDOW_EXCURSION})
            # mean speed (torso lengths / s) for information
            sp = []
            for k in range(1, len(rel)):
                dt = ts[k] - ts[k - 1]
                if dt <= 0 or dt > 2.5 / POSE_SAMPLE_FPS:
                    continue
                d = np.linalg.norm(arr[k] - arr[k - 1], axis=1)
                d = d[~np.isnan(d)]
                if d.size:
                    sp.append(float(d.mean() / dt))
            hip_t = np.array([h for _, h, _ in abs_hip])
            hip_disp = float(np.hypot(*(np.percentile(hip_t, 95, axis=0) - np.percentile(hip_t, 5, axis=0))))
            scales = np.array([s for _, _, s in abs_hip])
            zoom_ratio = float(np.percentile(scales, 95) / max(np.percentile(scales, 5), 1e-6))
        else:
            overall, sp, hip_disp, zoom_ratio = 0.0, [], 0.0, 1.0
        failing_windows = [w for w in windows if not w["passed"]]
        worst = min(windows, key=lambda w: (w["excursion"] or 0.0)) if windows else None
        d_metrics = {
            "overall_limb_range": r(overall), "windows": len(windows), "failing_windows": len(failing_windows),
            "worst_window": worst, "mean_limb_speed_torso_per_s": r(float(np.mean(sp)) if sp else 0.0),
            "hip_center_travel_frac_of_frame": r(hip_disp), "body_scale_ratio_p95_p5": r(zoom_ratio, 3),
        }
        d_thr = {"window_s": MOTION_WINDOW_SECONDS, "window_step_s": MOTION_WINDOW_STEP,
                 "min_window_excursion": MIN_WINDOW_EXCURSION, "min_window_samples": MIN_WINDOW_SAMPLES,
                 "min_overall_limb_range": MIN_OVERALL_RANGE,
                 "units": "torso lengths, landmarks relative to hip centre (camera pan/zoom cancels out)"}
        checks["dancing"] = check(bool(windows) and not failing_windows and overall >= MIN_OVERALL_RANGE,
                                  d_metrics, d_thr, {"window_excursions": windows})

        # ---------- 5. identity ----------
        src = read_image(source)
        f0 = kept[0]
        best = None
        for mode in ("cover", "contain", "stretch"):
            fitted = fit_source(src, aw, ah, mode)
            gw, gh = fit_long_side(aw, ah, 256)
            ga = cv2.resize(luma(fitted.astype(np.float32)), (gw, gh), interpolation=cv2.INTER_AREA)
            gb = cv2.resize(luma(f0.astype(np.float32)), (gw, gh), interpolation=cv2.INTER_AREA)
            cand = {"fit": mode, "ssim": ssim_gray(ga, gb), "ncc": ncc(ga, gb),
                    "hist_dist": hist_dist(color_hist(fitted), color_hist(f0))}
            if best is None or cand["ssim"] > best["ssim"]:
                best = cand
        raw_best = best  # whole-frame comparison: reported as info only (generators may re-centre the person)

        # person-aligned comparison: scale+translate the source so its pose landmarks land on the first
        # frame's, then compare the padded person crops (robust to re-centring / re-scaling)
        src_lm = det.landmarks(src)
        f0_lm = samples[0]["lm"] if samples and samples[0]["idx"] == 0 and samples[0]["ok"] else None
        aligned = person_aligned_compare(src, src_lm, f0, f0_lm)
        if aligned is not None:
            best = dict(aligned, fit="person-aligned")
        first_ok = (best["ssim"] >= FIRST_FRAME_MIN_SSIM and best["ncc"] >= FIRST_FRAME_MIN_NCC
                    and best["hist_dist"] <= FIRST_FRAME_MAX_HIST_DIST)

        # torso colour consistency
        torso_series = []
        ref_hist = None
        for s in samples:
            if not s["ok"]:
                continue
            img = kept[s["idx"]]
            mask = clothing_mask(img.shape, s["lm"])
            if int(mask.sum() // 255) < 50:
                continue
            hst = color_hist(img, mask)
            if ref_hist is None:
                ref_hist = hst
            torso_series.append((s["t"], hist_dist(ref_hist, hst)))
        id_windows = []
        if torso_series:
            tt = np.array([t for t, _ in torso_series])
            dd = np.array([d for _, d in torso_series])
            for jw in judged_windows(tt, duration, IDENTITY_WINDOW_SECONDS, IDENTITY_MIN_WINDOW_SAMPLES):
                m = jw["mask"]
                if m.any():
                    id_windows.append({"start_s": jw["start_s"], "end_s": jw["end_s"], "samples": int(m.sum()),
                                       "median_torso_hist_dist": r(float(np.median(dd[m]))),
                                       "merged_insufficient": jw["merged_insufficient"]})
        worst_id = max(id_windows, key=lambda w: w["median_torso_hist_dist"]) if id_windows else None
        torso_ok = bool(worst_id) and worst_id["median_torso_hist_dist"] <= TORSO_MAX_HIST_DIST

        # source photo's clothing vs. the video's first torso sample
        src_torso_dist = None
        if src_lm is not None and pose_ok(src_lm, src.shape[1], src.shape[0]) and ref_hist is not None:
            smask = clothing_mask(src.shape, src_lm)
            if int(smask.sum() // 255) >= 50:
                src_torso_dist = hist_dist(color_hist(src, smask), ref_hist)
        src_torso_ok = src_torso_dist is None or src_torso_dist <= SOURCE_TORSO_MAX_HIST_DIST

        # face presence (head crop from pose landmarks)
        src_face = bool(src_lm is not None and det.face_in_head(src, src_lm))
        if not src_face:
            src_face = bool(det.face.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(src))).detections)
        faces = [det.face_in_head(kept[s["idx"]], s["lm"]) for s in valid]
        face_ratio = float(np.mean(faces)) if faces else 0.0
        face_ok = (face_ratio >= MIN_FACE_PRESENCE) if src_face else True

        # face identity: SFace cosine similarity of each usable sampled face to the source face
        src_id = det.face_identity(src, src_lm) if src_lm is not None else {"status": "no_face"}
        if src_id["status"] == "no_face":
            src_id = det.face_identity(src, None)
        fid = {"source_face": src_id["status"] != "no_face"}
        face_id_ok, face_id_fail = True, ""
        if fid["source_face"]:
            fid["source_face_px"] = r(src_id["width_px"], 1)
            px_scale = W / float(aw)
            skips: dict = {}
            series = []  # (t, cosine, hair dE or None)
            for s in valid:
                res = det.face_identity(kept[s["idx"]], s["lm"], px_scale)
                if res["status"] != "ok":
                    skips[res["status"]] = skips.get(res["status"], 0) + 1
                    continue
                de = None
                if res["hair_lab"] is not None and src_id.get("hair_lab") is not None:
                    de = float(np.linalg.norm(res["hair_lab"] - src_id["hair_lab"]))
                series.append((s["t"], det.cosine(src_id["feature"], res["feature"]), de))
            usable = len(series)
            fid.update({"person_samples": len(valid), "usable_faces": usable,
                        "skip_ratio": r(1 - usable / len(valid), 3) if valid else None, "skipped": skips})
            if usable:
                cs = np.array([c for _, c, _ in series])
                tt = np.array([t for t, _, _ in series])
                fid["cosine_first"] = r(float(cs[0]))
                fid["cosine_median"] = r(float(np.median(cs)))
                fid["cosine_p10"] = r(float(np.percentile(cs, 10)))
                n_secs_f = max(1, int(math.ceil(duration - 1e-6)))
                fid["per_second_median"] = [r(float(np.median(cs[(tt >= k) & (tt < k + 1)])), 3)
                                            if np.any((tt >= k) & (tt < k + 1)) else None for k in range(n_secs_f)]
                wins = []
                hair = np.array([np.nan if d is None else d for (_, _, d) in series])
                for jw in judged_windows(tt, duration, IDENTITY_WINDOW_SECONDS, IDENTITY_MIN_WINDOW_SAMPLES):
                    m = jw["mask"]
                    if m.any():
                        hm = hair[m]
                        hm = hm[~np.isnan(hm)]
                        wins.append({"start_s": jw["start_s"], "end_s": jw["end_s"], "faces": int(m.sum()),
                                     "median_cosine": r(float(np.median(cs[m]))),
                                     "median_hair_delta_e": r(float(np.median(hm)), 2) if hm.size else None,
                                     "merged_insufficient": jw["merged_insufficient"]})
                fid["insufficient_windows_merged"] = [s_ for w_ in wins for s_ in w_["merged_insufficient"]]
                fid["windows"] = wins
                worst_w = min(wins, key=lambda w_: w_["median_cosine"])
                fid["worst_window"] = worst_w
                hair_w = [w_ for w_ in wins if w_["median_hair_delta_e"] is not None]
                fid["hair_worst_window"] = max(hair_w, key=lambda w_: w_["median_hair_delta_e"]) if hair_w else None
                if usable < FACE_ID_MIN_USABLE or usable < FACE_ID_MIN_USABLE_RATIO * max(1, len(valid)):
                    face_id_ok, face_id_fail = False, f"too few usable faces to verify identity ({usable}/{len(valid)})"
                elif np.median(cs) < FACE_ID_MIN_MEDIAN or worst_w["median_cosine"] < FACE_ID_MIN_WINDOW_MEDIAN:
                    face_id_ok, face_id_fail = False, (f"face identity drifts from source (median cosine {np.median(cs):.3f}, "
                                                       f"worst {IDENTITY_WINDOW_SECONDS:g}s window {worst_w['median_cosine']:.3f} @ {worst_w['start_s']}-{worst_w['end_s']}s, "
                                                       f"{worst_w['faces']} faces)")
            else:
                face_id_ok, face_id_fail = False, "no usable face in any sampled frame"

        i_metrics = {
            "first_frame_fit": best["fit"], "first_frame_ssim": r(best["ssim"]), "first_frame_ncc": r(best["ncc"]),
            "first_frame_hist_dist": r(best["hist_dist"]),
            "first_frame_alignment": best.get("alignment"),
            "first_frame_raw_whole_frame": {"fit": raw_best["fit"], "ssim": r(raw_best["ssim"]), "ncc": r(raw_best["ncc"]),
                                            "hist_dist": r(raw_best["hist_dist"]), "gating": False},
            "source_vs_video_torso_hist_dist": r(src_torso_dist),
            "torso_hist_worst_window": worst_id, "source_face_detected": src_face,
            "face_presence_ratio": r(face_ratio, 3),
            "face_identity": fid,
        }
        i_thr = {"first_frame_min_ssim": FIRST_FRAME_MIN_SSIM, "first_frame_min_ncc": FIRST_FRAME_MIN_NCC,
                 "first_frame_compare": f"person-aligned crop at {FIRST_FRAME_PERSON_LONG_SIDE}px long side "
                                        "(falls back to whole frame at 256px if pose missing)",
                 "first_frame_max_hist_dist": FIRST_FRAME_MAX_HIST_DIST, "torso_max_hist_dist": TORSO_MAX_HIST_DIST,
                 "source_torso_max_hist_dist": SOURCE_TORSO_MAX_HIST_DIST,
                 "identity_window_s": IDENTITY_WINDOW_SECONDS, "identity_min_window_samples": IDENTITY_MIN_WINDOW_SAMPLES,
                 "min_face_presence": MIN_FACE_PRESENCE if src_face else "n/a (no face in source)",
                 "face_id": ({"min_median_cosine": FACE_ID_MIN_MEDIAN, "min_window_median_cosine": FACE_ID_MIN_WINDOW_MEDIAN,
                              "min_face_px": FACE_ID_MIN_FACE_PX, "max_yaw": FACE_ID_MAX_YAW,
                              "min_sharpness": FACE_ID_MIN_SHARPNESS, "min_score": FACE_ID_MIN_SCORE,
                              "min_usable_ratio": FACE_ID_MIN_USABLE_RATIO, "min_usable": FACE_ID_MIN_USABLE,
                              "hair_delta_e": "reported only (not gated)"}
                             if fid["source_face"] else "n/a (YuNet found no face in source)")}
        i_fail = []
        if not first_ok:
            i_fail.append("first frame does not match source photo")
        if not src_torso_ok:
            i_fail.append("clothing colours differ from source photo")
        if not torso_ok:
            i_fail.append("torso/clothing appearance drifts" if worst_id else "no torso samples")
        if not face_ok:
            i_fail.append("face not visible often enough")
        if not face_id_ok:
            i_fail.append(face_id_fail)
        checks["identity"] = check(not i_fail, i_metrics, i_thr, {"failures": i_fail, "torso_windows": id_windows})
    finally:
        det.close()

    # ---------- 6. seams ----------
    jumps = []
    gmed = float(np.median(diffs)) if diffs.size else 0.0
    for i in range(diffs.size):
        lo, hi = max(0, i - SEAM_LOCAL_RADIUS), min(diffs.size, i + SEAM_LOCAL_RADIUS + 1)
        neigh = np.concatenate([diffs[lo:i], diffs[i + 1:hi]])
        lmed = float(np.median(neigh)) if neigh.size else gmed
        d = float(diffs[i])
        if d > SEAM_MIN_ABS and d > SEAM_K * max(lmed, 1e-3) and d > SEAM_GLOBAL_K * max(gmed, 1e-3):
            jumps.append({"frame": i + 1, "time_s": r((i + 1) / fps, 3), "diff": r(d, 3), "local_median": r(lmed, 3)})
    max_ratio = float(np.max(diffs / max(gmed, 1e-3))) if diffs.size else 0.0
    s_metrics = {"jumps": len(jumps), "global_median_diff": r(gmed), "max_diff": r(float(diffs.max()) if diffs.size else 0.0),
                 "max_diff_over_global_median": r(max_ratio, 2),
                 "max_diff_frame": int(np.argmax(diffs)) + 1 if diffs.size else None}
    s_thr = {"local_k": SEAM_K, "global_k": SEAM_GLOBAL_K, "min_abs_diff": SEAM_MIN_ABS,
             "local_radius_frames": SEAM_LOCAL_RADIUS, "max_jumps": MAX_SEAM_JUMPS}
    checks["seams"] = check(len(jumps) <= MAX_SEAM_JUMPS, s_metrics, s_thr, {"jump_frames": jumps[:50]} if jumps else None)
    return report


def summarise(report: dict) -> str:
    lines = [f"dance-video-verify: {report['video']}"]
    c = report["checks"]
    def g(name, key):
        return c.get(name, {}).get("metrics", {}).get(key)
    keys = {
        "container": lambda: "not decodable: " + str(((c["container"].get("details") or {}).get("ffprobe_error") or "")[-160:]).replace("\n", " ") if not g("container", "decodable") else f"duration={g('container','duration_s')}s frames={g('container','decoded_frames')} fps={g('container','fps')} {g('container','width')}x{g('container','height')}",
        "frame_health": lambda: f"bad_frames={g('frame_health','bad_frames_total')} longest_frozen={g('frame_health','longest_frozen_run_s')}s",
        "person": lambda: f"coverage={g('person','coverage')} min_per_second={g('person','min_per_second_coverage')}",
        "dancing": lambda: f"overall_range={g('dancing','overall_limb_range')} failing_windows={g('dancing','failing_windows')}/{g('dancing','windows')} worst={((g('dancing','worst_window') or {}).get('excursion'))}",
        "identity": lambda: f"ssim={g('identity','first_frame_ssim')} ncc={g('identity','first_frame_ncc')} hist={g('identity','first_frame_hist_dist')} torso_worst={((g('identity','torso_hist_worst_window') or {}).get('median_torso_hist_dist'))} face={g('identity','face_presence_ratio')} face_cos_median={(g('identity','face_identity') or {}).get('cosine_median')} face_cos_worst_window={((g('identity','face_identity') or {}).get('worst_window') or {}).get('median_cosine')}",
        "seams": lambda: f"jumps={g('seams','jumps')} max_diff/median={g('seams','max_diff_over_global_median')}",
    }
    for name in ["container", "frame_health", "person", "dancing", "identity", "seams"]:
        ch = c.get(name)
        if ch is None:
            continue
        status = "PASS" if ch["passed"] else ("SKIP/FAIL" if ch.get("skipped") else "FAIL")
        extra = ch.get("note") or keys[name]()
        fails = (ch.get("details") or {}).get("failures")
        lines.append(f"  [{status:9}] {name:13} {extra}" + (f"  ({'; '.join(fails)})" if fails else ""))
    lines.append(f"RESULT: {'PASS' if report['passed'] else 'FAIL'}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Verify a generated dancing-person video against its source photo.")
    ap.add_argument("--video", required=True)
    ap.add_argument("--source", required=True)
    ap.add_argument("--min-seconds", type=float, default=DEFAULT_MIN_SECONDS)
    ap.add_argument("--report", help="write JSON report here")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # non-ASCII paths on legacy Windows code pages
        except (AttributeError, ValueError):
            pass
    video, source = Path(a.video), Path(a.source)
    for p, what in ((video, "video"), (source, "source photo")):
        if not p.is_file():
            sys.stderr.write(f"[dance-verify] {what} not found: {p}\n")
            return 2
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.stderr.write(f"[dance-verify] {tool} not found on PATH\n")
            return 2
    try:
        report = analyse(video, source, a.min_seconds)
    except EnvError as exc:
        sys.stderr.write(f"[dance-verify] environment error: {exc}\n")
        return 2
    report["passed"] = all(ch["passed"] for ch in report["checks"].values()) and len(report["checks"]) == 6
    if a.report:
        Path(a.report).parent.mkdir(parents=True, exist_ok=True)
        Path(a.report).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    if not a.quiet:
        print(summarise(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
