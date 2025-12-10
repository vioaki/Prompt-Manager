import hashlib
import json
import time
from flask import Blueprint, render_template, request, current_app, url_for, jsonify, make_response
from flask_login import current_user
from sqlalchemy.sql.expression import func
from models import db, Image, Tag, SystemSetting
from extensions import limiter
from services.image_service import ImageService

bp = Blueprint('public', __name__)


def can_see_sensitive():
    """判断当前用户是否有权查看敏感内容"""
    if current_user.is_authenticated: return True

    # 修改点：从数据库读取开关 (持久化)
    allow_toggle = SystemSetting.get_bool('allow_sensitive_toggle', default=True)

    if not allow_toggle: return False
    return request.cookies.get('pm_show_sensitive') == '1'


def _get_common_data(category_filter=None):
    """
    提取画廊和模板页通用的查询逻辑 (用于网页渲染)
    :param category_filter: None(所有) 或 'template'(仅模板)
    """
    page = request.args.get('page', 1, type=int)
    tag_filter = request.args.get('tag', '').strip()
    search_query = request.args.get('q', '').strip()
    sort_by = request.args.get('sort', 'date')
    show_sensitive = can_see_sensitive()

    # 构建图片查询
    query = Image.query.filter_by(status='approved')

    if category_filter:
        query = query.filter_by(category=category_filter)

    if not show_sensitive:
        query = query.filter(~Image.tags.any(Tag.is_sensitive == True))

    if tag_filter:
        query = query.filter(Image.tags.any(name=tag_filter))

    if search_query:
        query = query.filter(
            Image.title.contains(search_query) |
            Image.prompt.contains(search_query) |
            Image.author.contains(search_query)
        )

    # 排序
    if sort_by == 'hot':
        query = query.order_by(Image.heat_score.desc(), Image.created_at.desc())
    elif sort_by == 'random':
        query = query.order_by(func.random())
    else:
        query = query.order_by(Image.created_at.desc())

    pagination = query.paginate(page=page, per_page=current_app.config['ITEMS_PER_PAGE'])

    # 构建标签筛选列表
    tags_query = db.session.query(Tag).join(Tag.images).filter(Image.status == 'approved')

    if category_filter:
        tags_query = tags_query.filter(Image.category == category_filter)

    if not show_sensitive:
        tags_query = tags_query.filter(Tag.is_sensitive == False)

    all_tags = tags_query.group_by(Tag.id).order_by(Tag.name).all()

    return {
        'images': pagination.items,
        'pagination': pagination,
        'active_tag': tag_filter,
        'active_search': search_query,
        'all_tags': all_tags,
        'current_sort': sort_by
    }


@bp.route('/')
def index():
    """画廊主页"""
    data = _get_common_data(category_filter=None)
    return render_template('index.html', **data)


@bp.route('/templates')
def templates_index():
    """模板库"""
    data = _get_common_data(category_filter='template')
    return render_template('index.html', **data)


@bp.route('/upload', methods=['GET', 'POST'])
@limiter.limit(lambda: current_app.config['UPLOAD_RATE_LIMIT'])
def upload():
    """发布新作品"""
    if request.method == 'GET':
        return render_template('upload.html')

    file = request.files.get('image')
    if not file: return "缺少主图", 400

    # 1. 获取用户选择的分类 (gallery 或 template)
    category = request.form.get('category', 'gallery')

    # 2. 从数据库读取审核配置
    if category == 'template':
        need_approval = SystemSetting.get_bool('approval_template', default=True)
    else:
        # 默认为 gallery
        need_approval = SystemSetting.get_bool('approval_gallery', default=True)

    # 3. 决定初始状态
    initial_status = 'pending' if need_approval else 'approved'

    try:
        # 构造表单数据复本以修改状态
        form_data = request.form.to_dict()
        form_data['status'] = initial_status

        new_image = ImageService.create_image(
            file=file,
            data=form_data,
            ref_files=request.files.getlist('ref_images')
        )
        return render_template('success.html', status=initial_status, image=new_image)
    except Exception as e:
        current_app.logger.error(f"Upload Error: {e}")
        return f"发布失败: {str(e)}", 500


@bp.route('/about')
def about():
    return render_template('about.html')


