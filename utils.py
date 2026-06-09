import os
import uuid
import urllib.request
from PIL import Image as PilImage
from flask import current_app

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:
    boto3 = None

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
VIDEO_EXTENSIONS = {'.mp4', '.webm', '.ogg', '.mov', '.m4v'}
# 向后兼容别名
ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS

IMAGE_CONTENT_TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
}
VIDEO_CONTENT_TYPES = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v', '.ogg': 'video/ogg',
}

THUMB_SIZE = (400, 400)


def _resolve_upload_dir(upload_folder):
    """将配置的 upload_folder 解析为绝对目录并确保存在。"""
    if not os.path.isabs(upload_folder):
        full_dir = os.path.join(current_app.root_path, upload_folder)
    else:
        full_dir = upload_folder
    os.makedirs(full_dir, exist_ok=True)
    return full_dir


def _web_path(upload_folder, filename):
    """生成本地文件对外暴露的 web 路径。"""
    return f"/{upload_folder}/{filename}".replace('//', '/')


def _save_thumbnail_from_pil(img, thumb_abspath):
    """从已打开的 PIL Image 生成并保存 400x400 缩略图 (JPEG)。"""
    thumb = img.copy()
    if thumb.mode in ('RGBA', 'P'):
        thumb = thumb.convert('RGB')
    thumb.thumbnail(THUMB_SIZE)
    thumb.save(thumb_abspath, quality=90, optimize=True)


def _s3_domain():
    """读取并规范化 S3 访问域名，未配置时报错。"""
    domain = (current_app.config.get('S3_DOMAIN') or '').strip().rstrip('/')
    if not domain:
        raise RuntimeError("云存储模式需要配置 S3_DOMAIN")
    return domain


def get_config_value(key, default):
    """
    获取配置值，优先从 ConfigService 读取（热更新），fallback 到 app.config
    """
    try:
        from services.config_service import ConfigService
        if key == 'IMG_MAX_DIMENSION':
            return ConfigService.get_img_max_dimension()
        elif key == 'IMG_QUALITY':
            return ConfigService.get_img_quality()
        elif key == 'ENABLE_IMG_COMPRESS':
            return ConfigService.get_enable_img_compress()
        elif key == 'MAX_REF_IMAGES':
            return ConfigService.get_max_ref_images()
        elif key == 'ITEMS_PER_PAGE':
            return ConfigService.get_items_per_page()
        elif key == 'ADMIN_PER_PAGE':
            return ConfigService.get_admin_per_page()
        elif key == 'USE_THUMBNAIL_IN_PREVIEW':
            return ConfigService.get_use_thumbnail_in_preview()
        elif key == 'UPLOAD_RATE_LIMIT':
            return ConfigService.get_upload_rate_limit()
        elif key == 'LOGIN_RATE_LIMIT':
            return ConfigService.get_login_rate_limit()
    except Exception:
        pass
    return current_app.config.get(key, default)


def get_s3_client():
    """
    获取配置好的 S3 客户端。
    """
    if not boto3:
        raise ImportError("使用云存储功能需要安装 boto3 库: pip install boto3")

    return boto3.client(
        's3',
        endpoint_url=current_app.config.get('S3_ENDPOINT'),
        aws_access_key_id=current_app.config.get('S3_ACCESS_KEY'),
        aws_secret_access_key=current_app.config.get('S3_SECRET_KEY')
    )


