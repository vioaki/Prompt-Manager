import os
import json
import zipfile
from werkzeug.utils import secure_filename
from flask import current_app
from extensions import db
from models import Image, Tag, ReferenceImage
from services.media_service import infer_media_type


class DataService:
    @staticmethod
    def import_zip_stream(zip_path):
        """流式处理 ZIP 导入，返回生成器"""
        yield "🚀 [System] 开始处理数据包...\n"

        stats = {'processed': 0, 'skipped': 0, 'errors': 0}
        upload_root = os.path.join(current_app.root_path, current_app.config['UPLOAD_FOLDER'])
        if not os.path.exists(upload_root): os.makedirs(upload_root)

        try:
            with zipfile.ZipFile(zip_path, 'r') as zf:
                if 'data.json' not in zf.namelist():
                    yield "❌ 错误：未找到 data.json\n"
                    return

                with zf.open('data.json') as f:
                    data = json.load(f)
                    items = data.get('images', [])

                yield f"📦 发现 {len(items)} 条记录，开始导入...\n"

                for item in items:
                    try:
                        # 查重：标题和作者相同则跳过
                        if Image.query.filter_by(title=item['title'], author=item.get('author', '')).first():
                            yield f"   ⏭️ [跳过] {item['title']}\n"
                            stats['skipped'] += 1
                            continue

                        yield f"   📥 [导入] {item['title']}... "

                        # 1. 提取主图
                        zip_img = item.get('zip_image_path')
                        if not zip_img or zip_img not in zf.namelist():
                            raise FileNotFoundError("主图缺失")

                        safe_name = secure_filename(os.path.basename(zip_img))
                        with zf.open(zip_img) as src, open(os.path.join(upload_root, safe_name), "wb") as dst:
                            dst.write(src.read())

                        # 2. 提取缩略图 (可选)
                        safe_thumb = None
                        if item.get('zip_thumb_path') and item['zip_thumb_path'] in zf.namelist():
                            safe_thumb = secure_filename(os.path.basename(item['zip_thumb_path']))
                            with zf.open(item['zip_thumb_path']) as src, open(os.path.join(upload_root, safe_thumb),
                                                                              "wb") as dst:
                                dst.write(src.read())

                        web_folder = current_app.config['UPLOAD_FOLDER']
                        local_file_path = f"/{web_folder}/{safe_name}"
                        img = Image(
                            title=item['title'],
                            author=item.get('author', ''),
                            prompt=item.get('prompt', ''),
                            description=item.get('description', ''),
                            type=item.get('type', 'txt2img'),
                            category=item.get('category', 'gallery'),  # 读取分类
                            file_path=local_file_path,
                            thumbnail_path=f"/{web_folder}/{safe_thumb}" if safe_thumb else None,
                            media_type=item.get('media_type') or infer_media_type(local_file_path),
                            status='pending',  # 导入后默认为待审核，需管理员确认
                            heat_score=item.get('heat_score', 0)
                        )
                        # ---------------------------------

                        # 3. 处理标签
                        for t in item.get('tags', []):
                            tag = Tag.query.filter_by(name=t).first() or Tag(name=t)
                            db.session.add(tag)
                            img.tags.append(tag)

                        # 4. 处理参考图
                        for ref_path in item.get('refs', []):
                            # 兼容旧版本 JSON
                            if isinstance(ref_path, str):
                                if ref_path in zf.namelist():
                                    safe_ref = secure_filename(os.path.basename(ref_path))
                                    with zf.open(ref_path) as src, open(os.path.join(upload_root, safe_ref),
                                                                        "wb") as dst:
                                        dst.write(src.read())
                                    ref_obj = ReferenceImage(file_path=f"/{web_folder}/{safe_ref}")
                                    img.refs.append(ref_obj)
                            # 兼容新版本 JSON
                            elif isinstance(ref_path, dict):
                                if not ref_path.get('is_placeholder') and ref_path.get('file_path'):
                                    fname = os.path.basename(ref_path['file_path'])
                                    zip_ref_path = f"images/{fname}"

                                    if zip_ref_path in zf.namelist():
                                        with zf.open(zip_ref_path) as src, open(os.path.join(upload_root, fname),
                                                                                "wb") as dst:
                                            dst.write(src.read())
                                        ref_obj = ReferenceImage(
                                            file_path=f"/{web_folder}/{fname}",
                                            position=ref_path.get('position', 0)
                                        )
                                        img.refs.append(ref_obj)

                        db.session.add(img)
                        db.session.commit()
                        stats['processed'] += 1
                        yield "✅ OK\n"

                    except Exception as e:
                        db.session.rollback()
                        stats['errors'] += 1
                        yield f"❌ {str(e)}\n"

        except Exception as e:
            yield f"\n❌ ZIP 读取失败: {str(e)}\n"
        finally:
            # 清理临时上传文件
            if os.path.exists(zip_path): os.remove(zip_path)

        yield f"\n🎉 完成：成功 {stats['processed']}，跳过 {stats['skipped']}，错误 {stats['errors']}"