import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc-channels';
import { indexFile } from '../services/rag/indexer';
import { ensureCourseDir, ensureNodeDir, getCourseDir, getNodeDir, deleteFileFs } from '../services/fs/content.service';
import type {
  IpcResponse,
  Course,
  CreateCourseDto,
  DagGraph,
  DagNode,
  DagEdge,
  StartSessionDto,
  EndSessionDto,
  SaveNotebookDto,
  Settings,
  GuidanceMode,
  FileRecord,
  CreateFileDto,
  FileType,
  ChatMessage,
  ChatThread,
  AgentType,
  ProviderConfig,
  ProviderModel,
  CreateProviderDto,
  CreateModelDto,
} from '@shared/types';
import { CourseRepository } from '../services/db/repositories/course.repo';
import { NodeRepository, EdgeRepository } from '../services/db/repositories/node.repo';
import { SessionRepository } from '../services/db/repositories/session.repo';
import { NotebookRepository } from '../services/db/repositories/notebook.repo';
import { getDb } from '../services/db/sqlite';

const courseRepo = new CourseRepository();
const nodeRepo = new NodeRepository();
const edgeRepo = new EdgeRepository();
const sessionRepo = new SessionRepository();
const notebookRepo = new NotebookRepository();

function ok<T>(data: T): IpcResponse<T> {
  return { success: true, data };
}

function fail(err: unknown): IpcResponse<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { success: false, error: message };
}

// ── Settings helpers ──────────────────────────────────────────────────────────

interface SettingsRow {
  id: number;
  default_provider: string;
  default_model: string;
  guidance_mode: string;
  font_size: number;
  remember_layout: number;
  theme: string;
  created_at: string;
  updated_at: string;
}

function getOrCreateSettings(): Settings {
  const db = getDb();
  const row = db.prepare<[], SettingsRow>('SELECT * FROM settings WHERE id = 1').get();
  if (row) {
    return rowToSettings(row);
  }
  db.prepare('INSERT INTO settings (id) VALUES (1)').run();
  return rowToSettings(
    db.prepare<[], SettingsRow>('SELECT * FROM settings WHERE id = 1').get()!
  );
}

function rowToSettings(row: SettingsRow): Settings {
  return {
    ...row,
    guidance_mode: row.guidance_mode as GuidanceMode,
    remember_layout: row.remember_layout === 1,
    theme: (row.theme ?? 'warm') as Settings['theme'],
  };
}

// ── File helpers ──────────────────────────────────────────────────────────────

interface FileRow {
  id: string;
  node_id: string | null;
  course_id: string | null;
  file_type: string;
  name: string;
  content: string | null;
  file_path: string | null;
  is_locked: number;
  created_at: string;
  updated_at: string;
}

function rowToFile(row: FileRow): FileRecord {
  return {
    ...row,
    file_type: row.file_type as FileType,
    is_locked: row.is_locked === 1,
  };
}

// ── Register all DB IPC handlers ──────────────────────────────────────────────

