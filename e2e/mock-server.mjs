/**
 * mock-server.mjs —— e2e 复现专用「同源 mock 云」静态服务器（端口 4173）。
 *
 * 职责：
 *  1. 静态托管 e2e 构建产物（dist-e2e/，SPA fallback）；
 *  2. 拦截 /.cloud/auth、/.cloud/database/rest、/.cloud/llm 请求，按表返回 mock 数据；
 *  3. POST/PATCH/DELETE 简易回写内存（仅本次进程有效）。
 *
 * 用法：
 *   node e2e/mock-server.mjs            # 先构建：npx vite build --mode e2e --outDir dist-e2e
 *   # 浏览器 localStorage 播种会话后打开 http://127.0.0.1:4173/ ：
 *   #   key = "workbuddy-cloud.session.<VITE_CLOUD_PUBLISHABLE_KEY>"
 *   #   value = {"accessToken":"e2e","refreshToken":"e2e","expiresAt":<未来毫秒>,"user":{"id":"e2e-user-1"}}
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tables, USER_ID } from './mock-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../dist-e2e');
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.map': 'application/json',
};

function json(res, data, status = 200, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

/** 极简 PostgREST 过滤：URL 形如 `column=op.value`（eq/neq/in/gt/gte/lt/lte） */
function applyFilters(rows, params) {
  let out = rows;
  for (const [col, raw] of params.entries()) {
    if (col === 'select' || col === 'order' || col === 'offset' || col === 'limit' || col === 'on_conflict' || col === 'columns') continue;
    const dot = raw.indexOf('.');
    if (dot < 0) continue;
    const op = raw.slice(0, dot);
    const val = decodeURIComponent(raw.slice(dot + 1));
    if (!['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'].includes(op)) continue;
    const values = op === 'in' ? val.replace(/^\(|\)$/g, '').split(',') : [val];
    out = out.filter((r) => {
      const cell = r[col];
      const cellStr = cell == null ? '' : String(cell);
      switch (op) {
        case 'eq':
          return values.some((v) => cellStr === v);
        case 'neq':
          return values.every((v) => cellStr !== v);
        case 'in':
          return values.some((v) => cellStr === v);
        case 'gt':
          return cellStr > values[0];
        case 'gte':
          return cellStr >= values[0];
        case 'lt':
          return cellStr < values[0];
        case 'lte':
          return cellStr <= values[0];
        default:
          return true;
      }
    });
  }
  // order=a.desc,b.asc（多列依次比较）
  const order = params.get('order');
  if (order) {
    const orders = order.split(',').map((part) => {
      const [c, dir] = part.split('.');
      return { column: c, asc: dir !== 'desc' };
    });
    out = [...out].sort((a, b) => {
      for (const o of orders) {
        const av = a[o.column] == null ? '' : String(a[o.column]);
        const bv = b[o.column] == null ? '' : String(b[o.column]);
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return o.asc ? cmp : -cmp;
      }
      return 0;
    });
  }
  return out;
}

/**
 * /.cloud/database/rest/rpc/<fn> —— PG 函数 RPC（2026-10-24 云端聚合）。
 *
 * 忠实复刻线上两个函数的聚合语义（SQL 见 docs/交接-2026-10-24.md）：
 *  - owner_id = auth.uid() 过滤（mock 侧 = USER_ID）
 *  - dailyCounts：近 14 天、UTC 日、每天 distinct wordId、升序
 *  - wordsByTier：按 tier 分组，组内 listNo → orderInList → id 排序
 *  - ep_today_quiz：lastQuizAt / firstSeenAt 的 UTC 日 = p_today
 * HTTP 层回**裸函数结果**（PostgREST 语义）；{data,error} 信封是 SDK 客户端加的。
 */
