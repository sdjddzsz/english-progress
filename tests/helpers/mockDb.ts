/**
 * mockDb.ts —— 内存 mock 云数据库（supabase-js 风格查询构建器）。
 * 供 repos / ai 测试复用；云 SDK 适配器的接口级 mock（云环境激活后由 T05 集成回验）。
 */
import type { CloudDatabaseLike, Envelope, PostgrestQuery } from '../../src/data/repository';

export type Row = Record<string, unknown>;

export class MockQuery implements PostgrestQuery {
  private filters: ((r: Row) => boolean)[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private singleMode = false;
  private mode: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private upsertOpts: { ignoreDuplicates?: boolean } = {};
  private wantRows = false;
  private countExact = false;

  constructor(
    private readonly db: MockDb,
    private readonly table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): PostgrestQuery {
    this.wantRows = true;
    if (opts?.count === 'exact') this.countExact = true;
    return this;
  }
  eq(column: string, value: unknown): PostgrestQuery { this.filters.push((r) => r[column] === value); return this; }
  neq(column: string, value: unknown): PostgrestQuery { this.filters.push((r) => r[column] !== value); return this; }
  gt(column: string, value: unknown): PostgrestQuery { this.filters.push((r) => (r[column] as number) > (value as number)); return this; }
  gte(column: string, value: unknown): PostgrestQuery { this.filters.push((r) => (r[column] as string) >= (value as string)); return this; }
  lt(column: string, value: unknown): PostgrestQuery { this.filters.push((r) => (r[column] as string) < (value as string)); return this; }
  lte(column: string, value: unknown): PostgrestQuery { this.filters.push((r) => (r[column] as number) <= (value as number)); return this; }
  in(column: string, values: unknown[]): PostgrestQuery { this.filters.push((r) => values.includes(r[column])); return this; }
  is(column: string, value: null): PostgrestQuery { this.filters.push((r) => r[column] === value); return this; }
  order(column: string, opts?: { ascending?: boolean }): PostgrestQuery { this.orderCol = column; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number): PostgrestQuery { this.limitN = n; return this; }
  range(from: number, to: number): PostgrestQuery { this.rangeFrom = from; this.rangeTo = to; return this; }
  single(): PostgrestQuery { this.singleMode = true; return this; }
  maybeSingle(): PostgrestQuery { this.singleMode = true; return this; }
  insert(values: Row | Row[]): PostgrestQuery { this.mode = 'insert'; this.payload = values; return this; }
  upsert(values: Row | Row[], opts?: { ignoreDuplicates?: boolean }): PostgrestQuery {
    this.mode = 'upsert';
    this.payload = values;
    this.upsertOpts = opts ?? {};
    return this;
  }
  update(values: Row): PostgrestQuery { this.mode = 'update'; this.payload = values; return this; }
  delete(): PostgrestQuery { this.mode = 'delete'; return this; }

  // thenable：await 时执行
  then<TResult>(
    onFulfilled?: (value: Envelope<Row[] | Row | null>) => TResult,
    onRejected?: (reason: unknown) => TResult,
  ): PromiseLike<TResult> {
    return Promise.resolve().then(() => {
      try {
        return onFulfilled!(this.exec());
      } catch (err) {
        if (onRejected) return onRejected(err);
        throw err;
      }
    });
  }

  private exec(): Envelope<Row[] | Row | null> {
    const rows = this.db.tables.get(this.table) ?? [];
    const filtered = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === 'insert') {
      const docs = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((d) => ({ ...d }));
      for (const d of docs) {
        if (!d.id) d.id = `gen_${this.db.seq++}`;
        rows.push({ ...d });
      }
      return { data: this.wantRows ? docs : [], error: null };
    }
    if (this.mode === 'upsert') {
      const docs = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((d) => ({ ...d }));
      for (const d of docs) {
        const idx = rows.findIndex((r) => r.id === d.id);
        if (idx >= 0) {
          if (this.upsertOpts.ignoreDuplicates) continue;
          rows[idx] = { ...rows[idx], ...d };
        } else {
          rows.push({ ...d });
        }
      }
      return { data: [], error: null };
    }
    if (this.mode === 'update') {
      const patch = this.payload as Row;
      const updated: Row[] = [];
      for (const r of filtered) {
        Object.assign(r, patch);
        updated.push({ ...r });
      }
      return { data: this.wantRows ? updated : [], error: null };
    }
    if (this.mode === 'delete') {
      const removed: Row[] = [];
      for (const r of filtered) {
        const idx = rows.indexOf(r);
        if (idx >= 0) {
          rows.splice(idx, 1);
          removed.push({ ...r });
        }
      }
      return { data: this.wantRows ? removed : [], error: null };
    }
    // select
    let out = [...filtered];
    if (this.orderCol) {
      const col = this.orderCol;
      out.sort((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.rangeFrom != null) out = out.slice(this.rangeFrom, (this.rangeTo ?? out.length - 1) + 1);
    else if (this.limitN != null) out = out.slice(0, this.limitN);
    if (this.singleMode) {
      if (out.length === 0) return { data: null, error: null };
      return { data: out[0], error: null };
    }
    return { data: out, error: null, count: this.countExact ? rows.length : null };
  }
}

export class MockDb implements CloudDatabaseLike {
  tables = new Map<string, Row[]>();
  seq = 1;
  from(table: string): PostgrestQuery {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new MockQuery(this, table);
  }
}
