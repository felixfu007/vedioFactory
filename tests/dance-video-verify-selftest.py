#!/usr/bin/env python3
"""Self-test for tests/dance-video-verify.py using positive / negative control clips.

All control clips are synthesised on the CPU (numpy + OpenCV drawing + ffmpeg VP9) into a
temporary directory, so the test is reproducible without the GPU or network (except for the
one-time MediaPipe model download done by the verifier).

The synthetic subject is a cartoon "mannequin" (head with face, shirt, trousers, skin-coloured
forearms) that MediaPipe Pose detects reliably. It is NOT a photoreal person; the real positive
controls are real GPU outputs, run when present: tests/fixtures/output/dance-full-e2e.webm (full
two-stage pipeline, must PASS) and tests/fixtures/output/dance-e2e.webm (stage 1 only, face drifts,
must FAIL identity only), both against tests/fixtures/dance-source.png.

Usage: python tests/dance-video-verify-selftest.py [--keep] [--only name,name] [--no-real]
Exit 0 when every control produced the expected verdicts.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VERIFIER = REPO_ROOT / "tests" / "dance-video-verify.py"
REAL_VIDEO = REPO_ROOT / "tests" / "fixtures" / "output" / "dance-e2e.webm"
REAL_FULL_VIDEO = REPO_ROOT / "tests" / "fixtures" / "output" / "dance-full-e2e.webm"
REAL_SOURCE = REPO_ROOT / "tests" / "fixtures" / "dance-source.png"

try:
    import numpy as np
    import cv2
except ImportError:  # pragma: no cover
    vp = REPO_ROOT / ".venv-qa" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if vp.exists() and not os.environ.get("DANCE_VERIFY_NO_REEXEC"):
        sys.exit(subprocess.call([str(vp), str(Path(__file__).resolve()), *sys.argv[1:]],
                                 env=dict(os.environ, DANCE_VERIFY_NO_REEXEC="1")))
    sys.stderr.write("missing numpy/opencv; install tests/requirements-qa.txt into .venv-qa\n")
    sys.exit(2)

W, H, FPS = 540, 960, 24
SKIN = (225, 180, 150)
SHIRT = (190, 60, 60)
PANTS = (40, 70, 120)
HAIR = (50, 30, 30)


def _bg() -> np.ndarray:
    y = np.linspace(0, 1, H)[:, None]
    img = np.empty((H, W, 3), np.uint8)
    img[..., 0] = (170 - 30 * y).astype(np.uint8)
    img[..., 1] = (190 - 50 * y).astype(np.uint8)
    img[..., 2] = (200 - 60 * y).astype(np.uint8)
    img[int(H * 0.84):] = (130, 110, 90)
    # a few static props so the background is not featureless
    cv2.rectangle(img, (30, 120), (130, 300), (230, 220, 200), -1)
    cv2.rectangle(img, (420, 500), (520, 806), (110, 90, 70), -1)
    return img


BG = _bg()


def _cap(img, a, b, r, col):
    a = (int(a[0]), int(a[1]))
    b = (int(b[0]), int(b[1]))
    cv2.line(img, a, b, col, int(2 * r), cv2.LINE_AA)
    cv2.circle(img, a, int(r), col, -1, cv2.LINE_AA)
    cv2.circle(img, b, int(r), col, -1, cv2.LINE_AA)


def _limb(o, l1, l2, a1, a2):
    e = o + l1 * np.array([math.sin(a1), math.cos(a1)])
    w = e + l2 * np.array([math.sin(a1 + a2), math.cos(a1 + a2)])
    return e, w


def render(t: float, *, shirt=SHIRT, dx: float = 0.0, person: bool = True, amp: float = 1.0) -> np.ndarray:
    """RGB frame of the mannequin dancing at time t (seconds). amp scales limb motion."""
    img = BG.copy()
    if not person:
        return img
    s4 = math.sin(t * 4.0)
    cx = W / 2 + dx + amp * 22 * math.sin(t * 2.1)
    hip = np.array([cx, H * 0.50 + amp * 8 * abs(s4)])
    sh = np.array([cx + amp * 10 * math.sin(t * 3), H * 0.27 + amp * 8 * abs(s4)])
    sw, hw = 56, 42
    ls, rs = sh + [-sw, 0], sh + [sw, 0]
    lh, rh = hip + [-hw, 0], hip + [hw, 0]
    la1 = -0.3 - amp * 1.5 * (0.5 + 0.5 * math.sin(t * 4.0))
    la2 = -amp * 0.8 * (0.5 + 0.5 * math.sin(t * 4 + 1))
    ra1 = 0.3 + amp * 1.5 * (0.5 + 0.5 * math.sin(t * 4.0 + 2.2))
    ra2 = amp * 0.8 * (0.5 + 0.5 * math.sin(t * 4 + 3))
    le, lw = _limb(ls, 95, 85, la1, la2)
    re, rw = _limb(rs, 95, 85, ra1, ra2)
    lk, la = _limb(lh, 140, 130, -0.1 - amp * 0.35 * max(0, s4), amp * 0.3 * max(0, s4))
    rk, ra = _limb(rh, 140, 130, 0.1 + amp * 0.35 * max(0, -s4), -amp * 0.3 * max(0, -s4))
    for a, b, rr in [(lh, lk, 24), (lk, la, 20), (rh, rk, 24), (rk, ra, 20)]:
        _cap(img, a, b, rr, PANTS)
    for a in (la, ra):
        cv2.ellipse(img, (int(a[0]), int(a[1] + 10)), (28, 13), 0, 0, 360, (30, 30, 30), -1, cv2.LINE_AA)
    torso = np.array([ls + [-8, -10], rs + [8, -10], rh + [10, 10], lh + [-10, 10]], np.int32)
    cv2.fillPoly(img, [torso], shirt, cv2.LINE_AA)
    cv2.line(img, (int(sh[0]), int(sh[1] + 30)), (int(hip[0]), int(hip[1])), tuple(int(c * 0.8) for c in shirt), 4)
    _cap(img, sh + [0, -18], sh + [0, -36], 15, SKIN)
    head = sh + [0, -78]
    hx, hy = int(head[0]), int(head[1])
    cv2.ellipse(img, (hx, hy), (37, 48), 0, 0, 360, SKIN, -1, cv2.LINE_AA)
    cv2.ellipse(img, (hx, hy - 23), (40, 30), 0, 180, 360, HAIR, -1, cv2.LINE_AA)
    for ex in (-14, 14):
        cv2.ellipse(img, (hx + ex, hy - 5), (8, 5), 0, 0, 360, (255, 255, 255), -1)
        cv2.circle(img, (hx + ex, hy - 5), 4, (20, 30, 40), -1)
        cv2.line(img, (hx + ex - 9, hy - 16), (hx + ex + 9, hy - 16), HAIR, 3)
    cv2.line(img, (hx, hy), (hx - 4, hy + 14), (190, 140, 110), 2)
    cv2.ellipse(img, (hx, hy + 26), (13, 6), 0, 0, 180, (170, 80, 80), -1)
    for a, b, rr, c in [(ls, le, 19, shirt), (le, lw, 15, SKIN), (rs, re, 19, shirt), (re, rw, 15, SKIN)]:
        _cap(img, a, b, rr, c)
    for w in (lw, rw):
        cv2.circle(img, (int(w[0]), int(w[1])), 17, SKIN, -1, cv2.LINE_AA)
    return img


def encode(frames, path: Path, fps: int = FPS, size: tuple[int, int] = (W, H)):
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{size[0]}x{size[1]}", "-r", str(fps),
           "-i", "pipe:0", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-deadline", "realtime",
           "-cpu-used", "8", "-row-mt", "1", "-pix_fmt", "yuv420p", str(path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames:
        proc.stdin.write(np.ascontiguousarray(f, dtype=np.uint8).tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg failed for {path}")


def write_png(img: np.ndarray, path: Path):
    ok, buf = cv2.imencode(".png", cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    assert ok
    buf.tofile(str(path))


def zoompan(img: np.ndarray, t: float) -> np.ndarray:
    """Camera-only motion: zoom speed ~ sin, pan speed ~ cos, so the camera never stops."""
    h, w = img.shape[:2]
    z = 1.175 - 0.175 * math.cos(t * 1.6)
    dxp = 40 * math.sin(t * 1.6)
    # anchor the zoom near the top so the head stays inside the frame
    M = np.array([[z, 0, (1 - z) * w / 2 + dxp], [0, z, (1 - z) * h * 0.08]], np.float32)
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def ts(seconds: float):
    return [i / FPS for i in range(int(round(seconds * FPS)))]


def build_controls(d: Path) -> list[dict]:
    src = d / "source.png"
    write_png(render(0.0), src)
    alt_src = d / "other-person.png"  # different clothing and placement
    other = render(1.3, shirt=(40, 160, 70), dx=-60)
    write_png(other, alt_src)
    c = []

    def add(name, frames, expect, source=src, note=""):
        path = d / f"{name}.webm"
        encode(frames, path)
        c.append({"name": name, "video": path, "source": source, "expect": expect, "note": note})

    pos = (render(t) for t in ts(12))
    add("positive_dance_12s", pos, {"overall": True}, note="synthetic mannequin dancing for 12 s")
    add("short_dance_5s", (render(t) for t in ts(5)),
        {"overall": False, "container": False, "frame_health": True, "person": True, "dancing": True, "identity": True, "seams": True},
        note="dancing but only 5 s -> duration failure only")
    still = render(0.0)
    add("still_loop_12s", (still for _ in ts(12)),
        {"overall": False, "container": True, "frame_health": False, "person": True, "dancing": False, "identity": True},
        note="source image looped for 12 s -> frozen + no dancing")
    black = np.zeros((H, W, 3), np.uint8)
    add("black_12s", (black for _ in ts(12)), {"overall": False, "frame_health": False, "person": False, "dancing": False},
        note="all-black clip")

    add("camera_zoom_pan_12s", (zoompan(still, t) for t in ts(12)),
        {"overall": False, "frame_health": True, "person": True, "dancing": False},
        note="static person, only the camera zooms/pans -> must not count as dancing")
    add("person_vanishes_12s", (render(t, person=t < 6.0) for t in ts(12)),
        {"overall": False, "person": False},
        note="person dances 6 s then leaves the frame")

    def spliced(t):
        if t < 6.0:
            return render(t)
        img = render(t + 0.45, dx=70)
        return np.clip(img.astype(np.int16) + 25, 0, 255).astype(np.uint8)
    add("seam_jump_12s", (spliced(t) for t in ts(12)),
        {"overall": False, "seams": False, "person": True, "dancing": True},
        note="hard splice at 6 s (pose phase jump + 70 px shift + exposure jump)")

    def drift(t):
        k = min(1.0, max(0.0, (t - 4.0) / 4.0))
        col = tuple(int(a * (1 - k) + b * k) for a, b in zip(SHIRT, (40, 150, 200)))
        return render(t, shirt=col)
    add("clothing_drift_12s", (drift(t) for t in ts(12)),
        {"overall": False, "identity": False, "seams": True, "dancing": True},
        note="shirt colour morphs red -> blue between 4 s and 8 s (identity drift)")
    add("subtle_sway_12s", (render(t, amp=0.06) for t in ts(12)),
        {"overall": False, "dancing": False, "frame_health": True, "person": True},
        note="person barely sways (6 % amplitude) -> not dancing")
    # controls built from the real source photo (validates detection on a photoreal person)
    if REAL_SOURCE.exists():
        real = cv2.cvtColor(cv2.imdecode(np.fromfile(str(REAL_SOURCE), np.uint8), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
        rh, rw = real.shape[:2]
        sc = 768 / max(rh, rw)
        size = (int(rw * sc) // 2 * 2, int(rh * sc) // 2 * 2)
        real = cv2.resize(real, size, interpolation=cv2.INTER_AREA)
        for name, gen, expect, note in [
            ("real_still_loop_12s", (real for _ in ts(12)),
             {"overall": False, "frame_health": False, "person": True, "dancing": False, "identity": True},
             "real source photo looped 12 s"),
            ("real_camera_zoom_pan_12s", (zoompan(real, t) for t in ts(12)),
             {"overall": False, "frame_health": True, "person": True, "dancing": False, "identity": True},
             "real source photo, camera-only zoom/pan"),
        ]:
            path = d / f"{name}.webm"
            encode(gen, path, size=size)
            c.append({"name": name, "video": path, "source": REAL_SOURCE, "expect": expect, "note": note})
        # different face on the same body: paste a public-domain portrait face (matplotlib's bundled
        # grace_hopper.jpg, US Navy photo) onto the real source with a similarity warp + seamlessClone
        swapped = face_swapped(real)
        if swapped is not None:
            swapped_src = d / "real-source-face-swapped.png"
            write_png(swapped, swapped_src)
            reason = {"identity": "face identity drifts"}
            c.append({"name": "real_face_swapped_source", "video": d / "real_camera_zoom_pan_12s.webm",
                      "source": swapped_src, "expect": {"overall": False, "identity": False}, "reason": reason,
                      "note": "real clip judged against the same photo with a different face"})

            def morph(t):
                k = min(1.0, max(0.0, (t - 3.0) / 3.0))
                return zoompan(cv2.addWeighted(real, 1 - k, swapped, k, 0), t)
            path = d / "real_face_drift_12s.webm"
            encode((morph(t) for t in ts(12)), path, size=size)
            c.append({"name": "real_face_drift_12s", "video": path, "source": REAL_SOURCE,
                      "expect": {"overall": False, "identity": False, "frame_health": True, "seams": True},
                      "reason": reason, "note": "face cross-fades to a different person between 3 s and 6 s"})
            # window edge case (OPTIMIZATION_PLAN 6.8): 12 s of good identity + ONE trailing frame with a
            # different face. The 6 fps sample at t=12.0 s lands alone in the tail; it must be folded into
            # the previous window instead of being judged as a 1-face window.
            path = d / "real_tail_window_12s_plus_1f.webm"
            frames = [zoompan(real, t) for t in ts(12)]
            frames.append(zoompan(swapped, 12.0))
            encode(iter(frames), path, size=size)
            c.append({"name": "real_tail_window_12s_plus_1f", "video": path, "source": REAL_SOURCE,
                      "expect": {"identity": True, "container": True},
                      "note": "12 s + 1 frame, last frame has a different face; short tail window must not be judged alone"})
        else:
            print("[WARN] face-swap controls skipped (grace_hopper.jpg or face detection unavailable)")
        # re-framing (OPTIMIZATION_PLAN 6.9): the generator may re-centre / re-scale the person.
        # Same photo translated +15 % of the width and scaled 0.9 -> first-frame check must PASS.
        # Built at the photo's native resolution (capped at 1344 px) so the 0.9x face stays large and sharp
        # enough for the face-identity quality filters; the point of this control is the first-frame check.
        full = cv2.cvtColor(cv2.imdecode(np.fromfile(str(REAL_SOURCE), np.uint8), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
        fs = min(1.0, 1344 / max(full.shape[:2]))
        fsize = (int(full.shape[1] * fs) // 2 * 2, int(full.shape[0] * fs) // 2 * 2)
        full = cv2.resize(full, fsize, interpolation=cv2.INTER_AREA)
        hh, ww = full.shape[:2]
        M = np.array([[0.9, 0, 0.05 * ww + 0.15 * ww], [0, 0.9, 0.05 * hh]], np.float32)
        reframed = cv2.warpAffine(full, M, (ww, hh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        path = d / "real_reframed_shift15_scale090.webm"
        encode((zoompan(reframed, t) for t in ts(12)), path, size=fsize)
        c.append({"name": "real_reframed_shift15_scale090", "video": path, "source": REAL_SOURCE,
                  "expect": {"identity": True}, "not_reason": {"identity": "first frame does not match"},
                  "note": "same photo shifted 15 % and scaled 0.9 inside the frame"})
        # different person with the same framing: outfit recoloured (dark red top, near-black trousers)
        # + a different face, identical geometry -> first-frame check must FAIL
        other = different_person(real)
        if other is not None:
            other_src = d / "real-different-person-same-framing.png"
            write_png(other, other_src)
            c.append({"name": "real_different_person_same_framing", "video": d / "real_camera_zoom_pan_12s.webm",
                      "source": other_src, "expect": {"overall": False, "identity": False},
                      "reason": {"identity": "first frame does not match"},
                      "note": "real clip vs. a different-looking person at exactly the same position"})
    # wrong source: same positive video judged against a different photo
    c.append({"name": "wrong_source_photo", "video": d / "positive_dance_12s.webm", "source": alt_src,
              "expect": {"overall": False, "identity": False}, "note": "positive clip vs. a different source photo"})
    return c


def _verifier_module():
    import importlib.util
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("dance_video_verify", VERIFIER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def face_swapped(real: np.ndarray):
    """Return `real` with its face replaced by grace_hopper.jpg's face, or None if unavailable."""
    import importlib.util
    spec = importlib.util.find_spec("matplotlib")
    if spec is None or not spec.origin:
        return None
    donor_path = Path(spec.origin).parent / "mpl-data" / "sample_data" / "grace_hopper.jpg"
    if not donor_path.exists():
        return None
    dv = _verifier_module()
    yn = cv2.FaceDetectorYN.create(str(dv.ensure_model("yunet")), "", (320, 320), 0.6, 0.3, 50)
    pose = dv.Detectors()
    try:
        lm = pose.landmarks(real)
    finally:
        pose.close()
    if lm is None:
        return None

    def detect(bgr):
        yn.setInputSize((bgr.shape[1], bgr.shape[0]))
        _, faces = yn.detect(bgr)
        return None if faces is None else max(faces, key=lambda f: f[14])

    donor = cv2.imdecode(np.fromfile(str(donor_path), np.uint8), cv2.IMREAD_COLOR)
    fd = detect(donor)
    # target face: detect on an upscaled head crop of the real photo, map back
    bgr = cv2.cvtColor(real, cv2.COLOR_RGB2BGR)
    cx, cy = lm[0, 0], lm[0, 1]
    size = max(3.0 * float(np.ptp(lm[0:11, 0])), 64.0)
    x0, y0 = int(max(0, cx - size / 2)), int(max(0, cy - size / 2))
    crop = bgr[y0:int(y0 + size), x0:int(x0 + size)]
    sc = 320.0 / max(crop.shape[:2])
    ft = detect(cv2.resize(crop, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC))
    if fd is None or ft is None:
        return None
    src_pts = fd[4:14].reshape(5, 2).astype(np.float32)
    dst_pts = (ft[4:14].reshape(5, 2) / sc + [x0, y0]).astype(np.float32)
    M, _ = cv2.estimateAffinePartial2D(src_pts, dst_pts)
    warped = cv2.warpAffine(donor, M, (bgr.shape[1], bgr.shape[0]), flags=cv2.INTER_CUBIC)
    fx, fy, fw, fh = ft[:4] / sc
    center = (int(x0 + fx + fw / 2), int(y0 + fy + fh * 0.55))
    mask = np.zeros(bgr.shape[:2], np.uint8)
    cv2.ellipse(mask, center, (int(fw * 0.42), int(fh * 0.55)), 0, 0, 360, 255, -1)
    out = cv2.seamlessClone(warped, bgr, mask, center, cv2.NORMAL_CLONE)
    return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


