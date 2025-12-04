import os
import time
from sqlalchemy import inspect
from werkzeug.security import generate_password_hash
from flask_migrate import migrate, upgrade, init, stamp

# 引入你的应用组件
from app import create_app, db
from models import User

# 创建应用上下文
app = create_app()


def ensure_admin_user():
    """
    [幂等性] 检查并创建管理员账户，确保系统初始化后立即可用。
    """
    admin_username = app.config.get('ADMIN_USERNAME', 'admin')

    # 尝试查询，如果表不存在（极端情况）则跳过
    try:
        user = User.query.filter_by(username=admin_username).first()
    except Exception:
        return

    if not user:
        print(f"👤 [System] 正在创建管理员账户: {admin_username} ...")
        admin_password = app.config.get('ADMIN_PASSWORD', '123456')
        admin = User(username=admin_username, password_hash=generate_password_hash(admin_password))
        db.session.add(admin)
        db.session.commit()
        print("✅ 管理员账户创建成功！")
    else:
        print(f"✅ 管理员账户 '{admin_username}' 已存在。")


def sync_database():
    """
    [核心逻辑] 智能数据库同步工具
    """
    print("=" * 60)
    print("🛠️  Prompt Manager 智能数据库同步工具 (Smart Sync)")
    print("=" * 60)

    with app.app_context():
        # 1. 检查数据库连接与表状态
        inspector = inspect(db.engine)
        existing_tables = inspector.get_table_names()
        db_path = str(db.engine.url)

        print(f"📂 数据库目标: {db_path}")

        # 2. 初始化迁移仓库 (如果不存在)
        if not os.path.exists('migrations'):
            print("📦 检测到全新环境，正在初始化 migrations 文件夹...")
            init()

        # 3. 处理“既有表但无版本号”的情况
        # 如果表存在（如 user），但没有 alembic_version，说明是以前用 db.create_all 创建的
        if 'user' in existing_tables and 'alembic_version' not in existing_tables:
            print("⚠️  检测到现有数据库表，但缺少迁移记录。")
            print("🏷️  正在标记数据库为最新版本 (Stamping head)...")
            stamp()

        # 4. 执行迁移 (生成脚本 -> 应用变更)
        print("🔍 正在扫描模型变动 (Auto Migrate)...")

        # 使用时间戳防止迁移脚本文件名冲突
        migration_message = f"auto_update_{int(time.time())}"

        try:
            # 尝试生成迁移脚本
            # rev_id=None 让 alembic 自动生成 ID
            migrate(message=migration_message)
        except Exception as e:
            # 如果没有变动，Alembic 可能会抛出异常或仅打印日志，这里捕获以防脚本中断
            print(f"ℹ️  生成迁移脚本提示: {e}")

        try:
            print("🚀 正在应用数据库变更 (Upgrade)...")
            upgrade()
            print("✅ 数据库结构已同步至最新。")
        except Exception as e:
            print(f"❌ 升级过程中发生错误: {e}")
            print("提示: 如果是'No changes detected'，则说明数据库已是最新，可忽略。")

        # 5. 确保种子数据 (管理员)
        ensure_admin_user()

    print("\n🎉 所有操作完成！系统已就绪。")


if __name__ == '__main__':
    try:
        sync_database()
    except KeyboardInterrupt:
        print("\n🚫 操作已取消。")
    except Exception as e:
        print(f"\n❌ 发生未预期的错误: {e}")