/**
 * mockDb.ts —— 内存 mock 云数据库（supabase-js 风格查询构建器）。
 * 供 repos / ai 测试复用；云 SDK 适配器的接口级 mock（云环境激活后由 T05 集成回验）。
 */
import type { CloudDatabaseLike, Envelope, PostgrestQuery } from '../../src/data/repository';

export type Row = Record<string, unknown>;

export class MockQuery implements PostgrestQuery {
  private filters: ((r: Row) => boolean)[] = [];
  // 多列排序（真实 PostgREST：`order=a.desc,b.asc`，按数组顺序依次比较）。
  // 旧实现只记最后一列 ⇒ 多列排序的方法（如 listBookWordsPage 的 tier.desc+id.asc）
  // 在测试里会静默退化成单列，真实缺陷被 mock 兜住。2026-10-22 修为累加。
  private orders: { column: string; asc: boolean }[] = [];
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
  order(column: string, opts?: { ascending?: boolean }): PostgrestQuery {
    this.orders.push({ column, asc: opts?.ascending ?? true });
    return this;
  }
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
        // ⚠ 这里**不能**替缺失的 id 兜一个假值。
        //   云端所有集合的 `id` 列都是 `text NOT NULL` 且**无默认值**（实测 25 张表皆如此），
        //   漏传 id 的 insert 在真实环境会报
        //   `null value in column "id" ... violates not-null constraint (23502)`。
        //   早期这行 `if (!d.id) d.id = gen_${seq++}` 会静默兜住 ⇒ 测试全绿而线上炸锅
        //   （rebuildWordBook 与 PlacementPage 的 saveTierSnapshot 都踩过）。
        //   现在忠实模拟 PG：缺失 id 直接报错，让这类缺陷在测试里就暴露。
        if (!d.id) {
          return {
            data: null,
            error: {
              message: 'null value in column "id" of relation "' + this.table + '" violates not-null constraint',
              code: '23502',
              details: null,
              hint: null,
            },
          };
        }
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
    if (this.orders.length > 0) {
      const orders = this.orders;
      out.sort((a, b) => {
        for (const o of orders) {
          const av = a[o.column] as string | number;
          const bv = b[o.column] as string | number;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          if (cmp !== 0) return o.asc ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (this.rangeFrom != null) out = out.slice(this.rangeFrom, (this.rangeTo ?? out.length - 1) + 1);
    else if (this.limitN != null) out = out.slice(0, this.limitN);
    // ⚠ 模拟服务端 PostgREST 的 **max-rows 默认上限 1000**（2026-10-13 线上实测确认）。
    //   不加这条，mock 会「老实」返回全部行 ⇒ `list()` 在超 1000 行时看起来完全正常，
    //   而真实云端会**静默截断**在 1000 行 —— 这正是那次线上事故的成因
    //   （rebuildWordBook 只备份/删除了 1000 条，剩下 4407 条形同不存在；
    //    refreshToday 只调度到前 1000 词，其余词永远排不进队列，且界面无任何异常）。
    //   模拟它，才逼出 `Repository.listAll` 的翻页实现。
    if (out.length > MockDb.SERVER_MAX_ROWS) out = out.slice(0, MockDb.SERVER_MAX_ROWS);
    if (this.singleMode) {
      if (out.length === 0) return { data: null, error: null };
      return { data: out[0], error: null };
    }
    // ⚠ count 必须是**过滤后**的行数（PostgREST `count=exact` 的语义是 WHERE 之后、分页之前的总数）。
    //   原先写 `rows.length`（全表）⇒ `count(filters)` 在测试里永远返回全表数，
    //   于是「按 tier 计数」「按 bookId 计数」这类调用在测试中**看起来都对**，实际全错。
    //   2026-10-14 由 tests/data/placementLoad.test.ts 的 countBookWordsByTier 用例抓出。
    return { data: out, error: null, count: this.countExact ? filtered.length : null };
  }
}

export class MockDb implements CloudDatabaseLike {
  /** 服务端 PostgREST 的 max-rows 默认上限（线上实测确认，不是猜的） */
  static readonly SERVER_MAX_ROWS = 1000;
  tables = new Map<string, Row[]>();
  seq = 1;
  /** 当前会话的 owner（对应云端 auth.uid()；PG 函数体内按它过滤，见 ep_home_summary SQL） */
  ownerId = 'u1';
  from(table: string): PostgrestQuery {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new MockQuery(this, table);
  }

  /**
   * RPC（用户 2026-10-24 云端聚合）：忠实实现云端两个 PG 函数的聚合语义
   * （ep_home_summary / ep_today_quiz，SQL 见迁移记录与交接文档）——
   * owner_id 过滤、UTC 日分组、每天 distinct wordId、排序键（listNo,orderInList,id）
   * 全部照 SQL 翻译，**不是兜底桩**：mock 与云端语义不一致 = 测试放生真实缺陷。
   *
   * ⚠ 返回形状必须照 SDK 的 processResponse：**信封** `{success, error, data, ...}`，
   *    不是裸聚合结果。2026-10-24 踩坑：mock 回裸值 ⇒ wordRepo 不拆信封也全绿，
   *    真 SDK 回信封 ⇒ 线上统计全 0。信封对不上，mock 就是在给真实缺陷兜底。
   *    未知函数照 PostgREST 回 404 错误信封（SDK 不抛，交给调用方 unwrap 抛）。
   */
  async rpc(fn: string, args: Record<string, unknown> = {}): Promise<Envelope<unknown>> {
    const errEnvelope = (message: string): Envelope<unknown> => ({
      data: null,
      error: { message, code: '404', details: null, hint: null },
      count: null,
      status: 404,
      statusText: 'Not Found',
    });
    const bookId = String(args.p_book_id ?? '');
    const rows = (this.tables.get('book_words') ?? []).filter(
      (r) => r.bookId === bookId && r.owner_id === this.ownerId,
    );
    const utcDate = (iso: unknown): string => (typeof iso === 'string' ? iso.slice(0, 10) : '');

    if (fn === 'ep_home_summary') {
      // remaining/graduated：stage>0 / stage=0
      const remaining = rows.filter((r) => (r.stage as number) > 0).length;
      const graduated = rows.filter((r) => (r.stage as number) === 0).length;
      // dailyCounts：近 14 天（UTC 日）每天答过的不同词数，升序
      const cutoff = Date.now() - 14 * 86_400_000;
      const perDay = new Map<string, Set<string>>();
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
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, set]) => ({ date, count: set.size }));
      // tierCounts / wordsByTier：分组 + 组内按 listNo,orderInList,id 排序
      const byTier = new Map<number, Row[]>();
      for (const r of rows) {
        const t = r.tier as number;
        let arr = byTier.get(t);
        if (!arr) {
          arr = [];
          byTier.set(t, arr);
        }
        arr.push(r);
      }
      const tierCounts: Record<string, number> = {};
      const wordsByTier: Record<string, string[]> = {};
      for (const [t, arr] of byTier) {
        arr.sort(
          (a, b) =>
            (a.listNo as number) - (b.listNo as number) ||
            (a.orderInList as number) - (b.orderInList as number) ||
            String(a.id).localeCompare(String(b.id)),
        );
        tierCounts[String(t)] = arr.length;
        wordsByTier[String(t)] = arr.map((r) => String(r.wordId));
      }
      return { success: true, data: { remaining, graduated, dailyCounts, tierCounts, wordsByTier }, error: null };
    }

    if (fn === 'ep_today_quiz') {
      const today = String(args.p_today ?? '');
      const todayRows = rows.filter((r) => utcDate(r.lastQuizAt) === today);
      const firstSeenRows = rows.filter((r) => utcDate(r.firstSeenAt) === today);
      return {
        success: true,
        data: {
          words: todayRows.length,
          firstSeen: firstSeenRows.length,
          wordIds: todayRows.map((r) => String(r.wordId)),
          firstSeenIds: firstSeenRows.map((r) => String(r.wordId)),
        },
        error: null,
      };
    }

    if (fn === 'ep_stage_stats') {
      // byStage：各 stage（含 0=已毕业）计数；specialByStage：各阶段特种训练计数
      const byStage: Record<string, number> = {};
      const specialByStage: Record<string, number> = {};
      for (const r of rows) {
        const s = String(r.stage);
        byStage[s] = (byStage[s] ?? 0) + 1;
        if (r.specialTraining) specialByStage[s] = (specialByStage[s] ?? 0) + 1;
      }
      return { success: true, data: { byStage, specialByStage }, error: null };
    }

    return errEnvelope(`[rpc] unknown function: ${fn}`);
  }
}
