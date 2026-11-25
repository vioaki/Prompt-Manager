import {
  MAX_GIF_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_UPLOAD_BYTES,
  PromptMetaSchema,
  SubmitPayloadSchema,
  createPromptId,
  getContentDirRelativePath,
  normalizeTags,
  type AllowedMediaMimeType,
  type PromptMeta,
  type RefItem,
} from '@prompt-pages/shared';
import { authenticateRequest } from './auth.js';
import { detectImageMimeFromBytes, mimeToExtension } from './crypto.js';
import type { Env } from './env.js';
import { createSubmissionPullRequest, type FileMutation } from './github.js';

// Browsers normally send Content-Length. Bound chunked bodies before multipart parsing too.
export async function readUploadForm(request: Request): Promise<FormData | Response> {
  const maxBody = MAX_TOTAL_UPLOAD_BYTES + 128 * 1024;
  const tooLarge = () => Response.json({ error: '单次上传文件总量不能超过 4 MiB' }, { status: 413 });
  const length = request.headers.get('Content-Length');
  if (length !== null && Number(length) > maxBody) return tooLarge();
  let total = 0;
  try {
    let source: Request | Response = request;
    if (length === null && request.body) {
      const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxBody) throw new Error('multipart body too large');
          controller.enqueue(chunk);
        },
      }));
      source = new Response(bounded, { headers: request.headers });
    }
    const form = await source.formData();
    let fileBytes = 0;
    form.forEach((value) => {
      if (value instanceof File) fileBytes += value.size;
    });
    return fileBytes > MAX_TOTAL_UPLOAD_BYTES ? tooLarge() : form;
  } catch {
    return total > maxBody ? tooLarge() : Response.json({ error: '无效的 multipart/form-data 请求体' }, { status: 400 });
  }
}

export interface ValidatedUploadImage {
  bytes: Uint8Array;
  mime: AllowedMediaMimeType;
  ext: string;
}

export async function readAndValidateImageFile(
  file: File,
  label: string,
): Promise<ValidatedUploadImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`${label}为空文件`);
  }
  const mime = detectImageMimeFromBytes(bytes);
  if (!mime) {
    throw new Error(`${label}不是有效的图片格式（仅支持 WebP / GIF / PNG / JPEG，不支持视频）`);
  }
  const limit = mime === 'image/gif' ? MAX_GIF_BYTES : MAX_IMAGE_BYTES;
  if (bytes.byteLength > limit) {
    throw new Error(`${label}超过大小限制 (${Math.round(limit / (1024 * 1024))}MB)`);
  }
  return { bytes, mime, ext: mimeToExtension(mime) };
}

export async function handleSubmit(request: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(request, env);
  if (!user) {
    return Response.json({ error: '请先使用 GitHub 账号登录' }, { status: 401 });
  }

  const form = await readUploadForm(request);
  if (form instanceof Response) return form;

  const payloadRaw = form.get('payload');
  if (typeof payloadRaw !== 'string') {
    return Response.json({ error: '缺少表单元数据 payload' }, { status: 400 });
  }

  let parsedPayload;
  try {
    parsedPayload = SubmitPayloadSchema.parse(JSON.parse(payloadRaw));
  } catch (err) {
    return Response.json({ error: `表单校验失败: ${(err as Error).message}` }, { status: 400 });
  }

  const mainEntry = form.get('main');
  if (!(mainEntry instanceof File)) {
    return Response.json({ error: '缺少主图文件 main' }, { status: 400 });
  }

  let totalBytes = 0;
  let mainImg: ValidatedUploadImage;
  let thumbImg: ValidatedUploadImage;
  try {
    mainImg = await readAndValidateImageFile(mainEntry, '主图');
    totalBytes += mainImg.bytes.byteLength;

    const thumbEntry = form.get('thumb');
    if (thumbEntry instanceof File && thumbEntry.size > 0) {
      thumbImg = await readAndValidateImageFile(thumbEntry, '缩略图');
      totalBytes += thumbImg.bytes.byteLength;
    } else {
      thumbImg = mainImg;
    }
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const id = createPromptId(parsedPayload.title, now);
  const contentDir = getContentDirRelativePath(id, createdAt);

  const mainFilename = `main${mainImg.ext}`;
  const thumbFilename = thumbImg === mainImg ? mainFilename : `thumb${thumbImg.ext}`;

  const mutations: FileMutation[] = [
    { path: `${contentDir}/${mainFilename}`, content: mainImg.bytes },
  ];
  if (thumbFilename !== mainFilename) {
    mutations.push({ path: `${contentDir}/${thumbFilename}`, content: thumbImg.bytes });
  }

  const refs: RefItem[] = [];
  let refIndex = 0;
  try {
    for (const entry of parsedPayload.refLayout) {
      if (entry.kind === 'placeholder') {
        refs.push({ kind: 'placeholder', label: entry.label || 'User' });
      } else if (entry.kind === 'new-image') {
        const refFile = form.get(entry.field);
        if (!(refFile instanceof File)) {
          throw new Error(`缺少参考图文件字段 ${entry.field}`);
        }
        const validatedRef = await readAndValidateImageFile(refFile, `参考图 #${refIndex + 1}`);
        totalBytes += validatedRef.bytes.byteLength;
        if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
          throw new Error(`单次投稿总文件体积不能超过 ${Math.round(MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024))}MB`);
        }
        const refFilename = `ref-${refIndex}${validatedRef.ext}`;
        mutations.push({ path: `${contentDir}/${refFilename}`, content: validatedRef.bytes });
        refs.push({ kind: 'image', file: refFilename });
        refIndex += 1;
      }
    }
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const cleanTags = normalizeTags(parsedPayload.tags).tags;
  const trimmedAuthorName = parsedPayload.anonymous ? '' : parsedPayload.authorName.trim();
  const authorGithub = parsedPayload.anonymous || !trimmedAuthorName ? null : user.login;

  const meta: PromptMeta = PromptMetaSchema.parse({
    schemaVersion: 1,
    id,
    title: parsedPayload.title,
    category: parsedPayload.category,
    prompt: parsedPayload.prompt,
    description: parsedPayload.description,
    tags: cleanTags,
    author: {
      name: trimmedAuthorName,
      github: authorGithub,
    },
    media: {
      main: mainFilename,
      thumb: thumbFilename,
      mimeType: mainImg.mime,
      width: parsedPayload.mainWidth,
      height: parsedPayload.mainHeight,
    },
    refs,
    createdAt,
  });

  mutations.push({
    path: `${contentDir}/meta.json`,
    content: JSON.stringify(meta, null, 2) + '\n',
  });

  const pr = await createSubmissionPullRequest({
    env,
    user,
    meta,
    contentDir,
    files: mutations,
  });

  return Response.json(
    {
      id: meta.id,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      branch: pr.branch,
    },
    { status: 201 },
  );
}