def different_person(real: np.ndarray):
    """Same framing/pose as `real`, but recoloured outfit and (if available) a different face."""
    dv = _verifier_module()
    pose = dv.Detectors()
    try:
        lm = pose.landmarks(real)
    finally:
        pose.close()
    if lm is None:
        return None
    P = lambda k: (int(lm[k, 0]), int(lm[k, 1]))
    torso = float(np.linalg.norm((lm[11, :2] + lm[12, :2]) / 2 - (lm[23, :2] + lm[24, :2]) / 2))
    th = max(3, int(0.30 * torso))
    top = np.zeros(real.shape[:2], np.uint8)
    quad = lm[[11, 12, 24, 23], :2]
    cen = quad.mean(axis=0)
    cv2.fillPoly(top, [(cen + (quad - cen) * 1.25).astype(np.int32)], 255)
    for a_, b_ in ((11, 13), (13, 15), (12, 14), (14, 16)):
        cv2.line(top, P(a_), P(b_), 255, int(th * 0.8))
    bottom = np.zeros(real.shape[:2], np.uint8)
    cv2.fillPoly(bottom, [np.array([P(23), P(24), P(26), P(25)], np.int32)], 255)
    for a_, b_ in ((23, 25), (25, 27), (24, 26), (26, 28)):
        cv2.line(bottom, P(a_), P(b_), 255, th)
    bottom[top > 0] = 0
    lab = cv2.cvtColor(real, cv2.COLOR_RGB2LAB).astype(np.float32)
    out = lab.copy()
    for mask, lmul, a_, b_ in ((top, 0.45, 175.0, 155.0), (bottom, 0.30, 128.0, 122.0)):
        alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), 2.0)[..., None]
        target = np.dstack([lab[..., 0] * lmul, np.full(lab.shape[:2], a_), np.full(lab.shape[:2], b_)])
        out = out * (1 - alpha) + target * alpha
    recol = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)
    swapped = face_swapped(recol)
    return swapped if swapped is not None else recol