export function registerDbHandlers(): void {
  // ── Course ──────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DB_COURSE_LIST, (): IpcResponse<Course[]> => {
    try {
      return ok(courseRepo.findAll());
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    IPC.DB_COURSE_CREATE,
    (_event, data: CreateCourseDto): IpcResponse<Course> => {
      try {
        const course = courseRepo.create(data);
        try { ensureCourseDir(course.id); } catch { /* non-fatal */ }
        return ok(course);
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_COURSE_UPDATE,
    (
      _event,
      id: string,
      data: Partial<Omit<Course, 'id' | 'created_at'>>
    ): IpcResponse<Course> => {
      try {
        return ok(courseRepo.update(id, data));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_COURSE_DELETE,
    (_event, id: string): IpcResponse<void> => {
      try {
        const courseDir = getCourseDir(id);
        courseRepo.delete(id);
        try { deleteFileFs(courseDir); } catch { /* non-fatal */ }
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Node (single) ────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DAG_DELETE_NODE,
    (_event, courseId: string, nodeId: string): IpcResponse<void> => {
      try {
        const nodeDir = getNodeDir(courseId, nodeId);
        nodeRepo.delete(nodeId);
        try { deleteFileFs(nodeDir); } catch { /* non-fatal */ }
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_NODE_GET,
    (_event, nodeId: string): IpcResponse<DagNode | null> => {
      try {
        return ok(nodeRepo.findById(nodeId));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── DAG ─────────────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_DAG_GET,
    (_event, courseId: string): IpcResponse<DagGraph> => {
      try {
        const nodes = nodeRepo.findByCourse(courseId);
        const edges = edgeRepo.findByCourse(courseId);
        return ok({ nodes, edges });
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_DAG_SAVE,
    (
      _event,
      payload: { courseId: string; nodes: DagNode[]; edges: DagEdge[] }
    ): IpcResponse<DagGraph> => {
      try {
        const db = getDb();
        const upsertNode = db.prepare(
          `INSERT INTO dag_nodes (
             id, course_id, chapter, chapter_order, name, description,
             node_type, status, hours_est, difficulty,
             prerequisites, required_tools, required_cost,
             position_x, position_y
           ) VALUES (
             @id, @course_id, @chapter, @chapter_order, @name, @description,
             @node_type, @status, @hours_est, @difficulty,
             @prerequisites, @required_tools, @required_cost,
             @position_x, @position_y
           )
           ON CONFLICT(id) DO UPDATE SET
             chapter = excluded.chapter,
             chapter_order = excluded.chapter_order,
             name = excluded.name,
             description = excluded.description,
             node_type = excluded.node_type,
             status = excluded.status,
             hours_est = excluded.hours_est,
             difficulty = excluded.difficulty,
             prerequisites = excluded.prerequisites,
             required_tools = excluded.required_tools,
             required_cost = excluded.required_cost,
             position_x = excluded.position_x,
             position_y = excluded.position_y,
             updated_at = datetime('now')`
        );

        // Collect IDs of nodes that will be removed before the transaction
        const incomingIds = new Set(payload.nodes.map((n) => n.id));
        const existingNodes = nodeRepo.findByCourse(payload.courseId);
        const removedNodes = existingNodes.filter((n) => !incomingIds.has(n.id));

        db.transaction(() => {
          for (const node of payload.nodes) {
            upsertNode.run({
              ...node,
              prerequisites: JSON.stringify(node.prerequisites),
              required_tools: JSON.stringify(node.required_tools),
              required_cost: JSON.stringify(node.required_cost),
            });
          }
          // Delete nodes that are no longer in the DAG
          for (const node of removedNodes) {
            nodeRepo.delete(node.id);
          }
          edgeRepo.saveAll(payload.courseId, payload.edges);
          // Keep total_nodes in sync
          db.prepare(
            `UPDATE courses SET
               total_nodes = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ?),
               done_nodes  = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ? AND status = 'done'),
               updated_at  = datetime('now')
             WHERE id = ?`
          ).run(payload.courseId, payload.courseId, payload.courseId);
        })();

        // Ensure FS dirs for all nodes (non-fatal)
        for (const node of payload.nodes) {
          try { ensureNodeDir(payload.courseId, node.id); } catch { /* non-fatal */ }
        }
        // Delete FS dirs for removed nodes (non-fatal)
        for (const node of removedNodes) {
          try { deleteFileFs(getNodeDir(payload.courseId, node.id)); } catch { /* non-fatal */ }
        }

        return ok({
          nodes: nodeRepo.findByCourse(payload.courseId),
          edges: edgeRepo.findByCourse(payload.courseId),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Session ──────────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_SESSION_START,
    (_event, data: StartSessionDto): IpcResponse => {
      try {
        return ok(sessionRepo.start(data));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_SESSION_END,
    (_event, id: string, data: EndSessionDto): IpcResponse => {
      try {
        return ok(sessionRepo.end(id, data));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Files ────────────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_FILES_GET,
    (_event, nodeId: string): IpcResponse<FileRecord[]> => {
      try {
        const rows = getDb()
          .prepare<[string], FileRow>(
            'SELECT * FROM files WHERE node_id = ? ORDER BY created_at ASC'
          )
          .all(nodeId);
        return ok(rows.map(rowToFile));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_FILE_CREATE,
    (_event, data: CreateFileDto): IpcResponse<FileRecord> => {
      try {
        const id = data.id ?? randomUUID();
        getDb()
          .prepare(
            `INSERT INTO files (id, node_id, course_id, file_type, name, content, file_path, is_locked)
             VALUES (@id, @node_id, @course_id, @file_type, @name, @content, @file_path, @is_locked)`
          )
          .run({
            id,
            node_id: data.node_id ?? null,
            course_id: data.course_id ?? null,
            file_type: data.file_type,
            name: data.name,
            content: data.content ?? null,
            file_path: data.file_path ?? null,
            is_locked: data.is_locked ? 1 : 0,
          });
        const row = getDb()
          .prepare<[string], FileRow>('SELECT * FROM files WHERE id = ?')
          .get(id)!;
        // Auto-index into RAG if content is provided
        if (data.content && data.node_id && data.course_id) {
          try { indexFile(id, data.node_id, data.course_id, data.content); } catch { /* non-fatal */ }
        }
        return ok(rowToFile(row));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_FILE_UPDATE,
    (
      _event,
      id: string,
      data: Partial<Pick<FileRecord, 'name' | 'content' | 'file_path' | 'is_locked'>>
    ): IpcResponse<FileRecord> => {
      try {
        const existing = getDb()
          .prepare<[string], FileRow>('SELECT * FROM files WHERE id = ?')
          .get(id);
        if (!existing) throw new Error(`File not found: ${id}`);

        getDb()
          .prepare(
            `UPDATE files SET
               name = @name,
               content = @content,
               file_path = @file_path,
               is_locked = @is_locked,
               updated_at = datetime('now')
             WHERE id = @id`
          )
          .run({
            id,
            name: data.name ?? existing.name,
            content: data.content ?? existing.content,
            file_path: data.file_path ?? existing.file_path,
            is_locked: (data.is_locked ?? existing.is_locked === 1) ? 1 : 0,
          });
        const row = getDb()
          .prepare<[string], FileRow>('SELECT * FROM files WHERE id = ?')
          .get(id)!;
        return ok(rowToFile(row));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Notebook ─────────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_NOTEBOOK_GET,
    (_event, nodeId: string, courseId: string) => {
      try {
        return ok(notebookRepo.getOrCreate(nodeId, courseId));
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_NOTEBOOK_SAVE,
    (_event, nodeId: string, courseId: string, data: SaveNotebookDto) => {
      try {
        return ok(notebookRepo.save(nodeId, courseId, data));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Settings ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SETTINGS_GET, (): IpcResponse<Settings> => {
    try {
      return ok(getOrCreateSettings());
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    IPC.SETTINGS_SAVE,
    (_event, data: Partial<Omit<Settings, 'id' | 'created_at'>>): IpcResponse<Settings> => {
      try {
        const current = getOrCreateSettings();
        getDb()
          .prepare(
            `UPDATE settings SET
               default_provider = @default_provider,
               default_model = @default_model,
               guidance_mode = @guidance_mode,
               font_size = @font_size,
               remember_layout = @remember_layout,
               theme = @theme,
               updated_at = datetime('now')
             WHERE id = 1`
          )
          .run({
            default_provider: data.default_provider ?? current.default_provider,
            default_model: data.default_model ?? current.default_model,
            guidance_mode: data.guidance_mode ?? current.guidance_mode,
            font_size: data.font_size ?? current.font_size,
            remember_layout: (data.remember_layout ?? current.remember_layout) ? 1 : 0,
            theme: data.theme ?? current.theme,
          });
        return ok(getOrCreateSettings());
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Messages ──────────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_MESSAGES_GET,
    (_event, courseId: string, agent: string, nodeId?: string, threadId?: string): IpcResponse<ChatMessage[]> => {
      try {
        interface MsgRow { id: string; role: string; content: string; created_at: string }
        let rows: MsgRow[];
        if (threadId) {
          rows = getDb()
            .prepare<[string], MsgRow>(
              `SELECT id, role, content, created_at
               FROM messages
               WHERE thread_id = ?
               ORDER BY created_at ASC`
            )
            .all(threadId);
        } else if (nodeId) {
          rows = getDb()
            .prepare<[string, string, string], MsgRow>(
              `SELECT id, role, content, created_at
               FROM messages
               WHERE course_id = ? AND agent = ? AND node_id = ?
               ORDER BY created_at ASC`
            )
            .all(courseId, agent, nodeId);
        } else {
          rows = getDb()
            .prepare<[string, string], MsgRow>(
              `SELECT id, role, content, created_at
               FROM messages
               WHERE course_id = ? AND agent = ? AND node_id IS NULL
               ORDER BY created_at ASC`
            )
            .all(courseId, agent);
        }
        const messages: ChatMessage[] = rows.map((r) => ({
          id: r.id,
          role: r.role as 'user' | 'assistant',
          content: r.content,
          timestamp: new Date(r.created_at).getTime(),
        }));
        return ok(messages);
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_MESSAGE_CREATE,
    (
      _event,
      data: { id: string; courseId: string; role: string; content: string; agent: string; nodeId?: string; threadId?: string }
    ): IpcResponse<void> => {
      try {
        const db = getDb();
        db.prepare(
          `INSERT OR IGNORE INTO messages (id, course_id, node_id, role, content, agent, thread_id)
           VALUES (@id, @course_id, @node_id, @role, @content, @agent, @thread_id)`
        ).run({
          id: data.id,
          course_id: data.courseId,
          node_id: data.nodeId ?? null,
          role: data.role,
          content: data.content,
          agent: data.agent,
          thread_id: data.threadId ?? null,
        });
        // Keep thread updated_at in sync
        if (data.threadId) {
          db.prepare(
            `UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?`
          ).run(data.threadId);
        }
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_MESSAGE_DELETE,
    (_event, id: string): IpcResponse<void> => {
      try {
        getDb().prepare('DELETE FROM messages WHERE id = ?').run(id);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Chat threads ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_THREAD_LIST,
    (_event, courseId: string, agent: string, nodeId?: string): IpcResponse<ChatThread[]> => {
      try {
        interface ThreadRow {
          id: string; course_id: string; node_id: string | null;
          agent: string; title: string; created_at: string; updated_at: string; deleted: number;
        }
        let rows: ThreadRow[];
        if (nodeId) {
          rows = getDb()
            .prepare<[string, string, string], ThreadRow>(
              `SELECT * FROM chat_threads
               WHERE course_id = ? AND agent = ? AND node_id = ? AND deleted = 0
               ORDER BY updated_at DESC`
            )
            .all(courseId, agent, nodeId);
        } else {
          rows = getDb()
            .prepare<[string, string], ThreadRow>(
              `SELECT * FROM chat_threads
               WHERE course_id = ? AND agent = ? AND node_id IS NULL AND deleted = 0
               ORDER BY updated_at DESC`
            )
            .all(courseId, agent);
        }
        const threads: ChatThread[] = rows.map((r) => ({
          id: r.id,
          courseId: r.course_id,
          nodeId: r.node_id,
          agent: r.agent as AgentType,
          title: r.title,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          deleted: r.deleted === 1,
        }));
        return ok(threads);
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_THREAD_CREATE,
    (_event, data: { courseId: string; agent: string; nodeId?: string; title?: string }): IpcResponse<ChatThread> => {
      try {
        const id = randomUUID();
        const db = getDb();
        db.prepare(
          `INSERT INTO chat_threads (id, course_id, node_id, agent, title)
           VALUES (@id, @course_id, @node_id, @agent, @title)`
        ).run({
          id,
          course_id: data.courseId,
          node_id: data.nodeId ?? null,
          agent: data.agent,
          title: data.title ?? '新对话',
        });
        interface ThreadRow {
          id: string; course_id: string; node_id: string | null;
          agent: string; title: string; created_at: string; updated_at: string; deleted: number;
        }
        const row = db.prepare<[string], ThreadRow>('SELECT * FROM chat_threads WHERE id = ?').get(id)!;
        return ok({
          id: row.id, courseId: row.course_id, nodeId: row.node_id,
          agent: row.agent as AgentType, title: row.title,
          createdAt: row.created_at, updatedAt: row.updated_at, deleted: false,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_THREAD_UPDATE,
    (_event, id: string, data: { title?: string }): IpcResponse<void> => {
      try {
        getDb()
          .prepare(`UPDATE chat_threads SET title = @title, updated_at = datetime('now') WHERE id = @id`)
          .run({ id, title: data.title ?? '新对话' });
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    IPC.DB_THREAD_DELETE,
    (_event, id: string): IpcResponse<void> => {
      try {
        getDb()
          .prepare(`UPDATE chat_threads SET deleted = 1, updated_at = datetime('now') WHERE id = ?`)
          .run(id);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Providers ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DB_PROVIDER_LIST, (): IpcResponse<ProviderConfig[]> => {
    try {
      interface ProviderRow {
        id: string; name: string; type: string; base_url: string | null;
        api_key_name: string | null; is_builtin: number; enabled: number;
      }
      const rows = getDb()
        .prepare<[], ProviderRow>('SELECT * FROM providers ORDER BY is_builtin DESC, created_at ASC')
        .all();
      return ok(rows.map((r): ProviderConfig => ({
        id: r.id, name: r.name,
        type: r.type as ProviderConfig['type'],
        baseUrl: r.base_url, apiKeyName: r.api_key_name,
        isBuiltin: r.is_builtin === 1, enabled: r.enabled === 1,
      })));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle(
    IPC.DB_PROVIDER_CREATE,
    (_event, data: CreateProviderDto): IpcResponse<ProviderConfig> => {
      try {
        const id = randomUUID();
        const db = getDb();
        db.prepare(
          `INSERT INTO providers (id, name, type, base_url, api_key_name, is_builtin)
           VALUES (@id, @name, @type, @base_url, @api_key_name, 0)`
        ).run({ id, name: data.name, type: data.type, base_url: data.baseUrl, api_key_name: data.apiKeyName ?? null });
        interface ProviderRow {
          id: string; name: string; type: string; base_url: string | null;
          api_key_name: string | null; is_builtin: number; enabled: number;
        }
        const row = db.prepare<[string], ProviderRow>('SELECT * FROM providers WHERE id = ?').get(id)!;
        return ok({ id: row.id, name: row.name, type: row.type as ProviderConfig['type'],
          baseUrl: row.base_url, apiKeyName: row.api_key_name, isBuiltin: false, enabled: true });
      } catch (err) { return fail(err); }
    }
  );

  ipcMain.handle(
    IPC.DB_PROVIDER_UPDATE,
    (_event, id: string, data: Partial<Pick<ProviderConfig, 'name' | 'baseUrl' | 'apiKeyName' | 'enabled'>>): IpcResponse<void> => {
      try {
        const db = getDb();
        interface ProviderRow { name: string; base_url: string | null; api_key_name: string | null; enabled: number }
        const existing = db.prepare<[string], ProviderRow>(
          'SELECT name, base_url, api_key_name, enabled FROM providers WHERE id = ?'
        ).get(id);
        if (!existing) throw new Error(`Provider not found: ${id}`);
        db.prepare(
          `UPDATE providers SET name = @name, base_url = @base_url, api_key_name = @api_key_name, enabled = @enabled WHERE id = @id`
        ).run({
          id,
          name: data.name ?? existing.name,
          base_url: data.baseUrl !== undefined ? data.baseUrl : existing.base_url,
          api_key_name: data.apiKeyName !== undefined ? data.apiKeyName : existing.api_key_name,
          enabled: (data.enabled !== undefined ? data.enabled : existing.enabled === 1) ? 1 : 0,
        });
        return ok(undefined);
      } catch (err) { return fail(err); }
    }
  );

  ipcMain.handle(
    IPC.DB_PROVIDER_DELETE,
    (_event, id: string): IpcResponse<void> => {
      try {
        getDb().prepare('DELETE FROM providers WHERE id = ? AND is_builtin = 0').run(id);
        return ok(undefined);
      } catch (err) { return fail(err); }
    }
  );

  // ── Provider models ───────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_MODEL_LIST,
    (_event, providerId?: string): IpcResponse<ProviderModel[]> => {
      try {
        interface ModelRow {
          id: string; provider_id: string; model_id: string; label: string; tag: string; is_builtin: number;
        }
        let rows: ModelRow[];
        if (providerId) {
          rows = getDb()
            .prepare<[string], ModelRow>('SELECT * FROM provider_models WHERE provider_id = ? ORDER BY is_builtin DESC, created_at ASC')
            .all(providerId);
        } else {
          rows = getDb()
            .prepare<[], ModelRow>('SELECT * FROM provider_models ORDER BY is_builtin DESC, created_at ASC')
            .all();
        }
        return ok(rows.map((r): ProviderModel => ({
          id: r.id, providerId: r.provider_id, modelId: r.model_id,
          label: r.label, tag: r.tag, isBuiltin: r.is_builtin === 1,
        })));
      } catch (err) { return fail(err); }
    }
  );

  ipcMain.handle(
    IPC.DB_MODEL_CREATE,
    (_event, data: CreateModelDto): IpcResponse<ProviderModel> => {
      try {
        const id = randomUUID();
        const db = getDb();
        db.prepare(
          `INSERT INTO provider_models (id, provider_id, model_id, label, tag, is_builtin)
           VALUES (@id, @provider_id, @model_id, @label, @tag, 0)`
        ).run({ id, provider_id: data.providerId, model_id: data.modelId, label: data.label, tag: data.tag ?? '' });
        return ok({ id, providerId: data.providerId, modelId: data.modelId, label: data.label, tag: data.tag ?? '', isBuiltin: false });
      } catch (err) { return fail(err); }
    }
  );

  ipcMain.handle(
    IPC.DB_MODEL_DELETE,
    (_event, id: string): IpcResponse<void> => {
      try {
        getDb().prepare('DELETE FROM provider_models WHERE id = ?').run(id);
        return ok(undefined);
      } catch (err) { return fail(err); }
    }
  );

  ipcMain.handle(
    IPC.PROVIDER_FETCH_MODELS,
    async (_event, providerId: string): Promise<IpcResponse<{ added: number; models: string[] }>> => {
      try {
        const db = getDb();
        const provider = db.prepare<[string], {
          id: string; type: string; base_url: string | null; api_key_name: string | null;
        }>('SELECT id, type, base_url, api_key_name FROM providers WHERE id = ?').get(providerId);
        if (!provider) return fail(new Error('Provider not found'));

        // Fetch available model IDs
        let modelIds: string[] = [];

        if (provider.type === 'ollama') {
          const baseUrl = provider.base_url ?? 'http://localhost:11434';
          const res = await fetch(`${baseUrl}/api/tags`);
          if (!res.ok) return fail(new Error(`Ollama responded ${res.status}`));
          const json = await res.json() as { models?: Array<{ name: string }> };
          modelIds = (json.models ?? []).map((m) => m.name);
        } else {
          const baseUrl = provider.base_url;
          if (!baseUrl) return fail(new Error('No base URL configured'));
          let apiKey = '';
          if (provider.api_key_name) {
            const { getApiKey } = await import('../utils/keychain');
            apiKey = (await getApiKey(provider.api_key_name)) ?? '';
          }
          const res = await fetch(`${baseUrl}/models`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });
          if (!res.ok) return fail(new Error(`Provider responded ${res.status}`));
          const json = await res.json() as { data?: Array<{ id: string }> };
          // Filter out embedding / audio / image models
          const SKIP = /embed|tts|whisper|dall-e|vision|audio|moderat|rerank/i;
          modelIds = (json.data ?? []).map((m) => m.id).filter((id) => !SKIP.test(id));
        }

        // Insert new models (skip existing)
        const existing = new Set(
          db.prepare<[string], { model_id: string }>('SELECT model_id FROM provider_models WHERE provider_id = ?')
            .all(providerId).map((r) => r.model_id)
        );
        const insert = db.prepare(
          'INSERT OR IGNORE INTO provider_models (id, provider_id, model_id, label, tag, is_builtin) VALUES (?,?,?,?,?,0)'
        );
        const added: string[] = [];
        db.transaction(() => {
          for (const mid of modelIds) {
            if (existing.has(mid)) continue;
            const rowId = `fetched:${providerId}:${mid}`;
            insert.run(rowId, providerId, mid, mid, '');
            added.push(mid);
          }
        })();

        return ok({ added: added.length, models: modelIds });
      } catch (err) { return fail(err); }
    }
  );

  // ── Node complete ─────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_NODE_COMPLETE,
    (_event, nodeId: string): IpcResponse<{ updatedNodes: DagNode[] }> => {
      try {
        const db = getDb();

        // Mark node as done
        db.prepare(
          `UPDATE dag_nodes SET status = 'done', updated_at = datetime('now') WHERE id = ?`
        ).run(nodeId);

        // Find successors (nodes that depend on this node via edges)
        interface EdgeRow { target_node_id: string }
        const successorEdges = db
          .prepare<[string], EdgeRow>('SELECT target_node_id FROM dag_edges WHERE source_node_id = ?')
          .all(nodeId);

        const unlockedIds: string[] = [];
        for (const edge of successorEdges) {
          const targetId = edge.target_node_id;

          // Check if all predecessors of the target are done
          interface PredRow { source_node_id: string }
          const preds = db
            .prepare<[string], PredRow>('SELECT source_node_id FROM dag_edges WHERE target_node_id = ?')
            .all(targetId);

          interface StatusRow { status: string }
          const allDone = preds.every((p) => {
            const n = db
              .prepare<[string], StatusRow>('SELECT status FROM dag_nodes WHERE id = ?')
              .get(p.source_node_id);
            return n?.status === 'done';
          });

          if (allDone) {
            db.prepare(
              `UPDATE dag_nodes SET status = 'available', updated_at = datetime('now') WHERE id = ? AND status = 'locked'`
            ).run(targetId);
            unlockedIds.push(targetId);
          }
        }

        // Update course done_nodes count
        interface NodeRow { course_id: string }
        const nodeRow = db.prepare<[string], NodeRow>('SELECT course_id FROM dag_nodes WHERE id = ?').get(nodeId);
        if (nodeRow) {
          db.prepare(
            `UPDATE courses SET
               done_nodes = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ? AND status = 'done'),
               updated_at = datetime('now')
             WHERE id = ?`
          ).run(nodeRow.course_id, nodeRow.course_id);
        }

        const allUpdatedIds = [nodeId, ...unlockedIds];
        interface DagNodeRow {
          id: string; course_id: string; chapter: string; chapter_order: number;
          name: string; description: string | null; node_type: string; status: string;
          hours_est: number; difficulty: string; prerequisites: string;
          required_tools: string; required_cost: string;
          bloom_target: string | null; learning_type: string | null; priority: string | null;
          position_x: number; position_y: number; created_at: string; updated_at: string;
        }
        const updatedNodes: DagNode[] = allUpdatedIds.map((id) => {
          const r = db.prepare<[string], DagNodeRow>('SELECT * FROM dag_nodes WHERE id = ?').get(id)!;
          return {
            ...r,
            node_type:    r.node_type    as DagNode['node_type'],
            status:       r.status       as DagNode['status'],
            difficulty:   r.difficulty   as DagNode['difficulty'],
            bloom_target: r.bloom_target as DagNode['bloom_target'],
            learning_type: r.learning_type as DagNode['learning_type'],
            priority:     r.priority     as DagNode['priority'],
            prerequisites:  JSON.parse(r.prerequisites)   as string[],
            required_tools: JSON.parse(r.required_tools)  as string[],
            required_cost:  JSON.parse(r.required_cost)   as DagNode['required_cost'],
          };
        });

        return ok({ updatedNodes });
      } catch (err) {
        return fail(err);
      }
    }
  );

}