async function handleRpc(req, res, fn) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let args = {};
  try {
    args = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    /* ignore */
  }
  const bookId = String(args.p_book_id ?? '');
  const rows = (tables.book_words ?? []).filter((r) => r.bookId === bookId && r.owner_id === USER_ID);
  const utcDate = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : '');

  if (fn === 'ep_home_summary') {
    const remaining = rows.filter((r) => r.stage > 0).length;
    const graduated = rows.filter((r) => r.stage === 0).length;
    const cutoff = Date.now() - 14 * 86400000;
    const perDay = new Map();
    for (const r of rows) {
      const at = r.lastQuizAt;
      if (typeof at !== 'string' || new Date(at).getTime() < cutoff) continue;
      const d = utcDate(at);
      let set = perDay.get(d);
      if (!set) {
        set = new Set();
        perDay.set(d, set);
      }
      set.add(String(r.wordId));
    }
    const dailyCounts = [...perDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, set]) => ({ date, count: set.size }));
    const byTier = new Map();
    for (const r of rows) {
      const t = r.tier;
      let arr = byTier.get(t);
      if (!arr) {
        arr = [];
        byTier.set(t, arr);
      }
      arr.push(r);
    }
    const tierCounts = {};
    const wordsByTier = {};
    for (const [t, arr] of byTier) {
      arr.sort(
        (a, b) =>
          a.listNo - b.listNo || a.orderInList - b.orderInList || String(a.id).localeCompare(String(b.id)),
      );
      tierCounts[String(t)] = arr.length;
      wordsByTier[String(t)] = arr.map((r) => String(r.wordId));
    }
    return json(res, { remaining, graduated, dailyCounts, tierCounts, wordsByTier });
  }

  if (fn === 'ep_today_quiz') {
    const today = String(args.p_today ?? '');
    const todayRows = rows.filter((r) => utcDate(r.lastQuizAt) === today);
    const firstSeenRows = rows.filter((r) => utcDate(r.firstSeenAt) === today);
    return json(res, {
      words: todayRows.length,
      firstSeen: firstSeenRows.length,
      wordIds: todayRows.map((r) => String(r.wordId)),
      firstSeenIds: firstSeenRows.map((r) => String(r.wordId)),
    });
  }

  if (fn === 'ep_stage_stats') {
    const byStage = {};
    const specialByStage = {};
    for (const r of rows) {
      const s = String(r.stage);
      byStage[s] = (byStage[s] ?? 0) + 1;
      if (r.specialTraining) specialByStage[s] = (specialByStage[s] ?? 0) + 1;
    }
    return json(res, { byStage, specialByStage });
  }

  // PostgREST 对不存在的函数回 404 + JSON 错误体（SDK 不 throw，交给调用方拆信封）
  return json(res, { message: `mock: unknown function ${fn}`, code: '404' }, 404);
}

