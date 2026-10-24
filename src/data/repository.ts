/**
 * repository.ts —— 通用 CRUD / 分页 / 条件查询封装。
 * 查询构建器接口与 supabase-js（@tencent-ai/workbuddy-cloud-sdk 的 cloud.database）一致，
 * 便于测试时注入内存 mock 实现。
 *
 * 安全约定（SDK 文档）：
 * - 永不手传 owner_id / token：RLS + DEFAULT auth.uid() 负责；
 * - update/delete 必带条件（.eq('id', …)），且 .select() 检测"0 行受影响"（可能是 RLS 拦截）。
 */
import type { CollectionName } from '../types/domain';

// ===== 通用 id 生成 =====

/**
 * 生成文档 id。
 *
 * ⚠ 为什么必须在仓库层兜底生成，而不是要求每个调用方自己传：
 *   云端所有集合的 `id` 列都是 `text NOT NULL` 且**没有默认值**
 *   （实测 tier_snapshots / word_bookmarks 等皆如此），
 *   而 `insert()` 的签名是 `id?: string`（可选）—— 于是「可选」在类型上通过、在运行期炸：
 *   实测 `rebuildWordBook` 与 `PlacementPage` 的 `saveTierSnapshot` 都因此报
 *   `null value in column "id" violates not-null constraint (23502)`。
 *   把生成逻辑收在 insert 里，任何调用方漏传都不会再炸。
 *
 * 优先 `crypto.randomUUID`（浏览器 / Node ≥19 都有）；不可用时退化到手写 v4，
 * 再不可用则用时间戳 + 随机数兜底（此时仍保证同毫秒内不同、非空、字符串）。
 */
export function newDocId(): string {
  const c: Crypto | undefined = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // v4：置位版本号与变体位
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ===== 查询构建器接口（与 supabase-js 表面一致的最小子集）=====

export interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: unknown;
  hint?: unknown;
}

export interface PostgrestQuery {
  select(columns?: string, opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): PostgrestQuery;
  eq(column: string, value: unknown): PostgrestQuery;
  neq(column: string, value: unknown): PostgrestQuery;
  gt(column: string, value: unknown): PostgrestQuery;
  gte(column: string, value: unknown): PostgrestQuery;
  lt(column: string, value: unknown): PostgrestQuery;
  lte(column: string, value: unknown): PostgrestQuery;
  in(column: string, values: unknown[]): PostgrestQuery;
  is(column: string, value: null): PostgrestQuery;
  order(column: string, opts?: { ascending?: boolean }): PostgrestQuery;
  limit(n: number): PostgrestQuery;
  range(from: number, to: number): PostgrestQuery;
  single(): PostgrestQuery;
  maybeSingle(): PostgrestQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): PostgrestQuery;
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): PostgrestQuery;
  update(values: Record<string, unknown>): PostgrestQuery;
  delete(): PostgrestQuery;
}

export interface Envelope<T> {
  data: T;
  error: PostgrestErrorLike | null;
  count?: number | null;
  /** 真 SDK（processResponse）还带这三个字段；应用代码只读 data/error/count，mock 照抄以防失真 */
  success?: boolean;
  status?: number;
  statusText?: string;
}

export interface CloudDatabaseLike {
  from(table: string): PostgrestQuery;
  /**
   * PostgREST RPC（2026-10-24 云端聚合用）：调用云端 PG 函数（SECURITY DEFINER，
   * 函数体内显式 owner_id=auth.uid() 过滤），一个请求拿聚合好的统计，
   * 替代「拉全表再客户端算」（首页原 9 个全表分页请求 ⇒ 2 个小请求）。
   *
   * ⚠ 返回值是 **SDK 信封** `{success, error, data, ...}`（processResponse 的形状），
   *    不是裸函数结果——调用方必须拆信封（error 时抛出、取 data）。
   *    2026-10-24 实测踩坑：直接 cast 成业务类型读字段 ⇒ 线上统计全 0
   *    （mock 回裸值把缺陷兜住了）。类型在此收紧，杜绝第二次。
   */
  rpc(fn: string, args?: Record<string, unknown>): Promise<Envelope<unknown>>;
}

