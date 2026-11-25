import { lintPromptDraft } from '@prompt-pages/shared';
import { discoverAndValidateContent, loadSiteConfig, resolvePaths } from './utils.js';

function main() {
  const { contentDir, siteConfigPath } = resolvePaths();
  loadSiteConfig(siteConfigPath);
  const { entries, errors } = discoverAndValidateContent(contentDir);

  let warningCount = 0;
  for (const entry of entries) {
    const { warnings } = lintPromptDraft({
      prompt: entry.meta.prompt,
      category: entry.meta.category,
      tags: entry.meta.tags,
    });
    warningCount += warnings.length;
  }

  console.log(
    `[validate] 扫描目录: ${contentDir}\n[validate] 有效作品: ${entries.length} 条, 错误: ${errors.length} 项, 规范提醒: ${warningCount} 项`,
  );

  if (errors.length > 0) {
    console.error('\n校验失败详情:');
    for (const err of errors) {
      console.error(`  - [${err.path}] ${err.message}`);
    }
    process.exit(1);
  }
}

main();
