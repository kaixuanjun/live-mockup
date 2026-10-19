/**
 * 本地开发服务器（Vite/Next/CRA 那类）代理适配测试。
 *
 * 起一个模拟 dev server：根相对资源、ESM 相对导入、fetch('/api/...')、
 * 动态 img、绝对 URL fetch —— 然后经 /p/ 载入，看哪些内容丢。
 */
import http from 'node:http';
import { launch, sleep } from './cdp.mjs';

const DEV_PORT = 5199;

const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Dev Fixture</title>
<link rel="stylesheet" href="/src/app.css">
<script type="module" src="/src/main.js"></script>
</head><body>
<div id="app"><p id="boot">booting…</p></div>
<img id="logo" src="/logo.png" alt="logo">
</body></html>`;

const MAIN = `import { label } from './lib.js';
document.getElementById('boot').textContent = 'imported:' + label;
const app = document.getElementById('app');
(async () => {
  const r = await fetch('/api/items');
  const items = await r.json();
  const ul = document.createElement('ul');
  ul.id = 'items';
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = it.name;
    ul.appendChild(li);
  }
  app.appendChild(ul);
  const abs = await fetch('http://localhost:${DEV_PORT}/api/items').then((x) => x.json());
  const p = document.createElement('p');
  p.id = 'abs';
  p.textContent = 'abs:' + abs.length;
  app.appendChild(p);
})();
`;

const LIB = `export const label = 'ok';
// 再引一张根相对图片，验证 JS 里造的 URL
const im = new Image(); im.id = 'jsimg'; im.src = '/logo2.png';
document.body.appendChild(im);
`;

const CSS = `body{background:#0f1116;color:#e8e8ef;font:16px system-ui}
#logo{width:40px;height:40px}#jsimg{width:20px;height:20px}`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const dev = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${DEV_PORT}`);
  const send = (code, type, body) => {
    // 故意不发 CORS 头：真实 dev server 大多如此，考验垫片能不能把请求拉回代理
    res.writeHead(code, { 'Content-Type': type });
    res.end(body);
  };
  if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', INDEX);
  if (url.pathname === '/src/main.js') return send(200, 'text/javascript; charset=utf-8', MAIN);
  if (url.pathname === '/src/lib.js') return send(200, 'text/javascript; charset=utf-8', LIB);
  if (url.pathname === '/src/app.css') return send(200, 'text/css; charset=utf-8', CSS);
  if (url.pathname === '/logo.png' || url.pathname === '/logo2.png') return send(200, 'image/png', PNG);
  if (url.pathname === '/api/items')
    return send(200, 'application/json', JSON.stringify([{ name: '一号' }, { name: '二号' }, { name: '三号' }]));
  return send(404, 'text/plain', 'nope ' + url.pathname);
});
await new Promise((r) => dev.listen(DEV_PORT, r));

const results = [];
const ok = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

const b = await launch({ port: 9334 });
try {
  // 1) 用「不带协议」的地址，看是否被强行补成 https
  const src = await b.evaluate(`''`);
  await b.goto('http://localhost:4321/', 2500);
  const mapped = await b.evaluate(`(() => {
    const i = document.querySelector('#urlInput');
    i.value = 'localhost:${DEV_PORT}';
    document.querySelector('#loadBtn').click();
    return new Promise((r) => setTimeout(() => {
      const f = document.querySelector('#frame');
      r({ src: f.getAttribute('src'), loading: document.querySelector('#stageLoading').className });
    }, 1200));
  })()`);
  console.log(`· 无协议地址 → ${mapped.src}`);
  ok('不带协议时补 http 而不是 https', mapped.src.startsWith('/p/http://localhost'), mapped.src);
  ok('站点根补了尾斜杠（相对路径才解析得对）', mapped.src.endsWith('/'), mapped.src);

  // 2) 完整 http:// 地址，看内容
  await b.goto('http://localhost:4321/', 2000);
  await b.goto(`http://localhost:4321/`, 500);
  await b.evaluate(`(() => {
    const i = document.querySelector('#urlInput');
    i.value = 'http://localhost:${DEV_PORT}/';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#loadBtn').click();
  })()`);
  await sleep(3200);

  const state = await b.evaluate(`(() => {
    const f = document.querySelector('#frame');
    const d = f.contentDocument;
    if (!d) return { cross: true };
    return {
      boot: d.querySelector('#boot')?.textContent || '',
      items: d.querySelectorAll('#items li').length,
      abs: d.querySelector('#abs')?.textContent || '',
      logo: (() => { const i = d.querySelector('#logo'); return i ? i.naturalWidth : -1; })(),
      jsimg: (() => { const i = d.querySelector('#jsimg'); return i ? i.naturalWidth : -1; })(),
      bg: getComputedStyle(d.body).backgroundColor,
      title: d.title,
    };
  })()`);
  console.log('· 页面状态', JSON.stringify(state));
  ok('页面骨架载入', state.title === 'Dev Fixture', state.title);
  ok('根相对 CSS 生效', state.bg === 'rgb(15, 17, 22)', state.bg);
  ok('ESM 相对导入执行', state.boot.startsWith('imported:'), state.boot);
  ok('根相对 <img> 显示', state.logo > 0, `naturalWidth=${state.logo}`);
  ok('JS 里 new Image 的根相对 URL 显示', state.jsimg > 0, `naturalWidth=${state.jsimg}`);
  ok('fetch("/api/items") 拿到数据', state.items === 3, `${state.items} 条`);
  ok('绝对 URL fetch 拿到数据', state.abs === 'abs:3', state.abs);
  await b.shot('17-devserver');
  console.log('· 截图 17-devserver');
} catch (e) {
  ok('测试未抛异常', false, e.message);
} finally {
  ok('无控制台错误', b.problems.length === 0, b.problems.slice(0, 6).join(' | '));
  await b.close();
  dev.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n═══ 结果 ═══');
if (failed.length) {
  console.log(`✗ ${failed.length}/${results.length} 项失败：`);
  failed.forEach((f) => console.log('  · ' + f.name));
  process.exit(1);
}
console.log(`✓ 本地 dev server 适配全部通过（${results.length} 项）`);
