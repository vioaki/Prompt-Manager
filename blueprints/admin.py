from flask import Blueprint, render_template, request, redirect, url_for, flash, current_app, Response, \
    stream_with_context, send_file, jsonify
from flask_login import login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from models import db, Image, Tag, ReferenceImage, SystemSetting, User
from services.image_service import ImageService
from services.data_service import DataService
from services.config_service import ConfigService
import json
import time
import zipfile
import io
import os
import urllib.request

bp = Blueprint('admin', __name__, url_prefix='/admin')

# 版本信息
VERSION_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'VERSION')
GITHUB_VERSION_URL = 'https://raw.githubusercontent.com/vioaki/Prompt-Manager/main/VERSION'


def get_current_version():
    """获取当前版本号"""
    try:
        with open(VERSION_FILE, 'r') as f:
            return f.read().strip()
    except Exception:
        return 'unknown'


def _is_safe_redirect(target):
    """仅允许跳转到本站相对路径，防止开放重定向。"""
    if not target:
        return False
    # 拒绝绝对 URL 与协议相对 URL (//evil.com)
    return target.startswith('/') and not target.startswith('//')


@bp.route('/')
@login_required
def dashboard():
    """管理后台主页"""
    active_tab = request.args.get('tab', 'pending')
    search_query = request.args.get('q', '').strip()

    # 待审核队列
    pending_images = Image.query.filter_by(status='pending').order_by(Image.created_at.asc()).all()

    # 已发布列表（含搜索和分页）
    approved_query = Image.query.filter_by(status='approved')
    if search_query:
        approved_query = approved_query.filter(
            Image.title.contains(search_query) |
            Image.author.contains(search_query) |
            Image.prompt.contains(search_query)
        )

    page = request.args.get('page', 1, type=int)
    per_page = current_app.config['ADMIN_PER_PAGE']
    approved_pagination = approved_query.order_by(Image.created_at.desc()).paginate(page=page, per_page=per_page)

    all_tags = Tag.query.order_by(Tag.name).all()

    stats = {
        'total_images': Image.query.count(),
        'total_tags': Tag.query.count()
    }

    # 获取系统设置 (从数据库读取持久化配置)
    approval_settings = {
        'gallery': SystemSetting.get_bool('approval_gallery', default=True),
        'template': SystemSetting.get_bool('approval_template', default=True)
    }

    # 获取敏感内容开关设置
    allow_sensitive_toggle = SystemSetting.get_bool('allow_sensitive_toggle', default=True)
    current_app.config['ALLOW_PUBLIC_SENSITIVE_TOGGLE'] = allow_sensitive_toggle

    # 获取各类配置
    upload_settings = ConfigService.get_upload_settings()
    display_settings = ConfigService.get_display_settings()
    rate_limit_settings = ConfigService.get_rate_limit_settings()
    readonly_settings = ConfigService.get_readonly_settings()

    # 获取当前版本
    current_version = get_current_version()

    return render_template('admin.html',
                           pending_images=pending_images,
                           approved_pagination=approved_pagination,
                           active_tab=active_tab,
                           search_query=search_query,
                           all_tags=all_tags,
                           stats=stats,
                           approval_settings=approval_settings,
                           allow_sensitive_toggle=allow_sensitive_toggle,
                           upload_settings=upload_settings,
                           display_settings=display_settings,
                           rate_limit_settings=rate_limit_settings,
                           readonly_settings=readonly_settings,
                           current_version=current_version)


@bp.route('/approve/<int:img_id>', methods=['POST'])
@login_required
def approve(img_id):
    """审核通过单个作品"""
    img = db.session.get(Image, img_id)
    if img:
        img.status = 'approved'
        db.session.commit()
        flash('作品已发布')
    return redirect(url_for('admin.dashboard', tab='pending'))


@bp.route('/approve-all', methods=['POST'])
@login_required
def approve_all():
    """一键通过所有待审核作品"""
    try:
        # 批量更新效率更高
        updated_count = Image.query.filter_by(status='pending').update({'status': 'approved'})
        db.session.commit()
        if updated_count > 0:
            flash(f'🎉 已一键通过 {updated_count} 个作品！')
        else:
            flash('没有待审核的作品。')
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Batch approve error: {e}")
        flash('操作失败，请查看日志')

    return redirect(url_for('admin.dashboard', tab='pending'))


