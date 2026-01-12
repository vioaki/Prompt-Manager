import os
import secrets
from urllib.parse import quote_plus
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, '.env'))

instance_path = os.path.join(basedir, 'instance')
if not os.path.exists(instance_path):
    os.makedirs(instance_path)


def str_to_bool(s):
    return str(s).lower() == 'true'


def get_or_create_secret_key():
    """
    获取或自动生成 SECRET_KEY
    优先级: 环境变量 > 持久化文件 > 自动生成并保存
    """
    # 1. 优先使用环境变量
    env_key = os.environ.get('SECRET_KEY')
    if env_key and env_key != 'dev-key-please-change-in-prod':
        return env_key

    # 2. 尝试从持久化文件读取
    secret_file = os.path.join(instance_path, '.secret_key')
    if os.path.exists(secret_file):
        with open(secret_file, 'r') as f:
            return f.read().strip()

    # 3. 自动生成并保存
    new_key = secrets.token_hex(32)
    with open(secret_file, 'w') as f:
        f.write(new_key)
    print("[Config] 已自动生成 SECRET_KEY 并保存到 instance/.secret_key")
    return new_key


class Config:
    """应用全局配置"""
    SECRET_KEY = get_or_create_secret_key()

    # =========================================================
    # 数据库智能配置逻辑
    # =========================================================
    db_type = os.environ.get('DB_TYPE', 'sqlite').lower()

    # 读取通用配置
    db_user = os.environ.get('DB_USER', 'root')
    db_pass = os.environ.get('DB_PASSWORD', '')
    db_host = os.environ.get('DB_HOST', '127.0.0.1')
    db_name = os.environ.get('DB_NAME', 'promptmanager')

    if db_type == 'mysql':
        # === MySQL 模式 ===
        db_port = os.environ.get('DB_PORT', '3306')
        
        # 使用 mysql+pymysql 协议，兼容 Windows
        # 自动处理密码特殊字符
        if db_pass:
            encoded_pass = quote_plus(db_pass)
            SQLALCHEMY_DATABASE_URI = f"mysql+pymysql://{db_user}:{encoded_pass}@{db_host}:{db_port}/{db_name}?charset=utf8mb4"
        else:
            SQLALCHEMY_DATABASE_URI = f"mysql+pymysql://{db_user}@{db_host}:{db_port}/{db_name}?charset=utf8mb4"
            
        print(f"[Config] 已启用 MySQL (PyMySQL): {db_host}:{db_port}/{db_name}")

    elif db_type == 'postgresql':
        # === PostgreSQL 模式 ===
        db_port = os.environ.get('DB_PORT', '5432')
        if db_pass:
            encoded_pass = quote_plus(db_pass)
            SQLALCHEMY_DATABASE_URI = f"postgresql://{db_user}:{encoded_pass}@{db_host}:{db_port}/{db_name}"
        else:
            SQLALCHEMY_DATABASE_URI = f"postgresql://{db_user}@{db_host}:{db_port}/{db_name}"

        print(f"[Config] 已启用 PostgreSQL 数据库: {db_host}:{db_port}/{db_name}")

    else:
        # === SQLite 模式 ===
        env_sqlite_path = os.environ.get('SQLITE_PATH')
        default_sqlite_path = os.path.join(instance_path, 'data.sqlite')
        
        if env_sqlite_path:
            SQLALCHEMY_DATABASE_URI = f'sqlite:///{env_sqlite_path}'
        else:
            SQLALCHEMY_DATABASE_URI = f'sqlite:///{default_sqlite_path}'
        print(f"[Config] 使用 SQLite: {SQLALCHEMY_DATABASE_URI}")

    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # =========================================================
    # 其他配置
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

    ENABLE_IMG_COMPRESS = str_to_bool(os.environ.get('ENABLE_IMG_COMPRESS', 'True'))
    USE_THUMBNAIL_IN_PREVIEW = str_to_bool(os.environ.get('USE_THUMBNAIL_IN_PREVIEW', 'True'))
    USE_LOCAL_RESOURCES = str_to_bool(os.environ.get('USE_LOCAL_RESOURCES', 'True'))
    ALLOW_PUBLIC_SENSITIVE_TOGGLE = str_to_bool(os.environ.get('ALLOW_PUBLIC_SENSITIVE_TOGGLE', 'True'))

    STORAGE_TYPE = os.environ.get('STORAGE_TYPE') or 'local'
    S3_ENDPOINT = os.environ.get('S3_ENDPOINT')
    S3_ACCESS_KEY = os.environ.get('S3_ACCESS_KEY')
    S3_SECRET_KEY = os.environ.get('S3_SECRET_KEY')
    S3_BUCKET = os.environ.get('S3_BUCKET')
    S3_DOMAIN = os.environ.get('S3_DOMAIN')
    S3_THUMB_SUFFIX = os.environ.get('S3_THUMB_SUFFIX') or ''