def process_image(file_storage, upload_folder, ext=None):
    """
    处理上传图片：保存原图并生成缩略图，支持自动压缩和 GIF 处理。
    扩展名应由上游 (media_service) 校验；非图片扩展名会回退为 .jpg。
    返回 (web_original, web_thumb)。
    """
    filename_in = file_storage.filename
    ext = (ext or os.path.splitext(filename_in)[1].lower()) if (ext or filename_in) else ''
    if ext not in IMAGE_EXTENSIONS:
        ext = '.jpg'

    unique_name = uuid.uuid4().hex
    filename = f"{unique_name}{ext}"

    # === 分支 A：通用 S3 云存储模式 ===
    if current_app.config.get('STORAGE_TYPE') == 'cloud':
        try:
            s3 = get_s3_client()
            bucket_name = current_app.config.get('S3_BUCKET')
            domain = _s3_domain()

            content_type = file_storage.content_type or IMAGE_CONTENT_TYPES.get(ext, 'application/octet-stream')

            s3.upload_fileobj(
                file_storage,
                bucket_name,
                filename,
                ExtraArgs={'ContentType': content_type}
            )

            web_original = f"{domain}/{filename}"
            thumb_suffix = current_app.config.get('S3_THUMB_SUFFIX') or ''
            web_thumb = f"{web_original}{thumb_suffix}"
            return web_original, web_thumb

        except Exception as e:
            current_app.logger.error(f"S3 Upload Error: {e}")
            raise e

    # === 分支 B：本地文件存储模式 ===
    full_upload_dir = _resolve_upload_dir(upload_folder)
    file_abspath = os.path.join(full_upload_dir, filename)

    max_dim = get_config_value('IMG_MAX_DIMENSION', 1600)
    save_quality = get_config_value('IMG_QUALITY', 85)
    enable_compress = get_config_value('ENABLE_IMG_COMPRESS', True)

    try:
        img = PilImage.open(file_storage)

        # GIF 特殊处理：保留帧，原图即缩略图
        if img.format == 'GIF':
            img.save(file_abspath, save_all=True, optimize=True)
            web_path = _web_path(upload_folder, filename)
            return web_path, web_path

        thumb_filename = f"{unique_name}_thumb.jpg"
        thumb_abspath = os.path.join(full_upload_dir, thumb_filename)
        _save_thumbnail_from_pil(img, thumb_abspath)

        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')

        if enable_compress:
            if img.width > max_dim or img.height > max_dim:
                img.thumbnail((max_dim, max_dim), PilImage.Resampling.LANCZOS)
            img.save(file_abspath, quality=save_quality, optimize=True)
        else:
            img.save(file_abspath, quality=100, optimize=False)

        return _web_path(upload_folder, filename), _web_path(upload_folder, thumb_filename)

    except Exception as e:
        current_app.logger.error(f"Image processing error: {e}")
        raise e


def save_video(file_storage, upload_folder, ext, poster_file=None):
    """
    保存上传的视频：不经过 PIL，原样落地；可选地从 poster_file 生成封面缩略图。
    返回 (web_original, web_thumb|None)。
    """
    unique_name = uuid.uuid4().hex
    filename = f"{unique_name}{ext}"

    # === 分支 A：S3 云存储 ===
    if current_app.config.get('STORAGE_TYPE') == 'cloud':
        s3 = get_s3_client()
        bucket_name = current_app.config.get('S3_BUCKET')
        domain = _s3_domain()
        content_type = file_storage.content_type or VIDEO_CONTENT_TYPES.get(ext, 'application/octet-stream')
        s3.upload_fileobj(file_storage, bucket_name, filename, ExtraArgs={'ContentType': content_type})
        web_original = f"{domain}/{filename}"

        web_thumb = None
        if poster_file and getattr(poster_file, 'filename', ''):
            try:
                thumb_name = f"{unique_name}_thumb.jpg"
                poster_img = PilImage.open(poster_file)
                if poster_img.mode in ('RGBA', 'P'):
                    poster_img = poster_img.convert('RGB')
                poster_img.thumbnail(THUMB_SIZE)
                import io
                buf = io.BytesIO()
                poster_img.save(buf, format='JPEG', quality=90, optimize=True)
                buf.seek(0)
                s3.upload_fileobj(buf, bucket_name, thumb_name, ExtraArgs={'ContentType': 'image/jpeg'})
                web_thumb = f"{domain}/{thumb_name}"
            except Exception as e:
                current_app.logger.error(f"Video poster (S3) error: {e}")
                web_thumb = None
        return web_original, web_thumb

    # === 分支 B：本地存储 ===
    full_upload_dir = _resolve_upload_dir(upload_folder)
    file_storage.save(os.path.join(full_upload_dir, filename))
    web_original = _web_path(upload_folder, filename)

    web_thumb = None
    if poster_file and getattr(poster_file, 'filename', ''):
        try:
            thumb_filename = f"{unique_name}_thumb.jpg"
            thumb_abspath = os.path.join(full_upload_dir, thumb_filename)
            poster_img = PilImage.open(poster_file)
            _save_thumbnail_from_pil(poster_img, thumb_abspath)
            web_thumb = _web_path(upload_folder, thumb_filename)
        except Exception as e:
            current_app.logger.error(f"Video poster error: {e}")
            web_thumb = None

    return web_original, web_thumb