@bp.route('/delete/<int:img_id>', methods=['POST'])
@login_required
def delete(img_id):
    """删除作品"""
    if ImageService.delete_image(img_id):
        flash('删除成功')
    else:
        flash('删除失败：找不到图片')

    # 优先从表单获取 next，再从 URL 参数获取
    next_url = request.form.get('next') or request.args.get('next')
    if next_url and _is_safe_redirect(next_url):
        return redirect(next_url)
    return redirect(url_for('admin.dashboard'))


@bp.route('/edit/<int:img_id>', methods=['GET', 'POST'])
@login_required
def edit_image(img_id):
    """编辑作品"""
    img = db.session.get(Image, img_id)
    if not img: return redirect(url_for('admin.dashboard'))

    if request.method == 'POST':
        # 处理前端传来的逗号分隔 ID 字符串
        raw_ids = request.form.get('deleted_ref_ids', '')
        deleted_ids_list = raw_ids.split(',') if raw_ids else []

        try:
            ImageService.update_image(
                image_id=img.id,
                data=request.form,
                new_main_file=request.files.get('new_image'),
                new_ref_files=request.files.getlist('add_refs'),
                deleted_ref_ids=deleted_ids_list,
                poster_file=request.files.get('video_poster')
            )
            flash('修改保存成功')
        except ValueError as e:
            flash(f'保存失败: {e}')
        except Exception as e:
            flash(f'保存失败: {e}')

        next_url = request.form.get('next')
        if next_url and _is_safe_redirect(next_url):
            return redirect(next_url)
        return redirect(url_for('admin.dashboard', tab='approved' if img.status == 'approved' else 'pending'))

    next_url = request.args.get('next')
    return render_template('admin_edit.html', img=img, next_url=next_url)


@bp.route('/import-zip', methods=['POST'])
@login_required
def import_zip():
    """导入备份数据包 (流式响应)"""
    file = request.files.get('zip_file')
    if not file: return "请上传 ZIP 文件", 400

    temp_zip_path = os.path.join(current_app.instance_path, 'temp_import.zip')
    if not os.path.exists(current_app.instance_path): os.makedirs(current_app.instance_path)
    file.save(temp_zip_path)

    return Response(stream_with_context(DataService.import_zip_stream(temp_zip_path)), mimetype='text/plain')


@bp.route('/export-zip', methods=['POST'])
@login_required
def export_zip():
    """导出全量数据包 (含图片和元数据)"""
    images = Image.query.all()
    if not images:
        flash('没有数据可导出')
        return redirect(url_for('admin.dashboard', tab='data-mgmt'))

    memory_file = io.BytesIO()

    # 构建 ZIP
    with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
        json_data = []
        upload_root = os.path.join(current_app.root_path, current_app.config['UPLOAD_FOLDER'])

        for img in images:
            # 准备元数据
            item_data = img.to_dict()

            img_filename = os.path.basename(img.file_path)
            item_data['zip_image_path'] = f"images/{img_filename}"

            if img.thumbnail_path:
                thumb_name = os.path.basename(img.thumbnail_path)
                item_data['zip_thumb_path'] = f"images/{thumb_name}"

            # 写入主图
            abs_img_path = os.path.join(upload_root, img_filename)
            if os.path.exists(abs_img_path):
                zf.write(abs_img_path, f"images/{img_filename}")

            # 写入缩略图
            if img.thumbnail_path:
                abs_thumb = os.path.join(upload_root, os.path.basename(img.thumbnail_path))
                if os.path.exists(abs_thumb):
                    zf.write(abs_thumb, f"images/{os.path.basename(img.thumbnail_path)}")

            # 写入参考图
            item_data['refs'] = []
            for ref in img.refs:
                ref_fname = os.path.basename(ref.file_path)
                abs_ref_path = os.path.join(upload_root, ref_fname)
                if os.path.exists(abs_ref_path):
                    zf.write(abs_ref_path, f"images/{ref_fname}")
                    item_data['refs'].append(f"images/{ref_fname}")

            json_data.append(item_data)

        # 写入 JSON 索引
        zf.writestr("data.json", json.dumps({"images": json_data}, ensure_ascii=False, indent=2))

    memory_file.seek(0)
    filename = f"backup_{time.strftime('%Y%m%d')}.zip"
    return send_file(
        memory_file,
        mimetype='application/zip',
        as_attachment=True,
        download_name=filename
    )


