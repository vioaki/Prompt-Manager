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

* **完善的后台管理**
    * **审核流程**：内置“待审核”到“已发布”的审核流，适合多人协作或内容筛选。
    * **自动审核**：支持分别为画廊页和模板页设置自动通过或人工审核。
    * **数据备份与恢复**：支持一键导出包含原图、提示词和元数据的 ZIP 数据包，方便数据迁移与备份。

* **隐私与安全**
    * **本地化运行**：所有数据均存储在本地，确保数据主权。
    * **敏感内容控制**：提供敏感内容（NSFW）遮罩开关，管理员可通过配置文件控制访客权限。

##  安装与启动

本项目基于 Python Flask 开发。

### 1. 克隆项目

```bash
git clone https://github.com/vioaki/Prompt-Manager.git
cd Prompt-Manager
````

### 2\. 创建环境并安装依赖

建议使用虚拟环境以避免依赖冲突。

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

### 3\. 初始化配置

首次运行前，请复制示例配置文件并根据需要修改（**建议修改默认的管理员密码**）。

```bash
# 复制配置文件 (请修改默认账号密码) (windows环境使用copy命令)
cp .env.example .env

# 初始化/升级数据库 (自动创建 data.sqlite 和管理员账户)
python manage_db.py
```

> **默认管理员账号**: `admin`
> **默认密码**: 请查看 `.env` 文件中的配置，或在首次运行时进行修改。

### 4\. 启动服务

根据您的操作系统选择启动方式：

**Windows (使用 Flask 内置服务器):**

```bash
flask run --host=0.0.0.0 --port=5000
# 或者
python app.py
```

**Linux / macOS (使用 Gunicorn 高性能服务器):**

```bash
# 启动 4 个工作进程，适合生产环境
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```

启动后，访问浏览器 `http://localhost:5000` 即可开始使用。

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
