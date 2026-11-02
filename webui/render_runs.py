"""
Run build_gds_scene.py in Blender for the web UI.

Each run gets its own folder under renders/ holding the YAML files it was
built from, the settings file it ran with (run.json), the log, the .blend and
the rendered image. Runs go one at a time; extra ones wait in a queue.
"""
import ast
import io
import json
import os
import re
import shutil
import subprocess
import threading
import tokenize
from datetime import datetime
from pathlib import Path

from PIL import Image

QUICK_MAX_SAMPLES = 32  # quick renders: at most this many samples, half resolution
THUMB_WIDTH = 360


# --- The script's settings ----------------------------------------------------

def script_settings(script):
    """The SETTINGS constants of build_gds_scene.py with the comments that
    explain them, read from the source (running it needs Blender).
    Returns {NAME: {"value": ..., "help": "..."}}."""
    source = script.read_text(encoding="utf-8")
    lines = source.splitlines()
    comments = {}
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.COMMENT:
            comments[tok.start[0]] = (tok.start[1], tok.string.lstrip("#").strip())

    settings = {}
    for node in ast.parse(source).body:
        if not (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name) and node.targets[0].id.isupper()):
            continue
        try:
            value = ast.literal_eval(node.value)
        except ValueError:
            continue  # computed, like SCRIPT_DIR
        # The comment block right above, stopping at section headers, plus
        # a comment at the end of the line itself
        above = []
        n = node.lineno - 1
        while n >= 1 and lines[n - 1].lstrip().startswith("#"):
            text = lines[n - 1].strip().lstrip("#").strip()
            if text.startswith(("---", "===")):
                break
            above.insert(0, text)
            n -= 1
        col, inline = comments.get(node.end_lineno, (0, ""))
        if col == 0:
            inline = ""  # a comment line of its own, not after the value
        help_text = " ".join(t for t in above + [inline] if t)
        settings[node.targets[0].id] = {"value": value, "help": help_text}
    return settings


# --- Blender ------------------------------------------------------------------

_blender_cache = {}


def find_blender():
    """Path to the Blender executable, or None. BLENDER overrides the search."""
    candidates = [os.environ.get("BLENDER"),
                  "/Applications/Blender.app/Contents/MacOS/Blender",
                  shutil.which("blender")]
    program_files = os.environ.get("ProgramFiles")
    if program_files:
        candidates += sorted(map(str, Path(program_files, "Blender Foundation")
                                 .glob("Blender*/blender.exe")), reverse=True)
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def blender_info():
    """{"path", "version"} for the Blender that runs builds, or None."""
    path = find_blender()
    if path is None:
        return None
    if path not in _blender_cache:
        try:
            out = subprocess.run([path, "--version"], capture_output=True, text=True,
                                 timeout=60).stdout
            version = next((l.strip() for l in out.splitlines() if l.startswith("Blender")), "")
        except (OSError, subprocess.TimeoutExpired):
            version = ""
        _blender_cache[path] = version
    return {"path": path, "version": _blender_cache[path]}


