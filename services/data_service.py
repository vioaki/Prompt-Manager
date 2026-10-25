import hashlib
import json
import os
from pathlib import Path
import uuid
import zipfile

from werkzeug.utils import secure_filename
from flask import current_app
from extensions import db
from models import Image, Tag, ReferenceImage
from services.media_service import infer_media_type


CHUNK_SIZE = 1024 * 1024
CONTENT_DEFAULTS = {
    'title': '', 'author': '', 'prompt': '', 'description': '',
    'type': 'txt2img', 'category': 'gallery',
}


def _content_fields(item, main_path):
    fields = {key: item.get(key) or default for key, default in CONTENT_DEFAULTS.items()}
    fields['media_type'] = item.get('media_type') or infer_media_type(main_path)
    if not fields['title'] or not all(isinstance(value, str) for value in fields.values()):
        raise ValueError('作品信息无效或缺少标题')
    return fields


def _references(refs):
    if not isinstance(refs, list):
        raise ValueError('refs 必须是列表')
    result = []
    for index, ref in enumerate(refs):
        if isinstance(ref, str):
            ref = {'file_path': ref}
        if not isinstance(ref, dict):
            raise ValueError('参考图格式无效')
        placeholder = ref.get('is_placeholder', False)
        position = ref.get('position', index)
        if type(placeholder) is not bool or type(position) is not int or position < 0:
            raise ValueError('参考图占位符或位置无效')
        path = None if placeholder else ref.get('file_path')
        if not placeholder and (not isinstance(path, str) or not path):
            raise ValueError('真实参考图缺少路径')
        result.append({'file_path': path, 'is_placeholder': placeholder, 'position': position})
    return sorted(result, key=lambda ref: ref['position'])


def _digest(stream):
    digest = hashlib.sha256()
    while chunk := stream.read(CHUNK_SIZE):
        digest.update(chunk)
    return digest.hexdigest()


def _fingerprint(item, main_path, thumb_path, refs, digest):
    tags = item.get('tags', [])
    if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
        raise ValueError('tags 必须是字符串列表')
    return (
        tuple(_content_fields(item, main_path).items()), tuple(sorted(set(tags))),
        digest(main_path), digest(thumb_path) if thumb_path else None,
        tuple((ref['position'], ref['is_placeholder'],
               None if ref['is_placeholder'] else digest(ref['file_path'])) for ref in refs),
    )


