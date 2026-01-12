"""
配置服务模块

提供统一的配置读取接口，优先从数据库读取，fallback 到 .env 配置。
区分热更新配置和需要重启的配置。
"""

from flask import current_app
from models import SystemSetting


class ConfigService:
    """
    配置服务类

    热更新配置 (存储在数据库):
    - 审核设置: approval_gallery, approval_template, allow_sensitive_toggle
    - 上传设置: img_max_dimension, img_quality, enable_img_compress, max_ref_images
    - 显示设置: items_per_page, admin_per_page, use_thumbnail_in_preview
    - 限流设置: upload_rate_limit, login_rate_limit

    需重启配置 (仅从 .env 读取):
    - 数据库连接: DB_TYPE, DB_HOST, etc.
    - 存储配置: STORAGE_TYPE, S3_*
    - 密钥: SECRET_KEY
    """

    # ==================== 热更新配置 ====================

    @staticmethod
    def get_img_max_dimension():
        """获取图片最大尺寸 (热更新)"""
        val = SystemSetting.get_int('img_max_dimension', default=0)
        if val > 0:
            return val
        return current_app.config.get('IMG_MAX_DIMENSION', 1600)

    @staticmethod
    def set_img_max_dimension(value):
        """设置图片最大尺寸"""
        SystemSetting.set_int('img_max_dimension', value)

    @staticmethod
    def get_img_quality():
        """获取图片压缩质量 (热更新)"""
        val = SystemSetting.get_int('img_quality', default=0)
        if val > 0:
            return val
        return current_app.config.get('IMG_QUALITY', 85)

    @staticmethod
    def set_img_quality(value):
        """设置图片压缩质量"""
        SystemSetting.set_int('img_quality', max(1, min(100, value)))

    @staticmethod
    def get_enable_img_compress():
        """获取是否启用图片压缩 (热更新)"""
        db_val = SystemSetting.get_str('enable_img_compress', default='')
        if db_val:
            return db_val == '1'
        return current_app.config.get('ENABLE_IMG_COMPRESS', True)

    @staticmethod
    def set_enable_img_compress(value):
        """设置是否启用图片压缩"""
        SystemSetting.set_bool('enable_img_compress', value)

    @staticmethod
    def get_max_ref_images():
        """获取最大参考图数量 (热更新)"""
        val = SystemSetting.get_int('max_ref_images', default=0)
        if val > 0:
            return val
        return current_app.config.get('MAX_REF_IMAGES', 10)

    @staticmethod
    def set_max_ref_images(value):
        """设置最大参考图数量"""
        SystemSetting.set_int('max_ref_images', max(1, value))

    @staticmethod
    def get_items_per_page():
        """获取首页每页数量 (热更新)"""
        val = SystemSetting.get_int('items_per_page', default=0)
        if val > 0:
            return val
        return current_app.config.get('ITEMS_PER_PAGE', 24)

    @staticmethod
    def set_items_per_page(value):
        """设置首页每页数量"""
        SystemSetting.set_int('items_per_page', max(1, value))

    @staticmethod
    def get_admin_per_page():
        """获取后台每页数量 (热更新)"""
        val = SystemSetting.get_int('admin_per_page', default=0)
        if val > 0:
            return val
        return current_app.config.get('ADMIN_PER_PAGE', 12)

    @staticmethod
    def set_admin_per_page(value):
        """设置后台每页数量"""
        SystemSetting.set_int('admin_per_page', max(1, value))

    @staticmethod
    def get_use_thumbnail_in_preview():
        """获取是否使用缩略图预览 (热更新)"""
        db_val = SystemSetting.get_str('use_thumbnail_in_preview', default='')
        if db_val:
            return db_val == '1'
        return current_app.config.get('USE_THUMBNAIL_IN_PREVIEW', True)

    @staticmethod
    def set_use_thumbnail_in_preview(value):
        """设置是否使用缩略图预览"""
        SystemSetting.set_bool('use_thumbnail_in_preview', value)

    @staticmethod
    def get_upload_rate_limit():
        """获取上传限流配置 (热更新)"""
        val = SystemSetting.get_str('upload_rate_limit', default='')
        if val:
            return val
        return current_app.config.get('UPLOAD_RATE_LIMIT', '100 per hour')

    @staticmethod
    def set_upload_rate_limit(value):
        """设置上传限流配置"""
        SystemSetting.set_str('upload_rate_limit', value)

    @staticmethod
    def get_login_rate_limit():
        """获取登录限流配置 (热更新)"""
        val = SystemSetting.get_str('login_rate_limit', default='')
        if val:
            return val
        return current_app.config.get('LOGIN_RATE_LIMIT', '10 per minute')

    @staticmethod
    def set_login_rate_limit(value):
        """设置登录限流配置"""
        SystemSetting.set_str('login_rate_limit', value)

    # ==================== 批量获取配置 ====================

    @staticmethod
    def get_upload_settings():
        """获取所有上传相关配置"""
        return {
            'img_max_dimension': ConfigService.get_img_max_dimension(),
            'img_quality': ConfigService.get_img_quality(),
            'enable_img_compress': ConfigService.get_enable_img_compress(),
            'max_ref_images': ConfigService.get_max_ref_images(),
        }

    @staticmethod
    def get_display_settings():
        """获取所有显示相关配置"""
        return {
            'items_per_page': ConfigService.get_items_per_page(),
            'admin_per_page': ConfigService.get_admin_per_page(),
            'use_thumbnail_in_preview': ConfigService.get_use_thumbnail_in_preview(),
        }

    @staticmethod
    def get_rate_limit_settings():
        """获取所有限流相关配置"""
        return {
            'upload_rate_limit': ConfigService.get_upload_rate_limit(),
            'login_rate_limit': ConfigService.get_login_rate_limit(),
        }

    # ==================== 需重启配置 (只读) ====================

    @staticmethod
    def get_readonly_settings():
        """获取需要重启才能生效的配置 (只读展示)"""
        return {
            'storage_type': current_app.config.get('STORAGE_TYPE', 'local'),
            'db_type': current_app.config.get('SQLALCHEMY_DATABASE_URI', '').split(':')[0] if current_app.config.get('SQLALCHEMY_DATABASE_URI') else 'sqlite',
            'upload_folder': current_app.config.get('UPLOAD_FOLDER', 'static/uploads'),
            'use_local_resources': current_app.config.get('USE_LOCAL_RESOURCES', True),
        }
