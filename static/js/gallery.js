/**
 * static/js/gallery.js
 * 画廊页面核心交互逻辑：详情弹窗、变量解析、交互式Prompt、统计打点。
 */

// --- Global State for Prompt Variables ---
window.currentVars = {};
window.rawPrompt = "";
window.currentImgId = null;

// --- Detail Modal Logic ---

window.showDetail = function(el) {
    try {
        const scriptTag = el.querySelector('.img-data');
        if (!scriptTag) return;
        const data = JSON.parse(scriptTag.textContent);

        // 1. 基础信息渲染
        const modalImg = document.getElementById('modalImg');
        const modalVideo = document.getElementById('modalVideo');
        // 优先使用后端 media_type，回退到扩展名判断 (兼容历史数据)
        const isVideo = data.media_type === 'video' ||
            /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(data.file_path || '');

        if (isVideo) {
            modalImg.classList.add('d-none');
            modalImg.src = '';
            modalVideo.src = data.file_path;
            modalVideo.classList.remove('d-none');
            modalVideo.load();
        } else {
            modalVideo.pause();
            modalVideo.src = '';
            modalVideo.classList.add('d-none');
            modalImg.src = data.file_path;
            modalImg.classList.remove('d-none');
        }
        document.getElementById('modalTitle').innerText = data.title;
        document.getElementById('modalAuthor').innerText = data.author ? 'by ' + data.author : '';

        window.currentImgId = data.id;
        window.rawPrompt = data.prompt || "";
        window.currentVars = {};

        // 2. Prompt 解析与变量生成
        const promptContainer = document.getElementById('modalPrompt');
        const varsSection = document.getElementById('modalVarsSection');
        const varsContainer = document.getElementById('modalVarsContainer');

        // 正则匹配 {{variable}}
        const regex = /\{\{(.*?)\}\}/g;
        const matches = [...window.rawPrompt.matchAll(regex)];

        if (matches.length > 0) {
            // A. 生成高亮 Prompt：用 DOM API 逐段拼接，避免 innerHTML 注入用户数据 (XSS)
            promptContainer.textContent = '';
            let lastIndex = 0;
            let varIndex = 0;
            window.rawPrompt.replace(regex, (match, p1, offset) => {
                if (offset > lastIndex) {
                    promptContainer.appendChild(
                        document.createTextNode(window.rawPrompt.slice(lastIndex, offset))
                    );
                }
                const varName = p1.trim();
                const span = document.createElement('span');
                span.id = `preview-var-${varIndex++}`;
                span.className = 'prompt-var-highlight';
                span.dataset.original = varName;
                span.textContent = match;
                promptContainer.appendChild(span);
                lastIndex = offset + match.length;
                return match;
            });
            if (lastIndex < window.rawPrompt.length) {
                promptContainer.appendChild(
                    document.createTextNode(window.rawPrompt.slice(lastIndex))
                );
            }

            // B. 生成变量输入列表 (DOM API + addEventListener，无字符串拼接)
            varsContainer.textContent = '';
            const uniqueVars = new Set();

            matches.forEach(match => {
                const varName = match[1].trim();
                if (!uniqueVars.has(varName)) {
                    uniqueVars.add(varName);
                    window.currentVars[varName] = "";

                    const row = document.createElement('div');
                    row.className = 'var-input-row animate-up';

                    const label = document.createElement('div');
                    label.className = 'var-label';
                    label.title = varName;
                    label.textContent = varName;

                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'var-input';
                    input.placeholder = 'Value';
                    input.autocomplete = 'off';
                    input.addEventListener('input', () => window.updateVar(varName, input.value));

                    row.appendChild(label);
                    row.appendChild(input);
                    varsContainer.appendChild(row);
                }
            });
            varsSection.classList.remove('d-none');
        } else {
            // 没有变量：直接显示纯文本，隐藏输入区
            promptContainer.innerText = window.rawPrompt;
            varsSection.classList.add('d-none');
        }

        // 3. 重置复制按钮状态
        const btn = document.getElementById('btnCopyPrompt');
        if(btn) {
            btn.innerHTML = '<i class="bi bi-clipboard me-1"></i> <span>Copy</span>';
            // 恢复默认的灰色极简样式
            btn.className = 'btn btn-sm text-secondary p-0 fw-bold d-flex align-items-center transition-colors';
        }

        // 4. 渲染其他详情 (描述、标签、参考图、管理按钮)
        renderOtherDetails(data);

        // 5. 显示模态框
        if (typeof bootstrap !== 'undefined') {
            new bootstrap.Modal(document.getElementById('detailModal')).show();
        }
    } catch(e) {
        console.error("Detail Error:", e);
    }
}

