// Full-page database view (Phase 3). Renders a Notion-style table or board for
// a page whose kind==='database'. Rows are pages (database_id set) whose props
// live in a jsonb map keyed by property id; the row title is the implicit
// "Name" column. Clicking a row's title opens it as a page (/p/<rowId>) — a
// full-page nav, matching the repo's client-nav lesson.
//
// All mutations go through the createServerFn wrappers in ~/server/docs and we
// re-fetch the affected slice (schema and/or rows) after each change. v1 keeps
// state local + optimistic-free for correctness.

import { useEffect, useMemo, useState } from 'react';
import {
  AUTO_PROPERTY_TYPES,
  dbRows as dbRowsFn,
  dbSchema as dbSchemaFn,
  propAdd as propAddFn,
  rowAdd as rowAddFn,
  rowDelete as rowDeleteFn,
  rowUpdate as rowUpdateFn,
  searchMentions as searchMentionsFn,
  uploadFile as uploadFileFn,
  viewAdd as viewAddFn,
  viewUpdate as viewUpdateFn,
  type DbProperty,
  type DbRow,
  type DbSchema,
  type DbView,
  type FileRef,
  type JsonValue,
  type PropertyType,
  type SelectOption,
  type ViewType,
} from '~/server/docs';

const PROPERTY_TYPES: { value: PropertyType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'select', label: 'Select' },
  { value: 'multi_select', label: 'Multi-select' },
  { value: 'status', label: 'Status' },
  { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'person', label: 'Person' },
  { value: 'files', label: 'Files & media' },
  { value: 'created_time', label: 'Created time' },
  { value: 'created_by', label: 'Created by' },
  { value: 'last_edited_time', label: 'Last edited time' },
  { value: 'last_edited_by', label: 'Last edited by' },
];

const SELECT_TYPES = new Set(['select', 'status']);
const DATE_TYPES = new Set(['date']);
const FILE_TYPES = new Set(['files']);

const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  table: 'Table',
  board: 'Board',
  list: 'List',
  gallery: 'Gallery',
  calendar: 'Calendar',
  timeline: 'Timeline',
};

const ADDABLE_VIEW_TYPES: ViewType[] = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'];

// ---------- shared value rendering ----------

/** Read a row's value for a property, computing auto/meta types from row.meta. */
function readPropValue(row: DbRow, property: DbProperty): JsonValue {
  switch (property.type) {
    case 'created_time':
      return row.meta.createdTime;
    case 'last_edited_time':
      return row.meta.lastEditedTime;
    case 'created_by':
    case 'last_edited_by':
      return row.meta.createdByName ?? row.meta.createdById ?? null;
    default:
      return row.props[property.id] ?? null;
  }
}

/** Human-friendly read-only text for any value (used by list/gallery/cards). */
function renderValueText(row: DbRow, property: DbProperty): string {
  const value = readPropValue(row, property);
  if (value === null || value === undefined || value === '') return '';
  switch (property.type) {
    case 'created_time':
    case 'last_edited_time':
      return new Date(String(value)).toLocaleString();
    case 'checkbox':
      return value ? '✓' : '';
    case 'select':
    case 'status': {
      const opt = (property.config.options ?? []).find((o) => o.id === value);
      return opt?.name ?? String(value);
    }
    case 'multi_select': {
      const opts = property.config.options ?? [];
      const ids = Array.isArray(value) ? (value as string[]) : [];
      return ids.map((id) => opts.find((o) => o.id === id)?.name ?? id).join(', ');
    }
    case 'files': {
      const files = Array.isArray(value) ? (value as unknown as FileRef[]) : [];
      return files.map((f) => f.name).join(', ');
    }
    default:
      return String(value);
  }
}

/** First image URL among a row's `files` properties (for gallery cards). */
function firstImageUrl(row: DbRow, properties: DbProperty[]): string | null {
  for (const p of properties) {
    if (!FILE_TYPES.has(p.type)) continue;
    const value = row.props[p.id];
    const files = Array.isArray(value) ? (value as unknown as FileRef[]) : [];
    const img = files.find((f) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(f.url));
    if (img) return img.url;
  }
  return null;
}

