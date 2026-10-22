/**
 * repro-stage-detail.mjs —— 复现「首页每个阶段的词表打不开」。
 *
 * 流程：Edge 打开 e2e 应用 → 预植 localStorage 会话 → 等首页渲染 → 点「词表」→
 * 抓 URL / 可见文本 / console 错误 / .cloud 请求序列，输出诊断报告。
 *
 * 用法：先起 mock-server.mjs（4173），再：
 *   NODE_PATH=<受管workspace>/node_modules node e2e/repro-stage-detail.mjs
 */
import pw from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright/index.js';
const { chromium } = pw;

const BASE = 'http://127.0.0.1:4173';
const SESSION_KEY = 'workbuddy-cloud.session.wbpk_e2e0000000000000000000000000';
const EXPIRES_AT = Date.now() + 24 * 3600 * 1000;

const consoleLines = [];
const cloudCalls = [];

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
  // 默认不拦 service worker（模拟用户重复使用的真实状态）；BLOCK_SW=1 时拦掉
  if (process.env.BLOCK_SW === '1') {
    await context.route('**/sw.js', (r) => r.abort());
    await context.route('**/workbox-*.js', (r) => r.abort());
  }
  await context.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    [SESSION_KEY, JSON.stringify({ accessToken: 'e2e', refreshToken: 'e2e', expiresAt: EXPIRES_AT, user: { id: 'e2e-user-1' } })],
  );

  const page = await context.newPage();
  page.on('console', (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text().slice(0, 300)}`);
  });
  page.on('pageerror', (err) => {
    consoleLines.push(`[pageerror] ${err.stack?.slice(0, 1500) ?? err.message.slice(0, 400)}`);
  });
  page.on('requestfailed', (req) => {
    consoleLines.push(`[requestfailed] ${req.url().slice(0, 160)} :: ${req.failure()?.errorText ?? ''}`);
  });
  page.on('request', (req) => {
    if (req.url().includes('/.cloud/')) cloudCalls.push(`${req.method()} ${req.url().replace(BASE, '')}`);
  });
  page.on('response', async (res) => {
    if (res.url().includes('/.cloud/')) {
      let tail = '';
      try {
        const body = await res.text();
        tail = body.length > 120 ? `${body.slice(0, 120)}…` : body;
      } catch {
        tail = '<no body>';
      }
      cloudCalls[cloudCalls.length - 1] += ` → ${res.status()} ${tail.replace(/\s+/g, ' ').slice(0, 160)}`;
    }
  });

  console.log('== 1) 打开首页 ==');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log('goto warn:', e.message));
  await page.waitForTimeout(3500);
  // 等 SW 注册完成（autoUpdate：首载注册，再刷一次就用上缓存壳）
  await page.waitForTimeout(2000);
  console.log('URL:', page.url());
  console.log('== 1.5) 首页加载期间的 .cloud 请求 ==');
  for (const c of cloudCalls) console.log('  ', c);
  console.log('== 1.6) 首页加载期间的 console/pageerror ==');
  for (const c of consoleLines.slice(0, 20)) console.log('  ', c);
  const homeText = (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 700);
  console.log('首页文本:', homeText);

  // === 二次加载（SW 已注册，模拟用户重复使用）===
  if (process.env.SKIP_RELOAD !== '1') {
    console.log('== 1.7) 刷新页面（SW 生效后） ==');
    cloudCalls.length = 0;
    consoleLines.length = 0;
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log('reload warn:', e.message));
    await page.waitForTimeout(4000);
    console.log('reload 后 .cloud 请求数:', cloudCalls.length);
    console.log('reload 后 console:', consoleLines.slice(0, 10).join(' || ') || '(无)');
    const homeText2 = (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 300);
    console.log('reload 后首页文本:', homeText2);
  }

  const wordListBtn = page.getByRole('button', { name: '词表' }).first();
  const btnCount = await page.getByRole('button', { name: '词表' }).count();
  console.log('「词表」按钮数:', btnCount);
  if (btnCount === 0) {
    console.log('!! 首页没有「词表」按钮——先记录 DOM 再退出');
    console.log((await page.content()).slice(0, 2000));
    await browser.close();
    return;
  }

  console.log('== 2) 点击第一个「词表」 ==');
  cloudCalls.length = 0;
  consoleLines.length = 0;
  const t0 = Date.now();
  await wordListBtn.click();
  await page.waitForTimeout(9000);
  console.log('点击后等待耗时(ms):', Date.now() - t0);
  console.log('URL:', page.url());
  const afterText = (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 900);
  console.log('点击后文本:', afterText);

  console.log('== 3) .cloud 请求序列 ==');
  for (const c of cloudCalls) console.log('  ', c);

  console.log('== 4) console/pageerror ==');
  for (const c of consoleLines.slice(0, 30)) console.log('  ', c);

  await page.screenshot({ path: 'e2e/shot-stage-detail.png', fullPage: false });
  await browser.close();
}

main().catch((e) => {
  console.error('REPRO FAILED:', e);
  process.exit(1);
});
