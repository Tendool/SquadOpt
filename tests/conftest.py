import os, sys, importlib, pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from tests.synthetic import make_csv  # noqa: E402


@pytest.fixture(scope="session")
def csv_path(tmp_path_factory):
    return str(make_csv(tmp_path_factory.mktemp("data") / "synthetic_fc26.csv", n=600, seed=3))


@pytest.fixture(scope="session")
def se():
    import squad_engine
    return squad_engine


@pytest.fixture(scope="session")
def df(se, csv_path):
    return se.add_utilities(se.load_players(csv_path))


@pytest.fixture(scope="session")
def app_module(csv_path):
    os.environ["FC26_CSV"] = csv_path
    import app
    return importlib.reload(app) if getattr(app, "CSV", None) != csv_path else app


@pytest.fixture()
def client(app_module):
    return app_module.app.test_client()