/** Read a File to a bare base64 string (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface DatabaseViewProps {
  databaseId: string;
  initialSchema: DbSchema;
}

export function DatabaseView({ databaseId, initialSchema }: DatabaseViewProps) {
  const [schema, setSchema] = useState<DbSchema>(initialSchema);
  const [activeViewId, setActiveViewId] = useState<string>(
    initialSchema.views[0]?.id ?? '',
  );
  const [rows, setRows] = useState<DbRow[]>([]);
  const [loading, setLoading] = useState(true);

  const activeView = useMemo(
    () => schema.views.find((v) => v.id === activeViewId) ?? schema.views[0],
    [schema.views, activeViewId],
  );

  async function refreshSchema(): Promise<DbSchema> {
    const next = await dbSchemaFn({ data: { databaseId } });
    setSchema(next);
    return next;
  }

  async function refreshRows(viewId?: string) {
    setLoading(true);
    try {
      const effectiveViewId = viewId ?? (activeViewId || undefined);
      const next = await dbRowsFn({ data: { databaseId, viewId: effectiveViewId } });
      setRows(next);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshRows(activeViewId || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId]);

  async function handleAddRow(initialProps?: Record<string, JsonValue>) {
    const created = await rowAddFn({ data: { databaseId } });
    if (initialProps && Object.keys(initialProps).length > 0) {
      await rowUpdateFn({ data: { id: created.id, props: initialProps } });
    }
    await refreshRows();
  }

  async function handleRowPatch(id: string, patch: { title?: string; props?: Record<string, JsonValue> }) {
    await rowUpdateFn({ data: { id, ...patch } });
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              title: patch.title ?? r.title,
              props: patch.props ? { ...r.props, ...patch.props } : r.props,
            }
          : r,
      ),
    );
  }

  async function handleDeleteRow(id: string) {
    await rowDeleteFn({ data: { id } });
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleAddProperty(name: string, type: PropertyType) {
    const config =
      SELECT_TYPES.has(type) || type === 'multi_select' ? { options: [] as SelectOption[] } : {};
    await propAddFn({ data: { databaseId, name, type, config } });
    await refreshSchema();
  }

  async function handleAddView(type: ViewType) {
    const created = await viewAddFn({ data: { databaseId, type } });
    const next = await refreshSchema();
    // Seed a sensible default config prop for the new view's grouping/placement.
    if (type === 'board') {
      const groupProp = next.properties.find((p) => SELECT_TYPES.has(p.type));
      if (groupProp) {
        await viewUpdateFn({ data: { id: created.id, config: { groupBy: groupProp.id } } });
        await refreshSchema();
      }
    } else if (type === 'calendar' || type === 'timeline') {
      const dateProp = next.properties.find((p) => DATE_TYPES.has(p.type));
      if (dateProp) {
        await viewUpdateFn({ data: { id: created.id, config: { datePropId: dateProp.id } } });
        await refreshSchema();
      }
    } else if (type === 'gallery') {
      const cardProp = next.properties[0];
      if (cardProp) {
        await viewUpdateFn({ data: { id: created.id, config: { cardPropId: cardProp.id } } });
        await refreshSchema();
      }
    }
    setActiveViewId(created.id);
  }

  /** Shallow-merge a config patch into the active view's stored config. */
  async function handleSetViewConfig(patch: Record<string, JsonValue>) {
    if (!activeView) return;
    await viewUpdateFn({ data: { id: activeView.id, config: { ...activeView.config, ...patch } } });
    await refreshSchema();
  }

  async function handleAddOption(property: DbProperty, name: string): Promise<SelectOption> {
    const option: SelectOption = {
      id: crypto.randomUUID(),
      name,
      color: 'gray',
    };
    const options = [...(property.config.options ?? []), option];
    await propAddOptionViaUpdate(property.id, options);
    await refreshSchema();
    return option;
  }

  async function handleSetGroupBy(propId: string) {
    if (!activeView) return;
    await viewUpdateFn({ data: { id: activeView.id, config: { ...activeView.config, groupBy: propId } } });
    await refreshSchema();
  }

  if (!activeView) {
    return <div className="text-sm text-gray-400">No views.</div>;
  }

  return (
    <div>
      {/* View switcher */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-3 text-sm">
        {schema.views.map((v) => (
          <button
            key={v.id}
            className={`px-3 py-1.5 -mb-px border-b-2 ${
              v.id === activeView.id
                ? 'border-gray-800 text-gray-900 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
            onClick={() => setActiveViewId(v.id)}
          >
            {v.name}
          </button>
        ))}
        <div className="ml-1 flex items-center gap-1">
          <select
            className="px-1 py-1 text-gray-400 hover:text-gray-700 bg-transparent outline-none"
            value=""
            onChange={(e) => {
              const t = e.target.value as ViewType;
              if (t) void handleAddView(t);
              e.target.value = '';
            }}
            aria-label="Add view"
          >
            <option value="">＋ Add view…</option>
            {ADDABLE_VIEW_TYPES.map((t) => (
              <option key={t} value={t}>
                {VIEW_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-gray-400 py-4">Loading rows…</div>
      ) : activeView.type === 'board' ? (
        <BoardView
          view={activeView}
          properties={schema.properties}
          rows={rows}
          onSetGroupBy={(p) => void handleSetGroupBy(p)}
          onAddRow={(props) => void handleAddRow(props)}
          onPatchRow={(id, patch) => void handleRowPatch(id, patch)}
        />
      ) : activeView.type === 'list' ? (
        <ListView view={activeView} properties={schema.properties} rows={rows} />
      ) : activeView.type === 'gallery' ? (
        <GalleryView
          view={activeView}
          properties={schema.properties}
          rows={rows}
          onSetCardProp={(p) => void handleSetViewConfig({ cardPropId: p })}
        />
      ) : activeView.type === 'calendar' ? (
        <CalendarView
          view={activeView}
          properties={schema.properties}
          rows={rows}
          onSetDateProp={(p) => void handleSetViewConfig({ datePropId: p })}
        />
      ) : activeView.type === 'timeline' ? (
        <TimelineView
          view={activeView}
          properties={schema.properties}
          rows={rows}
          onSetDateProp={(p) => void handleSetViewConfig({ datePropId: p })}
        />
      ) : (
        <TableView
          properties={schema.properties}
          rows={rows}
          onAddRow={() => void handleAddRow()}
          onPatchRow={(id, patch) => void handleRowPatch(id, patch)}
          onDeleteRow={(id) => void handleDeleteRow(id)}
          onAddProperty={(name, type) => void handleAddProperty(name, type)}
          onAddOption={handleAddOption}
        />
      )}
    </div>
  );
}

/** Persist a new option list onto a select/status/multi_select property. */
async function propAddOptionViaUpdate(propertyId: string, options: SelectOption[]) {
  const { propUpdate } = await import('~/server/docs');
  await propUpdate({ data: { id: propertyId, config: { options } } });
}

// ---------- Table view ----------

interface TableViewProps {
  properties: DbProperty[];
  rows: DbRow[];
  onAddRow: () => void;
  onPatchRow: (id: string, patch: { title?: string; props?: Record<string, JsonValue> }) => void;
  onDeleteRow: (id: string) => void;
  onAddProperty: (name: string, type: PropertyType) => void;
  onAddOption: (property: DbProperty, name: string) => Promise<SelectOption>;
}

function TableView({
  properties,
  rows,
  onAddRow,
  onPatchRow,
  onDeleteRow,
  onAddProperty,
  onAddOption,
}: TableViewProps) {
  const [addingProp, setAddingProp] = useState(false);
  const [newPropName, setNewPropName] = useState('');
  const [newPropType, setNewPropType] = useState<PropertyType>('text');

  function submitNewProp() {
    const name = newPropName.trim();
    if (!name) return;
    onAddProperty(name, newPropType);
    setNewPropName('');
    setNewPropType('text');
    setAddingProp(false);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className="py-1.5 px-2 font-medium min-w-[12rem]">Name</th>
            {properties.map((p) => (
              <th key={p.id} className="py-1.5 px-2 font-medium min-w-[8rem]">
                {p.name}
              </th>
            ))}
            <th className="py-1.5 px-2 font-medium">
              {addingProp ? (
                <span className="flex items-center gap-1">
                  <input
                    autoFocus
                    className="border border-gray-300 rounded px-1 py-0.5 w-24 text-gray-800"
                    placeholder="Name"
                    value={newPropName}
                    onChange={(e) => setNewPropName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submitNewProp()}
                  />
                  <select
                    className="border border-gray-300 rounded px-1 py-0.5 text-gray-800"
                    value={newPropType}
                    onChange={(e) => setNewPropType(e.target.value as PropertyType)}
                  >
                    {PROPERTY_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <button className="text-gray-700 hover:text-gray-900" onClick={submitNewProp}>
                    ✓
                  </button>
                  <button
                    className="text-gray-400 hover:text-gray-700"
                    onClick={() => setAddingProp(false)}
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <button
                  className="text-gray-400 hover:text-gray-700"
                  onClick={() => setAddingProp(true)}
                >
                  ＋ property
                </button>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50 group">
              <td className="py-1 px-2">
                <div className="flex items-center gap-2">
                  <a
                    href={`/p/${row.id}`}
                    className="no-underline text-gray-900 hover:underline truncate"
                  >
                    {row.title || 'Untitled'}
                  </a>
                  <button
                    className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-600 text-xs"
                    onClick={() => onDeleteRow(row.id)}
                    title="Delete row"
                    aria-label="Delete row"
                  >
                    🗑
                  </button>
                </div>
              </td>
              {properties.map((p) => (
                <td key={p.id} className="py-1 px-2">
                  {AUTO_PROPERTY_TYPES.has(p.type) ? (
                    <span className="text-gray-500">{renderValueText(row, p) || '—'}</span>
                  ) : (
                    <CellEditor
                      property={p}
                      value={row.props[p.id] ?? null}
                      onChange={(value) => onPatchRow(row.id, { props: { [p.id]: value } })}
                      onAddOption={(name) => onAddOption(p, name)}
                    />
                  )}
                </td>
              ))}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="mt-2 text-sm text-gray-500 hover:text-gray-800 px-2 py-1"
        onClick={onAddRow}
      >
        ＋ New
      </button>
    </div>
  );
}

// ---------- Cell editor (per property type) ----------

interface CellEditorProps {
  property: DbProperty;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  onAddOption: (name: string) => Promise<SelectOption>;
}

function CellEditor({ property, value, onChange, onAddOption }: CellEditorProps) {
  switch (property.type) {
    case 'checkbox':
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={property.name}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          className="w-full bg-transparent outline-none"
          defaultValue={value === undefined || value === null ? '' : String(value)}
          onBlur={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          aria-label={property.name}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          className="bg-transparent outline-none"
          defaultValue={typeof value === 'string' ? value : ''}
          onBlur={(e) => onChange(e.target.value || null)}
          aria-label={property.name}
        />
      );
    case 'select':
    case 'status':
      return (
        <SelectCell
          options={property.config.options ?? []}
          value={typeof value === 'string' ? value : null}
          onChange={onChange}
          onAddOption={onAddOption}
        />
      );
    case 'multi_select':
      return (
        <MultiSelectCell
          options={property.config.options ?? []}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          onAddOption={onAddOption}
        />
      );
    case 'person':
      return (
        <PersonCell
          value={typeof value === 'string' ? value : null}
          onChange={onChange}
        />
      );
    case 'files':
      return (
        <FilesCell
          value={Array.isArray(value) ? (value as unknown as FileRef[]) : []}
          onChange={(files) => onChange(files as unknown as JsonValue)}
        />
      );
    case 'url':
    case 'email':
    case 'phone':
    case 'text':
    default:
      return (
        <input
          type={property.type === 'email' ? 'email' : property.type === 'url' ? 'url' : 'text'}
          className="w-full bg-transparent outline-none"
          defaultValue={typeof value === 'string' ? value : ''}
          onBlur={(e) => onChange(e.target.value)}
          aria-label={property.name}
        />
      );
  }
}

// ---------- Select / Status cell ----------

interface SelectCellProps {
  options: SelectOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  onAddOption: (name: string) => Promise<SelectOption>;
}

function SelectCell({ options, value, onChange, onAddOption }: SelectCellProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  async function submitOption() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const opt = await onAddOption(trimmed);
    onChange(opt.id);
    setName('');
    setAdding(false);
  }

  if (adding) {
    return (
      <span className="flex items-center gap-1">
        <input
          autoFocus
          className="border border-gray-300 rounded px-1 py-0.5 w-20"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submitOption()}
        />
        <button onClick={() => void submitOption()}>✓</button>
      </span>
    );
  }

  return (
    <select
      className="bg-transparent outline-none w-full"
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === '__add__') setAdding(true);
        else onChange(e.target.value || null);
      }}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      <option value="__add__">＋ Add option…</option>
    </select>
  );
}

// ---------- Multi-select cell ----------

interface MultiSelectCellProps {
  options: SelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  onAddOption: (name: string) => Promise<SelectOption>;
}

function MultiSelectCell({ options, value, onChange, onAddOption }: MultiSelectCellProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const byId = new Map(options.map((o) => [o.id, o]));

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  async function submitOption() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const opt = await onAddOption(trimmed);
    onChange([...value, opt.id]);
    setName('');
  }

  return (
    <div className="relative">
      <button
        className="flex flex-wrap gap-1 w-full text-left min-h-[1.25rem]"
        onClick={() => setOpen((v) => !v)}
      >
        {value.length === 0 ? (
          <span className="text-gray-300">—</span>
        ) : (
          value.map((id) => (
            <span key={id} className="bg-gray-100 rounded px-1 text-xs">
              {byId.get(id)?.name ?? id}
            </span>
          ))
        )}
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 bg-white border border-gray-200 rounded shadow p-1 min-w-[8rem]">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-1 px-1 py-0.5 hover:bg-gray-50">
              <input
                type="checkbox"
                checked={value.includes(o.id)}
                onChange={() => toggle(o.id)}
              />
              <span className="text-xs">{o.name}</span>
            </label>
          ))}
          <div className="flex items-center gap-1 mt-1 border-t border-gray-100 pt-1">
            <input
              className="border border-gray-300 rounded px-1 py-0.5 w-20 text-xs"
              placeholder="New"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submitOption()}
            />
            <button className="text-xs" onClick={() => void submitOption()}>
              ＋
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------- Board view ----------

interface BoardViewProps {
  view: DbView;
  properties: DbProperty[];
  rows: DbRow[];
  onSetGroupBy: (propId: string) => void;
  onAddRow: (props: Record<string, JsonValue>) => void;
  onPatchRow: (id: string, patch: { props?: Record<string, JsonValue> }) => void;
}

function BoardView({ view, properties, rows, onSetGroupBy, onAddRow, onPatchRow }: BoardViewProps) {
  const groupable = properties.filter((p) => SELECT_TYPES.has(p.type));
  const groupBy = view.config.groupBy ?? groupable[0]?.id ?? '';
  const groupProp = properties.find((p) => p.id === groupBy);

  if (!groupProp) {
    return (
      <div className="text-sm text-gray-500">
        Board views need a select or status property to group by.{' '}
        {groupable.length > 0 ? (
          <select
            className="border border-gray-300 rounded px-1 py-0.5 ml-1"
            value={groupBy}
            onChange={(e) => onSetGroupBy(e.target.value)}
          >
            <option value="">Choose…</option>
            {groupable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          'Add one first.'
        )}
      </div>
    );
  }

  const options = groupProp.config.options ?? [];
  // One column per option, plus a "No <prop>" column for unset rows.
  const columns: { id: string | null; label: string }[] = [
    ...options.map((o) => ({ id: o.id, label: o.name })),
    { id: null, label: `No ${groupProp.name}` },
  ];

  function rowsFor(optId: string | null): DbRow[] {
    return rows.filter((r) => {
      const v = r.props[groupProp!.id];
      return optId === null ? !v : v === optId;
    });
  }

  return (
    <div>
      <div className="mb-2 text-xs text-gray-500 flex items-center gap-1">
        Group by:
        <select
          className="border border-gray-300 rounded px-1 py-0.5"
          value={groupBy}
          onChange={(e) => onSetGroupBy(e.target.value)}
        >
          {groupable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((col) => (
          <div key={col.id ?? '__none__'} className="w-64 shrink-0 bg-gray-50 rounded p-2">
            <div className="text-xs font-medium text-gray-600 mb-2 px-1">
              {col.label} <span className="text-gray-400">{rowsFor(col.id).length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {rowsFor(col.id).map((row) => (
                <div key={row.id} className="bg-white border border-gray-200 rounded p-2 text-sm">
                  <a
                    href={`/p/${row.id}`}
                    className="no-underline text-gray-900 hover:underline block truncate"
                  >
                    {row.title || 'Untitled'}
                  </a>
                  <select
                    className="mt-1 text-xs text-gray-500 bg-transparent outline-none w-full"
                    value={(row.props[groupProp.id] as string) ?? ''}
                    onChange={(e) => onPatchRow(row.id, { props: { [groupProp.id]: e.target.value || null } })}
                    aria-label="Move card"
                  >
                    <option value="">No {groupProp.name}</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <button
              className="mt-2 w-full text-left text-xs text-gray-400 hover:text-gray-700 px-1"
              onClick={() => onAddRow(col.id ? { [groupProp.id]: col.id } : {})}
            >
              ＋ card
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Person cell (dropdown backed by /v1/users/search) ----------

interface PersonCellProps {
  value: string | null;
  onChange: (value: string | null) => void;
}

function PersonCell({ value, onChange }: PersonCellProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; label: string }[]>([]);
  // Cache the chosen person's label so a stored id renders as a name even
  // before a search runs.
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void searchMentionsFn({ data: { q } }).then((r) => {
      if (!cancelled) setResults(r);
    });
    return () => {
      cancelled = true;
    };
  }, [q, open]);

  function pick(id: string, name: string) {
    setLabel(name);
    onChange(id);
    setOpen(false);
    setQ('');
  }

  const display = value ? label ?? value : null;

  return (
    <div className="relative">
      <button
        className="w-full text-left truncate"
        onClick={() => setOpen((v) => !v)}
        aria-label="Person"
      >
        {display ? (
          <span className="bg-gray-100 rounded px-1 text-xs">{display}</span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 bg-white border border-gray-200 rounded shadow p-1 min-w-[10rem]">
          <input
            autoFocus
            className="border border-gray-300 rounded px-1 py-0.5 w-full text-xs mb-1"
            placeholder="Search people…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {value ? (
            <button
              className="block w-full text-left text-xs px-1 py-0.5 text-gray-400 hover:bg-gray-50"
              onClick={() => {
                setLabel(null);
                onChange(null);
                setOpen(false);
              }}
            >
              Clear
            </button>
          ) : null}
          {results.map((r) => (
            <button
              key={r.id}
              className="block w-full text-left text-xs px-1 py-0.5 hover:bg-gray-50"
              onClick={() => pick(r.id, r.label)}
            >
              {r.label}
            </button>
          ))}
          {results.length === 0 ? (
            <div className="text-xs text-gray-400 px-1 py-0.5">No matches</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------- Files cell (upload via uploadFile + thumbnails/links) ----------

interface FilesCellProps {
  value: FileRef[];
  onChange: (value: FileRef[]) => void;
}

function FilesCell({ value, onChange }: FilesCellProps) {
  const [busy, setBusy] = useState(false);

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      const added: FileRef[] = [];
      for (const file of Array.from(list)) {
        const dataBase64 = await fileToBase64(file);
        const { url } = await uploadFileFn({
          data: { filename: file.name, contentType: file.type, dataBase64 },
        });
        added.push({ url, name: file.name });
      }
      onChange([...value, ...added]);
    } finally {
      setBusy(false);
    }
  }

  function isImage(url: string): boolean {
    return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(url);
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((f, i) => (
        <span key={`${f.url}-${i}`} className="inline-flex items-center gap-1">
          {isImage(f.url) ? (
            <a href={f.url} target="_blank" rel="noreferrer">
              <img src={f.url} alt={f.name} className="h-6 w-6 object-cover rounded border border-gray-200" />
            </a>
          ) : (
            <a href={f.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">
              {f.name}
            </a>
          )}
          <button
            className="text-gray-300 hover:text-red-600 text-xs"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label="Remove file"
          >
            ✕
          </button>
        </span>
      ))}
      <label className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer">
        {busy ? '…' : '＋'}
        <input
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </label>
    </div>
  );
}

// ---------- List view ----------

interface ListViewProps {
  view: DbView;
  properties: DbProperty[];
  rows: DbRow[];
}

function ListView({ properties, rows }: ListViewProps) {
  // Show up to two inline props next to each row's title (skip files for brevity).
  const inlineProps = properties.filter((p) => !FILE_TYPES.has(p.type)).slice(0, 2);
  if (rows.length === 0) return <div className="text-sm text-gray-400 py-4">No rows.</div>;
  return (
    <div className="divide-y divide-gray-100 border-t border-gray-100">
      {rows.map((row) => (
        <a
          key={row.id}
          href={`/p/${row.id}`}
          className="flex items-center gap-3 py-2 px-1 no-underline text-gray-900 hover:bg-gray-50"
        >
          <span className="truncate font-medium">{row.title || 'Untitled'}</span>
          <span className="flex items-center gap-3 text-xs text-gray-500 truncate">
            {inlineProps.map((p) => {
              const text = renderValueText(row, p);
              return text ? (
                <span key={p.id} className="truncate">
                  {text}
                </span>
              ) : null;
            })}
          </span>
        </a>
      ))}
    </div>
  );
}

// ---------- Gallery view ----------

interface GalleryViewProps {
  view: DbView;
  properties: DbProperty[];
  rows: DbRow[];
  onSetCardProp: (propId: string) => void;
}

function GalleryView({ view, properties, rows, onSetCardProp }: GalleryViewProps) {
  const cardPropId = view.config.cardPropId ?? properties[0]?.id ?? '';
  const cardProp = properties.find((p) => p.id === cardPropId);
  return (
    <div>
      <div className="mb-2 text-xs text-gray-500 flex items-center gap-1">
        Card preview:
        <select
          className="border border-gray-300 rounded px-1 py-0.5"
          value={cardPropId}
          onChange={(e) => onSetCardProp(e.target.value)}
        >
          <option value="">None</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-gray-400 py-4">No rows.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {rows.map((row) => {
            const img = firstImageUrl(row, properties);
            const preview = cardProp ? renderValueText(row, cardProp) : '';
            return (
              <a
                key={row.id}
                href={`/p/${row.id}`}
                className="block no-underline text-gray-900 border border-gray-200 rounded overflow-hidden hover:shadow"
              >
                {img ? (
                  <img src={img} alt="" className="w-full h-28 object-cover" />
                ) : (
                  <div className="w-full h-28 bg-gray-50" />
                )}
                <div className="p-2">
                  <div className="font-medium text-sm truncate">{row.title || 'Untitled'}</div>
                  {preview ? <div className="text-xs text-gray-500 truncate">{preview}</div> : null}
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- date helpers (calendar/timeline) ----------

/** Parse a row's date prop value to a Date (local midnight) or null. */
function rowDate(row: DbRow, datePropId: string): Date | null {
  const raw = row.props[datePropId];
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw + (raw.length === 10 ? 'T00:00:00' : ''));
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Calendar view ----------

interface CalendarViewProps {
  view: DbView;
  properties: DbProperty[];
  rows: DbRow[];
  onSetDateProp: (propId: string) => void;
}

function CalendarView({ view, properties, rows, onSetDateProp }: CalendarViewProps) {
  const dateProps = properties.filter((p) => DATE_TYPES.has(p.type));
  const datePropId = view.config.datePropId ?? dateProps[0]?.id ?? '';
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const grid = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const startWeekday = first.getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [cursor]);

  const byDay = useMemo(() => {
    const map = new Map<string, DbRow[]>();
    if (!datePropId) return map;
    for (const row of rows) {
      const d = rowDate(row, datePropId);
      if (!d) continue;
      const key = ymd(d);
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    return map;
  }, [rows, datePropId]);

  const monthLabel = cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-1">
          Date property:
          <select
            className="border border-gray-300 rounded px-1 py-0.5"
            value={datePropId}
            onChange={(e) => onSetDateProp(e.target.value)}
          >
            <option value="">Choose…</option>
            {dateProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-2 hover:text-gray-800"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
            aria-label="Previous month"
          >
            ‹
          </button>
          <span className="font-medium text-gray-700">{monthLabel}</span>
          <button
            className="px-2 hover:text-gray-800"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>
      {!datePropId ? (
        <div className="text-sm text-gray-500">Pick a date property to place rows on the calendar.</div>
      ) : (
        <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 text-xs">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="bg-gray-50 px-1 py-1 font-medium text-gray-500 text-center">
              {d}
            </div>
          ))}
          {grid.map((cell, i) => (
            <div key={i} className="bg-white min-h-[5rem] p-1 align-top">
              {cell ? (
                <>
                  <div className="text-gray-400 text-[10px] mb-1">{cell.getDate()}</div>
                  <div className="flex flex-col gap-0.5">
                    {(byDay.get(ymd(cell)) ?? []).map((row) => (
                      <a
                        key={row.id}
                        href={`/p/${row.id}`}
                        className="block truncate no-underline bg-gray-100 hover:bg-gray-200 rounded px-1 text-[11px] text-gray-800"
                      >
                        {row.title || 'Untitled'}
                      </a>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Timeline view ----------

interface TimelineViewProps {
  view: DbView;
  properties: DbProperty[];
  rows: DbRow[];
  onSetDateProp: (propId: string) => void;
}

function TimelineView({ view, properties, rows, onSetDateProp }: TimelineViewProps) {
  const dateProps = properties.filter((p) => DATE_TYPES.has(p.type));
  const datePropId = view.config.datePropId ?? dateProps[0]?.id ?? '';

  // Place rows along a horizontal day axis spanning min→max date (clamped to a
  // sensible window). Pure CSS-grid column math, no extra dependency.
  const placed = useMemo(() => {
    if (!datePropId) return null;
    const dated = rows
      .map((row) => ({ row, date: rowDate(row, datePropId) }))
      .filter((x): x is { row: DbRow; date: Date } => x.date !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    if (dated.length === 0) return { dated, start: null as Date | null, days: 0 };
    const start = new Date(dated[0]!.date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dated[dated.length - 1]!.date);
    end.setHours(0, 0, 0, 0);
    const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
    return { dated, start, days: Math.min(days, 366) };
  }, [rows, datePropId]);

  function offsetDays(start: Date, d: Date): number {
    const a = new Date(d);
    a.setHours(0, 0, 0, 0);
    return Math.round((a.getTime() - start.getTime()) / 86_400_000);
  }

  return (
    <div>
      <div className="mb-2 text-xs text-gray-500 flex items-center gap-1">
        Date property:
        <select
          className="border border-gray-300 rounded px-1 py-0.5"
          value={datePropId}
          onChange={(e) => onSetDateProp(e.target.value)}
        >
          <option value="">Choose…</option>
          {dateProps.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {!datePropId ? (
        <div className="text-sm text-gray-500">Pick a date property to plot rows on the timeline.</div>
      ) : !placed || !placed.start || placed.dated.length === 0 ? (
        <div className="text-sm text-gray-400 py-4">No rows with a date.</div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="flex flex-col gap-1 min-w-max">
            {placed.dated.map(({ row, date }) => {
              const off = offsetDays(placed.start!, date);
              return (
                <div key={row.id} className="flex items-center gap-2 text-xs">
                  <div className="relative h-5" style={{ width: `${placed.days * 1.5}rem` }}>
                    <a
                      href={`/p/${row.id}`}
                      className="absolute top-0 h-5 flex items-center bg-blue-100 hover:bg-blue-200 rounded px-2 no-underline text-gray-800 whitespace-nowrap"
                      style={{ left: `${off * 1.5}rem` }}
                      title={`${row.title || 'Untitled'} — ${date.toLocaleDateString()}`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1 shrink-0" />
                      {row.title || 'Untitled'}
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