// ===== 查询描述 =====

export interface CompareFilter {
  column: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: unknown;
}

export interface InFilter {
  column: string;
  op: 'in';
  values: unknown[];
}

export type Filter = CompareFilter | InFilter;

export interface ListOptions {
  orderBy?: string;
  /**
   * 多列排序（按数组顺序依次 order()，PostgREST 语义为 `order=a.desc,b.asc`）。
   * 与 orderBy 同时给时 orders 先生效、orderBy 追加在后（调用方二选一即可）。
   * 用途：分页排序键必须唯一 ⇒ 展示序（如 tier.desc）+ 稳定键（id.asc）组合。
   */
  orders?: { column: string; ascending?: boolean }[];
  ascending?: boolean;
  limit?: number;
  offset?: number;
}

/** 写入分块大小（PostgREST 单请求行数上限保护） */
const CHUNK_SIZE = 100;

/**
 * 泛型仓储。T 为领域文档类型（须含 id: string）。
 */
export class Repository<T extends { id: string }> {
  constructor(
    private readonly db: CloudDatabaseLike,
    public readonly table: CollectionName,
  ) {}

  /** 解包 { data, error } 信封；出错抛带集合名前缀的英文错误（含 PG code 便于诊断） */
  private unwrap<U>(env: Envelope<U>): U {
    if (env.error) {
      throw new Error(`[${this.table}] ${env.error.message}${env.error.code ? ` (code=${env.error.code})` : ''}`);
    }
    return env.data;
  }

  private applyFilters(q: PostgrestQuery, filters: Filter[]): PostgrestQuery {
    let out = q;
    for (const f of filters) {
      if (f.op === 'in') out = out.in(f.column, f.values);
      else out = out[f.op](f.column, f.value);
    }
    return out;
  }

  // ===== 读 =====

  async getById(id: string): Promise<T | null> {
    const env = (await this.db
      .from(this.table)
      .select('*')
      .eq('id', id)
      .maybeSingle()) as unknown as Envelope<T | null>;
    return this.unwrap(env);
  }

  async list(filters: Filter[] = [], opts: ListOptions = {}): Promise<T[]> {
    let q = this.db.from(this.table).select('*');
    q = this.applyFilters(q, filters);
    for (const o of opts.orders ?? []) q = q.order(o.column, { ascending: o.ascending ?? true });
    if (opts.orderBy) q = q.order(opts.orderBy, { ascending: opts.ascending ?? true });
    if (opts.offset != null || opts.limit != null) {
      const from = opts.offset ?? 0;
      const to = opts.limit != null ? from + opts.limit - 1 : from + 1_000_000;
      q = q.range(from, to);
    }
    const env = (await q) as unknown as Envelope<T[]>;
    return this.unwrap(env);
  }

  async count(filters: Filter[] = []): Promise<number> {
    let q = this.db.from(this.table).select('*', { count: 'exact', head: true });
    q = this.applyFilters(q, filters);
    const env = (await q) as unknown as Envelope<unknown[]>;
    this.unwrap(env);
    return env.count ?? 0;
  }

