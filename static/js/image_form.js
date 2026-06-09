/**
 * static/js/image_form.js
 * 负责上传和编辑页面的表单交互逻辑
 */

document.addEventListener('DOMContentLoaded', function() {
    'use strict';

    const form = document.getElementById('imageForm');
    if (!form) return;

    // DOM Elements
    const mode = form.getAttribute('data-mode');
    const submitBtn = document.getElementById('submitBtn');

    // Type Selection
    const cardTxt2Img = document.querySelector('.type-selector-card[data-type="txt2img"]');
    const cardImg2Img = document.querySelector('.type-selector-card[data-type="img2img"]');

    // Reference Image Area
    const refUploadArea = document.getElementById('refUploadArea');
    const refContainer = document.getElementById('refContainer');
    const refEmptyMsg = document.getElementById('refEmptyMsg');
    const tempRefInput = document.getElementById('tempRefInput');
    const finalRefInput = document.getElementById('finalRefInput');
    const btnAddRef = document.getElementById('btnAddRef');
    const refLayoutInput = document.getElementById('refLayoutInput');

    // Tag Input
    const tagInput = document.getElementById('tagInput');
    const tagContainer = document.getElementById('tagWrapper');
    const realTagsInput = document.getElementById('realTagsInput');

    // State
    let newRefFiles = [];
    let deletedRefIds = [];
    let tags = [];

    // Initialization
    function init() {
        if (mode === 'edit') {
            try {
                // Restore tags
                tags = JSON.parse(form.getAttribute('data-existing-tags') || '[]');
                renderTags();

                // Restore reference images
                const existingRefs = JSON.parse(form.getAttribute('data-existing-refs') || '[]');

                existingRefs.forEach((ref) => {
                    if (ref.is_placeholder) {
                        appendPlaceholder(ref.id, 'existing');
                    } else {
                        appendExistingRef(ref.file_path, ref.id);
                    }
                });
            } catch (e) { console.error('Data restore failed:', e); }
        } else if (realTagsInput.value) {
            tags = realTagsInput.value.split(',').filter(t => t.trim());
            renderTags();
        }

        checkRefEmptyState();
        initSortable();
        updateIndices();
        initDragAndDrop();
    }

    // Drag and Drop Logic
    function initDragAndDrop() {
        const dropZones = [
            { el: document.querySelector('.upload-zone'), type: 'main' },
            { el: document.getElementById('refContainer'), type: 'ref' }
        ];

        dropZones.forEach(zone => {
            if (!zone.el) return;

            zone.el.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
                    zone.el.classList.add('drag-active');
                    e.dataTransfer.dropEffect = 'copy';
                } else {
                    zone.el.classList.remove('drag-active');
                }
            });

            zone.el.addEventListener('dragleave', (e) => {
                e.preventDefault();
                zone.el.classList.remove('drag-active');
            });

            zone.el.addEventListener('drop', (e) => {
                if (e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
                    e.preventDefault();
                    e.stopPropagation();
                    zone.el.classList.remove('drag-active');

                    const files = e.dataTransfer.files;
                    if (files.length === 0) return;

                    if (zone.type === 'main') {
                        const mainInput = document.getElementById('mainImageInput');
                        const dt = new DataTransfer();
                        dt.items.add(files[0]);
                        mainInput.files = dt.files;
                        mainInput.dispatchEvent(new Event('change'));
                    } else if (zone.type === 'ref') {
                        handleRefFiles(files);
                    }
                }
            });
        });
    }

    // Placeholder Logic
    function appendPlaceholder(idOrUid, type) {
        const div = document.createElement('div');
        div.className = 'draggable-item position-relative d-inline-block rounded-3 overflow-hidden shadow-sm bg-light border border-2 border-secondary';
        div.style.borderStyle = 'dashed !important';
        div.style.width = '100px'; div.style.height = '100px';

        div.setAttribute('data-type', type === 'existing' ? 'existing-placeholder' : 'placeholder');

        if (type === 'existing') {
            div.setAttribute('data-ref-id', idOrUid);
        } else {
            div.setAttribute('data-uid', idOrUid);
        }

        div.innerHTML = `
            <div class="w-100 h-100 d-flex flex-column align-items-center justify-content-center text-secondary opacity-75">
                <i class="bi bi-person-bounding-box fs-3 mb-1"></i>
                <span class="x-small fw-bold">{{User}}</span>
            </div>
            <div class="btn-remove-ref" title="移除"><i class="bi bi-x pointer-events-none"></i></div>
            <div class="index-badge"></div>
        `;

        refContainer.insertBefore(div, refEmptyMsg);
    }

    if (document.getElementById('btnAddPlaceholder')) {
        document.getElementById('btnAddPlaceholder').addEventListener('click', function() {
            const uid = 'ph_' + Date.now();
            appendPlaceholder(uid, 'new');
            checkRefEmptyState();
            updateIndices();
        });
    }

    // Type Toggling
    function toggleType(type) {
        if (type === 'txt2img') {
            cardTxt2Img.classList.add('active');
            cardImg2Img.classList.remove('active');
            cardTxt2Img.querySelector('input').checked = true;
            refUploadArea.classList.add('d-none');
        } else {
            cardImg2Img.classList.add('active');
            cardTxt2Img.classList.remove('active');
            cardImg2Img.querySelector('input').checked = true;
            refUploadArea.classList.remove('d-none');
            refUploadArea.animate([
                { opacity: 0, transform: 'translateY(-10px)' },
                { opacity: 1, transform: 'translateY(0)' }
            ], { duration: 300, easing: 'ease-out', fill: 'forwards' });
            setTimeout(initSortable, 100);
        }
    }
    if(cardTxt2Img) cardTxt2Img.addEventListener('click', () => toggleType('txt2img'));
    if(cardImg2Img) cardImg2Img.addEventListener('click', () => toggleType('img2img'));

    // Main Image / Video Preview
    const mainInput = document.getElementById('mainImageInput');
    const posterInput = document.getElementById('posterInput');
    const mainPreview = document.getElementById('mainPreview');
    const mainPreviewVideo = document.getElementById('mainPreviewVideo');
    const uploadZone = document.querySelector('.upload-zone');
    const btnChangeMedia = document.getElementById('btnChangeMedia');

    // 显式的“更换”入口：避免选好文件后整块区域仍捕获点击导致误触重选。
    if (btnChangeMedia && mainInput) {
        btnChangeMedia.addEventListener('click', () => mainInput.click());
    }

    // edit 模式下若已有主作品，进入页面即处于“已有预览”状态，需可交互。
    if (uploadZone && (mainPreview && mainPreview.getAttribute('src') ||
                       mainPreviewVideo && mainPreviewVideo.getAttribute('src'))) {
        uploadZone.classList.add('has-media');
    }

    if (mainInput) {
        mainInput.addEventListener('change', function() {
            if (!(this.files && this.files[0])) return;
            const file = this.files[0];
            document.getElementById('mainPlaceholder').classList.add('d-none');
            if (uploadZone) uploadZone.classList.add('has-media');

            if (file.type.startsWith('video/')) {
                showVideoPreview(file);
            } else {
                showImagePreview(file);
            }
        });
    }

    function showImagePreview(file) {
        if (mainPreviewVideo) {
            mainPreviewVideo.pause();
            mainPreviewVideo.removeAttribute('src');
            mainPreviewVideo.classList.add('d-none');
        }
        clearPoster();
        const reader = new FileReader();
        reader.onload = (e) => {
            mainPreview.src = e.target.result;
            mainPreview.classList.remove('d-none');
        };
        reader.readAsDataURL(file);
    }

    function showVideoPreview(file) {
        if (mainPreview) {
            mainPreview.src = '';
            mainPreview.classList.add('d-none');
        }
        const url = URL.createObjectURL(file);
        if (mainPreviewVideo) {
            mainPreviewVideo.src = url;
            mainPreviewVideo.classList.remove('d-none');
        }
        captureVideoPoster(file);
    }

    function clearPoster() {
        if (posterInput) posterInput.value = '';
    }

    // 客户端截取视频首帧作为封面，随表单一并提交。失败则留空，由后端/前端兜底占位。
    function captureVideoPoster(file) {
        clearPoster();
        if (!posterInput || typeof HTMLCanvasElement === 'undefined') return;

        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        const url = URL.createObjectURL(file);
        video.src = url;

        const cleanup = () => URL.revokeObjectURL(url);

        video.addEventListener('loadeddata', () => {
            // 跳到一个非零的早期帧，规避某些编码首帧全黑
            try { video.currentTime = Math.min(0.1, video.duration || 0.1); } catch (e) { /* noop */ }
        });

        video.addEventListener('seeked', () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 640;
                canvas.height = video.videoHeight || 360;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    if (blob) {
                        const posterFile = new File([blob], 'poster.jpg', { type: 'image/jpeg' });
                        const dt = new DataTransfer();
                        dt.items.add(posterFile);
                        posterInput.files = dt.files;
                    }
                    cleanup();
                }, 'image/jpeg', 0.85);
            } catch (e) {
                console.warn('Poster capture failed:', e);
                cleanup();
            }
        });

        video.addEventListener('error', cleanup);
    }

    // Reference Images Logic
    if (btnAddRef && tempRefInput) {
        btnAddRef.addEventListener('click', () => tempRefInput.click());

        tempRefInput.addEventListener('change', function() {
            if (!this.files.length) return;
            handleRefFiles(this.files);
            this.value = '';
        });
    }

    function handleRefFiles(files) {
        Array.from(files).forEach(file => {
            if (!file.type.startsWith('image/')) return;
            file._uid = Date.now() + Math.random().toString(36).substr(2, 9);
            newRefFiles.push(file);
            const imgUrl = URL.createObjectURL(file);
            appendRefPreview(imgUrl, file._uid);
        });

        checkRefEmptyState();
        syncNewFilesInput();
        updateIndices();
    }

    function appendExistingRef(url, id) {
        const div = createRefElement(url, 'existing');
        div.setAttribute('data-ref-id', id);
        div.innerHTML += `<div class="index-badge"></div>`;
        refContainer.insertBefore(div, refEmptyMsg);
    }

    function appendRefPreview(url, uid) {
        const div = createRefElement(url, 'new');
        div.setAttribute('data-uid', uid);
        div.innerHTML += `<div class="index-badge"></div>`;
        refContainer.insertBefore(div, refEmptyMsg);
    }

    function createRefElement(src, type) {
        const div = document.createElement('div');
        div.className = 'draggable-item position-relative d-inline-block rounded-3 overflow-hidden shadow-sm';
        div.style.width = '100px'; div.style.height = '100px';
        div.setAttribute('data-type', type);
        div.innerHTML = `
            <img src="${src}" class="w-100 h-100 object-fit-cover">
            <div class="btn-remove-ref" title="移除"><i class="bi bi-x pointer-events-none"></i></div>
        `;
        return div;
    }

    // Remove Event Delegation
    if (refContainer) {
        refContainer.addEventListener('click', function(e) {
            const btn = e.target.closest('.btn-remove-ref');
            if (!btn) return;

            const item = btn.closest('.draggable-item');
            const type = item.getAttribute('data-type');

            if (type === 'existing' || type === 'existing-placeholder') {
                deletedRefIds.push(item.getAttribute('data-ref-id'));
                document.getElementById('deletedRefIds').value = deletedRefIds.join(',');
            } else if (type === 'new') {
                const uid = item.getAttribute('data-uid');
                const img = item.querySelector('img');
                if(img && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
                newRefFiles = newRefFiles.filter(f => f._uid !== uid);
                syncNewFilesInput();
            }
            item.remove();
            checkRefEmptyState();
            updateIndices();
        });
    }

    function updateIndices() {
        const items = Array.from(refContainer.querySelectorAll('.draggable-item'))
                           .filter(el => el.style.display !== 'none');

        items.forEach((el, idx) => {
            const badge = el.querySelector('.index-badge');
            if(badge) badge.innerText = (idx + 1);
        });
    }

    function syncNewFilesInput() {
        if (!finalRefInput) return;
        const newOrder = [];
        refContainer.querySelectorAll('.draggable-item[data-type="new"]').forEach(el => {
            const uid = el.getAttribute('data-uid');
            const file = newRefFiles.find(f => f._uid === uid);
            if (file) newOrder.push(file);
        });
        newRefFiles = newOrder;

        const dt = new DataTransfer();
        newRefFiles.forEach(f => dt.items.add(f));
        finalRefInput.files = dt.files;
    }

    function checkRefEmptyState() {
        const items = refContainer.querySelectorAll('.draggable-item');
        if (items.length > 0) refEmptyMsg.classList.add('d-none');
        else refEmptyMsg.classList.remove('d-none');
    }

    function initSortable() {
        if (typeof Sortable !== 'undefined' && refContainer && !refContainer._sortable) {
            refContainer._sortable = new Sortable(refContainer, {
                animation: 200,
                ghostClass: 'sortable-ghost',
                draggable: ".draggable-item",
                delay: 100,
                delayOnTouchOnly: true,
                onEnd: function() {
                    updateIndices();
                    syncNewFilesInput();
                }
            });
        }
    }

    // Tag Logic
    function renderTags() {
        tagContainer.querySelectorAll('.tag-pill').forEach(el => el.remove());
        tags.forEach((tag, index) => {
            const span = document.createElement('span');
            span.className = 'tag-pill';
            span.innerHTML = `${tag} <i class="bi bi-x-lg" data-idx="${index}"></i>`;
            tagContainer.insertBefore(span, tagInput);
        });
        realTagsInput.value = tags.join(',');
    }

    if (tagContainer && tagInput) {
        tagContainer.addEventListener('click', (e) => {
            if(e.target === tagContainer) tagInput.focus();
            if(e.target.classList.contains('bi-x-lg')) {
                tags.splice(e.target.getAttribute('data-idx'), 1); renderTags();
            }
        });
        tagInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const val = this.value.replace(/,|，/g, '').trim();
                if (val && !tags.includes(val)) { tags.push(val); renderTags(); }
                this.value = '';
            } else if (e.key === 'Backspace' && !this.value && tags.length) {
                tags.pop(); renderTags();
            }
        });
        tagInput.addEventListener('blur', function() {
             const val = this.value.replace(/,|，/g, '').trim();
             if (val && !tags.includes(val)) { tags.push(val); renderTags(); this.value = ''; }
        });
    }

    // Form Submission
    form.addEventListener('submit', function() {
        if (submitBtn) {
            setTimeout(() => {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>处理中...';
            }, 0);
        }

        const layout = [];
        refContainer.querySelectorAll('.draggable-item').forEach(el => {
            const type = el.getAttribute('data-type');
            if (type === 'existing') {
                layout.push(`existing:${el.getAttribute('data-ref-id')}`);
            } else if (type === 'existing-placeholder') {
                layout.push(`existing:${el.getAttribute('data-ref-id')}`);
            } else if (type === 'placeholder') {
                layout.push('placeholder');
            } else {
                layout.push('new');
            }
        });

        if(refLayoutInput) refLayoutInput.value = JSON.stringify(layout);
        syncNewFilesInput();
    });

    init();
});