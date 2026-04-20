import { randomUUID } from 'crypto';
import { getDb } from '../sqlite';
import type { ChecklistItem } from '@shared/types';

interface ChecklistRow {
  id: string;
  node_id: string;
  concept: string;
  verification_question: string;
  required: number; // SQLite stores booleans as integers
  created_at: string;
}

export class ChecklistRepository {
  findByNode(nodeId: string): ChecklistItem[] {
    return getDb()
      .prepare<[string], ChecklistRow>(
        'SELECT * FROM mastery_checklist WHERE node_id = ? ORDER BY created_at'
      )
      .all(nodeId)
      .map((row) => ({ ...row, required: row.required === 1 }));
  }

  upsertAll(
    nodeId: string,
    items: Array<{ concept: string; verificationQuestion: string; required: boolean }>,
  ): void {
    const db = getDb();
    db.prepare('DELETE FROM mastery_checklist WHERE node_id = ?').run(nodeId);
    const insert = db.prepare(
      'INSERT INTO mastery_checklist (id, node_id, concept, verification_question, required) VALUES (?, ?, ?, ?, ?)',
    );
    for (const item of items) {
      insert.run(randomUUID(), nodeId, item.concept, item.verificationQuestion, item.required ? 1 : 0);
    }
  }

  hasChecklist(nodeId: string): boolean {
    const row = getDb()
      .prepare<[string], { cnt: number }>('SELECT COUNT(*) as cnt FROM mastery_checklist WHERE node_id = ?')
      .get(nodeId);
    return (row?.cnt ?? 0) > 0;
  }
}
