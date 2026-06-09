"""上传链路：图片、GIF、视频及其校验。"""
import io

from models import Image


def _upload(client, file_tuple, **form):
    stream, name = file_tuple
    data = {'title': form.pop('title', '作品'), 'prompt': 'hello'}
    data.update(form)
    data['image'] = (stream, name)
    return client.post('/upload', data=data, content_type='multipart/form-data')


def test_image_upload_sets_media_type_image(app, client, png_file):
    resp = _upload(client, png_file())
    assert resp.status_code == 200
    with app.app_context():
        img = Image.query.first()
        assert img is not None
        assert img.media_type == 'image'
        assert img.file_path.endswith('.png')
        assert img.thumbnail_path  # 图片应生成缩略图


def test_gif_upload_sets_media_type_gif(app, client, gif_file):
    resp = _upload(client, gif_file())
    assert resp.status_code == 200
    with app.app_context():
        img = Image.query.first()
        assert img.media_type == 'gif'
        assert img.file_path.endswith('.gif')


def test_video_upload_without_poster(app, client, video_file):
    resp = _upload(client, video_file())
    assert resp.status_code == 200
    with app.app_context():
        img = Image.query.first()
        assert img.media_type == 'video'
        assert img.file_path.endswith('.mp4')  # 保留视频扩展名，不再改成 .jpg
        assert img.thumbnail_path is None  # 无封面则缩略图为空


def test_video_upload_with_poster(app, client, video_file, poster_file):
    stream, name = video_file()
    pstream, pname = poster_file()
    resp = client.post('/upload', data={
        'title': '带封面视频', 'prompt': 'p',
        'image': (stream, name),
        'video_poster': (pstream, pname),
    }, content_type='multipart/form-data')
    assert resp.status_code == 200
    with app.app_context():
        img = Image.query.first()
        assert img.media_type == 'video'
        assert img.thumbnail_path and img.thumbnail_path.endswith('.jpg')


def test_illegal_extension_rejected(app, client):
    resp = client.post('/upload', data={
        'title': '坏文件', 'prompt': 'p',
        'image': (io.BytesIO(b'MZ\x90\x00evil'), 'malware.exe'),
    }, content_type='multipart/form-data')
    assert resp.status_code == 400
    with app.app_context():
        assert Image.query.count() == 0  # 不应静默存成 .jpg


def test_oversize_image_rejected(tmp_path, png_file):
    # 单独构造一个图片上限极小的 app，触发应用层精确校验
    from app import create_app
    from extensions import db
    from tests.conftest import make_test_config

    application = create_app(make_test_config(tmp_path, MAX_IMAGE_SIZE_MB=0))
    with application.app_context():
        db.create_all()
    c = application.test_client()
    stream, name = png_file()
    resp = c.post('/upload', data={'title': 't', 'prompt': 'p', 'image': (stream, name)},
                  content_type='multipart/form-data')
    assert resp.status_code == 400