/**
 * 辅助函数：渲染除 Prompt 外的其他信息
 * 将杂项逻辑分离，保持主函数整洁
 */
function renderOtherDetails(data) {
    // Description
    const descSection = document.getElementById('modalDescSection');
    if (data.description && data.description.trim() !== '') {
        descSection.classList.remove('d-none');
        document.getElementById('modalDesc').innerText = data.description;
    } else {
        descSection.classList.add('d-none');
    }

    // Tags
    const tagsContainer = document.getElementById('modalTags');
    tagsContainer.textContent = '';
    data.tags.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'badge rounded-pill fw-normal border me-1';
        span.style.background = 'var(--btn-bg)';
        span.style.color = 'var(--text-primary)';
        span.style.borderColor = 'rgba(128,128,128,0.2)';
        span.textContent = tag;
        tagsContainer.appendChild(span);
    });

    // Refs (参考图)
    const refsSection = document.getElementById('modalRefsSection');
    const refsContainer = document.getElementById('modalRefs');
    refsContainer.textContent = '';

    if (data.refs && data.refs.length > 0) {
        refsSection.classList.remove('d-none');

        const setMainImg = (src) => { document.getElementById('modalImg').src = src; };

        // 构建一个参考图缩略格 (用 DOM API，避免 innerHTML 注入)
        const buildCell = ({ src, label, isPlaceholder, onClick }) => {
            const cell = document.createElement('div');
            cell.className = 'd-flex flex-column align-items-center me-1';

            if (isPlaceholder) {
                const box = document.createElement('div');
                box.className = 'rounded border mb-1 d-flex flex-column align-items-center justify-content-center bg-light text-secondary';
                box.style.cssText = 'width:60px;height:60px;border-style:dashed !important;';
                const icon = document.createElement('i');
                icon.className = 'bi bi-person-bounding-box';
                icon.style.fontSize = '1.2rem';
                box.appendChild(icon);
                cell.appendChild(box);
            } else {
                const img = document.createElement('img');
                img.className = 'rounded border mb-1';
                img.style.cssText = 'width:60px;height:60px;object-fit:cover;';
                img.src = src;  // 属性赋值，不会执行其中的 HTML/JS
                cell.appendChild(img);
            }

            const cap = document.createElement('span');
            cap.style.cssText = 'font-size:0.6rem;color:var(--text-secondary);';
            cap.textContent = label;
            cell.appendChild(cap);

            if (onClick) {
                cell.classList.add('cursor-pointer');
                cell.addEventListener('click', onClick);
            }
            return cell;
        };

        // 效果图作为第一个参考
        refsContainer.appendChild(buildCell({
            src: data.file_path,
            label: '效果图',
            isPlaceholder: false,
            onClick: () => setMainImg(data.file_path),
        }));

        data.refs.forEach((ref, idx) => {
            refsContainer.appendChild(buildCell({
                src: ref.file_path,
                label: ref.is_placeholder ? `变量 ${idx + 1}` : `Ref ${idx + 1}`,
                isPlaceholder: ref.is_placeholder,
                onClick: ref.is_placeholder ? null : () => setMainImg(ref.file_path),
            }));
        });
    } else {
        refsSection.classList.add('d-none');
    }

    // Stats View (浏览量打点)
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    if (navigator.sendBeacon && csrfToken) {
        const formData = new FormData();
        formData.append('csrf_token', csrfToken);
        navigator.sendBeacon(`/api/stats/view/${data.id}`, formData);
    } else {
        fetch(`/api/stats/view/${data.id}`, {
            method: 'POST',
            headers: {'X-CSRFToken': csrfToken}
        }).catch(() => {});
    }

    // Admin Actions (编辑/删除按钮)
    const adminSection = document.getElementById('admin-actions');
    if (window.UserContext && window.UserContext.isAdmin) {
        adminSection.classList.remove('d-none');
        // 记录当前 URL 以便操作后返回
        const currentPath = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
        document.getElementById('btn-edit-art').href = `/admin/edit/${data.id}?next=${currentPath}`;
        document.getElementById('form-delete-art').action = `/admin/delete/${data.id}?next=${currentPath}`;
    } else {
        adminSection.classList.add('d-none');
    }
}

