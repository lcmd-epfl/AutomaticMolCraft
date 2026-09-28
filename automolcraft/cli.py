"""Command-line launcher for the AutomaticMolCraft web app.

    automolcraft serve     build the frontend if needed, start the backend, open the browser
    automolcraft doctor    check the environment and print what is missing
    automolcraft build-frontend

This is the cross-platform equivalent of ./dev.sh (which keeps working unchanged).
It is meant for an editable install from a clone: `pip install -e .`.
"""
from __future__ import annotations

import argparse
import ast
import importlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from importlib import metadata
from pathlib import Path

from . import __version__

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "webapp" / "database-explorer-lite"
BACKEND_DIR = APP_DIR / "backend"
FRONTEND_DIR = APP_DIR / "frontend"
DIST_DIR = FRONTEND_DIR / "dist"
# Same lookup order as dev.sh and backend/main.py:_load_env_discovery().
ENV_CANDIDATES = [ROOT / ".env", APP_DIR / ".env", BACKEND_DIR / ".env"]
VITE_PORT = 5173  # the backend's CORS allow-list expects the Vite dev server here


def _say(msg: str) -> None:
    print(f"[automolcraft] {msg}", flush=True)


def _fail(msg: str) -> None:
    print(f"[automolcraft] error: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def _check_layout() -> None:
    if not (BACKEND_DIR / "main.py").is_file():
        _fail(
            f"backend not found at {BACKEND_DIR}.\n"
            "  automolcraft runs from a clone of the repository: "
            "`git clone https://github.com/pregHosh/AutomaticMolCraftt && pip install -e ./AutomaticMolCraftt`"
        )


# ---------------------------------------------------------------------------
# Frontend build
# ---------------------------------------------------------------------------

def frontend_is_built() -> bool:
    """dist/index.html exists and the JS/CSS bundles it references are present (as in dev.sh)."""
    index = DIST_DIR / "index.html"
    if not index.is_file():
        return False
    html = index.read_text(encoding="utf-8", errors="replace")
    js = re.search(r'src="/(assets/[^"]+\.js)"', html)
    css = re.search(r'href="/(assets/[^"]+\.css)"', html)
    return bool(js and css and (DIST_DIR / js.group(1)).is_file() and (DIST_DIR / css.group(1)).is_file())


def _npm() -> str:
    npm = shutil.which("npm")
    if not npm:
        _fail(
            "npm not found; it is needed once to build the frontend.\n"
            "  Install Node.js into this env: conda install -c conda-forge --override-channels nodejs"
        )
    return npm


def _ensure_node_modules() -> None:
    if (FRONTEND_DIR / "node_modules").is_dir():
        return
    npm = _npm()
    _say("installing frontend dependencies (one time)")
    # `npm ci` installs exactly what package-lock.json pins and never rewrites it.
    if subprocess.run([npm, "ci"], cwd=FRONTEND_DIR).returncode != 0:
        _say("`npm ci` failed; falling back to `npm install`")
        if subprocess.run([npm, "install"], cwd=FRONTEND_DIR).returncode != 0:
            _fail("installing frontend dependencies failed (see npm output above)")


def build_frontend(force: bool = False) -> None:
    if not force and frontend_is_built():
        _say("frontend build up to date")
        return
    _ensure_node_modules()
    _say("building frontend")
    if subprocess.run([_npm(), "run", "build"], cwd=FRONTEND_DIR).returncode != 0:
        _fail("frontend build failed (see npm output above)")


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------

def _open_browser_when_up(url: str, port: int, timeout: float = 60.0) -> None:
    def wait_and_open() -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    webbrowser.open(url)
                    return
            except OSError:
                time.sleep(0.3)

    threading.Thread(target=wait_and_open, daemon=True).start()


def cmd_serve(args: argparse.Namespace) -> None:
    _check_layout()
    try:
        import uvicorn
    except ImportError:
        _fail("uvicorn is not installed in this Python; run `pip install -e .` in the repository")

    local_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    backend_url = f"http://{local_host}:{args.port}"

    vite = None
    if args.dev:
        _ensure_node_modules()
        env = {**os.environ, "VITE_BACKEND_URL": backend_url}
        vite = subprocess.Popen(
            [_npm(), "run", "dev", "--", "--host", args.host, "--port", str(VITE_PORT), "--strictPort"],
            cwd=FRONTEND_DIR,
            env=env,
        )
        ui_url, ui_port = f"http://{local_host}:{VITE_PORT}", VITE_PORT
    else:
        build_frontend(force=args.rebuild)
        ui_url, ui_port = backend_url, args.port

    _say(f"web UI:  {ui_url}")
    if args.dev:
        _say(f"API:     {backend_url}")
    _say("press Ctrl+C to stop")
    if not args.no_browser:
        _open_browser_when_up(ui_url, ui_port)

    # dev.sh starts uvicorn from backend/; main.py resolves ./xyz and ./_ase_tmp against the cwd.
    os.chdir(BACKEND_DIR)
    try:
        uvicorn.run(
            "main:app",
            app_dir=str(BACKEND_DIR),
            host=args.host,
            port=args.port,
            reload=args.reload,
            reload_dirs=[str(BACKEND_DIR)] if args.reload else None,
        )
    finally:
        if vite is not None and vite.poll() is None:
            vite.terminate()
            try:
                vite.wait(timeout=10)
            except subprocess.TimeoutExpired:
                vite.kill()


# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------

OK, WARN, BAD = "✓", "⚠", "✗"


class Report:
    def __init__(self) -> None:
        self.failed = False

    def section(self, title: str) -> None:
        print(f"\n{title}")

    def line(self, mark: str, label: str, detail: str = "", hint: str = "") -> None:
        print(f"  {mark} {label:<24} {detail}".rstrip())
        if hint and mark != OK:
            print(f"      → {hint}")
        if mark == BAD:
            self.failed = True


def _pinned_constants() -> dict[str, str]:
    """MOLCRAFT_PINNED_* from backend/main.py, read without importing it (import has side effects)."""
    out: dict[str, str] = {}
    try:
        tree = ast.parse((BACKEND_DIR / "main.py").read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return out
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.startswith("MOLCRAFT_PINNED_"):
                    out[target.id] = str(node.value.value)
    return out


def _read_env_file(path: Path) -> dict[str, str]:
    """Same parsing rules as backend/main.py:_load_env_file."""
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _try_import(module: str) -> tuple[bool, str]:
    try:
        mod = importlib.import_module(module)
    except Exception as exc:  # broken binary wheels raise ValueError/OSError, not just ImportError
        return False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:90] if str(exc) else ''}"
    return True, str(getattr(mod, "__version__", "") or "")


