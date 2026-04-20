import { randomUUID } from 'crypto';
import { getDb } from '../sqlite';
import type { Session, StartSessionDto, EndSessionDto } from '@shared/types';

interface SessionRow {
  id: string;
  course_id: string;
  node_id: string;
  phase: number;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  token_used: number;
  cost_cny: number;
  mastery_score: number | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    ...row,
    phase: row.phase as 2 | 3,
  };
}

export class SessionRepository {
  findById(id: string): Session | null {
    const row = getDb()
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
      .get(id);
    return row ? rowToSession(row) : null;
  }

  findByNode(nodeId: string): Session[] {
    const rows = getDb()
      .prepare<[string], SessionRow>(
        'SELECT * FROM sessions WHERE node_id = ? ORDER BY started_at DESC'
      )
      .all(nodeId);
    return rows.map(rowToSession);
  }

  start(data: StartSessionDto): Session {
    const id = data.id ?? randomUUID();
    getDb()
      .prepare(
        `INSERT INTO sessions (id, course_id, node_id, phase, started_at)
         VALUES (@id, @course_id, @node_id, @phase, @started_at)`
      )
      .run({ id, course_id: data.course_id, node_id: data.node_id, phase: data.phase, started_at: new Date().toISOString() });
    return this.findById(id)!;
  }

  end(id: string, data: EndSessionDto): Session {
    const existing = this.findById(id);
    if (!existing) throw new Error(`Session not found: ${id}`);

    getDb()
      .prepare(
        `UPDATE sessions SET
           ended_at = datetime('now'),
           duration_seconds = @duration_seconds,
           token_used = @token_used,
           cost_cny = @cost_cny,
           mastery_score = @mastery_score
         WHERE id = @id`
      )
      .run({
        id,
        duration_seconds: data.duration_seconds,
        token_used: data.token_used,
        cost_cny: data.cost_cny,
        mastery_score: data.mastery_score ?? null,
      });
    return this.findById(id)!;
  }
}