def _get_api_data(category_filter):
    """
    API 通用查询逻辑

    配置策略:
    1. 默认容量: 不传 per_page 时，默认一次返回 500 条。
    2. 无限模式: 传 per_page=-1 时，几乎不做限制 (上限 10000)。
    3. 缓存机制: 保留 ETag/304 优化，大列表传输时极其重要。
    """
    # --- 1. 参数解析 ---
    try:
        page = request.args.get('page', 1, type=int)
        raw_per_page = request.args.get('per_page', type=int)

        # 物理硬上限 (防止恶意攻击搞挂数据库)
        HARD_LIMIT = 10000

        # 默认值设为 500
        DEFAULT_LIMIT = 500

        if raw_per_page == -1:
            # 用户明确要求“全部”，给予最大权限
            per_page = HARD_LIMIT
        else:
            # 如果没传参数，用 500；传了则用传的值，但受硬上限约束
            per_page = raw_per_page if raw_per_page is not None else DEFAULT_LIMIT
            per_page = min(per_page, HARD_LIMIT)

    except ValueError:
        page = 1
        per_page = DEFAULT_LIMIT

    search_query = request.args.get('q', '').strip()
    tag_filter = request.args.get('tag', '').strip()
    sort_by = request.args.get('sort', 'date')

    # --- 2. 构建查询 ---
    query = Image.query.filter_by(status='approved')

    if category_filter:
        query = query.filter_by(category=category_filter)

    if search_query:
        query = query.filter(
            Image.title.contains(search_query) |
            Image.prompt.contains(search_query) |
            Image.author.contains(search_query)
        )

    if tag_filter:
        query = query.filter(Image.tags.any(name=tag_filter))

    # [可选] 过滤敏感内容
    # query = query.filter(~Image.tags.any(Tag.is_sensitive == True))

    # --- 3. 排序逻辑 ---
    if sort_by == 'hot':
        query = query.order_by(Image.heat_score.desc(), Image.created_at.desc())
    elif sort_by == 'random':
        query = query.order_by(func.random())
    else:
        query = query.order_by(Image.created_at.desc())

    # --- 4. 获取数据 ---
    pagination = query.paginate(page=page, per_page=per_page, error_out=False)
    items_data = [img.to_dict() for img in pagination.items]

    # --- 5. 构建响应 ---
    response_payload = {
        'code': 200,
        'message': 'success',
        'meta': {
            'page': page,
            'per_page': per_page,
            'total_items': pagination.total,
            'total_pages': pagination.pages,
            'has_next': pagination.has_next,
            # 自动生成下一页链接
            'next_url': url_for(request.endpoint, page=pagination.next_num, per_page=per_page, q=search_query,
                                tag=tag_filter, sort=sort_by, _external=True) if pagination.has_next else None,
            'server_timestamp': int(time.time())
        },
        'data': items_data
    }

    # --- 6. ETag 缓存校验 ---
    json_str = json.dumps(response_payload, sort_keys=True, ensure_ascii=False)
    etag_value = hashlib.md5(json_str.encode('utf-8')).hexdigest()

    if request.if_none_match and request.if_none_match.contains(etag_value):
        # 命中缓存，返回 304 Not Modified
        return make_response('', 304)

    # --- 7. 返回响应 ---
    response = make_response(json_str)
    response.headers['Content-Type'] = 'application/json'
    response.set_etag(etag_value)
    # 允许客户端缓存 60 秒
    response.headers['Cache-Control'] = 'public, max-age=60'

    return response


@bp.route('/api/gallery')
def api_gallery_list():
    """获取画廊数据 (JSON)"""
    return _get_api_data('gallery')


@bp.route('/api/templates')
def api_templates_list():
    """获取模板数据 (JSON)"""
    return _get_api_data('template')


@bp.route('/api/stats/view/<int:img_id>', methods=['POST'])
def stat_view(img_id):
    """增加浏览计数"""
    img = db.session.get(Image, img_id)
    if img:
        img.views_count += 1
        img.heat_score = img.views_count * 1 + img.copies_count * 10
        db.session.commit()
    return {'status': 'ok'}


@bp.route('/api/stats/copy/<int:img_id>', methods=['POST'])
def stat_copy(img_id):
    """增加复制计数"""
    img = db.session.get(Image, img_id)
    if img:
        img.copies_count += 1
        img.heat_score = img.views_count * 1 + img.copies_count * 10
        db.session.commit()
    return {'status': 'ok'}