  /**
   * 只取 `id` 的分页列表 —— 供**身份级**终局校验读回云端实存 id 集合用。
   *
   * 为什么不用 `list()`：它 `select('*')`，会把 8296 行的 `senses`/`examples` 等 jsonb 大字段
   * 全部拉下来（一次性导入虽可接受，但纯属白烧带宽）。
   * 为什么固定 `order('id')`：`id` 是主键 ⇒ 稳定序；无稳定排序的 `offset/limit` 分页会**重复或漏行**。
   *
   * @returns 该页的 id 数组（调用方负责翻页与「读全」断言）
   */
  async listIds(filters: Filter[] = [], opts: ListOptions = {}): Promise<string[]> {
    let q = this.db.from(this.table).select('id');
    q = this.applyFilters(q, filters);
    q = q.order('id', { ascending: true }); // 分页必须稳定序
    const from = opts.offset ?? 0;
    const to = opts.limit != null ? from + opts.limit - 1 : from + 1_000_000;
    q = q.range(from, to);
    const env = (await q) as unknown as Envelope<{ id: string }[]>;
    return this.unwrap(env).map((r) => r.id);
  }

  /**
   * 读全表（自动翻页）—— **凡是「要拿到全量行」的调用都必须用它**，不要用 `list()`。
   *
   * ⚠⚠ 为什么（2026-10-13 线上实测踩到）：
   *   `list()` 不传 limit 时虽然把 range 上界写成 `from + 1_000_000`，
   *   但**服务端（PostgREST）有 max-rows 默认上限 1000**，超出部分被静默丢弃 ——
   *   不报错、不告警，返回的就是前 1000 条。
   *   实际后果：`listBookWords` 在 5407 词的旧书上也只回了 **1000** 条（实测云端
   *   book_words 5407 行时 `.length` 为 1000）⇒
   *    - `rebuildWordBook` 只备份/删除了 1000 条，剩下 4407 条**它从未看见**；
   *    - `refreshToday`（每日队列展开）与 `expandDayForWords` 只会调度到前 1000 个词，
   *      词书里 80% 的词**永远排不进学习队列**。
   *   这类「静默少数据」比报错危险得多：它看起来完全正常。
   *
   * 翻页规则：
   *  - 每页 `pageSize`（默认 1000，恰好卡在服务端上限内），按 **orderBy 稳定序 + offset** 翻；
   *    无 orderBy 时强制按主键 `id` 排序 —— **无稳定排序的分页会重复或漏行**。
   *  - 「短页」（返回条数 < pageSize）视为读完；
   *  - 返回条数上限保护 `maxRows`：达到即停并抛错（说明服务端在静默截断，宁可报错也不能少数据）。
   */
  async listAll(
    filters: Filter[] = [],
    opts: ListOptions & { pageSize?: number; maxRows?: number; onPage?: (loaded: number) => void } = {},
  ): Promise<T[]> {
    const { onPage, ...listOpts } = opts;
    const pageSize = Math.max(1, opts.pageSize ?? 1000);
    const maxRows = Math.max(pageSize, opts.maxRows ?? 100_000);
    const out: T[] = [];
    let offset = opts.offset ?? 0;
    // 分页必须有稳定排序：调用方给了 orderBy 就用它，否则强制按主键 id。
    // ⚠ 调用方给的 orderBy **必须是唯一列**（如主键 id）——非唯一列（如 orderInList）
    //   会让 Postgres 不保证跨页顺序，出现行重复 / 漏行（见 wordRepo.listBookWords 的注释）。
    const orderBy = opts.orderBy ?? 'id';
    for (;;) {
      const page = await this.list(filters, {
        ...listOpts,
        orderBy,
        ascending: opts.ascending ?? true,
        offset,
        limit: pageSize,
      });
      out.push(...page);
      // 分页进度回调：全表读动辄 9 页、几十秒，调用方需要能显示"读到哪了"
      onPage?.(out.length);
      if (page.length < pageSize) break;
      offset += pageSize;
      if (out.length >= maxRows) {
        throw new Error(
          `[${this.table}] listAll 超过 maxRows=${maxRows} 仍未读完；` +
            `这通常意味着服务端在静默截断分页结果。请调大 maxRows 或改用更窄的过滤条件。`,
        );
      }
    }
    return out;
  }

  // ===== 写 =====

