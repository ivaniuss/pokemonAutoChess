"""Python client for the Pokemon Auto Chess training environment.

It starts tools/env-server.ts as a subprocess and talks to it with JSON lines, so the
real game rules (written in TypeScript) are used unchanged. Standard library only.

    from pac_env import PacEnv

    with PacEnv() as env:
        obs, legal = env.reset()
        done = False
        while not done:
            obs, reward, done, legal = env.step(legal[0])
"""

import json
import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PREFIX = "@@"


class PacEnvError(RuntimeError):
    pass


class PacEnv:
    def __init__(self, node: str = "node", debug: bool = False):
        self._proc = subprocess.Popen(
            [node, "--import", "tsx", "tools/env-server.ts"],
            cwd=REPO_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            # the game logs a lot on stderr; keep it only when debugging, an unread
            # pipe would eventually block the server
            stderr=None if debug or os.environ.get("PAC_ENV_DEBUG") else subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        ready = self._read()
        if not ready.get("ready"):
            raise PacEnvError(f"Unexpected first message: {ready}")

    def _read(self) -> dict:
        assert self._proc.stdout is not None
        while True:
            line = self._proc.stdout.readline()
            if line == "":
                raise PacEnvError("Environment process exited unexpectedly")
            if line.startswith(PREFIX):
                message = json.loads(line[len(PREFIX):])
                if "error" in message:
                    raise PacEnvError(message["error"])
                return message
            # any other line is game logging on stdout, ignore it

    def _request(self, payload: dict) -> dict:
        assert self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()
        return self._read()

    def reset(self):
        """Starts a new game. Returns (observation, legal_actions)."""
        m = self._request({"cmd": "reset"})
        return m["observation"], m["legalActions"]

    def step(self, action: dict):
        """Returns (observation, reward, done, legal_actions)."""
        m = self._request({"cmd": "step", "action": action})
        return m["observation"], m["reward"], m["done"], m["legalActions"]

    def close(self):
        if self._proc.poll() is None:
            try:
                assert self._proc.stdin is not None
                self._proc.stdin.write(json.dumps({"cmd": "close"}) + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
