import tempfile
from pathlib import Path
import pytest
from ._helpers import write_ui_dist

@pytest.fixture(scope="session")
def synthetic_ui_dist(tmp_path_factory):
    return write_ui_dist(tmp_path_factory.mktemp("compiled-ui"))

@pytest.fixture(scope="session", autouse=True)
def compiled_ui_environment(synthetic_ui_dist):
    with pytest.MonkeyPatch.context() as env:
        env.setenv("XK_UI_DIST", str(synthetic_ui_dist))
        yield

@pytest.fixture
def tmp_data_dir():
    with tempfile.TemporaryDirectory() as d:
        yield Path(d)
