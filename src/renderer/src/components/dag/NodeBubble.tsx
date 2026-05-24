import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { X, Wrench, ArrowRight, BookOpen, Pencil, Trash2, Check } from 'lucide-react'
import type { DagNode, Difficulty, NodePriority, NodeStatus, NodeType } from '@shared/types'
import { useAppStore } from '../../stores/app.store'

const STATUS_KEYS: Record<string, string> = {
  locked: 'dag_node.status_locked',
  available: 'dag_node.status_available',
  active: 'dag_node.status_active',
  done: 'dag_node.status_done'
}

const DIFFICULTY_KEYS: Record<string, string> = {
  beginner: 'dag_node.difficulty_beginner',
  intermediate: 'dag_node.difficulty_intermediate',
  advanced: 'dag_node.difficulty_advanced'
}

const STATUS_COLOR: Record<string, string> = {
  locked: 'var(--text3)',
  available: 'var(--accent)',
  active: 'var(--accent)',
  done: 'var(--green)'
}

interface NodeBubbleProps {
  node: DagNode
  allNodes: DagNode[]
  onClose: () => void
  onSaveEdits: (
    nodeId: string,
    data: Partial<DagNode>,
    prerequisites: string[]
  ) => Promise<void> | void
  onDeleteNode: (node: DagNode) => Promise<void> | void
  disabled?: boolean
  isClosing?: boolean
}

interface NodeDraft {
  name: string
  chapter: string
  description: string
  difficulty: Difficulty
  nodeType: NodeType
  status: NodeStatus
  priority: NodePriority | ''
}

function makeDraft(node: DagNode): NodeDraft {
  return {
    name: node.name,
    chapter: node.chapter,
    description: node.description ?? '',
    difficulty: node.difficulty,
    nodeType: node.node_type,
    status: node.status,
    priority: node.priority ?? ''
  }
}

