import io
import os
import tempfile

import pytest
from PIL import Image as PilImage
from werkzeug.security import generate_password_hash

from config import Config


def make_test_config(tmp_path, **overrides):
    upload_dir = os.path.join(str(tmp_path), 'uploads')
    os.makedirs(upload_dir, exist_ok=True)

    class TestConfig(Config):
        TESTING = True
        WTF_CSRF_ENABLED = False
        RATELIMIT_ENABLED = False
        USE_LOCAL_RESOURCES = False
        STORAGE_TYPE = 'local'
        API_UPLOAD_TOKEN = ''
        UPLOAD_FOLDER = upload_dir
        SQLALCHEMY_DATABASE_URI = f"sqlite:///{os.path.join(str(tmp_path), 'test.sqlite')}"
        SQLALCHEMY_TRACK_MODIFICATIONS = False

    for key, value in overrides.items():
        setattr(TestConfig, key, value)
    return TestConfig


@pytest.fixture
def app(tmp_path):
    from app import create_app
    from extensions import db
    from models import User

    application = create_app(make_test_config(tmp_path))
    with application.app_context():
        db.create_all()
        db.session.add(User(username='admin', password_hash=generate_password_hash('secret')))
        db.session.commit()
    yield application


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def auth_client(app):
    c = app.test_client()
    c.post('/login', data={'username': 'admin', 'password': 'secret'})
    return c


def _png_bytes(size=(64, 64), color=(120, 80, 200)):
    buf = io.BytesIO()
    PilImage.new('RGB', size, color).save(buf, format='PNG')
    buf.seek(0)
    return buf


def _gif_bytes(size=(48, 48)):
    buf = io.BytesIO()
    PilImage.new('P', size).save(buf, format='GIF')
    buf.seek(0)
    return buf


@pytest.fixture
def png_file():
    return lambda name='art.png': (_png_bytes(), name)


@pytest.fixture
def gif_file():
    return lambda name='art.gif': (_gif_bytes(), name)


@pytest.fixture
def video_file():
    """伪造的 mp4 字节流。后端不喂 PIL，仅按扩展名分流并原样落地。"""
    def _make(name='clip.mp4'):
        # 最小 mp4 ftyp box 头，足以代表一个视频文件
        data = b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom' + b'\x00' * 64
        return (io.BytesIO(data), name)
    return _make


@pytest.fixture
def poster_file():
    return lambda name='poster.jpg': (_png_bytes(color=(10, 10, 10)), name)

