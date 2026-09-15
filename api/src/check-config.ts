// 装 launchd 之前先验配置，免得配错了变成一个每 30 秒重启一次、谁也看不见的循环。
//   node src/check-config.ts /path/to/openheard.config.json
import { loadConfig } from './config.ts';

const path = process.argv[2] ?? process.env.OPENHEARD_CONFIG ?? './openheard.config.json';
const result = loadConfig(path);
if (result.ok) {
  console.log(`配置没问题：${path}`);
  console.log(`  监听 ${result.config.host}，库在 ${result.config.dbPath}`);
  console.log(`  ${result.config.queries.length} 条查询，聚类阈值 ${result.config.clusterGapS} 秒`);
} else {
  console.error(`配置有问题：${path}`);
  for (const p of result.problems) console.error(`  ${p}`);
  process.exit(1);
}
