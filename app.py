import os
import logging
from logging.handlers import RotatingFileHandler
from flask import Flask, render_template, request, jsonify
from werkzeug.security import generate_password_hash
from flask_login import current_user
from PIL import Image as PilImage

from config import Config
from extensions import db, login_manager, csrf, migrate, limiter
from models import User
from utils import ensure_local_resources


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    # 修复 Flask 3.0+ JSON 中文显示
    app.json.ensure_ascii = False

    # Pillow 解压炸弹防护：限制单张图片最大像素数
    PilImage.MAX_IMAGE_PIXELS = app.config.get('MAX_IMAGE_PIXELS')

    # 初始化扩展
    db.init_app(app)
    login_manager.init_app(app)
    csrf.init_app(app)
    migrate.init_app(app, db)
    limiter.init_app(app)

    # 注册蓝图
    from blueprints.public import bp as public_bp
    from blueprints.auth import bp as auth_bp
    from blueprints.admin import bp as admin_bp

    app.register_blueprint(public_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)

    # 检查静态资源
    with app.app_context():
        ensure_local_resources(app)

    # 配置登录
    login_manager.login_view = 'auth.login'

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, int(user_id))

    # 全局模版变量
    @app.context_processor
    def inject_global_vars():
        return dict(
            current_user=current_user,
            config=app.config
        )

    # 配置日志与错误处理
    configure_logging(app)
    register_error_handlers(app)
    register_commands(app)

    return app


def configure_logging(app):
    if not app.debug and not app.testing:
        if not os.path.exists('logs'):
            os.mkdir('logs')
        file_handler = RotatingFileHandler('logs/prompt_manager.log', maxBytes=10240, backupCount=10)
        file_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s: %(message)s'))
        file_handler.setLevel(logging.INFO)
        app.logger.addHandler(file_handler)
        app.logger.setLevel(logging.INFO)
        app.logger.info('Prompt Manager startup')


def register_error_handlers(app):
    @app.errorhandler(404)
    def page_not_found(e):
        return render_template('404.html'), 404

    @app.errorhandler(413)
    def request_entity_too_large(e):
        if request.path.startswith('/api/'):
            return jsonify({'code': 413, 'message': '上传内容过大', 'data': None}), 413
        return render_template('413.html'), 413

    @app.errorhandler(500)
    def internal_server_error(e):
        return render_template('500.html'), 500


def register_commands(app):
    @app.cli.command("init-db")
    def init_db_command():
        """初始化数据库和管理员账户"""
        db.create_all()
        admin_user = app.config['ADMIN_USERNAME']
        admin_pass = app.config['ADMIN_PASSWORD']

        if not User.query.filter_by(username=admin_user).first():
            admin = User(username=admin_user, password_hash=generate_password_hash(admin_pass))
            db.session.add(admin)
            db.session.commit()
            print(f"✅ 管理员创建成功: {admin_user}")
        else:
            print(f"ℹ️ 管理员 {admin_user} 已存在")

    @app.cli.command("backfill-media-type")
    def backfill_media_type_command():
        """根据 file_path 回填历史作品的 media_type 字段"""
        from models import Image
        from services.media_service import infer_media_type

        updated = 0
        for image in Image.query.all():
            correct = infer_media_type(image.file_path)
            if image.media_type != correct:
                image.media_type = correct
                updated += 1
        db.session.commit()
        print(f"✅ 已回填 {updated} 条记录的 media_type")


app = create_app()

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(host='0.0.0.0', port=5000)