#!/usr/bin/env python3
"""Run production GUI acceptance inside a private rootful Xwayland/i3 session."""
import os
import pathlib
import secrets
import subprocess
import tempfile
import time

root = pathlib.Path(__file__).resolve().parent.parent
children = []
with tempfile.TemporaryDirectory(prefix="nomad-i3-gui-") as temporary:
    directory = pathlib.Path(temporary)
    authority = directory / "Xauthority"
    authority.touch(mode=0o600)
    display = next(":" + str(number) for number in range(90, 110)
                   if not pathlib.Path(f"/tmp/.X11-unix/X{number}").exists()
                   and not pathlib.Path(f"/tmp/.X{number}-lock").exists())
    subprocess.run(["xauth", "-f", str(authority)],
                   input=f"add {display} . {secrets.token_hex(16)}\n", text=True, check=True,
                   stdout=subprocess.DEVNULL)
    environment = dict(os.environ, DISPLAY=display, XAUTHORITY=str(authority),
                       I3SOCK=str(directory / "i3.sock"), NOMAD_PRODUCTION="1",
                       XDG_SESSION_TYPE="x11")
    config = directory / "i3.config"
    config.write_text("font pango:monospace 10\nfocus_follows_mouse no\ndefault_border none\n"
                      + f"ipc-socket {environment['I3SOCK']}\n")
    try:
        with (directory / "xwayland.log").open("w") as output:
            children.append(subprocess.Popen(["Xwayland", display, "-geometry", "1600x900",
                                              "-nolisten", "tcp", "-auth", str(authority), "-noreset"],
                                             stdout=output, stderr=output))
        for _ in range(100):
            if children[0].poll() is not None:
                raise RuntimeError((directory / "xwayland.log").read_text())
            result = subprocess.run(["xdpyinfo"], env=environment, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL)
            if result.returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Private Xwayland display unavailable")
        with (directory / "i3.log").open("w") as output:
            children.append(subprocess.Popen(["i3", "-c", str(config)], env=environment,
                                             stdout=output, stderr=output))
        for _ in range(100):
            if pathlib.Path(environment["I3SOCK"]).exists():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Private i3 socket unavailable")
        print("Private authenticated Xwayland/i3 session ready", flush=True)
        result = subprocess.run([str(root / "node_modules/.bin/electron"),
                                 "test/secureProduction.gui.js", "--nointro", "--test-i3"],
                                cwd=root, env=environment, timeout=150)
        raise SystemExit(result.returncode)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
