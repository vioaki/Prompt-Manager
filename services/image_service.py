import json
from flask import current_app
from sqlalchemy.orm import selectinload
from sqlalchemy.sql.expression import func
from extensions import db
from models import Image, Tag, ReferenceImage
from utils import process_image, remove_physical_file
from services.media_service import save_media


class ImageService:
    @staticmethod
    def build_query(category_filter=None, search_query='', tag_filter='', sort_by='date', show_sensitive=True):
        """构建画廊/模板/API 共用的已审核作品查询。

        预加载 tags 与 refs 以消除 to_dict()/模板遍历产生的 N+1 查询。
        """
        query = Image.query.options(
            selectinload(Image.tags),
            selectinload(Image.refs),
        ).filter_by(status='approved')

        if category_filter:
            query = query.filter_by(category=category_filter)

        if not show_sensitive:
            query = query.filter(~Image.tags.any(Tag.is_sensitive == True))

        if tag_filter:
            query = query.filter(Image.tags.any(name=tag_filter))

        if search_query:
            query = query.filter(
                Image.title.contains(search_query) |
                Image.prompt.contains(search_query) |
                Image.author.contains(search_query)
            )

        if sort_by == 'hot':
            query = query.order_by(Image.heat_score.desc(), Image.created_at.desc())
        elif sort_by == 'random':
            query = query.order_by(func.random())
        else:
            query = query.order_by(Image.created_at.desc())

        return query

    @staticmethod
    def create_image(file, data, ref_files=None, poster_file=None):
        """创建新作品记录"""
        upload_folder = current_app.config['UPLOAD_FOLDER']
        web_path, thumb_path, media_type = save_media(file, upload_folder, poster_file=poster_file)

        try:
            image = Image(
                title=data.get('title'),
                author=data.get('author', '').strip(),
                prompt=data.get('prompt'),
                description=data.get('description', '').strip(),
                type=data.get('type'),
                category=data.get('category', 'gallery'),
                file_path=web_path,
                thumbnail_path=thumb_path,
                media_type=media_type,
                status=data.get('status', 'pending')
            )

            if data.get('tags'):
                ImageService._apply_tags(image, data.get('tags'))

            db.session.add(image)
            db.session.flush()

            if image.type == 'img2img':
                # 处理参考图布局 (create时也可能包含占位符)
                ref_layout_str = data.get('ref_layout')
                if ref_layout_str:
                    ImageService._process_layout_refs(image, ref_layout_str, ref_files)
                elif ref_files:
                    ImageService._process_refs(image, ref_files, start_pos=0)

            db.session.commit()
            return image

        except Exception as e:
            db.session.rollback()
            remove_physical_file(web_path)
            remove_physical_file(thumb_path)
            raise e

    @staticmethod
    def update_image(image_id, data, new_main_file=None, new_ref_files=None, deleted_ref_ids=None, poster_file=None):
        """更新作品信息"""
        image = db.session.get(Image, image_id)
        if not image:
            raise ValueError("Image not found")

        # 基础信息
        image.title = data.get('title')
        image.author = data.get('author')
        image.prompt = data.get('prompt')
        image.description = data.get('description')
        image.type = data.get('type')
        image.category = data.get('category')
        image.status = data.get('status')

        upload_folder = current_app.config['UPLOAD_FOLDER']

        # 替换主图
        if new_main_file and new_main_file.filename:
            old_files = [image.file_path, image.thumbnail_path]
            web_path, thumb_path, media_type = save_media(new_main_file, upload_folder, poster_file=poster_file)
            image.file_path = web_path
            image.thumbnail_path = thumb_path
            image.media_type = media_type

            for p in old_files:
                remove_physical_file(p)

        # 更新标签
        if 'tags' in data:
            image.tags = []
            ImageService._apply_tags(image, data['tags'])

        # 删除参考图
        if deleted_ref_ids:
            for ref_id in deleted_ref_ids:
                if not ref_id: continue
                ref = db.session.get(ReferenceImage, int(ref_id))
                if ref and ref.image_id == image.id:
                    if ref.file_path:
                        remove_physical_file(ref.file_path)
                    db.session.delete(ref)
            db.session.flush()

        # 处理参考图布局
        ref_layout_str = data.get('ref_layout')
        if ref_layout_str:
            ImageService._process_layout_refs(image, ref_layout_str, new_ref_files)
        else:
            max_pos = db.session.query(db.func.max(ReferenceImage.position)).filter_by(image_id=image.id).scalar() or 0
            if new_ref_files:
                ImageService._process_refs(image, new_ref_files, start_pos=max_pos + 1)

        db.session.commit()
        return image

    @staticmethod
    def delete_image(image_id):
        """删除作品"""
        image = db.session.get(Image, image_id)
        if not image: return False

        files_to_remove = [image.file_path, image.thumbnail_path]
        for r in image.refs:
            if r.file_path:
                files_to_remove.append(r.file_path)

        tags = list(image.tags)

        db.session.delete(image)
        db.session.commit()

        for p in files_to_remove:
            remove_physical_file(p)

        ImageService._clean_orphaned_tags(tags)
        return True

    @staticmethod
    def _apply_tags(image, tags_str):
        if not tags_str: return
        tag_names = set(t.strip() for t in tags_str.replace('，', ',').split(',') if t.strip())
        for name in tag_names:
            tag = Tag.query.filter_by(name=name).first()
            if not tag:
                tag = Tag(name=name)
                db.session.add(tag)
            image.tags.append(tag)

    @staticmethod
    def _process_refs(image, files, start_pos=0):
        upload_folder = current_app.config['UPLOAD_FOLDER']
        for i, f in enumerate(files):
            if f.filename:
                try:
                    path, _ = process_image(f, upload_folder)
                    ref = ReferenceImage(image_id=image.id, file_path=path, position=start_pos + i,
                                         is_placeholder=False)
                    db.session.add(ref)
                except:
                    pass

    @staticmethod
    def _process_layout_refs(image, layout_str, new_files):
        """解析参考图布局，处理占位符和新文件"""
        try:
            layout = json.loads(layout_str)
            new_file_iter = iter(new_files or [])
            upload_folder = current_app.config['UPLOAD_FOLDER']

            for index, item_key in enumerate(layout):
                if item_key == 'new':
                    try:
                        f = next(new_file_iter)
                        if f and f.filename:
                            path, _ = process_image(f, upload_folder)
                            ref = ReferenceImage(image_id=image.id, file_path=path, position=index,
                                                 is_placeholder=False)
                            db.session.add(ref)
                    except StopIteration:
                        pass

                elif item_key == 'placeholder':
                    ref = ReferenceImage(image_id=image.id, file_path='', position=index, is_placeholder=True)
                    db.session.add(ref)

                elif item_key.startswith('existing:'):
                    ref_id = int(item_key.split(':')[1])
                    ref = db.session.get(ReferenceImage, ref_id)
                    if ref and ref.image_id == image.id:
                        ref.position = index
        except Exception as e:
            current_app.logger.error(f"Layout parse error: {e}")

    @staticmethod
    def _clean_orphaned_tags(tags):
        if not tags: return
        for tag in tags:
            try:
                t = db.session.get(Tag, tag.id)
                if t and not t.images:
                    db.session.delete(t)
            except:
                pass
        db.session.commit()