async function handleCloudRest(req, res, url) {
  const m = /^\/\.cloud\/database\/rest\/([a-zA-Z_]+)$/.exec(url.pathname);
  if (!m) return json(res, { data: null, error: { message: `mock: unknown rest path ${url.pathname}` } }, 404);
  const table = m[1];
  if (!(table in tables)) return json(res, { data: [], error: null });
  const params = new URLSearchParams(url.search);
  const single = (req.headers.accept ?? '').includes('vnd.pgrst.object');
  const head = req.method === 'HEAD' || (req.headers.prefer ?? '').includes('count=');

  if (req.method === 'GET' || req.method === 'HEAD') {
    let rows = applyFilters(tables[table], params);
    const total = rows.length;
    // PostgREST 的 offset/limit 语义（listAll 分页依赖它：每页 1000 行）
    const offset = Number(params.get('offset') ?? 0);
    const limit = params.get('limit');
    if (Number.isFinite(offset) && offset > 0) rows = rows.slice(offset);
    if (limit != null && Number.isFinite(Number(limit))) rows = rows.slice(0, Number(limit));
    const pageTotal = rows.length;
    // ⚠ PostgREST 语义：响应体是**原始行数组**（不是 {data,error} 信封）——
    //   SDK 自己会包成 {success,error,data,count}；多包一层信封会让 data 变成对象，
    //   上层 [...data] 直接炸「Spread syntax requires ...iterable」。
    if (head) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Range': `0-${Math.max(0, pageTotal - 1)}/${total}`,
        'Preference-Applied': 'count=exact',
      });
      res.end();
      return;
    }
    // maybeSingle（Accept: vnd.pgrst.object+json）：SDK 会自行把数组收敛成单对象/ null，
    // 这里仍返回数组即可。
    return json(res, rows, 200, { 'Content-Range': `0-${Math.max(0, pageTotal - 1)}/${total}` });
  }

  // ===== 写操作：读 body，回写内存 =====
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = [];
  try {
    body = raw ? JSON.parse(raw) : [];
  } catch {
    body = [];
  }
  const rows = Array.isArray(body) ? body : [body];
  const bag = tables[table];
  // id 过滤：URL 形如 `?id=eq.<uuid>`（值带 op 前缀，要剥掉）
  const idRaw = params.get('id.eq') ?? params.get('id');
  const idEq = idRaw ? idRaw.replace(/^eq\./, '') : undefined;
  const targetIds = idEq ? [idEq] : rows.map((r) => r.id).filter(Boolean);

  if (req.method === 'POST') {
    // upsert：同 id 覆盖，否则追加
    for (const r of rows) {
      const i = bag.findIndex((x) => x.id === r.id);
      if (i >= 0) bag[i] = { ...bag[i], ...r };
      else bag.push(r);
    }
    return json(res, rows);
  }
  if (req.method === 'PATCH') {
    const updated = [];
    for (const r of rows) {
      const i = bag.findIndex((x) => targetIds.includes(x.id));
      if (i >= 0) {
        bag[i] = { ...bag[i], ...r };
        updated.push(bag[i]);
      }
    }
    return json(res, updated);
  }
  if (req.method === 'DELETE') {
    const removed = [];
    for (const id of targetIds) {
      const i = bag.findIndex((x) => x.id === id);
      if (i >= 0) removed.push(bag.splice(i, 1)[0]);
    }
    return json(res, removed);
  }
  return json(res, { data: null, error: { message: 'mock: method not handled' } }, 405);
}

/** /.cloud/llm/**：模型列表（GET /models）+ 聊天补全（SDK 强制 stream:true，必须回 SSE 帧） */
async function handleLlm(req, res, url) {
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    // 与真实形状对齐：数组或 {data:[...]} 均可，SDK 会归一化
    return json(res, [
      { id: 'step-5-preview', name: 'Step 5 Preview' },
      { id: 'step-6-turbo', name: 'Step 6 Turbo' },
      { id: 'step-7-mini', name: 'Step 7 Mini' },
    ]);
  }
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      /* ignore */
    }
    // 例句 JSON（与 parseExampleReply 的协议一致）；可用 E2E_LLM_REPLY 覆盖做异常用例
    const reply =
      process.env.E2E_LLM_REPLY ??
      JSON.stringify({ en: 'They decided to abandon the sinking ship.', zh: '他们决定弃船。' });
    const frame = (delta) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // 分两片吐内容，顺带验证 accumulate 拼接路径
    res.write(frame({ role: 'assistant', content: '' }));
    const mid = Math.ceil(reply.length / 2);
    res.write(frame({ content: reply.slice(0, mid) }));
    res.write(frame({ content: reply.slice(mid) }));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  return json(res, []);
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(DIST, pathname));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback
    try {
      const data = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end('dist-e2e not built. Run: npx vite build --mode e2e --outDir dist-e2e');
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    const rpcMatch = /^\/\.cloud\/database\/rest\/rpc\/([a-zA-Z_]+)$/.exec(url.pathname);
    if (rpcMatch) {
      await handleRpc(req, res, rpcMatch[1]);
      return;
    }
    if (url.pathname.startsWith('/.cloud/database/rest')) {
      await handleCloudRest(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/.cloud/llm')) {
      await handleLlm(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/.cloud/auth')) {
      // getSession 走 localStorage，正常不会打到这里；兜底返回当前用户
      return json(res, { user: { id: USER_ID, email: 'e2e@test.local' } });
    }
    if (url.pathname.startsWith('/.cloud/storage')) {
      return json(res, { data: null, error: null });
    }
    await serveStatic(req, res, url);
  } catch (e) {
    json(res, { data: null, error: { message: `mock server error: ${e instanceof Error ? e.message : String(e)}` } }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e-mock] listening on http://127.0.0.1:${PORT} (dist: ${DIST})`);
});
