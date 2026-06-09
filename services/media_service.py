"""媒体上传编排层：区分图片/视频，做扩展名与体积校验，委托 utils 落地存储。"""
import os

from flask import current_app

from utils import (
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    process_image,
    save_video,
)

ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS


def detect_media_type(ext):
    """根据扩展名返回媒体类型：'gif' / 'video' / 'image'。"""
    ext = (ext or '').lower()
    if ext == '.gif':
        return 'gif'
    if ext in VIDEO_EXTENSIONS:
        return 'video'
    return 'image'


def infer_media_type(file_path):
    """根据已存储路径推断媒体类型，供历史数据回填与序列化使用。"""
    if not file_path:
        return 'image'
    # 去除可能存在的 URL 查询参数 (如 S3 缩略图后缀)
    clean = file_path.split('?')[0]
    return detect_media_type(os.path.splitext(clean)[1])


def _validate(file_storage):
    """校验扩展名与文件大小，返回规范化的小写扩展名。非法时抛 ValueError。"""
    filename = file_storage.filename or ''
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"不支持的文件类型: {ext or '未知'}")

    media_type = detect_media_type(ext)
    if media_type == 'video':
        limit_mb = current_app.config.get('MAX_VIDEO_SIZE_MB', 200)
    else:
        limit_mb = current_app.config.get('MAX_IMAGE_SIZE_MB', 20)

    size = _file_size(file_storage)
    if size is not None and size > limit_mb * 1024 * 1024:
        raise ValueError(f"文件过大，上限为 {limit_mb}MB")

    return ext, media_type


def _file_size(file_storage):
    """获取上传文件大小 (字节)，无法定位时返回 None。读取后复位游标。"""
    stream = file_storage.stream
    try:
        pos = stream.tell()
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(pos)
        return size
    except (OSError, ValueError):
        return None


def save_media(file_storage, upload_folder, poster_file=None):
    """
    保存上传的主媒体文件。
    返回 (web_path, thumbnail_path|None, media_type)。
    非法扩展名或超体积会抛 ValueError，由调用方转为用户友好的响应。
    """
    ext, media_type = _validate(file_storage)

    if media_type == 'video':
        web_path, thumb_path = save_video(file_storage, upload_folder, ext, poster_file=poster_file)
    else:
        web_path, thumb_path = process_image(file_storage, upload_folder, ext=ext)

    return web_path, thumb_path, media_type