export const NodeBubble: React.FC<NodeBubbleProps> = ({
  node,
  allNodes,
  onClose,
  onSaveEdits,
  onDeleteNode,
  disabled,
  isClosing = false
}) => {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation()
  const setCurrentNode = useAppStore((s) => s.setCurrentNode)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<NodeDraft>(() => makeDraft(node))
  const [draftPrereqs, setDraftPrereqs] = useState<string[]>(node.prerequisites)
  const [saving, setSaving] = useState(false)

  const prereqNodes = allNodes.filter((n) => node.prerequisites.includes(n.id))
  const prereqOptions = useMemo(() => allNodes.filter((n) => n.id !== node.id), [allNodes, node.id])
  const isEn = i18n.language?.startsWith('en')

  useEffect(() => {
    setIsEditing(false)
    setDraft(makeDraft(node))
    setDraftPrereqs(node.prerequisites)
    setSaving(false)
  }, [node.id, node.prerequisites])

  const handleEnter = () => {
    if (node.status === 'locked') return
    setCurrentNode(node.id)
    navigate('/node')
  }

  const updateDraft = <K extends keyof NodeDraft>(key: K, value: NodeDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const togglePrereq = (id: string) => {
    setDraftPrereqs((current) =>
      current.includes(id) ? current.filter((p) => p !== id) : [...current, id]
    )
  }

  const handleSave = async () => {
    const name = draft.name.trim()
    if (!name) return
    setSaving(true)
    try {
      await onSaveEdits(
        node.id,
        {
          name,
          chapter: draft.chapter.trim() || node.chapter,
          description: draft.description.trim() ? draft.description.trim() : null,
          difficulty: draft.difficulty,
          node_type: draft.nodeType,
          status: draft.status,
          priority: draft.priority || null
        },
        draftPrereqs
      )
      setIsEditing(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      window.alert(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        width: 256,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: 'var(--app-workspace-node-detail-bg, var(--surface))',
        borderLeft: '1px solid var(--border)',
        animation: isClosing
          ? 'sidebarSlideOut 170ms cubic-bezier(0.4, 0, 1, 1) both'
          : 'sidebarSlideIn 190ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        pointerEvents: isClosing ? 'none' : 'auto',
        overflow: 'hidden'
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 14px 10px',
          backgroundColor: 'var(--app-workspace-node-detail-header-bg, var(--topbar))',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
          flexShrink: 0
        }}
      >
        <div key={node.id} className="ui-node-bubble-content-in" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4 }}>{node.chapter}</div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text)',
              lineHeight: 1.3,
              wordBreak: 'break-word'
            }}
          >
            {node.name}
          </div>
        </div>
        <button
          className="ui-pressable"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text3)',
            padding: 2,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            borderRadius: 4
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)'
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Scrollable body */}
      <div
        key={`${node.id}:${isEditing ? 'edit' : 'view'}`}
        className="ui-node-bubble-content-in"
        style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}
      >
        {isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <FieldLabel>{t('dag_node.name')}</FieldLabel>
              <TextInput
                value={draft.name}
                onChange={(value) => updateDraft('name', value)}
                autoFocus
              />
            </div>

            <div>
              <FieldLabel>{t('dag_node.chapter')}</FieldLabel>
              <TextInput
                value={draft.chapter}
                onChange={(value) => updateDraft('chapter', value)}
              />
            </div>

            <div>
              <FieldLabel>{t('dag_node.description')}</FieldLabel>
              <textarea
                className="ui-focus-ring"
                value={draft.description}
                onChange={(e) => updateDraft('description', e.target.value)}
                rows={5}
                style={inputStyle({ minHeight: 92, resize: 'vertical', lineHeight: 1.5 })}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <FieldLabel>{t('dag_node.difficulty')}</FieldLabel>
                <SelectInput
                  value={draft.difficulty}
                  onChange={(value) => updateDraft('difficulty', value as Difficulty)}
                  options={[
                    ['beginner', t('dag_node.difficulty_beginner')],
                    ['intermediate', t('dag_node.difficulty_intermediate')],
                    ['advanced', t('dag_node.difficulty_advanced')]
                  ]}
                />
              </div>
              <div>
                <FieldLabel>{t('dag_node.type')}</FieldLabel>
                <SelectInput
                  value={draft.nodeType}
                  onChange={(value) => updateDraft('nodeType', value as NodeType)}
                  options={[
                    ['main', t('dag_node.type_main')],
                    ['boss', t('dag_node.type_boss')]
                  ]}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <FieldLabel>{t('dag_node.status')}</FieldLabel>
                <SelectInput
                  value={draft.status}
                  onChange={(value) => updateDraft('status', value as NodeStatus)}
                  options={[
                    ['locked', t('dag_node.status_locked')],
                    ['available', t('dag_node.status_available')],
                    ['active', t('dag_node.status_active')],
                    ['done', t('dag_node.status_done')]
                  ]}
                />
              </div>
              <div>
                <FieldLabel>{t('dag_node.priority')}</FieldLabel>
                <SelectInput
                  value={draft.priority}
                  onChange={(value) => updateDraft('priority', value as NodePriority | '')}
                  options={[
                    ['', t('dag_node.priority_empty')],
                    ['must', 'must'],
                    ['should', 'should'],
                    ['nice_to_have', 'nice']
                  ]}
                />
              </div>
            </div>

            <div>
              <FieldLabel>{t('dag_node.prerequisites')}</FieldLabel>
              {prereqOptions.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {t('dag_node.no_prerequisites')}
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: 150,
                    overflowY: 'auto',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    backgroundColor: 'var(--app-workspace-bg, var(--bg))'
                  }}
                >
                  {prereqOptions.map((option, index) => (
                    <label
                      key={option.id}
                      style={{
                        display: 'flex',
                        gap: 7,
                        alignItems: 'flex-start',
                        padding: '7px 8px',
                        borderBottom:
                          index === prereqOptions.length - 1 ? 'none' : '1px solid var(--border)',
                        fontSize: 11,
                        color: 'var(--text2)',
                        cursor: 'pointer'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={draftPrereqs.includes(option.id)}
                        onChange={() => togglePrereq(option.id)}
                        style={{ marginTop: 1 }}
                      />
                      <span style={{ lineHeight: 1.35, wordBreak: 'break-word' }}>
                        {option.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Status & difficulty */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              <Tag color={STATUS_COLOR[node.status]}>
                {STATUS_KEYS[node.status]
                  ? t(STATUS_KEYS[node.status] as Parameters<typeof t>[0])
                  : node.status}
              </Tag>
              <Tag color="var(--text3)">
                {DIFFICULTY_KEYS[node.difficulty]
                  ? t(DIFFICULTY_KEYS[node.difficulty] as Parameters<typeof t>[0])
                  : node.difficulty}
              </Tag>
            </div>

            {/* Description — full text, no clamp */}
            {node.description && (
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--text2)',
                  lineHeight: 1.6,
                  margin: '0 0 12px',
                  wordBreak: 'break-word'
                }}
              >
                {node.description}
              </p>
            )}

            {(node.rationale || node.source_ids.length > 0) && (
              <div
                style={{
                  padding: '8px 9px',
                  backgroundColor: 'var(--app-workspace-muted-bg, var(--surface2))',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  marginBottom: 12
                }}
              >
                {node.rationale && (
                  <InfoRow
                    icon={<BookOpen size={11} />}
                    label={`${isEn ? 'Planning basis' : '规划依据'}：${node.rationale}`}
                  />
                )}
                {node.source_ids.length > 0 && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text3)',
                      lineHeight: 1.5,
                      wordBreak: 'break-all'
                    }}
                  >
                    {isEn ? 'Sources' : '来源'} {node.source_ids.length} ·{' '}
                    {node.source_ids.slice(0, 3).join(', ')}
                  </div>
                )}
              </div>
            )}

            <div
              style={{
                height: 1,
                backgroundColor: 'var(--border)',
                margin: '0 0 10px'
              }}
            />

            {/* Required tools */}
            {node.required_tools.length > 0 && (
              <InfoRow icon={<Wrench size={11} />} label={node.required_tools.join('、')} />
            )}

            {/* Prerequisites */}
            {prereqNodes.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>
                  {t('dag_node.prerequisites')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {prereqNodes.map((p) => (
                    <span
                      key={p.id}
                      style={{
                        fontSize: 10,
                        padding: '2px 7px',
                        backgroundColor: 'var(--app-workspace-muted-bg, var(--surface2))',
                        border: '1px solid var(--border)',
                        borderRadius: 3,
                        color: 'var(--text2)'
                      }}
                    >
                      {p.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer — always visible */}
      <div
        style={{
          padding: '10px 14px 14px',
          borderTop: '1px solid var(--border)',
          flexShrink: 0
        }}
      >
        {isEditing ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionButton
              icon={<Check size={13} />}
              label={saving ? t('common.saving') : t('dag_node.save_changes')}
              onClick={() => {
                void handleSave()
              }}
              disabled={disabled || saving || !draft.name.trim()}
              accent
            />
            <ActionButton
              icon={<X size={13} />}
              label={t('dag_node.cancel_edit')}
              onClick={() => {
                setDraft(makeDraft(node))
                setDraftPrereqs(node.prerequisites)
                setIsEditing(false)
              }}
              disabled={saving}
            />
          </div>
        ) : (
          <>
            <button
              className="ui-pressable"
              onClick={handleEnter}
              disabled={node.status === 'locked'}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '8px 0',
                backgroundColor: node.status === 'locked' ? 'var(--app-workspace-muted-bg, var(--surface2))' : 'var(--accent)',
                color: node.status === 'locked' ? 'var(--text3)' : '#fff',
                border: 'none',
                borderRadius: 'var(--r)',
                fontSize: 12,
                fontWeight: 600,
                cursor: node.status === 'locked' ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--sans)',
                transition: 'opacity 0.15s'
              }}
              onMouseEnter={(e) => {
                if (node.status !== 'locked')
                  (e.currentTarget as HTMLButtonElement).style.opacity = '0.85'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLButtonElement).style.opacity = '1'
              }}
            >
              {node.status === 'locked' ? t('dag_node.node_locked') : t('dag_node.enter_node')}
              {node.status !== 'locked' && <ArrowRight size={12} />}
            </button>
            <div
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}
            >
              <ActionButton
                icon={<Pencil size={13} />}
                label={t('dag_node.edit')}
                onClick={() => setIsEditing(true)}
                disabled={disabled}
              />
              <ActionButton
                icon={<Trash2 size={13} />}
                label={t('dag_node.delete')}
                onClick={() => {
                  void onDeleteNode(node)
                }}
                disabled={disabled}
                danger
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

const Tag: React.FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => (
  <span
    className="ui-scale-in"
    style={{
      fontSize: 10,
      fontWeight: 500,
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 7px',
      backgroundColor: 'var(--app-workspace-muted-bg, var(--surface2))',
      border: '1px solid var(--border)',
      borderRadius: 20,
      color
    }}
  >
    {children}
  </span>
)

const InfoRow: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 6,
      fontSize: 11,
      color: 'var(--text2)',
      marginBottom: 6
    }}
  >
    <span style={{ color: 'var(--text3)', display: 'flex', marginTop: 1, flexShrink: 0 }}>
      {icon}
    </span>
    <span style={{ wordBreak: 'break-word', lineHeight: 1.5 }}>{label}</span>
  </div>
)

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, marginBottom: 4 }}>
    {children}
  </div>
)

function inputStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid var(--border)',
    borderRadius: 6,
    backgroundColor: 'var(--app-workspace-bg, var(--bg))',
    color: 'var(--text)',
    fontSize: 12,
    padding: '7px 8px',
    fontFamily: 'var(--sans)',
    outline: 'none',
    transition: 'border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease',
    ...extra
  }
}

const TextInput: React.FC<{
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}> = ({ value, onChange, autoFocus }) => (
  <input
    className="ui-focus-ring"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    autoFocus={autoFocus}
    style={inputStyle()}
  />
)

const SelectInput: React.FC<{
  value: string
  onChange: (value: string) => void
  options: Array<[string, string]>
}> = ({ value, onChange, options }) => (
  <select
    className="ui-focus-ring"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    style={inputStyle({ padding: '6px 7px' })}
  >
    {options.map(([optionValue, label]) => (
      <option key={optionValue || '__empty'} value={optionValue}>
        {label}
      </option>
    ))}
  </select>
)

const ActionButton: React.FC<{
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  accent?: boolean
  danger?: boolean
}> = ({ icon, label, onClick, disabled, accent, danger }) => {
  const color = danger ? '#b45309' : accent ? 'var(--accent)' : 'var(--text2)'
  return (
    <button
      className="ui-pressable"
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: '7px 6px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        backgroundColor: accent ? 'var(--accent-s)' : danger ? 'var(--amber-s)' : 'var(--app-workspace-card-bg, var(--surface))',
        color: disabled ? 'var(--text3)' : color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'var(--sans)',
        opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden'
      }}
    >
      {icon}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </button>
  )
}