class DataService:
    @staticmethod
    def import_zip_stream(zip_path):
        """逐条提交作品；关闭生成器时清理未提交文件及上传暂存文件。"""
        stats = {'processed': 0, 'skipped': 0, 'errors': 0}
        upload_root = os.path.join(current_app.root_path, current_app.config['UPLOAD_FOLDER'])
        max_expanded = current_app.config['MAX_BACKUP_UNCOMPRESSED_SIZE_MB'] * 1024 * 1024
        extracted_bytes = 0
        local_hashes = {}

        def local_digest(path):
            if not path or path.startswith(('http://', 'https://')):
                raise ValueError('备份仅支持本地文件')
            absolute = os.path.join(upload_root, os.path.basename(path))
            if absolute not in local_hashes:
                with open(absolute, 'rb') as stream:
                    local_hashes[absolute] = _digest(stream)
            return local_hashes[absolute]

        try:
            yield '🚀 [System] 开始处理数据包...\n'
            os.makedirs(upload_root, exist_ok=True)
            if os.path.getsize(zip_path) > current_app.config['MAX_BACKUP_SIZE_MB'] * 1024 * 1024:
                raise ValueError('ZIP 文件超过备份大小上限')
            with zipfile.ZipFile(zip_path, 'r') as zf:
                if sum(info.file_size for info in zf.infolist()) > max_expanded:
                    raise ValueError('ZIP 解压总量超过备份解压上限')
                with zf.open('data.json') as stream:
                    data = json.load(stream)
                if not isinstance(data, dict) or not isinstance(data.get('images'), list):
                    raise ValueError('data.json 必须包含 images 列表')
                items = data['images']
                names = set(zf.namelist())
                archive_hashes = {}

                def archive_digest(name):
                    if not name or name not in names or zf.getinfo(name).is_dir():
                        raise FileNotFoundError(f'备份文件缺失: {name}')
                    if name not in archive_hashes:
                        with zf.open(name) as stream:
                            archive_hashes[name] = _digest(stream)
                    return archive_hashes[name]

                yield f'📦 发现 {len(items)} 条记录，开始导入...\n'
                for item in items:
                    created_paths = []
                    extracted_paths = {}
                    committed = False

                    def extract(name):
                        nonlocal extracted_bytes
                        if name in extracted_paths:
                            return extracted_paths[name]
                        extension = os.path.splitext(secure_filename(os.path.basename(name)))[1]
                        filename = f'{uuid.uuid4().hex}{extension}'
                        absolute = os.path.join(upload_root, filename)
                        with zf.open(name) as src, open(absolute, 'xb') as dst:
                            created_paths.append(absolute)
                            while chunk := src.read(CHUNK_SIZE):
                                extracted_bytes += len(chunk)
                                if extracted_bytes > max_expanded:
                                    raise ValueError('ZIP 解压总量超过备份解压上限')
                                dst.write(chunk)
                        web_path = f"/{current_app.config['UPLOAD_FOLDER']}/{filename}".replace('//', '/')
                        extracted_paths[name] = web_path
                        local_hashes[absolute] = archive_hashes[name]
                        return web_path

                    try:
                        main = item.get('zip_image_path')
                        thumb = item.get('zip_thumb_path')
                        refs = _references(item.get('refs', []))
                        for ref in refs:
                            if not ref['is_placeholder'] and ref['file_path'] not in names:
                                ref['file_path'] = f"images/{os.path.basename(ref['file_path'])}"
                        fingerprint = _fingerprint(item, main, thumb, refs, archive_digest)
                        fields = _content_fields(item, main)
                        duplicate = False
                        candidates = Image.query.filter_by(title=fields['title'], author=fields['author']).all()
                        for existing in candidates:
                            try:
                                existing_data = existing.to_dict()
                                existing_fingerprint = _fingerprint(
                                    existing_data, existing.file_path, existing.thumbnail_path,
                                    _references(existing_data['refs']), local_digest,
                                )
                            except (OSError, ValueError) as exc:
                                current_app.logger.warning('无法核对作品 %s 的文件，保留导入记录: %s', existing.id, exc)
                                continue
                            if existing_fingerprint == fingerprint:
                                duplicate = True
                                break
                        if duplicate:
                            stats['skipped'] += 1
                            yield f"   ⏭️ [跳过] {fields['title']}\n"
                            continue

                        yield f"   📥 [导入] {fields['title']}... "
                        img = Image(**fields, file_path=extract(main),
                                    thumbnail_path=extract(thumb) if thumb else None,
                                    status='pending', heat_score=item.get('heat_score', 0))
                        db.session.add(img)
                        for name in dict.fromkeys(item.get('tags', [])):
                            tag = Tag.query.filter_by(name=name).first() or Tag(name=name)
                            db.session.add(tag)
                            img.tags.append(tag)
                        for ref in refs:
                            img.refs.append(ReferenceImage(
                                file_path=None if ref['is_placeholder'] else extract(ref['file_path']),
                                position=ref['position'], is_placeholder=ref['is_placeholder'],
                            ))
                        db.session.commit()
                        committed = True
                        stats['processed'] += 1
                        message = '✅ OK\n'
                    except Exception as exc:
                        stats['errors'] += 1
                        message = f'❌ {exc}\n'
                    finally:
                        if not committed:
                            db.session.rollback()
                            for path in created_paths:
                                Path(path).unlink(missing_ok=True)
                                local_hashes.pop(path, None)
                    yield message
        except Exception as exc:
            stats['errors'] += 1
            yield f'\n❌ ZIP 读取失败: {exc}\n'
        finally:
            Path(zip_path).unlink(missing_ok=True)

        yield f"\n🎉 完成：成功 {stats['processed']}，跳过 {stats['skipped']}，错误 {stats['errors']}"
