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
}

export interface CloudDatabaseLike {
  from(table: string): PostgrestQuery;
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

  // ===== 写 =====

  async insert(doc: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const env = await this.db
      .from(this.table)
      .insert(doc as Record<string, unknown>)
      .select() as unknown as Envelope<T[]>;
    const rows = this.unwrap(env);
    if (!rows || rows.length === 0) {
      throw new Error(`[${this.table}] insert returned no rows (possibly blocked by RLS)`);
    }
    return rows[0];
  }

  async insertMany(docs: (Omit<T, 'id'> & { id?: string })[]): Promise<void> {
    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
      const chunk = docs.slice(i, i + CHUNK_SIZE);
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
}