// --- Variable Update Logic ---

/**
 * 实时更新变量：
 * 1. 更新内存中的变量值
 * 2. 同步更新上方 Prompt 预览区的高亮文本
 */
window.updateVar = function(name, value) {
    window.currentVars[name] = value;

    // 查找所有关联这个变量名的 span (遍历比对 dataset，避免把用户输入拼进 CSS 选择器)
    const allSpans = document.querySelectorAll('#modalPrompt span[data-original]');
    allSpans.forEach(span => {
        if (span.dataset.original !== name) return;
        if (value && value.trim() !== '') {
            // 用户输入了值：显示值
            span.innerText = value;
        } else {
            // 用户清空了输入：恢复显示占位符 {{variable}}
            span.innerText = `{{${name}}}`;
        }
    });
}

// --- Copy Logic ---

window.copyModalPrompt = function() {
    let textToCopy = window.rawPrompt;
    const regex = /\{\{(.*?)\}\}/g;

    // 执行最终替换：将 {{key}} 替换为用户输入的值
    if (regex.test(textToCopy)) {
        textToCopy = textToCopy.replace(regex, (match, p1) => {
            const varName = p1.trim();
            const userValue = window.currentVars[varName];
            // 策略：如果用户填了值就替换，没填就保留 {{key}} 方便后续手动处理
            return userValue ? userValue : match;
        });
    }

    const btn = document.getElementById('btnCopyPrompt');
    const onSuccess = () => {
        if(btn) {
            // 保存原始 HTML
            const originalHtml = btn.innerHTML;

            // [Minimalist Feedback] 极简反馈：只变图标和文字，不改变背景色
            btn.innerHTML = '<i class="bi bi-check2 me-1"></i> <span>Copied</span>';

            // 切换颜色状态：从灰色/蓝色 变为 绿色
            btn.classList.remove('text-secondary');
            btn.classList.add('text-success');

            // 2秒后自动恢复
            setTimeout(() => {
                btn.innerHTML = originalHtml;
                btn.classList.remove('text-success');
                btn.classList.add('text-secondary');
            }, 2000);
        }

        // Stats Copy (复制量打点)
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
        if (window.currentImgId && csrfToken) {
            fetch(`/api/stats/copy/${window.currentImgId}`, {
                method: 'POST',
                headers: {'X-CSRFToken': csrfToken}
            }).catch(() => {});
        }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy)
            .then(onSuccess)
            .catch((err) => {
                console.error("Clipboard API failed:", err);
                fallbackCopy(textToCopy, btn, onSuccess);
            });
    } else {
        fallbackCopy(textToCopy, btn, onSuccess);
    }
}

function fallbackCopy(text, parentBtn, callback) {
    try {
        const textArea = document.createElement("textarea");
        textArea.value = text;

        // 避免页面滚动
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";

        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (successful && callback) callback();
    } catch (err) {
        console.error("Copy failed:", err);
        alert("复制失败，请手动复制 Prompt");
    }
}
