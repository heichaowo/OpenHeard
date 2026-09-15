// 生成配置里 adminPasswordHash 的值。
//   node src/hash-password.ts '你的口令'
import { hashPassword } from './auth.ts';

const pw = process.argv[2];
if (!pw) {
  console.error("用法: node src/hash-password.ts '你的口令'");
  process.exit(2);
}
console.log(hashPassword(pw));
