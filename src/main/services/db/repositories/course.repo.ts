import { randomUUID } from 'crypto';
import { getDb } from '../sqlite';
import type { Course, CourseStatus, DepthPreference, CreateCourseDto } from '@shared/types';

interface CourseRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  total_nodes: number;
  done_nodes: number;
  hours_spent: number;
  total_token_used: number;
  total_cost_cny: number;
  goal_text: string | null;
  known_topics: string | null;
  time_budget: string | null;
  depth_preference: string | null;
  profile_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCourse(row: CourseRow): Course {
  return {
    ...row,
    status:           row.status           as CourseStatus,
    depth_preference: row.depth_preference as DepthPreference | null,
  };
}

export class CourseRepository {
  findAll(): Course[] {
    const rows = getDb()
      .prepare<[], CourseRow>('SELECT * FROM courses ORDER BY created_at DESC')
      .all();
    return rows.map(rowToCourse);
  }

  findById(id: string): Course | null {
    const row = getDb()
      .prepare<[string], CourseRow>('SELECT * FROM courses WHERE id = ?')
      .get(id);
    return row ? rowToCourse(row) : null;
  }

  create(data: CreateCourseDto): Course {
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO courses (id, name, description)
         VALUES (@id, @name, @description)`
      )
      .run({ id, name: data.name, description: data.description ?? null });
    return this.findById(id)!;
  }

  update(id: string, data: Partial<Omit<Course, 'id' | 'created_at'>>): Course {
    const existing = this.findById(id);
    if (!existing) throw new Error(`Course not found: ${id}`);

    const merged = { ...existing, ...data, id, updated_at: undefined };
    getDb()
      .prepare(
        `UPDATE courses SET
           name = @name,
           description = @description,
           status = @status,
           total_nodes = @total_nodes,
           done_nodes = @done_nodes,
           hours_spent = @hours_spent,
           total_token_used = @total_token_used,
           total_cost_cny = @total_cost_cny,
           goal_text = @goal_text,
           known_topics = @known_topics,
           time_budget = @time_budget,
           depth_preference = @depth_preference,
           profile_updated_at = @profile_updated_at,
           updated_at = datetime('now')
         WHERE id = @id`
      )
      .run(merged);
    return this.findById(id)!;
  }

  updateProfile(id: string, data: {
    goal_text?: string | null;
    known_topics?: string | null;
    time_budget?: string | null;
    depth_preference?: string | null;
  }): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (data.goal_text        !== undefined) { sets.push('goal_text = @goal_text');               params.goal_text        = data.goal_text; }
    if (data.known_topics     !== undefined) { sets.push('known_topics = @known_topics');         params.known_topics     = data.known_topics; }
    if (data.time_budget      !== undefined) { sets.push('time_budget = @time_budget');           params.time_budget      = data.time_budget; }
    if (data.depth_preference !== undefined) { sets.push('depth_preference = @depth_preference'); params.depth_preference = data.depth_preference; }
    if (sets.length === 0) return;
    sets.push(`profile_updated_at = datetime('now')`);
    getDb().prepare(`UPDATE courses SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM courses WHERE id = ?').run(id);
  }
}
