import os
from urllib.parse import quote_plus
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))

instance_path = os.path.join(basedir, 'instance')
if not os.path.exists(instance_path):
    os.makedirs(instance_path)

class Config:
    """应用全局配置"""
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-key-please-change-in-prod'

    # =========================================================
    # 数据库智能配置逻辑 (支持 MySQL / PostgreSQL / SQLite)
    # =========================================================
    db_type = os.environ.get('DB_TYPE', 'sqlite').lower()

    # 通用数据库配置读取 (仅当非 SQLite 时使用)
    db_user = os.environ.get('DB_USER', 'root')
    db_pass = os.environ.get('DB_PASSWORD', '')
    db_host = os.environ.get('DB_HOST', '127.0.0.1')
    db_name = os.environ.get('DB_NAME', 'promptmanager')

    if db_type == 'mysql':
        # === MySQL 模式 ===
        db_port = os.environ.get('DB_PORT', '3306') # MySQL 默认端口
        
        if db_pass:
            encoded_pass = quote_plus(db_pass)
            SQLALCHEMY_DATABASE_URI = f"mysql://{db_user}:{encoded_pass}@{db_host}:{db_port}/{db_name}"
        else:
            SQLALCHEMY_DATABASE_URI = f"mysql://{db_user}@{db_host}:{db_port}/{db_name}"
            
        print(f"🔌 [Config] 已启用 MySQL 数据库: {db_host}:{db_port}/{db_name}")

    elif db_type == 'postgresql':
        # === PostgreSQL 模式 ===
        db_port = os.environ.get('DB_PORT', '5432') # PG 默认端口
        if db_pass:
            encoded_pass = quote_plus(db_pass)
            SQLALCHEMY_DATABASE_URI = f"postgresql://{db_user}:{encoded_pass}@{db_host}:{db_port}/{db_name}"
        else:
            SQLALCHEMY_DATABASE_URI = f"postgresql://{db_user}@{db_host}:{db_port}/{db_name}"

        print(f"🐘 [Config] 已启用 PostgreSQL 数据库: {db_host}:{db_port}/{db_name}")

    else:
        # === SQLite 模式 (默认) ===
        env_sqlite_path = os.environ.get('SQLITE_PATH')
        
        if env_sqlite_path:
            SQLALCHEMY_DATABASE_URI = f'sqlite:///{env_sqlite_path}'
            print(f"mn [Config] 使用自定义 SQLite 路径: {env_sqlite_path}")
        else:
            default_sqlite_path = os.path.join(instance_path, 'data.sqlite')
            SQLALCHEMY_DATABASE_URI = f'sqlite:///{default_sqlite_path}'
            print(f"mn [Config] 使用默认 SQLite 路径: {default_sqlite_path}")

    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # =========================================================
    # 其他应用配置
    # =========================================================
    
    UPLOAD_FOLDER = os.environ.get('UPLOAD_FOLDER') or 'static/uploads'
    MAX_REF_IMAGES = int(os.environ.get('MAX_REF_IMAGES') or 10)

    UPLOAD_RATE_LIMIT = os.environ.get('UPLOAD_RATE_LIMIT') or '100 per hour'
    LOGIN_RATE_LIMIT = os.environ.get('LOGIN_RATE_LIMIT') or '10 per minute'

    ADMIN_USERNAME = os.environ.get('ADMIN_USERNAME') or 'admin'
    ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD') or '123456'

    ITEMS_PER_PAGE = int(os.environ.get('ITEMS_PER_PAGE') or 24)
    ADMIN_PER_PAGE = int(os.environ.get('ADMIN_PER_PAGE') or 12)

    IMG_MAX_DIMENSION = int(os.environ.get('IMG_MAX_DIMENSION') or 1600)
    IMG_QUALITY = int(os.environ.get('IMG_QUALITY') or 85)

    @staticmethod
    def _str_to_bool(s):
        return str(s).lower() == 'true'

    ENABLE_IMG_COMPRESS = _str_to_bool(os.environ.get('ENABLE_IMG_COMPRESS', 'True'))
    USE_THUMBNAIL_IN_PREVIEW = _str_to_bool(os.environ.get('USE_THUMBNAIL_IN_PREVIEW', 'True'))
    USE_LOCAL_RESOURCES = _str_to_bool(os.environ.get('USE_LOCAL_RESOURCES', 'True'))
    ALLOW_PUBLIC_SENSITIVE_TOGGLE = True

    STORAGE_TYPE = os.environ.get('STORAGE_TYPE') or 'local'
    S3_ENDPOINT = os.environ.get('S3_ENDPOINT')
    S3_ACCESS_KEY = os.environ.get('S3_ACCESS_KEY')
    S3_SECRET_KEY = os.environ.get('S3_SECRET_KEY')
    S3_BUCKET = os.environ.get('S3_BUCKET')
    S3_DOMAIN = os.environ.get('S3_DOMAIN')
    S3_THUMB_SUFFIX = os.environ.get('S3_THUMB_SUFFIX') or ''
