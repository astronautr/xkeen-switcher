"""Check container stop/reset/resume ordering without running Docker."""
import os
import subprocess
import shutil
from pathlib import Path
import pytest

@pytest.mark.skipif(shutil.which("bash") is None, reason="Host maintenance script requires Bash; not shipped in runtime image")
@pytest.mark.parametrize("reset_status", [0, 1])
def test_password_wrapper_resumes_service_after_success_or_failure(tmp_path, reset_status):
    docker = tmp_path / "docker"
    log = tmp_path / "docker-calls"
    docker.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
if [[ "$*" == *"compose run"* ]]; then
  exit "$TEST_DOCKER_RESET_STATUS"
fi
''')
    docker.chmod(0o755)
    env = dict(os.environ, PATH=f"{tmp_path}:{os.environ['PATH']}",
               TEST_DOCKER_LOG=str(log), TEST_DOCKER_RESET_STATUS=str(reset_status))
    primary, secondary = os.openpty()
    try:
        result = subprocess.run(
            ["bash", str(Path(__file__).resolve().parents[1] / "scripts/set-password.sh")],
            stdin=secondary, capture_output=True, env=env, timeout=10,
        )
    finally:
        os.close(primary)
        os.close(secondary)
    assert result.returncode == reset_status
    assert log.read_text().splitlines() == [
        "compose build xk-switcher", "compose stop xk-switcher",
        "compose run --rm --no-deps xk-switcher python -m xk_switcher.auth set-password",
        "compose up -d --no-build xk-switcher",
    ]
