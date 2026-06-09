"""API 接口：上传鉴权、分页 ETag、413。"""
import time

from models import Image


def _api_upload(client, png_file, headers=None):
    stream, name = png_file()
    return client.post('/api/upload', data={
        'title': 'api作品', 'prompt': 'p', 'image': (stream, name),
    }, content_type='multipart/form-data', headers=headers or {})


def test_api_upload_open_when_token_empty(app, client, png_file):
    resp = _api_upload(client, png_file)
    assert resp.status_code == 201
    assert resp.get_json()['data']['media_type'] == 'image'


def test_api_upload_requires_token_when_configured(tmp_path, png_file):
    from app import create_app
    from extensions import db
    from tests.conftest import make_test_config

    application = create_app(make_test_config(tmp_path, API_UPLOAD_TOKEN='s3cr3t'))
    with application.app_context():
        db.create_all()
    c = application.test_client()

    # 缺令牌 -> 401
    assert _api_upload(c, png_file).status_code == 401
    # 错令牌 -> 401
    assert _api_upload(c, png_file, headers={'X-API-Token': 'wrong'}).status_code == 401
    # 正确 Bearer -> 201
    ok = _api_upload(c, png_file, headers={'Authorization': 'Bearer s3cr3t'})
    assert ok.status_code == 201


def test_api_pagination_meta_and_etag_304(app, client, png_file):
    # 造几条已审核数据
    with app.app_context():
        from extensions import db
        for i in range(3):
            db.session.add(Image(title=f't{i}', file_path=f'/x/{i}.png',
                                 media_type='image', status='approved', category='gallery'))
        db.session.commit()

    r1 = client.get('/api/gallery?per_page=2')
    assert r1.status_code == 200
    body = r1.get_json()
    assert body['meta']['per_page'] == 2
    assert body['meta']['total_items'] == 3
    assert body['meta']['has_next'] is True
    etag = r1.headers.get('ETag')
    assert etag

    # 间隔超过 1 秒后带 If-None-Match 仍应命中 304 (回归：server_timestamp 不参与 ETag)
    time.sleep(1.1)
    r2 = client.get('/api/gallery?per_page=2', headers={'If-None-Match': etag})
    assert r2.status_code == 304


def test_413_returns_json_on_api(tmp_path, png_file):
    from app import create_app
    from extensions import db
    from tests.conftest import make_test_config

    # 把全局请求体上限压到极小，触发 413
    application = create_app(make_test_config(tmp_path, MAX_CONTENT_LENGTH=10))
    with application.app_context():
        db.create_all()
    c = application.test_client()
    stream, name = png_file()
    resp = c.post('/api/upload', data={'title': 't', 'image': (stream, name)},
                  content_type='multipart/form-data')
    assert resp.status_code == 413
    assert resp.get_json()['code'] == 413