def remove_physical_file(web_path):
    """
    安全删除物理文件或云端对象。
    """
    if not web_path:
        return

    # === 分支 A：删除云端对象 ===
    # 判断依据：URL 以 http 开头 且 当前模式为 cloud
    if current_app.config.get('STORAGE_TYPE') == 'cloud' and web_path.startswith(('http://', 'https://')):
        try:
            # 从 URL 中提取文件名 (Key)
            # 需要去除可能存在的 URL 参数 (如缩略图后缀)
            filename = web_path.split('?')[0].split('/')[-1]
            
            s3 = get_s3_client()
            bucket_name = current_app.config.get('S3_BUCKET')
            
            s3.delete_object(Bucket=bucket_name, Key=filename)
            current_app.logger.info(f"Deleted S3 object: {filename}")
            return
        except Exception as e:
            current_app.logger.error(f"S3 Deletion Error ({web_path}): {e}")
            return

    # === 分支 B：删除本地文件 ===
    try:
        # 防御性编程：如果是云端 URL，不进行本地删除尝试
        if web_path.startswith(('http://', 'https://')):
            return

        clean_path = web_path.lstrip('/')
        root = os.path.realpath(current_app.root_path)
        full_path = os.path.realpath(os.path.join(root, clean_path))

        # 路径穿越防护：解析后的绝对路径必须仍在项目根目录内
        if not (full_path == root or full_path.startswith(root + os.sep)):
            current_app.logger.warning(f"Refused to delete out-of-root path: {web_path}")
            return

        if os.path.exists(full_path):
            os.remove(full_path)
    except Exception as e:
        current_app.logger.error(f"File deletion error: {e}")


def ensure_local_resources(app):
    """
    检查并下载必要的静态资源 (Bootstrap, Icons 等)，
    实现内网或离线环境部署。
    """
    if not app.config.get('USE_LOCAL_RESOURCES'):
        return

    static_root = app.static_folder

    # 资源映射表
    resources = {
        'css/bootstrap.min.css': 'https://cdn.bootcdn.net/ajax/libs/twitter-bootstrap/5.3.0/css/bootstrap.min.css',
        'css/nprogress.min.css': 'https://cdn.bootcdn.net/ajax/libs/nprogress/0.2.0/nprogress.min.css',
        'css/bootstrap-icons.min.css': 'https://cdn.bootcdn.net/ajax/libs/bootstrap-icons/1.10.5/font/bootstrap-icons.min.css',
        'js/bootstrap.bundle.min.js': 'https://cdn.bootcdn.net/ajax/libs/twitter-bootstrap/5.3.0/js/bootstrap.bundle.min.js',
        'js/nprogress.min.js': 'https://cdn.bootcdn.net/ajax/libs/nprogress/0.2.0/nprogress.min.js',
        'js/Sortable.min.js': 'https://cdn.bootcdn.net/ajax/libs/Sortable/1.15.0/Sortable.min.js',
        'css/fonts/bootstrap-icons.woff2': 'https://cdn.bootcdn.net/ajax/libs/bootstrap-icons/1.10.5/font/fonts/bootstrap-icons.woff2',
        'css/fonts/bootstrap-icons.woff': 'https://cdn.bootcdn.net/ajax/libs/bootstrap-icons/1.10.5/font/fonts/bootstrap-icons.woff',
    }

    opener = urllib.request.build_opener()
    opener.addheaders = [('User-Agent', 'Mozilla/5.0')]
    urllib.request.install_opener(opener)

    for relative_path, url in resources.items():
        local_path = os.path.join(static_root, relative_path)
        os.makedirs(os.path.dirname(local_path), exist_ok=True)

        if not os.path.exists(local_path):
            try:
                print(f"Downloading resource: {relative_path}")
                urllib.request.urlretrieve(url, local_path)
            except Exception as e:
                print(f"Failed to download {relative_path}: {e}")