def open_in_blender(blend):
    blender = find_blender()
    if blender is None:
        raise RuntimeError("Blender not found.")
    subprocess.Popen([blender, str(blend)], stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


# --- Runs ---------------------------------------------------------------------

LAYER_DONE = re.compile(r"^(?:✓ (.+?): \d+ polygons|⚠ Layer (.+?): No geometry found)")
SAMPLE = re.compile(r"Sample (\d+)/(\d+)")
REMAINING = re.compile(r"Remaining: ([\d:.]+)")


class Run:
    def __init__(self, folder, mode, layer_count, info):
        self.folder = folder
        self.name = folder.name
        self.mode = mode                  # "build", "quick" or "final"
        self.layer_count = layer_count
        self.info = info                  # what the UI shows about the run's setup
        self.status = "queued"            # queued, running, done, failed, cancelled
        self.progress = 0.0
        self.phase = "Waiting for another run to finish"
        self.lines = []
        self.warnings = []
        self.error = None
        self.created = datetime.now().isoformat(timespec="seconds")
        self.started = self.finished = None
        self.layers_done = 0
        self.proc = None
        self.cancelled = False

    @property
    def renders(self):
        return self.mode != "build"

    def summary(self):
        return {
            "name": self.name, "mode": self.mode, "status": self.status,
            "progress": round(self.progress, 3), "phase": self.phase,
            "warnings": self.warnings, "error": self.error,
            "created": self.created, "started": self.started, "finished": self.finished,
            "image": (self.folder / "render.png").is_file(),
            "blend": (self.folder / "scene.blend").is_file(),
            "info": self.info,
        }

    def save_meta(self):
        (self.folder / "meta.json").write_text(json.dumps(self.summary(), indent=2), encoding="utf-8")

    def _set(self, progress, phase):
        self.progress = max(self.progress, progress)
        self.phase = phase

    def parse(self, line):
        """Follow the script's console output to estimate progress."""
        # Importing takes most of a build; for renders, Cycles takes most of the time
        import_end = 0.4 if self.renders else 0.9
        m = LAYER_DONE.match(line)
        if m:
            self.layers_done += 1
            if m.group(2):
                self.warnings.append(f"{m.group(2)}: nothing to import (empty layer or outside the crop)")
            n = max(1, self.layer_count)
            self._set(0.05 + (import_end - 0.05) * min(1, self.layers_done / n),
                      f"Importing layers ({self.layers_done}/{n})")
        elif line.startswith(("Cropping to region", "Starting GDS import")):
            self._set(0.05, "Importing layers")
        elif line.startswith("Saved "):
            self._set(import_end, "Saved the .blend")
        elif line.startswith("Rendering "):
            self._set(0.45, "Rendering")
        elif line.startswith("Render progress:"):
            m = SAMPLE.search(line)
            if m and int(m.group(2)):
                done, total = int(m.group(1)), int(m.group(2))
                left = REMAINING.search(line)
                self._set(0.45 + 0.5 * done / total,
                          f"Rendering · sample {done}/{total}" + (f" · {left.group(1)} left" if left else ""))
            elif "Compositing" in line or "Denoising" in line:
                self._set(0.96, "Compositing")
            else:
                self._set(0.45, "Rendering · " + line.split("|")[-1].strip())
        elif line.startswith("Rendered "):
            self._set(0.99, "Finishing")


class RunManager:
    def __init__(self, renders_dir, script):
        self.dir = renders_dir
        self.script = script
        self.runs = {}         # this session's runs by name
        self.queue = []
        self.lock = threading.Lock()
        self.worker = None

    def new_folder(self, mode):
        self.dir.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        folder = self.dir / f"{stamp}_{mode}"
        n = 2
        while folder.exists():
            folder = self.dir / f"{stamp}_{mode}-{n}"
            n += 1
        folder.mkdir()
        return folder

    def start(self, folder, mode, settings, layer_count, info):
        """Queue a run. `settings` is the run.json content."""
        (folder / "run.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")
        run = Run(folder, mode, layer_count, info)
        run.save_meta()
        with self.lock:
            self.runs[run.name] = run
            self.queue.append(run)
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._work, daemon=True)
                self.worker.start()
        return run

    def _work(self):
        while True:
            with self.lock:
                if not self.queue:
                    self.worker = None
                    return
                run = self.queue.pop(0)
            self._execute(run)

    def _execute(self, run):
        blender = find_blender()
        run.status = "running"
        run.started = datetime.now().isoformat(timespec="seconds")
        run._set(0.01, "Starting Blender")
        run.save_meta()
        if blender is None:
            return self._finish(run, "failed", "Blender not found. Set BLENDER to its executable.")
        cmd = [blender, "--background", "-noaudio", "--python-exit-code", "1",
               "--python", str(self.script), "--", "--settings", str(run.folder / "run.json")]
        try:
            run.proc = subprocess.Popen(
                cmd, cwd=str(self.script.parent), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                env={**os.environ, "PYTHONUNBUFFERED": "1"})
        except OSError as err:
            return self._finish(run, "failed", f"Couldn't start Blender: {err}")
        if run.cancelled:  # cancelled while Blender was starting
            run.proc.terminate()
        with open(run.folder / "log.txt", "w", encoding="utf-8") as log:
            for raw in run.proc.stdout:
                line = raw.rstrip("\n")
                run.lines.append(line)
                log.write(raw)
                log.flush()
                run.parse(line)
        code = run.proc.wait()
        if run.cancelled:
            return self._finish(run, "cancelled", None)
        expected = run.folder / ("render.png" if run.renders else "scene.blend")
        if code == 0 and expected.is_file():
            if run.renders:
                self._thumbnail(run)
            return self._finish(run, "done", None)
        # The last lines usually say what went wrong (sys.exit message or traceback)
        tail = [l for l in run.lines if l.strip()][-1:] or [f"Blender exited with code {code}"]
        return self._finish(run, "failed", tail[0])

    def _finish(self, run, status, error):
        run.status = status
        run.error = error
        run.finished = datetime.now().isoformat(timespec="seconds")
        if status == "done":
            run._set(1.0, "Done")
        else:
            run.phase = {"cancelled": "Cancelled", "failed": "Failed"}[status]
        run.proc = None
        run.save_meta()

    @staticmethod
    def _thumbnail(run):
        try:
            with Image.open(run.folder / "render.png") as img:
                img.thumbnail((THUMB_WIDTH, THUMB_WIDTH))
                img.convert("RGB").save(run.folder / "thumb.jpg", quality=85)
        except OSError:
            pass

    def cancel(self, name):
        run = self.runs.get(name)
        if run is None or run.status not in ("queued", "running"):
            return False
        run.cancelled = True
        with self.lock:
            if run in self.queue:
                self.queue.remove(run)
                self._finish(run, "cancelled", None)
                return True
        proc = run.proc
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        return True

    def get(self, name):
        """Summary and log of a run from this session or from disk."""
        run = self.runs.get(name)
        if run is not None:
            return run.summary(), run.lines
        folder = self.dir / name
        meta_file = folder / "meta.json"
        if not meta_file.is_file():
            return None, None
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except ValueError:
            return None, None
        if meta.get("status") in ("queued", "running"):
            # The server stopped while this run was going
            meta.update(status="failed", error="The server stopped during this run.", phase="Failed")
        meta["image"] = (folder / "render.png").is_file()
        meta["blend"] = (folder / "scene.blend").is_file()
        log = folder / "log.txt"
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines() if log.is_file() else []
        return meta, lines

    def list(self):
        if not self.dir.is_dir():
            return []
        out = []
        for folder in sorted(self.dir.iterdir(), reverse=True):
            if folder.is_dir():
                meta, _ = self.get(folder.name)
                if meta:
                    out.append(meta)
        return out
