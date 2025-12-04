import os
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))

instance_path = os.path.join(basedir, 'instance')
if not os.path.exists(instance_path):
    os.makedirs(instance_path)

class Config:
    """应用全局配置"""
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-key-please-change-in-prod'

    # 数据库配置
    # 将默认数据库路径指向 instance/data.sqlite
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL') or \
                              'sqlite:///' + os.path.join(instance_path, 'data.sqlite')
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # 文件上传配置
    UPLOAD_FOLDER = os.environ.get('UPLOAD_FOLDER') or 'static/uploads'
    MAX_REF_IMAGES = int(os.environ.get('MAX_REF_IMAGES') or 10)

    # 安全限流
    UPLOAD_RATE_LIMIT = os.environ.get('UPLOAD_RATE_LIMIT') or '100 per hour'
    LOGIN_RATE_LIMIT = os.environ.get('LOGIN_RATE_LIMIT') or '10 per minute'

    # 管理员账户
    ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME') or 'admin'
    ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD') or '123456'

    # 分页设置
    ITEMS_PER_PAGE = int(os.environ.get('ITEMS_PER_PAGE') or 24)
    ADMIN_PER_PAGE = int(os.environ.get('ADMIN_PER_PAGE') or 12)

    # 图片处理参数 (本地模式用)
    IMG_MAX_DIMENSION = int(os.environ.get('IMG_MAX_DIMENSION') or 1600)
    IMG_QUALITY = int(os.environ.get('IMG_QUALITY') or 85)

    @staticmethod
    def _str_to_bool(s):
        return str(s).lower() == 'true'

    ENABLE_IMG_COMPRESS = _str_to_bool(os.environ.get('ENABLE_IMG_COMPRESS', 'True'))
    USE_THUMBNAIL_IN_PREVIEW = _str_to_bool(os.environ.get('USE_THUMBNAIL_IN_PREVIEW', 'True'))

    # 本地化资源开关
    USE_LOCAL_RESOURCES = _str_to_bool(os.environ.get('USE_LOCAL_RESOURCES', 'True'))

    # 访客权限控制
    ALLOW_PUBLIC_SENSITIVE_TOGGLE = True

    # --- 存储配置 (通用 S3 支持) ---
    # 存储模式: local 或 cloud
    STORAGE_TYPE = os.environ.get('STORAGE_TYPE') or 'local'

    # S3 配置
    S3_ENDPOINT = os.environ.get('S3_ENDPOINT')
    S3_ACCESS_KEY = os.environ.get('S3_ACCESS_KEY')
    S3_SECRET_KEY = os.environ.get('S3_SECRET_KEY')
    S3_BUCKET = os.environ.get('S3_BUCKET')
    S3_DOMAIN = os.environ.get('S3_DOMAIN')

    # 云端缩略图处理后缀
    S3_THUMB_SUFFIX = os.environ.get('S3_THUMB_SUFFIX') or ''