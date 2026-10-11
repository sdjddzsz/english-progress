/**
 * trainingRepo.ts —— training_items / training_records 读写（四阶训练体系）。
 * 硬约束：TrainingRecord 无 score/accuracy/rating 字段；素材目标词必须来自当前队列。
 */
import type { TrainingItem, TrainingItemType, TrainingRecord, TrainingSource } from '../../types/domain';
import { getDb } from '../cloud';
import { Repository, type CloudDatabaseLike } from '../repository';

export interface TrainingRepo {
  readonly items: Repository<TrainingItem>;
  readonly records: Repository<TrainingRecord>;

  createItem(item: Omit<TrainingItem, 'id'> & { id?: string }): Promise<TrainingItem>;
  listItemsByType(type: TrainingItemType, limit?: number): Promise<TrainingItem[]>;
  listItemsBySource(source: TrainingSource, limit?: number): Promise<TrainingItem[]>;

  createRecord(record: Omit<TrainingRecord, 'id'> & { id?: string }): Promise<TrainingRecord>;
  listRecordsBySession(sessionId: string): Promise<TrainingRecord[]>;
}

export function createTrainingRepo(db: CloudDatabaseLike = getDb()): TrainingRepo {
  const items = new Repository<TrainingItem>(db, 'training_items');
  const records = new Repository<TrainingRecord>(db, 'training_records');

  return {
    items,
    records,

    createItem: (item) => items.insert(item),
    listItemsByType: (type, limit = 50) =>
      items.list([{ column: 'type', op: 'eq', value: type }], { orderBy: 'createdAt', ascending: false, limit }),
    listItemsBySource: (source, limit = 50) =>
      items.list([{ column: 'source', op: 'eq', value: source }], { orderBy: 'createdAt', ascending: false, limit }),

    createRecord: (record) => records.insert(record),
    listRecordsBySession: (sessionId) =>
      records.list([{ column: 'sessionId', op: 'eq', value: sessionId }], { orderBy: 'createdAt' }),
  };
}