def _molcraft_commit() -> str | None:
    try:
        raw = metadata.distribution("molcraftdiffusion").read_text("direct_url.json")
        return ((json.loads(raw or "{}").get("vcs_info") or {}).get("commit_id")) if raw else None
    except Exception:
        return None


def cmd_doctor(_args: argparse.Namespace) -> None:
    _check_layout()
    r = Report()
    print(f"automolcraft {__version__} · {platform.system()} {platform.machine()} · {ROOT}")

    # --- web app ---------------------------------------------------------
    r.section("Web app")
    py = sys.version_info
    r.line(OK if py >= (3, 10) else BAD, "Python", f"{platform.python_version()} ({sys.executable})",
           "use Python 3.10+ (the env files use 3.11)")
    for module, label in [
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("multipart", "python-multipart"),
        ("yaml", "PyYAML"),
        ("ase", "ase"),
        ("numpy", "numpy"),
        ("pandas", "pandas"),
        ("openTSNE", "openTSNE"),
    ]:
        ok, detail = _try_import(module)
        hint = "pip install -e ." if module != "pandas" else (
            "a numpy ABI error here usually means pandas was downgraded: pip install 'pandas>=2.3,<2.4'"
        )
        r.line(OK if ok else BAD, label, detail, hint)

    if frontend_is_built():
        r.line(OK, "frontend build", str(DIST_DIR.relative_to(ROOT)))
    elif shutil.which("npm"):
        r.line(WARN, "frontend build", "not built yet", "`automolcraft serve` builds it on first run")
    else:
        r.line(BAD, "frontend build", "not built and npm not found",
               "conda install -c conda-forge --override-channels nodejs")

    env_path = next((p for p in ENV_CANDIDATES if p.is_file()), None)
    env_values = _read_env_file(env_path) if env_path else {}
    r.line(OK if env_path else WARN, ".env",
           str(env_path.relative_to(ROOT)) if env_path else "none (defaults: <repo>/models, <repo>/outputs, ...)",
           "optional: cp webapp/database-explorer-lite/.env.example webapp/database-explorer-lite/.env")

    # --- MolCraftDiffusion ----------------------------------------------
    r.section("MolCraftDiffusion")
    pins = _pinned_constants()
    pin_version = pins.get("MOLCRAFT_PINNED_VERSION", "")
    pin_commit = pins.get("MOLCRAFT_PINNED_COMMIT", "")
    cli = shutil.which("MolCraftDiff")
    r.line(OK if cli else BAD, "MolCraftDiff CLI", cli or "not on PATH",
           "install MolCraftDiffusion into this env (see environment.yml / docs/installation.md)")
    try:
        version = metadata.version("molcraftdiffusion")
    except metadata.PackageNotFoundError:
        version = None
    if version is None:
        r.line(BAD, "version", "molcraftdiffusion not installed", "see docs/installation.md")
    elif version == pin_version:
        r.line(OK, "version", f"{version} (pinned {pin_version})")
    else:
        r.line(WARN, "version", f"{version}, app is pinned to {pin_version}",
               "other versions may work but are untested with this app")
    commit = _molcraft_commit()
    if commit and pin_commit and commit != pin_commit:
        note = "expected for the macOS env file (it pins the Mac-support commit)" if sys.platform == "darwin" else ""
        r.line(WARN, "commit", f"{commit[:10]} (pinned {pin_commit[:10]})", note)

    ok, torch_version = _try_import("torch")
    if not ok:
        r.line(BAD, "torch", torch_version, "comes with MolCraftDiffusion; reinstall it")
    else:
        import torch

        if torch.cuda.is_available():
            device = f"CUDA ({torch.cuda.get_device_name(0)})"
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            device = "Apple MPS"
        else:
            device = None
        r.line(OK if device else WARN, "torch device", f"{device or 'CPU only'} · torch {torch_version}",
               "generation and training will be slow on CPU")

    # --- analysis tools (optional) ----------------------------------------
    r.section("Analysis tools (optional)")
    for binary, used_by in [("xtb", "xTB properties / geometry optimisation"),
                            ("obabel", "openbabel molecule converter")]:
        path = shutil.which(binary)
        r.line(OK if path else WARN, binary, path or f"not found — needed for {used_by}",
               f"conda install -c conda-forge --override-channels {'xtb==6.7.1' if binary == 'xtb' else 'openbabel'}")
    for module, label, used_by, hint in [
        ("xtb.interface", "xtb-python", "xTB electronic properties",
         "conda install -c conda-forge --override-channels xtb-python"),
        ("posebusters", "posebusters", "PoseBusters validity metrics",
         "pip install 'posebusters>=0.5.1' morfeus-ml rmsd open3d 'pandas>=2.3,<2.4'"),
        ("open3d", "open3d", "validity metrics", "pip install open3d"),
        ("dscribe", "dscribe", "SOAP featurisation", "pip install -e '.[featurize]'"),
        ("umap", "umap-learn", "UMAP projection", "pip install -e '.[umap]'"),
    ]:
        ok, detail = _try_import(module)
        r.line(OK if ok else WARN, label, detail if ok else f"missing — needed for {used_by}", hint)

    # --- models -------------------------------------------------------------
    r.section("Models")
    models_dir = Path(
        os.environ.get("MOLCRAFT_MODELS_DIR") or env_values.get("MOLCRAFT_MODELS_DIR") or ROOT / "models"
    ).expanduser()
    # Same rule as backend/main.py:_discover_generation_models_uncached.
    models = sorted(p.parent.name for p in models_dir.glob("*/edm_chem.pkl"))
    if models:
        shown = ", ".join(models[:6]) + (" ..." if len(models) > 6 else "")
        r.line(OK, "generation models", f"{len(models)} in {models_dir}: {shown}")
    else:
        r.line(WARN, "generation models", f"none in {models_dir}",
               "download from https://huggingface.co/pregH/MolecularDiffusion "
               "or set MOLCRAFT_MODELS_DIR in .env")

    print()
    if r.failed:
        print("Some required items are missing (✗). Fix those, then run `automolcraft doctor` again.")
        raise SystemExit(1)
    print("Ready: run `automolcraft serve`.")


# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="automolcraft", description="AutomaticMolCraft web app launcher")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="start the web app (builds the frontend if needed)")
    serve.add_argument("--host", default="127.0.0.1", help="bind address; 0.0.0.0 to allow other machines")
    serve.add_argument("--port", type=int, default=8000, help="backend port (default 8000)")
    serve.add_argument("--dev", action="store_true",
                       help=f"also run the Vite dev server with hot reload on :{VITE_PORT}")
    serve.add_argument("--reload", action="store_true", help="restart the backend when Python files change")
    serve.add_argument("--rebuild", action="store_true", help="force a frontend rebuild (e.g. after git pull)")
    serve.add_argument("--no-browser", action="store_true", help="do not open a browser tab")
    serve.set_defaults(func=cmd_serve)

    doctor = sub.add_parser("doctor", help="check the environment and report what is missing")
    doctor.set_defaults(func=cmd_doctor)

    build = sub.add_parser("build-frontend", help="(re)build the frontend bundle")
    build.set_defaults(func=lambda _a: (_check_layout(), build_frontend(force=True)))

    args = parser.parse_args(argv)
    _prefer_own_env_on_path()
    args.func(args)


def _prefer_own_env_on_path() -> None:
    """Put this interpreter's bin/ first on PATH.

    The backend launches `MolCraftDiff`, `xtb` and `obabel` by name, so they must come from the
    same environment as the Python running the app, even when the env was not activated
    (e.g. `~/miniconda3/envs/molcraft/bin/automolcraft serve`).
    """
    bin_dir = str(Path(sys.executable).parent)
    parts = os.environ.get("PATH", "").split(os.pathsep)
    if parts[:1] != [bin_dir]:
        os.environ["PATH"] = os.pathsep.join([bin_dir, *[p for p in parts if p != bin_dir]])


if __name__ == "__main__":
    main()
