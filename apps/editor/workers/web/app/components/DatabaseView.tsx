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
  dbRows as dbRowsFn,
  dbSchema as dbSchemaFn,
  propAdd as propAddFn,
  rowAdd as rowAddFn,
  rowDelete as rowDeleteFn,
  rowUpdate as rowUpdateFn,
  viewAdd as viewAddFn,
  viewUpdate as viewUpdateFn,
  type DbProperty,
  type DbRow,
  type DbSchema,
  type DbView,
  type JsonValue,
  type PropertyType,
  type SelectOption,
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
];

const SELECT_TYPES = new Set(['select', 'status']);

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

  async function handleAddView(type: 'table' | 'board') {
    const created = await viewAddFn({ data: { databaseId, type } });
    const next = await refreshSchema();
    // For board views, default groupBy to the first select/status property.
    if (type === 'board') {
      const groupProp = next.properties.find((p) => SELECT_TYPES.has(p.type));
      if (groupProp) {
        await viewUpdateFn({ data: { id: created.id, config: { groupBy: groupProp.id } } });
        await refreshSchema();
      }
    }
    setActiveViewId(created.id);
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
          <button
            className="px-2 py-1 text-gray-400 hover:text-gray-700"
            onClick={() => void handleAddView('table')}
            title="Add table view"
          >
            ＋ Table
          </button>
          <button
            className="px-2 py-1 text-gray-400 hover:text-gray-700"
            onClick={() => void handleAddView('board')}
            title="Add board view"
          >
            ＋ Board
          </button>
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
                  <CellEditor
                    property={p}
                    value={row.props[p.id] ?? null}
                    onChange={(value) => onPatchRow(row.id, { props: { [p.id]: value } })}
                    onAddOption={(name) => onAddOption(p, name)}
                  />
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
