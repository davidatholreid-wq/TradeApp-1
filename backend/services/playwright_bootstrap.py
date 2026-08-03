"""Self-healing Playwright Chromium bootstrap.

The Playwright Python package pins its expected browser build revision
(e.g. ``chromium_headless_shell-1228``). When the ``playwright`` PyPI
package is upgraded but the pre-baked browsers under
``$PLAYWRIGHT_BROWSERS_PATH`` were not refreshed, ``chromium.launch()``
throws::

    Executable doesn't exist at
    /pw-browsers/chromium_headless_shell-1228/chrome-linux/headless_shell

This helper detects that mismatch and, if needed, runs
``playwright install chromium`` to fetch the matching build. It is
safe to call from:

  * FastAPI ``startup`` (as a background task — no first-user penalty).
  * The Land Rover OSH scraper right before ``launch()`` — self-heal
    at point of use, in case something wiped the browsers between
    process starts.

Concurrent calls are serialised by an ``asyncio.Lock`` so we never fire
two ``playwright install`` processes at once. After a successful
install we cache the result so subsequent calls are effectively no-ops.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import Optional

logger = logging.getLogger("fourbuy.playwright_bootstrap")

_install_lock: Optional[asyncio.Lock] = None
_last_ok: bool = False


def _get_lock() -> asyncio.Lock:
    global _install_lock
    if _install_lock is None:
        _install_lock = asyncio.Lock()
    return _install_lock


def _expected_headless_shell() -> Optional[Path]:
    """Best-effort lookup of the headless_shell binary Playwright expects.

    Playwright bakes its browser build revision into a module inside the
    ``playwright`` package. Rather than parsing that private constant,
    we simply glob under ``PLAYWRIGHT_BROWSERS_PATH`` for the
    ``chromium_headless_shell-*`` directory with the highest revision
    number. Playwright's ``chromium.launch()`` will still raise the
    canonical error with the exact expected path if this guess is
    wrong, which just triggers our reinstall path.
    """
    root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/pw-browsers"))
    if not root.exists():
        return None
    candidates = sorted(root.glob("chromium_headless_shell-*"))
    if not candidates:
        return None
    # Playwright's launch prefers the highest-numbered build.
    latest = candidates[-1]
    exe = latest / "chrome-linux" / "headless_shell"
    return exe if exe.exists() else None


async def _try_launch_chromium() -> Optional[Exception]:
    """Attempt a lightweight chromium launch. Returns None on success,
    or the launch exception on failure so the caller can decide whether
    to reinstall.
    """
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:
        return exc
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            await browser.close()
        return None
    except Exception as exc:
        return exc


async def _run_playwright_install() -> tuple[int, str]:
    """Run ``playwright install chromium`` in a subprocess. Returns
    ``(returncode, tail_of_output)``.

    We invoke via ``sys.executable -m playwright ...`` rather than the
    ``playwright`` CLI on PATH — this guarantees we're using the exact
    playwright module the running FastAPI process imports (avoids
    virtualenv-vs-system-python drift where the CLI shim can no-op
    silently when the environments disagree).
    """
    import sys
    env = os.environ.copy()
    # Preserve the pre-configured browsers path so we install into
    # the same directory the runtime reads from.
    env.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/pw-browsers")

    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "playwright",
        "install",
        "chromium",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        proc.kill()
        return -1, "playwright install chromium timed out after 5 minutes"
    tail = (stdout or b"").decode(errors="replace")[-1500:]
    logger.info(
        "playwright install chromium exited with rc=%s. Output tail:\n%s",
        proc.returncode, tail,
    )
    return proc.returncode or 0, tail


async def ensure_playwright_chromium(force: bool = False) -> bool:
    """Ensure Playwright's Chromium browser is installed and launchable.

    Returns ``True`` if the browser is ready, ``False`` otherwise.
    Safe to call repeatedly — serialised, cached, and non-throwing.
    """
    global _last_ok

    if _last_ok and not force:
        return True

    lock = _get_lock()
    async with lock:
        if _last_ok and not force:
            return True

        # Fast path: try a real launch. If it works we don't need to
        # reinstall anything.
        err = await _try_launch_chromium()
        if err is None:
            _last_ok = True
            return True

        logger.warning(
            "Playwright chromium launch failed (%s: %s) — attempting "
            "auto-install of matching browser build",
            err.__class__.__name__,
            str(err).splitlines()[0] if str(err) else "unknown",
        )

        rc, tail = await _run_playwright_install()
        if rc != 0:
            logger.error(
                "playwright install chromium failed (rc=%s). Tail:\n%s",
                rc,
                tail,
            )
            _last_ok = False
            return False

        # Verify by launching once more.
        err2 = await _try_launch_chromium()
        if err2 is None:
            logger.info("Playwright chromium auto-install succeeded")
            _last_ok = True
            return True

        logger.error(
            "Playwright chromium still not launchable after install: %s",
            err2,
        )
        _last_ok = False
        return False
