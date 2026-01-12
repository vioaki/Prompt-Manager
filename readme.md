# Prompt Manager

**Prompt Manager** 是一个优雅、现代化的本地 AI 绘画作品与提示词（Prompt）管理系统。

本项目旨在解决 AI 绘画过程中提示词管理混乱、参考图难以归档的痛点。它作为一个聚合平台，支持用户上传、审核和管理优质的 Prompt 模板。系统特别针对 **Nano Banana**、**Qwen Image Edit**、**Seedream** 等支持多张参考图的模型进行了优化，提供了多图上传及拖拽排序功能。

🔗 **演示站点**：[https://prompt.vioaki.xyz](https://prompt.vioaki.xyz)

如果有好用的prompt欢迎分享

> **提示**：演示站点的初始数据包通常包含在项目的 Release 中。
> **导入方法**：登录管理员后台 -> 系统设置 -> 选择 ZIP 压缩包 -> 点击“开始导入 -> 进入审核页审核”。

## 核心功能

* **沉浸式画廊**
    * 采用瀑布流布局，视觉体验流畅。
    * 支持高性能图片加载与自动生成缩略图。
    * 提供文生图（Txt2Img）与图生图（Img2Img）分类展示。
    * 内置深色模式与浅色模式，可一键切换。

* **高级上传与管理**
    * **多参考图支持**：专为图生图模式设计，支持上传多张参考图。
    * **拖拽排序**：可通过拖拽自由调整参考图的顺序，确保生成效果符合预期。
    * **图片占位符**：可生成图片占位符以表示不固定的参考图。
    * **标签系统**：支持标签录入与管理，便于分类检索。

* **交互式提示词模板**
    * **变量占位符**：支持在 Prompt 中使用 `{{变量名}}` 语法（如 `{{Character}}`, `{{Style}}`）定义动态参数。
    * **动态填充**：详情页会自动解析变量并生成输入框，用户填写后可**实时预览**修改后的 Prompt。
    * **智能复用**：一键复制时会自动替换变量为当前输入值，极大提升了风格模板的复用效率。

* **完善的后台管理**
    * **审核流程**：内置“待审核”到“已发布”的审核流，适合多人协作或内容筛选。
    * **自动审核**：支持分别为画廊页和模板页设置自动通过或人工审核。
    * **数据备份与恢复**：支持一键导出包含原图、提示词和元数据的 ZIP 数据包，方便数据迁移与备份。

* **隐私与安全**
    * **本地化运行**：所有数据均存储在本地，确保数据主权。
    * **敏感内容控制**：提供敏感内容（NSFW）遮罩开关，管理员可通过配置文件控制访客权限。

## ✨ 界面预览

<p align="center">
  <img src="assets/screenshot_detail.png" alt="Interactive Detail View" width="100%">
</p>

<table border="0">
  <tr>
    <td width="50%">
      <h3 align="center">沉浸式画廊</h3>
      <img src="assets/screenshot_gallery.png" alt="Gallery View" width="100%">
    </td>
    <td width="50%">
      <h3 align="center">高级工作流</h3>
      <img src="assets/screenshot_upload.png" alt="Upload & Sort" width="100%">
    </td>
  </tr>
</table>

<p align="center">
  <img src="assets/screenshot_admin.png" alt="Admin Dashboard" width="100%">
  <br>
  <em>现代化后台管理与审核系统</em>
</p>

---

##  安装与启动

本项目基于 Python Flask 开发，支持 Docker 和源码两种部署方式。

### Docker 部署（推荐）

#### 快速启动（零配置）

```bash
docker run -d \
  --name prompt-manager \
  -p 5000:5000 \
  -v ./data:/app/instance \
  -v ./uploads:/app/static/uploads \
  vioaki/prompt-manager:latest
```

启动后访问 `http://localhost:5000`，使用默认账号 `admin` / `123456` 登录，然后在后台修改密码。

#### 使用 Docker Compose

```bash
# 下载配置文件
curl -O https://raw.githubusercontent.com/vioaki/Prompt-Manager/main/docker-compose.yml

# 启动
docker compose up -d
```

#### 自定义配置

如需使用 MySQL/PostgreSQL 或 S3 存储，创建 `.env` 文件：

```bash
# 数据库配置（可选，默认 SQLite）
DB_TYPE=mysql
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=promptmanager

# S3 存储（可选，默认本地存储）
STORAGE_TYPE=cloud
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY=your_key
S3_SECRET_KEY=your_secret
S3_BUCKET=your_bucket
S3_DOMAIN=https://your-cdn.com
```

然后在 `docker-compose.yml` 中取消 `env_file: .env` 的注释。

### 源码部署

#### 1. 克隆项目

```bash
git clone https://github.com/vioaki/Prompt-Manager.git
cd Prompt-Manager
````

#### 2. 创建环境并安装依赖

**Windows:**

```bash
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
```

**Linux / macOS:**

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

#### 3. 初始化配置

```bash
# 可选：复制配置文件进行自定义
cp .env.example .env

# 初始化数据库
python manage_db.py
```

> **默认管理员账号**: `admin` / `123456`

#### 4. 启动服务

**Windows:**

```bash
flask run --host=0.0.0.0 --port=5000
# 或
python app.py
```

**Linux / macOS (生产环境):**

```bash
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```

启动后，访问 `http://localhost:5000` 即可开始使用。

##  使用指南

1.  **发布作品**：点击页面右上角的“上传”按钮。填写提示词（Prompt），如果是图生图作品，可以上传多张参考图并拖拽调整顺序。
2.  **后台审核**：默认上传的作品处于“待审核”状态。管理员需访问 `/login` 登录后台，对作品进行通过或删除操作。
3.  **敏感内容显示**：如果在 `.env` 配置文件中设置了 `ALLOW_PUBLIC_SENSITIVE_TOGGLE=True`，访客即可在“关于”页面看到开启显示敏感内容的开关。

##  目录结构

```text
.
├── blueprints/      # 路由蓝图 (后台管理、认证、公共页面)
├── services/        # 核心业务逻辑 (图片处理、数据导入导出)
├── static/          # 静态资源 (CSS, JS, 上传文件存储)
├── templates/       # HTML 模版文件
├── models.py        # 数据库模型定义
├── config.py        # 配置文件加载
└── app.py           # 应用启动入口
```

## API 接口

系统提供 RESTful API，支持第三方客户端集成和自动化工作流。

### 获取数据

| 接口 | 方法 | 描述 |
|------|------|------|
| `/api/gallery` | GET | 获取画廊数据 |
| `/api/templates` | GET | 获取模板数据 |

**查询参数：**

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `page` | Int | 1 | 页码 |
| `per_page` | Int | 500 | 每页数量，`-1` 获取全部（上限 1w） |
| `q` | String | - | 关键词搜索 |
| `tag` | String | - | 标签筛选 |
| `sort` | String | date | 排序：`date` / `hot` / `random` |

### 上传接口

```
POST /api/upload
Content-Type: multipart/form-data
```

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `image` | File | 是 | 主图文件 |
| `title` | String | 是 | 作品标题 |
| `prompt` | String | 否 | 提示词 |
| `author` | String | 否 | 作者名 |
| `description` | String | 否 | 描述 |
| `type` | String | 否 | `txt2img` / `img2img` |
| `category` | String | 否 | `gallery`（默认）/ `template` |
| `tags` | String | 否 | 逗号分隔的标签 |
| `ref_images` | File[] | 否 | 参考图（img2img 时使用，可多个） |

**请求示例：**

```bash
# cURL
curl -X POST https://your-domain.com/api/upload \
  -F "image=@photo.jpg" \
  -F "title=我的作品" \
  -F "prompt=a beautiful sunset" \
  -F "tags=风景,日落"

# 带参考图
curl -X POST https://your-domain.com/api/upload \
  -F "image=@result.jpg" \
  -F "title=风格转换" \
  -F "type=img2img" \
  -F "ref_images=@ref1.jpg" \
  -F "ref_images=@ref2.jpg"
```

**响应示例：**

```json
{
  "code": 201,
  "message": "上传成功，等待审核",
  "data": {
    "id": 1,
    "title": "我的作品",
    "status": "pending",
    "file_path": "/static/uploads/xxx.jpg",
    "tags": ["风景", "日落"],
    "created_at": "2025-01-12T10:30:00"
  }
}
```

**错误响应：**

```json
{"code": 400, "message": "缺少主图文件", "data": null}
{"code": 400, "message": "缺少标题", "data": null}
{"code": 500, "message": "上传失败: 错误信息", "data": null}
```

