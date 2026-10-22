/**
 * verify-features.mjs —— 本轮三项改动的 e2e 实测（用户 2026-10-22）：
 *  A. 词表页：服务端分页（book_words 请求 = 2 计数 + 1 取页）+ 列表渲染 + 计数正确；
 *  B. 笔记高亮：当前词有笔记 ⇒ 笔记图标金黄（warning.main #ed6c02），无笔记 ⇒ 淡灰；
 *  C. 例句：右键（=长按）释义 → 菜单「生成例句」→ LLM mock SSE → 例句块出现 → 删除消失；
 *  D. 布局：上一题/下一题在题卡上方（按钮 y < 单词 y），例句块在原按钮位置（页面下半部）。
 *
 * 前置：mock-server.mjs（4173）+ e2e 构建（dist-e2e）。
 * 用法：node e2e/verify-features.mjs
 */
import pw from 'file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright/index.js';
const { chromium } = pw;

const BASE = 'http://127.0.0.1:4173';
const SESSION_KEY = 'workbuddy-cloud.session.wbpk_e2e0000000000000000000000000';
const EXPIRES_AT = Date.now() + 24 * 3600 * 1000;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** 从 mock 云拉该用户全部笔记的 lemma 集合（与 app 同源接口） */
async function fetchNotedLemmas() {
  const res = await fetch(`${BASE}/.cloud/database/rest/word_notes?userId=eq.e2e-user-1`);
  const rows = await res.json();
  return new Set(rows.map((r) => r.lemma));
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
  await context.route('**/sw.js', (r) => r.abort());
  await context.route('**/workbox-*.js', (r) => r.abort());
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
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(1, 4).join('\n')}`));

  // 记录 .cloud 请求（方法 + Prefer 头，计数请求靠它识别）
  const cloudLog = [];
  page.on('request', (r) => {
    if (r.url().includes('/.cloud/')) {
      cloudLog.push({ method: r.method(), url: r.url().replace(BASE, ''), prefer: r.headers()['prefer'] ?? '' });
    }
  });

  // ===== 0) 首页 =====
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const homeText = await page.locator('body').innerText();
  check('首页渲染（四阶段卡片+词表按钮）', homeText.includes('词表') && homeText.includes('阶段一'), '');

  // ===== A) 词表页 =====
  cloudLog.length = 0;
  await page.getByRole('button', { name: '词表' }).first().click();
  await page.waitForTimeout(4000);
  await page.waitForFunction(() => !document.body.innerText.includes('加载'), null, { timeout: 8000 }).catch(() => {});
  const stageUrl = page.url();
  const stageText = await page.locator('body').innerText();
  check('词表页打开（URL=/stage/1）', stageUrl.endsWith('/stage/1'), stageUrl);
  check('词表页渲染列表', stageText.includes('本阶段词库') && stageText.includes('阶段一'), stageText.split('\n').slice(0, 6).join(' / '));
  const bwLog = cloudLog.filter((c) => c.url.includes('/book_words'));
  const countLog = bwLog.filter((c) => c.method === 'HEAD' || c.prefer.includes('count=exact'));
  const fetchLog = bwLog.filter((c) => !(c.method === 'HEAD' || c.prefer.includes('count=exact')));
  check('数据链路 = 2 计数 + 1 取页（旧实现 9 次全表拉取）', countLog.length === 2 && fetchLog.length === 1, `计数 ${countLog.length} / 取页 ${fetchLog.length}`);
  check('计数带 stage 过滤（stage=eq.1 与 stage=eq.0 各一次）', countLog.some((c) => c.url.includes('stage=eq.1')) && countLog.some((c) => c.url.includes('stage=eq.0')), countLog.map((c) => c.url.slice(-30)).join(' | '));
  check(
    '取页带 stage 过滤 + tier.desc,id.asc 排序 + offset/limit',
    (() => {
      const u = decodeURIComponent(fetchLog[0]?.url ?? '');
      return /stage=eq\.1/.test(u) && /order=tier\.desc,id\.asc/.test(u) && /offset=0/.test(u) && /limit=100/.test(u);
    })(),
    fetchLog[0]?.url ?? '(无)',
  );
  // 计数正确性：mock 里 stage1 = floor(8296*0.98)=8130
  check('计数正确（本阶段 8130 词，非全表 8296）', stageText.includes('本阶段词库 8130 词'), stageText.match(/本阶段词库 \d+ 词/)?.[0] ?? '(未找到)');

  // ===== 回总览 → 开始刷（阶段一）=====
  await page.getByRole('button', { name: '回总览' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /开始刷/ }).first().click();
  await page.waitForFunction(() => location.pathname.includes('/quiz'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const quizText = await page.locator('body').innerText();
  check('考查页出题', quizText.includes('上一题') && quizText.includes('下一题'), quizText.split('\n').slice(0, 4).join(' / '));

  // ===== D) 布局：按钮在上方 =====
  const btnBox = await page.getByRole('button', { name: '下一题' }).boundingBox().catch(() => null);
  const wordBox = await page.locator('h4').first().boundingBox().catch(() => null);
  check('上一题/下一题在页面上方（按钮 y < 单词 y）', Boolean(btnBox && wordBox && btnBox.y < wordBox.y), `按钮 y=${btnBox?.y?.toFixed(0)} 单词 y=${wordBox?.y?.toFixed(0)}`);

  // ===== B) 笔记高亮 =====
  const noteBtn = page.locator('button[aria-label^="note"]').first();
  await noteBtn.waitFor({ timeout: 8000 }).catch(() => {});
  const lemma = await page.locator('h4').first().innerText().catch(() => '');
  const notedLemmas = await fetchNotedLemmas();
  const shouldBeGolden = notedLemmas.has(lemma.trim());
  const noteColor = await noteBtn.evaluate((el) => getComputedStyle(el).color).catch(() => '');
  const golden = noteColor === 'rgb(249, 168, 37)';
  check(
    `笔记高亮与笔记状态一致（当前词 ${lemma}：${shouldBeGolden ? '有笔记→金黄' : '无笔记→淡灰'}）`,
    shouldBeGolden ? golden : !golden,
    `颜色=${noteColor}`,
  );

  // ===== C) 例句 =====
  // 点第一个选项作答（揭示释义区）
  const optButtons = page.locator('button').filter({ hasText: /放弃|抛弃|放任|沉溺|离开|遗弃/ });
  if ((await optButtons.count()) > 0) await optButtons.first().click().catch(() => {});
  else await page.locator('button[style*="border"]').first().click().catch(() => {});
  await page.waitForTimeout(1500);
  const afterAnswer = await page.locator('body').innerText();
  check('作答后显示全部释义区', afterAnswer.includes('的全部释义'), '');

  // 右键（=长按）第一条释义行 → 菜单
  const senseText = page.getByText(/^\d+\.\s/).first();
  await senseText.waitFor({ timeout: 6000 }).catch(() => {});
  const senseBox = await senseText.boundingBox().catch(() => null);
  if (senseBox) {
    await page.mouse.click(senseBox.x + senseBox.width / 2, senseBox.y + senseBox.height / 2, { button: 'right' });
  }
  await page.waitForTimeout(800);
  const genItem = page.getByRole('menuitem', { name: '生成例句' });
  const menuVisible = await genItem.isVisible().catch(() => false);
  check('右键/长按释义弹出菜单（含「生成例句」）', menuVisible, menuVisible ? '' : `释义行定位=${Boolean(senseBox)} 页面文本片段=${afterAnswer.slice(0, 60)}`);
  if (menuVisible) {
    await genItem.click();
    await page.waitForTimeout(5000);
    const afterGen = await page.locator('body').innerText();
    check('生成例句成功（LLM SSE → 例句块出现）', afterGen.includes('abandon the sinking ship') && afterGen.includes('他们决定弃船'), '');
    const playBtn = page.locator('button[aria-label^="play example"]').first();
    check('例句带 AI 朗读按钮', (await playBtn.count()) > 0, '');
    // 例句块位置：页面下半部（原按钮位置）——删之前测
    const exY = await page.getByText('例句（', { exact: false }).first().boundingBox().catch(() => null);
    const viewH = page.viewportSize().height;
    check('例句块在原上/下一题按钮位置（页面下半部）', Boolean(exY && exY.y > viewH * 0.5), `y=${exY?.y?.toFixed(0)} / 视口 ${viewH}`);
    const delBtn = page.locator('button[aria-label^="delete example"]').first();
    if ((await delBtn.count()) > 0) {
      await delBtn.click();
      await page.waitForTimeout(1500);
      const afterDel = await page.locator('body').innerText();
      check('例句可删除', !afterDel.includes('abandon the sinking ship'), '');
    }
  }

  check('全程无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ||| '));

  await page.screenshot({ path: 'e2e/shot-features.png', fullPage: false });
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e);
  process.exit(1);
});