def run_verifier(video: Path, source: Path, report: Path) -> tuple[int, dict, str]:
    p = subprocess.run([sys.executable, str(VERIFIER), "--video", str(video), "--source", str(source),
                        "--report", str(report)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    data = json.loads(report.read_text(encoding="utf-8")) if report.exists() else {}
    noise = ("W0000", "I0000", "WARNING: All log messages", "INFO: Created TensorFlow")
    err = "\n".join(l for l in p.stderr.splitlines() if not l.startswith(noise))
    return p.returncode, data, (p.stdout + err).strip()


def check_window_helper() -> list[str]:
    """Pure-function checks of judged_windows (no video needed)."""
    dv = _verifier_module()
    errs = []
    t = np.append(np.arange(0, 12.0 + 1e-9, 1 / 6), [])  # 6 fps samples 0..12.0 s incl. 12.0
    w = dv.judged_windows(t, 12.042, 2.0, 3)
    if len(w) != 6 or w[-1]["start_s"] != 10.0 or int(w[-1]["mask"].sum()) != 13:
        errs.append(f"12.042 s clip: expected 6 windows, last 10.0-12.042 s with 13 samples, got "
                    f"{[(x['start_s'], x['end_s'], int(x['mask'].sum())) for x in w]}")
    if int(sum(x["mask"].sum() for x in w)) != t.size:
        errs.append("windows do not cover every sample exactly once")
    sparse = np.array([0.1, 0.5, 0.9, 1.5, 2.2, 6.1, 6.5, 7.0, 7.4])  # window 2-4 s has 1 sample, 4-6 s none
    w = dv.judged_windows(sparse, 8.0, 2.0, 3)
    if any(int(x["mask"].sum()) < 3 for x in w) or int(sum(x["mask"].sum() for x in w)) != sparse.size:
        errs.append(f"sparse samples: insufficient windows not folded: {[(x['start_s'], int(x['mask'].sum())) for x in w]}")
    w = dv.judged_windows(np.array([0.2, 0.6, 1.0]), 1.2, 2.0, 3)
    if len(w) != 1:
        errs.append("clip shorter than one window must give exactly one window")
    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="keep the temp dir with clips and reports")
    ap.add_argument("--only", help="comma separated control names")
    ap.add_argument("--no-real", action="store_true", help="skip the real fixture even if present")
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="dance-verify-selftest-"))
    t0 = time.time()
    try:
        helper_errs = check_window_helper()
        print(f"[{'OK ' if not helper_errs else 'BAD'}] judged_windows unit checks" + ("" if not helper_errs else ": " + "; ".join(helper_errs)))
        controls = build_controls(tmp)
        if a.only:
            wanted = set(a.only.split(","))
            controls = [c for c in controls if c["name"] in wanted]
        results, ok_all = [], not helper_errs
        for c in controls:
            rc, rep, out = run_verifier(c["video"], c["source"], tmp / f"{c['name']}.report.json")
            checks = rep.get("checks", {})
            mismatches = []
            if rc not in (0, 1):
                mismatches.append(f"verifier exit code {rc}")
            for key, want in c["expect"].items():
                got = (rc == 0) if key == "overall" else checks.get(key, {}).get("passed")
                if got != want:
                    mismatches.append(f"{key}: expected {'PASS' if want else 'FAIL'}, got {'PASS' if got else 'FAIL'}")
            for key, text in (c.get("not_reason") or {}).items():
                fails = " | ".join((checks.get(key, {}).get("details") or {}).get("failures") or [])
                if text in fails:
                    mismatches.append(f"{key}: unexpected failure reason '{text}' in '{fails}'")
            for key, text in (c.get("reason") or {}).items():
                fails = " | ".join((checks.get(key, {}).get("details") or {}).get("failures") or [])
                if text not in fails:
                    mismatches.append(f"{key}: expected failure reason containing '{text}', got '{fails}'")
            ok = not mismatches
            ok_all &= ok
            verdicts = " ".join(f"{k}={'P' if v.get('passed') else 'F'}" for k, v in checks.items())
            print(f"[{'OK ' if ok else 'BAD'}] {c['name']:34} exit={rc} {verdicts}")
            if not ok:
                print("      " + "; ".join(mismatches))
                print("      " + out.replace("\n", "\n      "))
            results.append({"name": c["name"], "ok": ok, "exit": rc, "mismatches": mismatches})

        if not a.no_real and not a.only:
            # Real GPU outputs: the full two-stage pipeline must PASS; the stage-1-only (TI2V-5B) video is a real
            # negative control whose face drifts, so it must fail identity and nothing else.
            for name, video, expect_fail in (
                ("real_full_pipeline", REAL_FULL_VIDEO, set()),
                ("real_stage1_only", REAL_VIDEO, {"identity"}),
            ):
                if not (video.exists() and REAL_SOURCE.exists()):
                    print(f"[SKIP] {name}: {video.relative_to(REPO_ROOT)} or {REAL_SOURCE.relative_to(REPO_ROOT)} not present yet")
                    continue
                rc, rep, out = run_verifier(video, REAL_SOURCE, tmp / f"{name}.report.json")
                failed = {k for k, v in ((rep or {}).get("checks") or {}).items() if not v.get("passed")}
                ok = failed == expect_fail and (rc == 0) == (not expect_fail)
                ok_all &= ok
                expected = "PASS" if not expect_fail else f"FAIL only {sorted(expect_fail)}"
                print(f"[{'OK ' if ok else 'BAD'}] {name:22} exit={rc} failed={sorted(failed)} (expected {expected})")
                if not ok:
                    print("      " + out.replace("\n", "\n      "))
        print(f"selftest {'PASSED' if ok_all else 'FAILED'} in {time.time() - t0:.1f}s ({len(results)} synthetic controls)")
        if a.keep:
            print(f"artifacts kept in {tmp}")
        return 0 if ok_all else 1
    finally:
        if not a.keep:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
