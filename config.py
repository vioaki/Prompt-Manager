import os
from urllib.parse import quote_plus, urlparse, urlunparse
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))

instance_path = os.path.join(basedir, 'instance')
if not os.path.exists(instance_path):
    os.makedirs(instance_path)

class Config:
    """应用全局配置"""
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-key-please-change-in-prod'

    # --- 数据库配置 (自动修复特殊字符密码) ---
    _db_url = os.environ.get('DATABASE_URL')
    
    if _db_url and _db_url.startswith('mysql'):
        try:
            # 1. 解析原始 URL
            # 格式通常是: mysql://user:password@host:port/dbname
            # 注意：如果密码含特殊字符，直接 urlparse 可能会解析错误，
            # 所以这里我们采用更稳妥的手动替换方式，或者假设用户在 .env 里填的是未编码的密码
            
            # 方案：我们不直接使用 .env 里的完整 URL，而是建议你在 .env 里拆分配置
            # 但为了兼容你当前的写法，我们尝试一种通用的修复逻辑：
            
            # 如果你的 .env 里是完整的 URL (mysql://root:密码@...)
            # 且密码里有 @ 等符号，urlparse 会直接报错或解析错。
            # 最稳妥的办法是：不要在 .env 里写完整的 URL，而是写各个字段。
            
            # --- 紧急修复逻辑 ---
            # 既然你现在 .env 里已经是完整的 URL 且报错了，
            # 我们在这里无法直接解析那个错误的 URL 字符串。
            # 你必须修改 .env 文件，或者在这里硬编码修复。
            
            # 为了彻底解决你的问题，我建议你采用下面的逻辑：
            # 优先读取单独的 DB 配置，如果没有，再尝试读取 DATABASE_URL
            
            db_user = os.environ.get('DB_USER', 'root')
            db_pass = os.environ.get('DB_PASSWORD') # 读取单独的密码字段
            db_host = os.environ.get('DB_HOST', '127.0.0.1')
            db_port = os.environ.get('DB_PORT', '3306')
            db_name = os.environ.get('DB_NAME', 'promptmanager')
            
            if db_pass:
                # 如果环境变量里配置了 DB_PASSWORD，我们优先使用这种安全方式构建 URL
                encoded_pass = quote_plus(db_pass)
                SQLALCHEMY_DATABASE_URI = f"mysql://{db_user}:{encoded_pass}@{db_host}:{db_port}/{db_name}"
            else:
                # 如果没有单独配置密码，只能使用原有的 DATABASE_URL
                # 但注意：如果 DATABASE_URL 里包含未转义的特殊字符，这里依然会报错
                SQLALCHEMY_DATABASE_URI = _db_url
                
        except Exception as e:
            print(f"⚠️ 数据库 URL 解析警告: {e}")
            SQLALCHEMY_DATABASE_URI = _db_url
    else:
        # 默认 SQLite
        SQLALCHEMY_DATABASE_URI = _db_url or \
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