@bp.route('/tag/update', methods=['POST'])
@login_required
def update_tag():
    """标签管理：重命名与敏感设置"""
    is_json = request.is_json
    data = request.get_json() if is_json else request.form

    tag_id = data.get('tag_id')
    new_name = data.get('new_name', '').strip()
    is_sensitive = data.get('is_sensitive')

    # 兼容 Form 表单的 Checkbox
    if not is_json and 'is_sensitive' in request.form:
        is_sensitive = True
    elif not is_json:
        is_sensitive = False

    tag = db.session.get(Tag, int(tag_id))
    if not tag:
        return (jsonify({'status': 'error'}), 404) if is_json else redirect(url_for('admin.dashboard'))

    # 更新状态
    if tag.is_sensitive != is_sensitive:
        tag.is_sensitive = is_sensitive
        db.session.commit()

    # 更新名称（合并逻辑）
    if new_name and new_name != tag.name:
        existing = Tag.query.filter_by(name=new_name).first()
        if existing:
            for img in tag.images:
                if img not in existing.images:
                    existing.images.append(img)
            db.session.delete(tag)
            flash(f'标签已合并至: {new_name}')
        else:
            tag.name = new_name
        db.session.commit()

    # 清理僵尸标签
    _clean_orphaned_tags()

    if is_json: return jsonify({'status': 'ok'})
    return redirect(url_for('admin.dashboard'))


def _clean_orphaned_tags():
    """清理没有关联图片的僵尸标签"""
    orphaned = Tag.query.filter(~Tag.images.any()).all()
    for tag in orphaned:
        db.session.delete(tag)
    if orphaned:
        db.session.commit()


@bp.route('/setting/global', methods=['POST'])
@login_required
def update_global_setting():
    """全局设置：更新各类系统开关"""
    is_json = request.is_json
    data = request.get_json() if is_json else request.form

    # 1. 敏感内容开关
    if 'allow_toggle' in data:
        val = data.get('allow_toggle', False)
        # 兼容表单
        if not is_json and 'allow_toggle' in request.form:
            val = True
        elif not is_json:
            val = False

        SystemSetting.set_bool('allow_sensitive_toggle', val)
        current_app.config['ALLOW_PUBLIC_SENSITIVE_TOGGLE'] = val

    # 2. 画廊审核开关
    if 'approval_gallery' in data:
        SystemSetting.set_bool('approval_gallery', data.get('approval_gallery'))

    # 3. 模板审核开关
    if 'approval_template' in data:
        SystemSetting.set_bool('approval_template', data.get('approval_template'))

    if is_json: return jsonify({'status': 'ok'})
    flash('系统设置已更新')
    return redirect(url_for('admin.dashboard', tab='data-mgmt'))


@bp.route('/setting/upload', methods=['POST'])
@login_required
def update_upload_setting():
    """上传配置：图片处理相关设置 (热更新)"""
    is_json = request.is_json
    data = request.get_json() if is_json else request.form

    try:
        if 'img_max_dimension' in data:
            ConfigService.set_img_max_dimension(int(data.get('img_max_dimension')))

        if 'img_quality' in data:
            ConfigService.set_img_quality(int(data.get('img_quality')))

        if 'enable_img_compress' in data:
            val = data.get('enable_img_compress')
            if is_json:
                ConfigService.set_enable_img_compress(val)
            else:
                ConfigService.set_enable_img_compress('enable_img_compress' in request.form)

        if 'max_ref_images' in data:
            ConfigService.set_max_ref_images(int(data.get('max_ref_images')))

        if is_json:
            return jsonify({'status': 'ok', 'data': ConfigService.get_upload_settings()})
        flash('上传配置已更新')
    except Exception as e:
        if is_json:
            return jsonify({'status': 'error', 'message': str(e)}), 400
        flash(f'保存失败: {e}')

    return redirect(url_for('admin.dashboard', tab='data-mgmt'))


