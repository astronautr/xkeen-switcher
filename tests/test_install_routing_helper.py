"""Installer must use Compose's dotenv semantics without executing credentials."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install-routing-helper.sh"

@pytest.mark.parametrize("password", ["literal$8 and spaces", "quote'\" dollar$HOME", "$(touch should-not-exist)`touch neither`"])
def test_installer_reads_resolved_credentials_without_shell_expansion(tmp_path, password):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    shutil.copy(SCRIPT, scripts / SCRIPT.name)
    router = tmp_path / "router"
    router.mkdir()
    for name in ("S04xk-routing", "S06xk-routing", "xk-routing.sh", "xk-apply.sh", "xk-update.py", "xk-update-recovery.sh"):
        (router / name).write_text("#!/bin/sh\nexit 0\n")
    (tmp_path / ".env").write_text("SSH_PASSWORD=$8\nexit 77\n")
    config = {"services": {"xk-switcher": {"environment": {"ROUTER_HOST": "router.test", "ROUTER_USER": "root",
              "ROUTER_PORT": 22, "SSH_PASSWORD": password}}}}
    (tmp_path / "resolved.json").write_text(json.dumps(config))
    bins = tmp_path / "bin"
    bins.mkdir()
    (bins / "python3").symlink_to(sys.executable)
    for name, body in {
        "docker": "import pathlib,sys\nassert sys.argv[1:]==['compose','--env-file','.env','config','--format','json']\nprint(pathlib.Path('resolved.json').read_text())\n",
        "sshpass": "import json,os,pathlib,sys\nexpected=json.loads(pathlib.Path('resolved.json').read_text())['services']['xk-switcher']['environment']['SSH_PASSWORD']\nassert os.environ['SSHPASS']==expected\nassert 'root@router.test' in sys.argv\nif sys.argv[-1].endswith('capabilities'): print('{\"version\":3,\"ready\":true,\"bundle\":true,\"selective\":true}')\n",
    }.items():
        target = bins / name
        target.write_text(f"#!{sys.executable}\n" + body)
        target.chmod(0o755)
    result = subprocess.run(["bash", str(scripts / SCRIPT.name)], cwd=tmp_path,
                            env={**os.environ, "PATH": str(bins) + os.pathsep + os.environ["PATH"]},
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert "Routing helpers installed" in result.stdout
    assert password not in result.stdout + result.stderr
    assert not (tmp_path / "should-not-exist").exists()
    assert not (tmp_path / "neither").exists()
