"""ZIP 备份的内容完整性、去重、大小限制和资源清理。"""
import io
import json
import os
import re
import zipfile
from contextlib import contextmanager
from pathlib import Path

import pytest

from PIL import Image as PilImage

from extensions import db
from models import Image, ReferenceImage
from services.data_service import DataService


def _backup(items, files=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, payload in (files or {'images/main.png': b'main'}).items():
            zf.writestr(name, payload)
        zf.writestr('data.json', json.dumps({'images': items}))
    buf.seek(0)
    return buf


def _item(**overrides):
    return dict({'title': '同名作品', 'author': 'tester', 'prompt': 'prompt',
                 'zip_image_path': 'images/main.png', 'refs': [], 'tags': []}, **overrides)


def _import(app, archive):
    path = Path(app.instance_path) / 'test-import.zip'
    path.write_bytes(archive.getvalue())
    with app.app_context():
        log = ''.join(DataService.import_zip_stream(str(path)))
    assert not path.exists()
    return log


def _stored_bytes(app, path):
    return (Path(app.config['UPLOAD_FOLDER']) / os.path.basename(path)).read_bytes()


def test_placeholder_roundtrip(app, auth_client):
    root = Path(app.config['UPLOAD_FOLDER'])
    (root / 'main.png').write_bytes(b'main')
    (root / 'ref.png').write_bytes(b'reference')
    with app.app_context():
        img = Image(title='占位符', author='tester', prompt='p', file_path='/uploads/main.png')
        img.refs = [ReferenceImage(file_path=None if i % 2 else '',
                                   is_placeholder=True, position=i) for i in reversed(range(99))]
        img.refs.append(ReferenceImage(file_path='/uploads/ref.png', position=100))
        db.session.add(img)
        db.session.commit()

    response = auth_client.post('/admin/export-zip')
    assert response.status_code == 200
    archive = io.BytesIO(response.data)
    response.close()
    with zipfile.ZipFile(archive) as zf:
        refs = json.loads(zf.read('data.json'))['images'][0]['refs']
        assert sum(r['is_placeholder'] for r in refs) == 99
        assert [r['position'] for r in refs] == [*range(99), 100]
        assert set(zf.namelist()) == {'images/main.png', 'images/ref.png', 'data.json'}
    with app.app_context():
        db.session.delete(db.session.get(Image, 1))
        db.session.commit()
    assert '成功 1' in _import(app, archive)
    with app.app_context():
        img = Image.query.one()
        assert img.status == 'pending'
        assert len(img.refs) == 100
        assert [r.position for r in img.refs] == [*range(99), 100]
        assert all(r.is_placeholder and r.file_path is None for r in img.refs[:99])
        assert _stored_bytes(app, img.refs[-1].file_path) == b'reference'


def test_import_preserves_placeholder_metadata(app):
    refs = [{'file_path': None, 'is_placeholder': True, 'position': i} for i in range(99)]
    assert '成功 1' in _import(app, _backup([_item(refs=refs)]))
    with app.app_context():
        assert ReferenceImage.query.filter_by(is_placeholder=True).count() == 99


def test_same_title_different_content_and_exact_duplicates(app):
    items = [_item(), _item(prompt='other'), _item(zip_image_path='images/other.png'),
             _item(zip_image_path='images/renamed.png')]
    files = {'images/main.png': b'main', 'images/other.png': b'other', 'images/renamed.png': b'main'}
    assert '成功 3，跳过 1，错误 0' in _import(app, _backup(items, files))
    assert '成功 0，跳过 4，错误 0' in _import(app, _backup(items, files))
    with app.app_context():
        assert Image.query.count() == 3


def test_import_never_overwrites_existing_files(app):
    root = Path(app.config['UPLOAD_FOLDER'])
    (root / 'main.png').write_bytes(b'existing')
    assert '成功 1' in _import(app, _backup([_item()]))
    assert (root / 'main.png').read_bytes() == b'existing'
    with app.app_context():
        assert _stored_bytes(app, Image.query.one().file_path) == b'main'


def test_missing_real_reference_fails_record(app):
    refs = [{'file_path': '/uploads/missing.png', 'position': 0, 'is_placeholder': False}]
    assert '成功 0，跳过 0，错误 1' in _import(app, _backup([_item(refs=refs)]))
    with app.app_context():
        assert Image.query.count() == 0
    assert not list(Path(app.config['UPLOAD_FOLDER']).iterdir())


@pytest.mark.parametrize('change', [
    {'description': 'changed'}, {'type': 'img2img'}, {'category': 'template'},
    {'media_type': 'video'}, {'tags': ['new']},
    {'refs': [{'is_placeholder': True, 'position': 2}]},
    {'zip_thumb_path': 'images/thumb.png'},
])
def test_content_differences_are_not_duplicates(app, change):
    files = {'images/main.png': b'main', 'images/thumb.png': b'thumb'}
    assert '成功 2，跳过 0，错误 0' in _import(app, _backup([_item(), _item(**change)], files))


def test_reference_contents_and_positions_participate_in_dedup(app):
    files = {'images/main.png': b'main', 'images/ref.png': b'first', 'images/other.png': b'second'}
    refs = [{'file_path': '/old/ref.png', 'position': 0}, {'is_placeholder': True, 'position': 1}]
    changed_file = [dict(refs[0], file_path='images/other.png'), refs[1]]
    changed_order = [dict(refs[0], position=1), dict(refs[1], position=0)]
    items = [_item(refs=refs), _item(refs=changed_file), _item(refs=changed_order), _item(refs=refs)]
    assert '成功 3，跳过 1，错误 0' in _import(app, _backup(items, files))


def test_volatile_metadata_and_tag_order_do_not_change_identity(app):
    assert '成功 1' in _import(app, _backup([_item(tags=['b', 'a', 'a'])]))
    with app.app_context():
        img = Image.query.one()
        img.status = 'approved'
        img.heat_score = 999
        db.session.commit()
        assert len(img.tags) == 2
    item = _item(tags=['a', 'b'], id=999, created_at='2000-01-01', heat_score=3,
                 zip_image_path='images/renamed.png')
    assert '成功 0，跳过 1，错误 0' in _import(app, _backup([item], {'images/renamed.png': b'main'}))


def test_legacy_string_refs_use_list_order_and_unique_filenames(app):
    files = {'images/main.png': b'main', 'first/ref.png': b'one', 'second/ref.png': b'two'}
    item = _item(refs=['first/ref.png', 'second/ref.png'])
    assert '成功 1' in _import(app, _backup([item], files))
    with app.app_context():
        refs = Image.query.one().refs
        assert [ref.position for ref in refs] == [0, 1]
        assert [_stored_bytes(app, ref.file_path) for ref in refs] == [b'one', b'two']
        assert refs[0].file_path != refs[1].file_path
    assert '跳过 1，错误 0' in _import(app, _backup([item], files))


def test_bad_record_does_not_stop_following_records(app):
    items = [_item(refs=['images/missing.png']), _item()]
    assert '成功 1，跳过 0，错误 1' in _import(app, _backup(items))


def test_invalid_zip_reports_error_and_cleans_up(app):
    assert '成功 0，跳过 0，错误 1' in _import(app, io.BytesIO(b'not a ZIP'))


def test_expanded_size_limit_rejects_before_writing(app):
    app.config['MAX_BACKUP_UNCOMPRESSED_SIZE_MB'] = 1
    log = _import(app, _backup([_item()], {'images/main.png': b'x' * (2 * 1024 * 1024)}))
    assert '解压总量' in log and '错误 1' in log
    assert not list(Path(app.config['UPLOAD_FOLDER']).iterdir())


def test_repeated_members_also_obey_extraction_budget(app):
    app.config['MAX_BACKUP_UNCOMPRESSED_SIZE_MB'] = 1
    data = _backup([_item(), _item(prompt='different')], {'images/main.png': b'x' * 700_000})
    assert '成功 1，跳过 0，错误 1' in _import(app, data)
    assert len(list(Path(app.config['UPLOAD_FOLDER']).iterdir())) == 1


def test_failed_write_rolls_back_only_new_files(app, monkeypatch):
    import builtins
    from services import data_service

    assert '成功 1' in _import(app, _backup([_item()]))
    before = set(Path(app.config['UPLOAD_FOLDER']).iterdir())

    @contextmanager
    def failing_open(path, mode='r', *args, **kwargs):
        with builtins.open(path, mode, *args, **kwargs) as stream:
            if mode == 'xb':
                class FailingWriter:
                    def write(self, chunk):
                        stream.write(chunk[:2])
                        raise OSError('disk full')
                yield FailingWriter()
            else:
                yield stream

    monkeypatch.setattr(data_service, 'open', failing_open, raising=False)
    log = _import(app, _backup([_item(title='new')]))
    assert 'disk full' in log and '成功 0，跳过 0，错误 1' in log
    assert set(Path(app.config['UPLOAD_FOLDER']).iterdir()) == before
    with app.app_context():
        assert Image.query.count() == 1


def test_failed_commit_removes_extracted_files_and_tags(app, monkeypatch):
    from models import Tag

    def fail():
        raise RuntimeError('commit failed')

    monkeypatch.setattr(db.session, 'commit', fail)
    assert '错误 1' in _import(app, _backup([_item(tags=['new'])]))
    assert not list(Path(app.config['UPLOAD_FOLDER']).iterdir())
    with app.app_context():
        assert Image.query.count() == Tag.query.count() == 0


def test_import_reads_media_in_bounded_chunks(app, monkeypatch):
    original_read = zipfile.ZipExtFile.read

    def bounded_read(stream, size=-1):
        if stream.name != 'data.json':
            assert 0 < size <= 1024 * 1024
        return original_read(stream, size)

    monkeypatch.setattr(zipfile.ZipExtFile, 'read', bounded_read)
    assert '成功 1' in _import(app, _backup([_item()], {'images/main.png': b'x' * 2_000_000}))


def test_backup_limit_applies_before_csrf_and_preserves_api_limit(app, auth_client):
    app.config.update(WTF_CSRF_ENABLED=True, MAX_CONTENT_LENGTH=1024, MAX_BACKUP_SIZE_MB=1)
    html = auth_client.get('/admin/').get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', html).group(1)
    archive = _backup([_item()], {'images/main.png': os.urandom(4096)})
    payload = archive.getvalue()
    response = auth_client.post('/admin/import-zip', data={
        'zip_file': (archive, 'backup.zip'), 'csrf_token': token,
    })
    assert response.status_code == 200
    assert '成功 1' in response.get_data(as_text=True)
    response.close()
    assert app.config['MAX_CONTENT_LENGTH'] == 1024
    assert auth_client.post('/api/upload', data={'image': (io.BytesIO(payload), 'a.png')}).status_code == 413
    no_csrf = auth_client.post('/admin/import-zip', data={'zip_file': (io.BytesIO(payload), 'backup.zip')})
    assert no_csrf.status_code == 400

    for size in [1024 * 1024 + 1, 11 * 1024 * 1024 + 1]:
        response = auth_client.post('/admin/import-zip', data={
            'zip_file': (io.BytesIO(b'x' * size), 'too-large.zip'), 'csrf_token': token,
        })
        assert response.status_code == 413
        assert '1 MiB' in response.get_data(as_text=True)
        response.close()
    assert not list(Path(app.instance_path).glob('import-*.zip'))


def test_import_accepts_exact_file_size_limit(app, auth_client):
    archive = _backup([_item()])
    app.config['MAX_BACKUP_SIZE_MB'] = len(archive.getvalue()) / (1024 * 1024)
    response = auth_client.post('/admin/import-zip', data={'zip_file': (archive, 'backup.zip')})
    assert response.status_code == 200
    assert '成功 1' in response.get_data(as_text=True)
    response.close()


def test_upload_save_failure_removes_temp_file(app, auth_client, monkeypatch):
    from werkzeug.datastructures import FileStorage

    def fail_save(self, destination, **kwargs):
        destination.write(b'partial')
        raise OSError('upload failed')

    monkeypatch.setattr(FileStorage, 'save', fail_save)
    with pytest.raises(OSError, match='upload failed'):
        auth_client.post('/admin/import-zip', data={'zip_file': (_backup([_item()]), 'backup.zip')})
    assert not list(Path(app.instance_path).iterdir())


def test_unstarted_import_responses_use_unique_tempfiles_and_cleanup(app):
    from flask import session

    responses = []
    for _ in range(2):
        with app.test_request_context('/admin/import-zip', method='POST',
                                      data={'zip_file': (_backup([_item()]), 'backup.zip')}):
            session['_user_id'] = '1'
            responses.append(app.view_functions['admin.import_zip']())
    paths = list(Path(app.instance_path).glob('import-*.zip'))
    assert len(paths) == 2
    responses[0].close()
    assert sum(path.exists() for path in paths) == 1
    responses[1].close()
    assert not any(path.exists() for path in paths)


def test_interrupted_import_preserves_committed_records(app):
    path = Path(app.instance_path) / 'interrupt.zip'
    path.write_bytes(_backup([_item(), _item(title='second')]).getvalue())
    with app.app_context():
        stream = DataService.import_zip_stream(path)
        for line in stream:
            if '[导入] second' in line:
                break
        stream.close()
        assert Image.query.count() == 1
    assert not path.exists()
    assert len(list(Path(app.config['UPLOAD_FOLDER']).iterdir())) == 1


@pytest.fixture
def export_handles(app, monkeypatch):
    from blueprints import admin

    path = Path(app.config['UPLOAD_FOLDER']) / 'main.png'
    path.write_bytes(os.urandom(64 * 1024))
    with app.app_context():
        img = Image(title='export', file_path='/uploads/main.png', thumbnail_path='/uploads/main.png')
        img.refs.append(ReferenceImage(file_path='/uploads/main.png', position=0))
        db.session.add(img)
        db.session.commit()
    handles = []
    original = admin.tempfile.TemporaryFile

    def tracked_file(*args, **kwargs):
        result = original(*args, **kwargs)
        handles.append(result)
        return result

    monkeypatch.setattr(admin.tempfile, 'TemporaryFile', tracked_file)
    yield handles
    for handle in handles:
        handle.close()


@pytest.mark.parametrize('mode', ['complete', 'interrupt', 'unstarted'])
def test_export_closes_disk_file(app, auth_client, export_handles, mode):
    if mode == 'unstarted':
        from flask import session
        with app.test_request_context('/admin/export-zip', method='POST'):
            session['_user_id'] = '1'
            response = app.view_functions['admin.export_zip']()
    else:
        response = auth_client.post('/admin/export-zip', buffered=False)
    handle = export_handles[0]
    assert not isinstance(handle, io.BytesIO)
    assert not handle.closed
    assert response.content_length == os.fstat(handle.fileno()).st_size
    if mode == 'complete':
        with zipfile.ZipFile(io.BytesIO(response.data)) as zf:
            assert zf.namelist() == ['images/main.png', 'data.json']
            assert zf.testzip() is None
    elif mode == 'interrupt':
        assert next(iter(response.response))
    response.close()
    assert handle.closed
    assert not list(Path(app.instance_path).iterdir())


@pytest.mark.parametrize('stage', ['write', 'send'])
def test_export_failure_closes_disk_file(auth_client, export_handles, monkeypatch, stage):
    from blueprints import admin

    def fail(*args, **kwargs):
        raise OSError('disk or response failed')

    if stage == 'write':
        monkeypatch.setattr(zipfile.ZipFile, 'write', fail)
    else:
        monkeypatch.setattr(admin, 'send_file', fail)
    with pytest.raises(OSError, match='disk or response failed'):
        auth_client.post('/admin/export-zip')
    assert export_handles[0].closed


def test_export_missing_reference_is_explicit_error(app, auth_client, export_handles):
    with app.app_context():
        Image.query.one().refs[0].file_path = '/uploads/missing.png'
        db.session.commit()
    response = auth_client.post('/admin/export-zip')
    assert response.status_code == 400
    assert '文件缺失 missing.png' in response.get_data(as_text=True)
    assert export_handles[0].closed


def _build_backup_zip(media_type='video', img_name='clip.mp4'):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        # 主文件内容（视频用任意字节，图片用真实 PNG）
        if media_type == 'video':
            payload = b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 32
        else:
            ib = io.BytesIO()
            PilImage.new('RGB', (8, 8)).save(ib, format='PNG')
            payload = ib.getvalue()
        zf.writestr(f'images/{img_name}', payload)
        zf.writestr('data.json', json.dumps({'images': [{
            'title': '回放', 'author': 'tester', 'prompt': 'p',
            'type': 'txt2img', 'category': 'gallery',
            'media_type': media_type,
            'zip_image_path': f'images/{img_name}',
            'tags': [], 'refs': [],
        }]}))
    buf.seek(0)
    return buf.getvalue()


def test_import_preserves_video_media_type(app):
    with app.app_context():
        zip_path = os.path.join(app.instance_path, 'rt.zip')
        os.makedirs(app.instance_path, exist_ok=True)
        with open(zip_path, 'wb') as f:
            f.write(_build_backup_zip(media_type='video'))

        from services.data_service import DataService
        list(DataService.import_zip_stream(zip_path))  # 消费生成器

        img = Image.query.filter_by(title='回放').first()
        assert img is not None
        assert img.media_type == 'video'


def test_import_infers_media_type_when_missing(app):
    """旧备份没有 media_type 字段时，按 file_path 扩展名推断。"""
    with app.app_context():
        # 构造缺少 media_type 的 data.json
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('images/old.mp4', b'\x00\x00\x00\x18ftypmp42')
            zf.writestr('data.json', json.dumps({'images': [{
                'title': '旧视频', 'author': 'x', 'zip_image_path': 'images/old.mp4',
                'tags': [], 'refs': [],
            }]}))
        zip_path = os.path.join(app.instance_path, 'old.zip')
        os.makedirs(app.instance_path, exist_ok=True)
        with open(zip_path, 'wb') as f:
            f.write(buf.getvalue())

        from services.data_service import DataService
        list(DataService.import_zip_stream(zip_path))

        img = Image.query.filter_by(title='旧视频').first()
        assert img is not None
        assert img.media_type == 'video'