  /**
   * 插入单行。**id 缺省时自动生成**（见 newDocId 说明：云端 `id` 列 NOT NULL 且无默认值，
   * 而本方法签名把 id 标成可选 ⇒ 漏传会在运行期报 23502）。
   * 需要幂等写入的场景请用 upsertMany + 确定性 id，不要用 insert。
   */
  async insert(doc: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const withId = doc.id ? doc : { ...doc, id: newDocId() };
    const env = await this.db
      .from(this.table)
      .insert(withId as Record<string, unknown>)
      .select() as unknown as Envelope<T[]>;
    const rows = this.unwrap(env);
    if (!rows || rows.length === 0) {
      throw new Error(`[${this.table}] insert returned no rows (possibly blocked by RLS)`);
    }
    return rows[0];
  }

  /**
   * 批量插入（分片）。⚠ 与 insert 一样**不生成 id 的幂等保证** —— 逐行独立插入，
   *   重跑会产生重复行；需要幂等请用 upsertMany + 确定性 id。
   *   仅用于小批量（每片 CHUNK_SIZE 行）；大批量走 upsertMany 分片。
   */
  async insertMany(docs: (Omit<T, 'id'> & { id?: string })[]): Promise<void> {
    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
      const chunk = docs.slice(i, i + CHUNK_SIZE).map((d) => (d.id ? d : { ...d, id: newDocId() }));
      const env = await this.db
        .from(this.table)
        .insert(chunk as Record<string, unknown>[]) as unknown as Envelope<unknown[]>;
      this.unwrap(env);
    }
  }

  /** 幂等批量 upsert（hit 确定性 ID 去重的底层通道） */
  async upsertMany(docs: (T & Record<string, unknown>)[], opts: { ignoreDuplicates?: boolean } = {}): Promise<void> {
    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
      const chunk = docs.slice(i, i + CHUNK_SIZE);
      const env = await this.db
        .from(this.table)
        .upsert(chunk as Record<string, unknown>[], {
          onConflict: 'id',
          ignoreDuplicates: opts.ignoreDuplicates ?? false,
        }) as unknown as Envelope<unknown[]>;
      this.unwrap(env);
    }
  }

  /**
   * 按 id 更新。返回更新后的行；返回 null 表示 0 行受影响
   * （不存在，或被 RLS 过滤——不是成功，须由调用方提示）。
   */
  async update(id: string, patch: Partial<T>): Promise<T | null> {
    const env = await this.db
      .from(this.table)
      .update(patch as Record<string, unknown>)
      .eq('id', id)
      .select() as unknown as Envelope<T[]>;
    const rows = this.unwrap(env);
    return rows && rows.length > 0 ? rows[0] : null;
  }

  /** 返回是否真的删除了行（0 行 = 不存在或 RLS 拦截） */
  async remove(id: string): Promise<boolean> {
    const env = await this.db
      .from(this.table)
      .delete()
      .eq('id', id)
      .select() as unknown as Envelope<T[]>;
    const rows = this.unwrap(env);
    return Boolean(rows && rows.length > 0);
  }

  /**
   * 按 id 批量删除（重建词书这类「删大批」的场景）。
   * ⚠ 必须分片：`in.(…)` 的 URL 会随 id 数线性增长，8296 个 id 远超请求行上限
   *   （实测 5407 个就 ≈82KB，`TypeError: Failed to fetch`）。这里按 ID_BATCH 切批。
   * @returns 累计请求成功删除的行数（**不是**精确匹配数：RLS 过滤掉的行同样不计入）
   */
  async removeMany(ids: string[], batch = 100): Promise<number> {
    const unique = [...new Set(ids)].filter(Boolean);
    let removed = 0;
    for (let i = 0; i < unique.length; i += batch) {
      const slice = unique.slice(i, i + batch);
      const env = await this.db
        .from(this.table)
        .delete()
        .in('id', slice)
        .select() as unknown as Envelope<T[]>;
      const rows = this.unwrap(env);
      removed += rows ? rows.length : 0;
    }
    return removed;
  }
}
