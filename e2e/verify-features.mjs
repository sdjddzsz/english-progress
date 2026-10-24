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
  const llmPosts = [];
  page.on('request', (r) => {
    if (r.url().includes('/.cloud/')) {
      cloudLog.push({ method: r.method(), url: r.url().replace(BASE, ''), prefer: r.headers()['prefer'] ?? '' });
      if (r.url().includes('/.cloud/llm') && r.method() === 'POST') {
        try {
          llmPosts.push(JSON.parse(r.postData() ?? '{}'));
        } catch {
          /* ignore */
        }
      }
    }
  });

  // ===== 0) 首页 =====
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const homeText = await page.locator('body').innerText();
  check('首页渲染（四阶段卡片+词表按钮）', homeText.includes('词表') && homeText.includes('阶段一'), '');
  // 计划卡改四阶段真实节奏（用户 2026-10-23）：不再有 tier 模型的「超出预算」红警告，
  // 改为「剩余/已毕业 + 近 14 天节奏 + 预计完成日」三段式
  check(
    '计划卡显示四阶段真实节奏（剩余词+近14天节奏+预计完成日，无旧红警告）',
    /剩余 \d+ 词 · 已彻底毕业 \d+ 词/.test(homeText) &&
      /近 14 天：学习 \d+ 天/.test(homeText) &&
      homeText.includes('预计完成日') &&
      !homeText.includes('按当前参数完不成'),
    homeText.match(/剩余[^\n]*|近 14 天[^\n]*|预计完成日[^\n]*|按当前参数[^\n]*/g)?.slice(0, 3).join(' | ') ?? '',
  );
  // 今日检测统计（用户 2026-10-23）：今天答过多少词 + 其中多少第一次出现
  check(
    '计划卡显示今日检测统计（检测 N 词 · 其中第一次出现 M 词）',
    /今天：检测 \d+ 词（无论过没过）· 其中第一次出现 \d+ 词/.test(homeText),
    homeText.match(/今天：检测[^\n]*/g)?.[0] ?? '(未找到)',
  );

  // ===== 0b) 云端聚合链路（用户 2026-10-24：统计改云端算）=====
  // 背景：云资源拥挤、客户端拉全表 book_words（8296 行 / 9 个串行分页请求）常失败。
  // 现在首页统计全部由 PG 函数 ep_home_summary / ep_today_quiz 在云端算好，客户端直拉。
  const rpcLog = cloudLog.filter((c) => c.url.includes('/rpc/'));
  const homeBwLog = cloudLog.filter((c) => c.url.includes('/book_words'));
  check(
    '首页统计走云端 RPC（ep_home_summary + ep_today_quiz）',
    rpcLog.some((c) => c.url.includes('ep_home_summary')) && rpcLog.some((c) => c.url.includes('ep_today_quiz')),
    rpcLog.map((c) => `${c.method} ${c.url.replace('/.cloud/database/rest', '')}`).join(' | ') || '(无)',
  );
  check(
    '首页零 book_words 请求（旧实现 = 9 个全表分页请求拉 8296 行）',
    homeBwLog.length === 0,
    homeBwLog.map((c) => c.url.slice(0, 70)).join(' | ') || '(无)',
  );
  // 统计数值真值：直接打 mock 的 rpc 端点拿云端聚合结果，与页面显示逐项对账
  // （防「请求走了 RPC 但页面数字还是客户端旧逻辑算的」这种半吊子改造）
  const todayUtc = new Date().toISOString().slice(0, 10);
  const rpcHome = await (
    await fetch(`${BASE}/.cloud/database/rest/rpc/ep_home_summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_book_id: 'e2e-book-1' }),
    })
  ).json();
  const rpcToday = await (
    await fetch(`${BASE}/.cloud/database/rest/rpc/ep_today_quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_book_id: 'e2e-book-1', p_today: todayUtc }),
    })
  ).json();
  check(
    '计划卡剩余/毕业数与云端聚合一致',
    homeText.includes(`剩余 ${rpcHome.remaining} 词 · 已彻底毕业 ${rpcHome.graduated} 词`),
    `页面期望「剩余 ${rpcHome.remaining} · 毕业 ${rpcHome.graduated}」`,
  );
  check(
    '计划卡节奏天数与云端聚合一致（近 14 天学习 N 天）',
    homeText.includes(`近 14 天：学习 ${rpcHome.dailyCounts.length} 天`),
    `云端 dailyCounts=${rpcHome.dailyCounts.length} 天`,
  );
  check(
    '今日检测数与云端聚合一致（检测/第一次出现两个数都对账）',
    homeText.includes(`今天：检测 ${rpcToday.words} 词`) && homeText.includes(`其中第一次出现 ${rpcToday.firstSeen} 词`),
    `云端 words=${rpcToday.words} / firstSeen=${rpcToday.firstSeen}`,
  );
  // 四阶段卡片词库量（2026-10-24 起也走云端 ep_stage_stats，首页不再拉全表）
  const rpcStage = await (
    await fetch(`${BASE}/.cloud/database/rest/rpc/ep_stage_stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_book_id: 'e2e-book-1' }),
    })
  ).json();
  check(
    '四阶段卡片词库量与云端聚合一致（阶段一/二有数，不再拉全表算）',
    homeText.includes(`词库 ${rpcStage.byStage['1']} 词`) && homeText.includes(`词库 ${rpcStage.byStage['2']} 词`),
    `云端 byStage=${JSON.stringify(rpcStage.byStage)}`,
  );
  check(
    '特种训练词数与云端聚合一致（有才显示）',
    rpcStage.specialByStage['1'] > 0 ? homeText.includes(`特种训练 ${rpcStage.specialByStage['1']} 词`) : true,
    `云端 specialByStage=${JSON.stringify(rpcStage.specialByStage)}`,
  );

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
  // 临时模型联动（用户 2026-10-23）：问答框选临时模型 ⇒ 例句生成用同一模型
  const modelSelect = page.locator('[aria-label="AI 模型（本轮临时选择）"]').first();
  if ((await modelSelect.count()) > 0) {
    await modelSelect.click();
    await page.waitForTimeout(500);
    const opt = page.getByRole('option', { name: 'step-6-turbo' });
    if ((await opt.count()) > 0) {
      await opt.click();
      await page.waitForTimeout(400);
      console.log('（已选临时模型 step-6-turbo）');
    } else {
      console.log('（模型下拉无 step-6-turbo 选项——mock models 端点可能没生效）');
    }
  }
  // 点第一个选项作答（揭示释义区）
  const optButtons = page.locator('button').filter({ hasText: /放弃|抛弃|放任|沉溺|离开|遗弃/ });
  if ((await optButtons.count()) > 0) await optButtons.first().click().catch(() => {});
  else await page.locator('button[style*="border"]').first().click().catch(() => {});
  await page.waitForTimeout(1500);
  const afterAnswer = await page.locator('body').innerText();
  check('作答后显示全部释义区', afterAnswer.includes('的全部释义'), '');

  // 右键（=长按）**子义项**（用户 2026-10-23：逗号拆开后每条意思单独生成）
  const subSpan = page.getByText('放弃', { exact: true }).last();
  await subSpan.waitFor({ timeout: 6000 }).catch(() => {});
  const subBox = await subSpan.boundingBox().catch(() => null);
  if (subBox) {
    await page.mouse.click(subBox.x + subBox.width / 2, subBox.y + subBox.height / 2, { button: 'right' });
  }
  await page.waitForTimeout(800);
  const genItem = page.getByRole('menuitem', { name: '生成例句（放弃）' });
  const menuVisible = await genItem.isVisible().catch(() => false);
  check('右键子义项弹出菜单（「生成例句（放弃）」——只含那一条意思）', menuVisible, menuVisible ? '' : `子义项定位=${Boolean(subBox)} 片段=${afterAnswer.slice(0, 60)}`);
  const editBtn = page.locator('button[aria-label^="编辑义项"]').first();
  check('义项编辑入口独立（行尾铅笔按钮，不与子义项长按冲突）', (await editBtn.count()) > 0, '');
  if (menuVisible) {
    await genItem.click();
    await page.waitForTimeout(5000);
    const afterGen = await page.locator('body').innerText();
    check('生成例句成功（LLM SSE → 例句块出现）', afterGen.includes('abandon the sinking ship') && afterGen.includes('他们决定弃船'), '');
    // 子义项提示词：请求体里只带「放弃」这一条，不带兄弟义项「抛弃」
    const lastLlm = llmPosts[llmPosts.length - 1];
    const userMsg = lastLlm?.messages?.find((m) => m.role === 'user')?.content ?? '';
    check(
      '生成提示词只含该子义项（义项释义：放弃，不含抛弃）',
      userMsg.includes('义项释义：放弃') && !userMsg.includes('抛弃'),
      userMsg.match(/义项释义：[^\n]*/)?.[0] ?? '(无)',
    );
    // 临时模型联动断言：本次生成请求体的 model = 问答框选中的临时模型
    check(
      '例句生成跟随问答框临时模型（model=step-6-turbo）',
      lastLlm?.model === 'step-6-turbo',
      `请求体 model=${lastLlm?.model ?? '(无)'}`,
    );
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
