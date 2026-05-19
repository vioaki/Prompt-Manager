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
        const isVideo = /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(data.file_path || '');

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
            // A. 生成高亮 Prompt HTML
            // 给每个变量 span 一个唯一的 ID，方便 updateVar 函数精确定位更新
            let varIndex = 0;
            const highlightedHtml = window.rawPrompt.replace(regex, (match, p1) => {
                const varName = p1.trim();
                const spanId = `preview-var-${varName}-${varIndex++}`;
                // data-original 用于后续查找所有同名变量
                return `<span id="${spanId}" class="prompt-var-highlight" data-original="${varName}">${match}</span>`;
            });
            promptContainer.innerHTML = highlightedHtml;

            // B. 生成变量输入列表
            varsContainer.innerHTML = '';
            const uniqueVars = new Set();

            matches.forEach(match => {
                const varName = match[1].trim();
                // 去重：如果同一个变量出现多次，只生成一个输入框
                if (!uniqueVars.has(varName)) {
                    uniqueVars.add(varName);
                    window.currentVars[varName] = ""; // 初始化值

                    const div = document.createElement('div');
                    div.className = 'var-input-row animate-up'; // 使用 style.css 中定义的 iOS 风格样式
                    div.innerHTML = `
                        <div class="var-label" title="${varName}">${varName}</div>
                        <input type="text" class="var-input"
                               placeholder="Value"
                               autocomplete="off"
                               oninput="window.updateVar('${varName}', this.value)">
                    `;
                    varsContainer.appendChild(div);
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
    tagsContainer.innerHTML = '';
    data.tags.forEach(tag => {
        tagsContainer.innerHTML += `<span class="badge rounded-pill fw-normal border me-1" style="background:var(--btn-bg); color:var(--text-primary); border-color: rgba(128,128,128,0.2) !important;">${tag}</span>`;
    });

    // Refs (参考图)
    const refsSection = document.getElementById('modalRefsSection');
    const refsContainer = document.getElementById('modalRefs');
    refsContainer.innerHTML = '';

    if (data.refs && data.refs.length > 0) {
        refsSection.classList.remove('d-none');
        // 添加效果图作为第一个参考
        refsContainer.innerHTML += `
        <div class="d-flex flex-column align-items-center cursor-pointer me-2" onclick="document.getElementById('modalImg').src='${data.file_path}'">
            <img src="${data.file_path}" class="rounded border mb-1" style="width:60px;height:60px;object-fit:cover;">
            <span style="font-size:0.6rem;color:var(--text-secondary);">效果图</span>
        </div>`;

        data.refs.forEach((ref, idx) => {
            let innerHTML = '';
            if (ref.is_placeholder) {
                innerHTML = `
                <div class="rounded border mb-1 d-flex flex-column align-items-center justify-content-center bg-light text-secondary" style="width:60px;height:60px; border-style: dashed !important;">
                    <i class="bi bi-person-bounding-box" style="font-size: 1.2rem;"></i>
                </div>
                <span style="font-size:0.6rem;color:var(--text-secondary);">变量 ${idx+1}</span>`;
            } else {
                innerHTML = `
                <img src="${ref.file_path}" class="rounded border mb-1" style="width:60px;height:60px;object-fit:cover;">
                <span style="font-size:0.6rem;color:var(--text-secondary);">Ref ${idx+1}</span>`;
            }

            const div = document.createElement('div');
            div.className = 'd-flex flex-column align-items-center cursor-pointer me-1';
            // 只有非占位符图片才支持点击切换大图
            if (!ref.is_placeholder) {
                div.onclick = function() { document.getElementById('modalImg').src = ref.file_path; };
            }
            div.innerHTML = innerHTML;
            refsContainer.appendChild(div);
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

    // 查找所有关联这个变量名的 span
    const spans = document.querySelectorAll(`span[data-original="${name}"]`);
    spans.forEach(span => {
        if (value && value.trim() !== '') {
            // 用户输入了值：显示值，去除下划线/特殊样式，使其看起来像普通文本但保留高亮色
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
