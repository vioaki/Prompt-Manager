"""ZIP 导入保留 media_type。"""
import io
import json
import os
import zipfile

from PIL import Image as PilImage

from models import Image


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