@bp.route('/setting/display', methods=['POST'])
@login_required
def update_display_setting():
    """显示配置：分页和预览相关设置 (热更新)"""
    is_json = request.is_json
    data = request.get_json() if is_json else request.form

    try:
        if 'items_per_page' in data:
            ConfigService.set_items_per_page(int(data.get('items_per_page')))

        if 'admin_per_page' in data:
            ConfigService.set_admin_per_page(int(data.get('admin_per_page')))

        if 'use_thumbnail_in_preview' in data:
            val = data.get('use_thumbnail_in_preview')
            if is_json:
                ConfigService.set_use_thumbnail_in_preview(val)
            else:
                ConfigService.set_use_thumbnail_in_preview('use_thumbnail_in_preview' in request.form)

        if is_json:
            return jsonify({'status': 'ok', 'data': ConfigService.get_display_settings()})
        flash('显示配置已更新')
    except Exception as e:
        if is_json:
            return jsonify({'status': 'error', 'message': str(e)}), 400
        flash(f'保存失败: {e}')

    return redirect(url_for('admin.dashboard', tab='data-mgmt'))


@bp.route('/setting/ratelimit', methods=['POST'])
@login_required
def update_ratelimit_setting():
    """限流配置：访问频率限制 (热更新)"""
    is_json = request.is_json
    data = request.get_json() if is_json else request.form

    try:
        if 'upload_rate_limit' in data:
            ConfigService.set_upload_rate_limit(data.get('upload_rate_limit'))

        if 'login_rate_limit' in data:
            ConfigService.set_login_rate_limit(data.get('login_rate_limit'))

        if is_json:
            return jsonify({'status': 'ok', 'data': ConfigService.get_rate_limit_settings()})
        flash('限流配置已更新')
    except Exception as e:
        if is_json:
            return jsonify({'status': 'error', 'message': str(e)}), 400
        flash(f'保存失败: {e}')

    return redirect(url_for('admin.dashboard', tab='data-mgmt'))


@bp.route('/setting/password', methods=['POST'])
@login_required
def update_password():
    """修改当前用户密码"""
    is_json = request.is_json
    data = request.get_json() if is_json else request.form

    old_password = data.get('old_password', '')
    new_password = data.get('new_password', '')
    confirm_password = data.get('confirm_password', '')

    # 验证
    if not old_password or not new_password:
        msg = '请填写完整的密码信息'
        if is_json:
            return jsonify({'status': 'error', 'message': msg}), 400
        flash(msg)
        return redirect(url_for('admin.dashboard', tab='data-mgmt'))

    if new_password != confirm_password:
        msg = '两次输入的新密码不一致'
        if is_json:
            return jsonify({'status': 'error', 'message': msg}), 400
        flash(msg)
        return redirect(url_for('admin.dashboard', tab='data-mgmt'))

    if len(new_password) < 6:
        msg = '新密码长度至少为6位'
        if is_json:
            return jsonify({'status': 'error', 'message': msg}), 400
        flash(msg)
        return redirect(url_for('admin.dashboard', tab='data-mgmt'))

    # 验证旧密码
    user = db.session.get(User, current_user.id)
    if not check_password_hash(user.password_hash, old_password):
        msg = '当前密码错误'
        if is_json:
            return jsonify({'status': 'error', 'message': msg}), 400
        flash(msg)
        return redirect(url_for('admin.dashboard', tab='data-mgmt'))

    # 更新密码
    user.password_hash = generate_password_hash(new_password)
    db.session.commit()

    if is_json:
        return jsonify({'status': 'ok', 'message': '密码修改成功'})
    flash('密码修改成功')
    return redirect(url_for('admin.dashboard', tab='data-mgmt'))


@bp.route('/check-update', methods=['GET'])
@login_required
def check_update():
    """检查是否有新版本"""
    current = get_current_version()

    try:
        req = urllib.request.Request(GITHUB_VERSION_URL, headers={'User-Agent': 'Prompt-Manager'})
        with urllib.request.urlopen(req, timeout=5) as response:
            latest = response.read().decode('utf-8').strip()

        # 比较版本号
        def parse_version(v):
            return tuple(map(int, v.replace('v', '').split('.')))

        has_update = parse_version(latest) > parse_version(current)

        return jsonify({
            'status': 'ok',
            'current': current,
            'latest': latest,
            'has_update': has_update
        })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'current': current,
            'message': f'检查更新失败: {str(e)}'
        })