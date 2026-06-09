"""安全与序列化回归：XSS 转义、to_dict 脱离请求上下文。"""
from models import Image


def test_to_dict_works_without_request_context(app):
    """模型序列化不应再依赖 Flask request (分层违规已修复)。"""
    with app.app_context():
        from extensions import db
        img = Image(title='t', file_path='/static/uploads/a.mp4', status='approved')
        db.session.add(img)
        db.session.flush()
        # 模拟历史数据：media_type 列加入前的旧行为 NULL
        db.session.execute(db.text('UPDATE image SET media_type = NULL WHERE id = :i'), {'i': img.id})
        db.session.refresh(img)

        d = img.to_dict()  # 不传 base_url，且不在请求上下文中
        assert d['file_path'] == '/static/uploads/a.mp4'  # 相对路径原样返回
        assert d['media_type'] == 'video'  # media_type 为空时按扩展名推断


def test_to_dict_prefixes_base_url(app):
    with app.app_context():
        from extensions import db
        img = Image(title='t', file_path='/static/uploads/a.png',
                    media_type='image', status='approved')
        db.session.add(img)
        db.session.flush()
        d = img.to_dict('https://example.com/')
        assert d['file_path'] == 'https://example.com/static/uploads/a.png'


def test_xss_payload_is_escaped_in_inline_json(app, client):
    """含 HTML 的 prompt/tag 内联进 <script> 时危险字符必须被转义。"""
    with app.app_context():
        from extensions import db
        from services.image_service import ImageService
        img = Image(title='xss', prompt='{{<img src=x onerror=alert(1)>}}',
                    file_path='/static/uploads/a.png', media_type='image',
                    status='approved', category='gallery')
        db.session.add(img)
        db.session.flush()
        ImageService._apply_tags(img, '<script>alert(1)</script>')
        db.session.commit()

    resp = client.get('/')
    html = resp.get_data(as_text=True)
    # tojson 会把 < 转义成 <，原始 <img / <script> 不应出现在内联 JSON 中
    assert '<img src=x onerror' not in html
    assert '<script>alert(1)</script>' not in html
    assert '\\u003c' in html  # 已被转义
