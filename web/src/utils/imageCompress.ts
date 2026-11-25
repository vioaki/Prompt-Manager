import { MAX_GIF_BYTES, MAX_IMAGE_BYTES } from '@prompt-pages/shared';

export interface CompressedMediaBundle {
  mainFile: File;
  thumbFile: File;
  width: number;
  height: number;
  originalBytes: number;
  compressedBytes: number;
  previewUrl: string;
}

const ACCEPTED_MIME = new Set([
  'image/webp',
  'image/gif',
  'image/jpeg',
  'image/png',
]);

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('图片编码失败'));
      },
      mime,
      quality,
    );
  });
}

async function renderScaledCanvas(
  bitmap: ImageBitmap,
  maxDimension: number,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const ratio = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { canvas, width, height };
}

export async function compressMainImage(file: File): Promise<CompressedMediaBundle> {
  if (!ACCEPTED_MIME.has(file.type) && !/\.(webp|gif|jpe?g|png)$/i.test(file.name)) {
    throw new Error('不支持的文件格式，仅支持 JPG / PNG / WebP / GIF 图片（不支持视频）');
  }

  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
  const bitmap = await createImageBitmap(file);

  try {
    if (isGif) {
      if (file.size > MAX_GIF_BYTES) {
        throw new Error(`GIF 体积不能超过 ${Math.round(MAX_GIF_BYTES / (1024 * 1024))}MB`);
      }
      const { canvas: thumbCanvas } = await renderScaledCanvas(bitmap, 480);
      const thumbBlob = await canvasToBlob(thumbCanvas, 'image/webp', 0.8);
      const thumbFile = new File([thumbBlob], 'thumb.webp', { type: 'image/webp' });
      return {
        mainFile: new File([file], 'main.gif', { type: 'image/gif' }),
        thumbFile,
        width: bitmap.width,
        height: bitmap.height,
        originalBytes: file.size,
        compressedBytes: file.size,
        previewUrl: URL.createObjectURL(file),
      };
    }

    const { canvas: mainCanvas, width, height } = await renderScaledCanvas(bitmap, 1600);
    const mainBlob = await canvasToBlob(mainCanvas, 'image/webp', 0.84);
    if (mainBlob.size > MAX_IMAGE_BYTES) {
      throw new Error(`压缩后图片仍超过 ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB，请缩小分辨率`);
    }

    const { canvas: thumbCanvas } = await renderScaledCanvas(bitmap, 480);
    const thumbBlob = await canvasToBlob(thumbCanvas, 'image/webp', 0.8);

    const mainFile = new File([mainBlob], 'main.webp', { type: 'image/webp' });
    const thumbFile = new File([thumbBlob], 'thumb.webp', { type: 'image/webp' });

    return {
      mainFile,
      thumbFile,
      width,
      height,
      originalBytes: file.size,
      compressedBytes: mainBlob.size,
      previewUrl: URL.createObjectURL(mainBlob),
    };
  } finally {
    bitmap.close();
  }
}

export async function compressRefImage(file: File): Promise<{ file: File; previewUrl: string }> {
  if (!ACCEPTED_MIME.has(file.type) && !/\.(webp|gif|jpe?g|png)$/i.test(file.name)) {
    throw new Error('参考图仅支持 JPG / PNG / WebP / GIF');
  }
  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
  if (isGif) {
    if (file.size > MAX_GIF_BYTES) {
      throw new Error('参考 GIF 过大');
    }
    return {
      file: new File([file], 'ref.gif', { type: 'image/gif' }),
      previewUrl: URL.createObjectURL(file),
    };
  }

  const bitmap = await createImageBitmap(file);
  try {
    const { canvas } = await renderScaledCanvas(bitmap, 1400);
    const blob = await canvasToBlob(canvas, 'image/webp', 0.82);
    const outFile = new File([blob], 'ref.webp', { type: 'image/webp' });
    return { file: outFile, previewUrl: URL.createObjectURL(blob) };
  } finally {
    bitmap.close();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
