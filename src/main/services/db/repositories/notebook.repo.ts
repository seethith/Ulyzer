import { randomUUID } from 'crypto';
import { getDb } from '../sqlite';
import type { Notebook, SaveNotebookDto } from '@shared/types';

interface NotebookRow {
  id: string;
  node_id: string;
  course_id: string;
  title: string;
  content: string;
  review_content: string;
  review_submitted: number;
  created_at: string;
  updated_at: string;
}

function rowToNotebook(row: NotebookRow): Notebook {
  return {
    ...row,
    review_submitted: row.review_submitted === 1,
  };
}

export class NotebookRepository {
  findByNode(nodeId: string): Notebook | null {
    const row = getDb()
      .prepare<[string], NotebookRow>(
        'SELECT * FROM notebooks WHERE node_id = ? LIMIT 1'
      )
      .get(nodeId);
    return row ? rowToNotebook(row) : null;
  }

  /** Returns existing notebook or creates a new one */
  getOrCreate(nodeId: string, courseId: string): Notebook {
    const existing = this.findByNode(nodeId);
    if (existing) return existing;

    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO notebooks (id, node_id, course_id)
         VALUES (@id, @node_id, @course_id)`
      )
      .run({ id, node_id: nodeId, course_id: courseId });
    return this.findByNode(nodeId)!;
  }

  save(nodeId: string, courseId: string, data: SaveNotebookDto): Notebook {
    const notebook = this.getOrCreate(nodeId, courseId);

    const merged = {
      id: notebook.id,
      title: data.title ?? notebook.title,
      content: data.content ?? notebook.content,
      review_content: data.review_content ?? notebook.review_content,
      review_submitted:
        data.review_submitted !== undefined
          ? data.review_submitted
            ? 1
            : 0
          : notebook.review_submitted
            ? 1
            : 0,
    };

    getDb()
      .prepare(
        `UPDATE notebooks SET
           title = @title,
           content = @content,
           review_content = @review_content,
           review_submitted = @review_submitted,
           updated_at = datetime('now')
         WHERE id = @id`
      )
      .run(merged);
    return this.findByNode(nodeId)!;
  }
}
