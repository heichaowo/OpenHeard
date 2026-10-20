// 测试用的假 llama-server。真的那个要 2.5 GB 的模型，这里只学它的接口。
// 行为写在 -m 指的那个「模型文件」里（一段 JSON），测试不用靠环境变量传话。
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const val = (flag) => args[args.indexOf(flag) + 1];
const behavior = JSON.parse(readFileSync(val('-m'), 'utf8'));

if (behavior.log) appendFileSync(behavior.log, `${JSON.stringify({ argv: args, pid: process.pid })}\n`);

for (let i = 0; i < (behavior.stderrLines ?? 0); i++) console.error(`log line ${i}`);
if (behavior.mode === 'die') {
  console.error('bind failed');
  process.exit(1);
}
if (behavior.mode === 'ignore-term') process.on('SIGTERM', () => {});

const readyAt = Date.now() + (behavior.healthDelayMs ?? 0);
createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(Date.now() >= readyAt ? 200 : 503).end('{"status":"ok"}');
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (behavior.log) appendFileSync(behavior.log, `${JSON.stringify({ url: req.url, body: JSON.parse(body) })}\n`);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: behavior.reply } }] }));
    }, behavior.replyDelayMs ?? 0);
  });
}).listen(Number(val('--port')), val('--host'));
