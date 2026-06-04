// Full-page database view (Phase 3). Renders a Notion-style table or board for
// a page whose kind==='database'. Rows are pages (database_id set) whose props
// live in a jsonb map keyed by property id; the row title is the implicit
// "Name" column. Clicking a row's title opens it as a page (/p/<rowId>) — a
// full-page nav, matching the repo's client-nav lesson.
//
// All mutations go through the createServerFn wrappers in ~/server/docs and we
// re-fetch the affected slice (schema and/or rows) after each change. v1 keeps
// state local + optimistic-free for correctness.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { groupRowsForView, buildSubItemTree, flattenSubItems } from '~/lib/db-view';
import {
  aggOptionsForType,
  computeAggregation,
  AGG_LABEL_KEY,
  type AggregationOp,
} from '~/lib/db-aggregate';
import {
  buildChartSeries,
  normalizeChartConfig,
  formatChartValue,
  chartColor,
  isMeasurableProp,
  isGroupableProp,
  CHART_TYPES,
  MEASURE_KINDS,
  type ChartConfig,
  type ChartType,
  type ChartMeasure,
  type ChartSeries,
  type BuildSeriesLabels,
} from '~/lib/db-chart';
import {
  AUTO_PROPERTY_TYPES,
  dbList as dbListFn,
  dbRows as dbRowsFn,
  dbSchema as dbSchemaFn,
  propAdd as propAddFn,
  relatedRows as relatedRowsFn,
  rowAdd as rowAddFn,
  rowDelete as rowDeleteFn,
  rowSetSubItem as rowSetSubItemFn,
  rowUpdate as rowUpdateFn,
  runActions as runActionsFn,
  automationsList as automationsListFn,
  automationCreate as automationCreateFn,
  automationUpdate as automationUpdateFn,
  automationSetEnabled as automationSetEnabledFn,
  automationDelete as automationDeleteFn,
  searchMentions as searchMentionsFn,
  templatesList as templatesListFn,
  templateCreate as templateCreateFn,
  templateDelete as templateDeleteFn,
  updatePage as updatePageFn,
  uploadFile as uploadFileFn,
  viewAdd as viewAddFn,
  viewUpdate as viewUpdateFn,
  type DatabaseListItem,
  type DbProperty,
  type DbRow,
  type DbSchema,
  type DbTemplate,
  type DbView,
  type FileRef,
  type FilterCondition,
  type FilterGroup,
  type FilterOp,
  type JsonValue,
  type PropertyType,
  type RelationChip,
  type SelectOption,
  type ViewType,
  type Automation,
  type AutomationTrigger,
} from '~/server/docs';
import { describeAction, type ButtonAction } from '@allenlabs/editor';
import { TableSkeleton } from '~/components/Skeleton';

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
  { value: 'relation', label: 'Relation' },
  { value: 'rollup', label: 'Rollup' },
  { value: 'formula', label: 'Formula' },
  { value: 'button', label: 'Button' },
  { value: 'created_time', label: 'Created time' },
  { value: 'created_by', label: 'Created by' },
  { value: 'last_edited_time', label: 'Last edited time' },
  { value: 'last_edited_by', label: 'Last edited by' },
];

const SELECT_TYPES = new Set(['select', 'status']);
const DATE_TYPES = new Set(['date']);
const FILE_TYPES = new Set(['files']);

const ADDABLE_VIEW_TYPES: ViewType[] = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart'];

// ---------- filter operator metadata (Phase 15) ----------

/** Operators available for each property type (drives the filter builder). */
function operatorsForType(type: string): FilterOp[] {
  switch (type) {
    case 'number':
      return ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'];
    case 'checkbox':
      return ['checked', 'unchecked'];
    case 'select':
    case 'status':
    case 'person':
      return ['is', 'is_not', 'is_empty', 'is_not_empty'];
    case 'multi_select':
    case 'relation':
      return ['has', 'has_not', 'is_empty', 'is_not_empty'];
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return ['on', 'before', 'after', 'within_days', 'is_empty', 'is_not_empty'];
    default:
      // text / url / email / phone / formula / rollup / title
      return ['contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty'];
  }
}

/** Operators that take no value input. */
const VALUELESS_OPS = new Set<FilterOp>(['is_empty', 'is_not_empty', 'checked', 'unchecked']);

/** Property options for the builder dropdowns: the implicit title + every prop. */
function filterablePropOptions(properties: DbProperty[]): { id: string; name: string; type: string }[] {
  return [{ id: 'title', name: 'title', type: 'title' }, ...properties.map((p) => ({ id: p.id, name: p.name, type: p.type }))];
}

/** Select/status options across the schema, for the `is`/`has` value picker. */
function valueOptionsFor(properties: DbProperty[], propId: string): SelectOption[] {
  const p = properties.find((x) => x.id === propId);
  if (!p) return [];
  return p.config.options ?? [];
}

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

/**
 * Raw value of a row's cell for footer aggregation. Relation/rollup/formula
 * read from their resolved side-maps; everything else from props/meta. Kept raw
 * (not display-formatted) so the numeric/date/checkbox math sees real values.
 */
function calcValueFor(row: DbRow, property: DbProperty): unknown {
  if (property.type === 'relation') return row.relations?.[property.id] ?? [];
  if (property.type === 'rollup') return row.rollups?.[property.id] ?? null;
  if (property.type === 'formula') return row.formulas?.[property.id] ?? null;
  return readPropValue(row, property);
}

/** Format a rollup's computed value for display (percent/date/number aware). */
function formatRollup(fn: string, value: JsonValue): string {
  if (value === null || value === undefined) return '';
  if (fn === 'percent_checked' || fn === 'percent_unchecked') {
    return typeof value === 'number' ? `${Math.round(value * 100)}%` : String(value);
  }
  if (fn === 'latest_date' || fn === 'earliest_date') {
    return typeof value === 'string' ? new Date(value).toLocaleDateString() : String(value);
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

/** True iff a formula cell holds an `{ __error }` sentinel. */
function formulaError(value: JsonValue): string | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const err = (value as { __error?: unknown }).__error;
    if (typeof err === 'string') return err;
  }
  return null;
}

/** Format a formula's computed value for read-only display. */
function formatFormula(value: JsonValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

/** Human-friendly read-only text for any value (used by list/gallery/cards). */
function renderValueText(row: DbRow, property: DbProperty): string {
  // Relation + rollup read from their resolved/computed side-maps, not props.
  if (property.type === 'relation') {
    const chips = row.relations?.[property.id] ?? [];
    return chips.map((c) => c.title || 'Untitled').join(', ');
  }
  if (property.type === 'rollup') {
    const fn = typeof property.config.fn === 'string' ? property.config.fn : 'count';
    const value = row.rollups?.[property.id] ?? null;
    return formatRollup(fn, value);
  }
  if (property.type === 'formula') {
    const value = row.formulas?.[property.id] ?? null;
    const err = formulaError(value);
    if (err) return `⚠ ${err}`;
    return formatFormula(value);
  }
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
  workspaceId: string;
  initialSchema: DbSchema;
  /** When false, the user is a viewer: hide +row/+property/+view + read-only cells. */
  editable?: boolean;
  /**
   * Phase 15 — LINKED database embed: read this source DB's rows (and add rows
   * to it) instead of `databaseId`'s. The view config (filters/sorts/group)
   * still comes from `databaseId`'s views. Omit for a normal full-page DB.
   */
  sourceDatabaseId?: string | null;
  /** Phase 15 — compact embed mode (linked view): tighter chrome. */
  embed?: boolean;
}

/** View-type → i18n key for its display label (chrome, not user data). */
const VIEW_TYPE_LABEL_KEYS: Record<ViewType, string> = {
  table: 'db.viewTable',
  board: 'db.viewBoard',
  list: 'db.viewList',
  gallery: 'db.viewGallery',
  calendar: 'db.viewCalendar',
  timeline: 'db.viewTimeline',
  chart: 'db.viewChart',
};

export function DatabaseView({
  databaseId,
  workspaceId,
  initialSchema,
  editable = true,
  sourceDatabaseId = null,
  embed = false,
}: DatabaseViewProps) {
  const { t } = useT();
  const [schema, setSchema] = useState<DbSchema>(initialSchema);
  const [showAutomations, setShowAutomations] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string>(
    initialSchema.views[0]?.id ?? '',
  );
  const [rows, setRows] = useState<DbRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Phase 15: row templates for the "New ▾" split button.
  const [templates, setTemplates] = useState<DbTemplate[]>([]);
  // Side-peek: the row currently opened in the right-side panel (or null).
  const [peekRowId, setPeekRowId] = useState<string | null>(null);

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
      const next = await dbRowsFn({
        data: { databaseId, viewId: effectiveViewId, sourceDatabaseId },
      });
      setRows(next);
    } finally {
      setLoading(false);
    }
  }

  // Templates seed rows of the database we actually write to (source for a
  // linked embed, else the page's own DB).
  const writeDbId = sourceDatabaseId ?? databaseId;

  useEffect(() => {
    void refreshRows(activeViewId || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId]);

  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    void templatesListFn({ data: { databaseId: writeDbId } }).then((tpls) => {
      if (!cancelled) setTemplates(tpls);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeDbId, editable]);

  async function handleAddRow(initialProps?: Record<string, JsonValue>, templateId?: string) {
    const created = await rowAddFn({
      data: { databaseId: writeDbId, templateId: templateId ?? null },
    });
    if (initialProps && Object.keys(initialProps).length > 0) {
      // `databaseId` hint routes native_do rows (whose id isn't in PG) to the
      // workspace DO; ignored on the PG path.
      await rowUpdateFn({ data: { id: created.id, props: initialProps, databaseId: writeDbId } });
    }
    await refreshRows();
  }

  async function handleAddSubItem(parentId: string) {
    const created = await rowAddFn({ data: { databaseId: writeDbId, subItemParentId: parentId } });
    void created;
    await refreshRows();
  }

  async function handleSetSubItemParent(id: string, parentId: string | null) {
    await rowSetSubItemFn({ data: { id, parentId } });
    await refreshRows();
  }

  async function handleCreateTemplate() {
    const tpl = await templateCreateFn({ data: { databaseId: writeDbId } });
    setTemplates((prev) => [...prev, tpl]);
    // Open the template page so the user can fill in its props + content.
    if (typeof window !== 'undefined') window.location.href = `/p/${tpl.id}`;
  }

  async function handleDeleteTemplate(id: string) {
    await templateDeleteFn({ data: { id } });
    setTemplates((prev) => prev.filter((tpl) => tpl.id !== id));
  }

  async function handleRowPatch(id: string, patch: { title?: string; props?: Record<string, JsonValue> }) {
    await rowUpdateFn({ data: { id, ...patch, databaseId: writeDbId } });
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
    await rowDeleteFn({ data: { id, databaseId: writeDbId } });
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  // Bulk archive a set of rows (each via the existing rowDelete), then refresh.
  async function handleBulkDelete(ids: string[]) {
    for (const id of ids) {
      await rowDeleteFn({ data: { id, databaseId: writeDbId } });
    }
    setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
  }

  // Bulk set one property's value across a set of rows (each via rowUpdate).
  async function handleBulkSetProp(ids: string[], propId: string, value: JsonValue) {
    for (const id of ids) {
      await rowUpdateFn({ data: { id, props: { [propId]: value }, databaseId: writeDbId } });
    }
    setRows((prev) =>
      prev.map((r) => (ids.includes(r.id) ? { ...r, props: { ...r.props, [propId]: value } } : r)),
    );
  }

  // Persist the per-column aggregation footer selection into the active view's
  // config (`config.calcs[propId] = op`). The `databaseId` hint routes native
  // views to their workspace DO; ignored on the PG path. Footer math is purely
  // client-side, so no row re-fetch is needed.
  async function handleSetCalc(propId: string, op: AggregationOp) {
    if (!activeView) return;
    const prevCalcs = activeView.config.calcs ?? {};
    const nextCalcs: Record<string, string> = { ...prevCalcs };
    if (op === 'none') delete nextCalcs[propId];
    else nextCalcs[propId] = op;
    await viewUpdateFn({
      data: { id: activeView.id, config: { ...activeView.config, calcs: nextCalcs }, databaseId },
    });
    await refreshSchema();
  }

  async function handleAddProperty(
    name: string,
    type: PropertyType,
    extraConfig?: Record<string, JsonValue>,
  ) {
    const config: Record<string, JsonValue> =
      SELECT_TYPES.has(type) || type === 'multi_select'
        ? { options: [] as unknown as JsonValue }
        : {};
    Object.assign(config, extraConfig ?? {});
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
        await viewUpdateFn({ data: { id: created.id, config: { groupBy: groupProp.id }, databaseId } });
        await refreshSchema();
      }
    } else if (type === 'calendar' || type === 'timeline') {
      const dateProp = next.properties.find((p) => DATE_TYPES.has(p.type));
      if (dateProp) {
        await viewUpdateFn({ data: { id: created.id, config: { datePropId: dateProp.id }, databaseId } });
        await refreshSchema();
      }
    } else if (type === 'gallery') {
      const cardProp = next.properties[0];
      if (cardProp) {
        await viewUpdateFn({ data: { id: created.id, config: { cardPropId: cardProp.id }, databaseId } });
        await refreshSchema();
      }
    } else if (type === 'chart') {
      // Seed a sensible default: bar chart, count measure, grouped by the first
      // groupable (select/status/checkbox/person/…) property if one exists.
      const groupProp = next.properties.find((p) => isGroupableProp(p));
      const chart: ChartConfig = {
        chartType: 'bar',
        measure: { kind: 'count' },
        ...(groupProp ? { groupBy: groupProp.id } : {}),
      };
      await viewUpdateFn({ data: { id: created.id, config: { chart }, databaseId } });
      await refreshSchema();
    }
    setActiveViewId(created.id);
  }

  /** Shallow-merge a config patch into the active view's stored config. */
  async function handleSetViewConfig(patch: Record<string, unknown>) {
    if (!activeView) return;
    await viewUpdateFn({ data: { id: activeView.id, config: { ...activeView.config, ...patch }, databaseId } });
    await refreshSchema();
    // Filters/sorts/group changes re-query the rows.
    await refreshRows();
  }

  async function handleAddOption(property: DbProperty, name: string): Promise<SelectOption> {
    const option: SelectOption = {
      id: crypto.randomUUID(),
      name,
      color: 'gray',
    };
    const options = [...(property.config.options ?? []), option];
    await propAddOptionViaUpdate(property.id, options, databaseId);
    await refreshSchema();
    return option;
  }

  async function handleSetGroupBy(propId: string) {
    if (!activeView) return;
    await viewUpdateFn({ data: { id: activeView.id, config: { ...activeView.config, groupBy: propId }, databaseId } });
    await refreshSchema();
  }

  // Persist the chart-view config (chartType / groupBy / measure / kpiLabel)
  // under `config.chart`. The `databaseId` hint routes native views to their
  // workspace DO; ignored on the PG path. Chart math is purely client-side over
  // the already-loaded rows, so no row re-fetch is needed.
  async function handleSetChartConfig(chart: ChartConfig) {
    if (!activeView) return;
    await viewUpdateFn({
      data: { id: activeView.id, config: { ...activeView.config, chart }, databaseId },
    });
    await refreshSchema();
  }

  if (!activeView) {
    return <div className="text-sm text-gray-400 dark:text-gray-500">{t('db.noViews')}</div>;
  }

  return (
    <div data-db-view>
      {/* View switcher */}
      <div className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-700 mb-3 text-sm">
        {schema.views.map((v) => (
          <button
            key={v.id}
            className={`px-3 py-1.5 -mb-px border-b-2 ${
              v.id === activeView.id
                ? 'border-gray-800 text-gray-900 dark:text-gray-100 font-medium'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100'
            }`}
            onClick={() => setActiveViewId(v.id)}
          >
            {v.name}
          </button>
        ))}
        {editable ? (
          <div className="ml-1 flex items-center gap-1">
            <select
              className="px-1 py-1 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 bg-transparent outline-none"
              value=""
              onChange={(e) => {
                const t = e.target.value as ViewType;
                if (t) void handleAddView(t);
                e.target.value = '';
              }}
              aria-label={t('db.addViewAria')}
            >
              <option value="">{t('db.addView')}</option>
              {ADDABLE_VIEW_TYPES.map((vt) => (
                <option key={vt} value={vt}>
                  {t(VIEW_TYPE_LABEL_KEYS[vt])}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {activeView.sourceDatabaseId ? (
          <span className="ml-2 text-[10px] uppercase tracking-wide text-blue-600 bg-blue-50 rounded px-1.5 py-0.5">
            {t('db.linkedBadge')}
          </span>
        ) : null}
        {editable && !activeView.sourceDatabaseId ? (
          <button
            className="ml-auto px-2 py-1 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
            onClick={() => setShowAutomations((s) => !s)}
            data-testid="automations-toggle"
            title={t('db.automations')}
          >
            ⚡ {t('db.automations')}
          </button>
        ) : null}
      </div>

      {editable && showAutomations && !activeView.sourceDatabaseId ? (
        <AutomationsPanel
          databaseId={databaseId}
          properties={schema.properties}
          onClose={() => setShowAutomations(false)}
        />
      ) : null}

      {/* Phase 15: filter / sort / group builder toolbar. */}
      {editable ? (
        <FilterSortGroupBar
          view={activeView}
          properties={schema.properties}
          onSetConfig={(patch) => void handleSetViewConfig(patch)}
        />
      ) : null}

      {loading ? (
        <TableSkeleton />
      ) : activeView.type === 'board' ? (
        <BoardView
          view={activeView}
          properties={schema.properties}
          rows={rows}
          editable={editable}
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
      ) : activeView.type === 'chart' ? (
        <ChartView
          view={activeView}
          properties={schema.properties}
          rows={rows}
          editable={editable}
          onSetChartConfig={(c) => void handleSetChartConfig(c)}
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
          workspaceId={workspaceId}
          databaseId={writeDbId}
          view={activeView}
          properties={schema.properties}
          rows={rows}
          editable={editable}
          templates={templates}
          onAddRow={(props, templateId) => void handleAddRow(props, templateId)}
          onPatchRow={(id, patch) => void handleRowPatch(id, patch)}
          onDeleteRow={(id) => void handleDeleteRow(id)}
          onAddProperty={(name, type, config) => void handleAddProperty(name, type, config)}
          onAddOption={handleAddOption}
          onAddSubItem={(parentId) => void handleAddSubItem(parentId)}
          onSetSubItemParent={(id, parentId) => void handleSetSubItemParent(id, parentId)}
          onCreateTemplate={() => void handleCreateTemplate()}
          onDeleteTemplate={(id) => void handleDeleteTemplate(id)}
          onToggleSubItems={(enabled) => void handleSetViewConfig({ subItemsEnabled: enabled })}
          onSetCalc={(propId, op) => void handleSetCalc(propId, op)}
          onOpenPeek={(id) => setPeekRowId(id)}
          onBulkDelete={(ids) => void handleBulkDelete(ids)}
          onBulkSetProp={(ids, propId, value) => void handleBulkSetProp(ids, propId, value)}
        />
      )}

      {peekRowId ? (
        <SidePeek
          rowId={peekRowId}
          properties={schema.properties}
          row={rows.find((r) => r.id === peekRowId) ?? null}
          editable={editable}
          onAddOption={handleAddOption}
          onPatchRow={(id, patch) => void handleRowPatch(id, patch)}
          onClose={() => setPeekRowId(null)}
        />
      ) : null}
    </div>
  );
}

// ---------- Filter / Sort / Group builder bar (Phase 15) ----------

interface FilterSortGroupBarProps {
  view: DbView;
  properties: DbProperty[];
  onSetConfig: (patch: Record<string, unknown>) => void;
}

/** Normalize a view's stored filters into a FilterGroup for the builder. */
function viewFilterGroup(view: DbView): FilterGroup {
  const fg = view.config.filterGroup;
  if (fg && Array.isArray(fg.conditions)) return fg;
  const legacy = view.config.filters ?? [];
  return {
    conjunction: 'and',
    conditions: legacy
      .filter((c) => typeof c.propId === 'string')
      .map((c) => ({ propId: c.propId, op: (c.op as FilterOp) ?? 'contains', value: c.value })),
  };
}

function FilterSortGroupBar({ view, properties, onSetConfig }: FilterSortGroupBarProps) {
  const { t } = useT();
  const [open, setOpen] = useState<'filter' | 'sort' | 'group' | null>(null);
  const group = viewFilterGroup(view);
  const sorts = view.config.sorts ?? [];
  const groupBy = view.config.groupBy ?? '';
  const propOpts = filterablePropOptions(properties);
  const filterCount = group.conditions.length;

  const tab = (key: 'filter' | 'sort' | 'group', label: string, count: number) => (
    <button
      className={`px-2 py-1 rounded text-xs ${
        open === key ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100'
      }`}
      onClick={() => setOpen((v) => (v === key ? null : key))}
    >
      {label}
      {count > 0 ? <span className="ml-1 text-blue-600">{count}</span> : null}
    </button>
  );

  return (
    <div className="mb-2 text-sm">
      <div className="flex items-center gap-1">
        {tab('filter', t('db.filter'), filterCount)}
        {tab('sort', t('db.sort'), sorts.length)}
        {tab('group', t('db.group'), groupBy ? 1 : 0)}
      </div>

      {open === 'filter' ? (
        <FilterBuilder
          group={group}
          propOpts={propOpts}
          properties={properties}
          onChange={(next) => onSetConfig({ filterGroup: next, filters: [] })}
          onClose={() => setOpen(null)}
        />
      ) : open === 'sort' ? (
        <SortBuilder
          sorts={sorts}
          propOpts={propOpts}
          onChange={(next) => onSetConfig({ sorts: next })}
          onClose={() => setOpen(null)}
        />
      ) : open === 'group' ? (
        <div className="mt-1 p-2 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 inline-flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">{t('db.groupBy')}</span>
          <select
            className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 text-xs"
            value={groupBy}
            onChange={(e) => onSetConfig({ groupBy: e.target.value })}
          >
            <option value="">{t('db.groupNone')}</option>
            {properties
              .filter((p) => SELECT_TYPES.has(p.type) || p.type === 'checkbox' || p.type === 'person')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

/** AND/OR multi-condition filter builder (one level of nesting supported). */
function FilterBuilder({
  group,
  propOpts,
  properties,
  onChange,
  onClose,
}: {
  group: FilterGroup;
  propOpts: { id: string; name: string; type: string }[];
  properties: DbProperty[];
  onChange: (next: FilterGroup) => void;
  onClose: () => void;
}) {
  const { t } = useT();

  const setConjunction = (conjunction: 'and' | 'or') => onChange({ ...group, conjunction });
  const addCondition = () =>
    onChange({
      ...group,
      conditions: [...group.conditions, { propId: 'title', op: 'contains', value: '' }],
    });
  const addNestedGroup = () =>
    onChange({
      ...group,
      conditions: [
        ...group.conditions,
        { conjunction: 'or', conditions: [{ propId: 'title', op: 'contains', value: '' }] },
      ],
    });
  const removeAt = (i: number) =>
    onChange({ ...group, conditions: group.conditions.filter((_, j) => j !== i) });
  const updateAt = (i: number, next: FilterCondition | FilterGroup) =>
    onChange({ ...group, conditions: group.conditions.map((c, j) => (j === i ? next : c)) });

  return (
    <div className="mt-1 p-2 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 max-w-2xl">
      <div className="flex items-center gap-2 mb-2 text-xs text-gray-500 dark:text-gray-400">
        <span>{t('db.where')}</span>
        <select
          className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
          value={group.conjunction}
          onChange={(e) => setConjunction(e.target.value as 'and' | 'or')}
          aria-label={t('db.where')}
        >
          <option value="and">{t('db.conjAnd')}</option>
          <option value="or">{t('db.conjOr')}</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        {group.conditions.map((cond, i) =>
          'conditions' in cond ? (
            <div key={i} className="border-l-2 border-gray-200 dark:border-gray-700 pl-2">
              <div className="flex items-center justify-between text-[11px] text-gray-400 dark:text-gray-500 mb-1">
                <span>{cond.conjunction === 'or' ? t('db.conjOr') : t('db.conjAnd')}</span>
                <button className="hover:text-red-600" onClick={() => removeAt(i)}>
                  {t('db.removeRule')}
                </button>
              </div>
              {cond.conditions.map((sub, j) =>
                'conditions' in sub ? null : (
                  <ConditionRow
                    key={j}
                    cond={sub}
                    propOpts={propOpts}
                    properties={properties}
                    onChange={(next) =>
                      updateAt(i, {
                        ...cond,
                        conditions: cond.conditions.map((s, k) => (k === j ? next : s)),
                      })
                    }
                    onRemove={() =>
                      updateAt(i, {
                        ...cond,
                        conditions: cond.conditions.filter((_, k) => k !== j),
                      })
                    }
                  />
                ),
              )}
              <button
                className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 mt-1"
                onClick={() =>
                  updateAt(i, {
                    ...cond,
                    conditions: [...cond.conditions, { propId: 'title', op: 'contains', value: '' }],
                  })
                }
              >
                {t('db.addFilter')}
              </button>
            </div>
          ) : (
            <ConditionRow
              key={i}
              cond={cond}
              propOpts={propOpts}
              properties={properties}
              onChange={(next) => updateAt(i, next)}
              onRemove={() => removeAt(i)}
            />
          ),
        )}
      </div>
      <div className="flex items-center gap-3 mt-2">
        <button className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100" onClick={addCondition} data-testid="filter-add">
          {t('db.addFilter')}
        </button>
        <button className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100" onClick={addNestedGroup}>
          {t('db.addFilterGroup')}
        </button>
        <button className="ml-auto text-xs text-blue-600 hover:text-blue-800" onClick={onClose}>
          {t('db.done')}
        </button>
      </div>
    </div>
  );
}

/** One leaf filter condition row: property → operator → value. */
function ConditionRow({
  cond,
  propOpts,
  properties,
  onChange,
  onRemove,
}: {
  cond: FilterCondition;
  propOpts: { id: string; name: string; type: string }[];
  properties: DbProperty[];
  onChange: (next: FilterCondition) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const propType = propOpts.find((p) => p.id === cond.propId)?.type ?? 'text';
  const ops = operatorsForType(propType);
  const valueless = VALUELESS_OPS.has(cond.op);
  const selectOptions = valueOptionsFor(properties, cond.propId);

  return (
    <div className="flex items-center gap-1 text-xs" data-testid="filter-condition">
      <select
        className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
        value={cond.propId}
        data-testid="filter-prop"
        onChange={(e) => {
          const nextType = propOpts.find((p) => p.id === e.target.value)?.type ?? 'text';
          const nextOps = operatorsForType(nextType);
          onChange({ propId: e.target.value, op: nextOps[0]!, value: '' });
        }}
      >
        {propOpts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === 'title' ? t('db.title') : p.name}
          </option>
        ))}
      </select>
      <select
        className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value as FilterOp })}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {t(`db.op.${op}`)}
          </option>
        ))}
      </select>
      {valueless ? null : selectOptions.length > 0 ? (
        <select
          className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
          value={typeof cond.value === 'string' ? cond.value : ''}
          data-testid="filter-value"
          onChange={(e) => onChange({ ...cond, value: e.target.value })}
        >
          <option value="">—</option>
          {selectOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-28"
          placeholder={t('db.value')}
          data-testid="filter-value"
          value={cond.value === null || cond.value === undefined ? '' : String(cond.value)}
          onChange={(e) =>
            onChange({
              ...cond,
              value:
                propType === 'number' && e.target.value !== ''
                  ? Number(e.target.value)
                  : e.target.value,
            })
          }
        />
      )}
      <button className="text-gray-300 dark:text-gray-600 hover:text-red-600" onClick={onRemove} aria-label={t('db.removeRule')}>
        ✕
      </button>
    </div>
  );
}

/** Multi-level sort builder. */
function SortBuilder({
  sorts,
  propOpts,
  onChange,
  onClose,
}: {
  sorts: { propId: string; dir?: 'asc' | 'desc' }[];
  propOpts: { id: string; name: string; type: string }[];
  onChange: (next: { propId: string; dir?: 'asc' | 'desc' }[]) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const add = () => onChange([...sorts, { propId: 'title', dir: 'asc' }]);
  const removeAt = (i: number) => onChange(sorts.filter((_, j) => j !== i));
  const updateAt = (i: number, next: { propId: string; dir?: 'asc' | 'desc' }) =>
    onChange(sorts.map((s, j) => (j === i ? next : s)));
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= sorts.length) return;
    const next = [...sorts];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className="mt-1 p-2 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 max-w-lg">
      <div className="flex flex-col gap-1">
        {sorts.map((s, i) => (
          <div key={i} className="flex items-center gap-1 text-xs">
            <button className="text-gray-300 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-200" onClick={() => move(i, -1)} aria-label="up">
              ↑
            </button>
            <button className="text-gray-300 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-200" onClick={() => move(i, 1)} aria-label="down">
              ↓
            </button>
            <select
              className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
              value={s.propId}
              onChange={(e) => updateAt(i, { ...s, propId: e.target.value })}
            >
              {propOpts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === 'title' ? t('db.title') : p.name}
                </option>
              ))}
            </select>
            <select
              className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
              value={s.dir ?? 'asc'}
              onChange={(e) => updateAt(i, { ...s, dir: e.target.value as 'asc' | 'desc' })}
            >
              <option value="asc">{t('db.sortAsc')}</option>
              <option value="desc">{t('db.sortDesc')}</option>
            </select>
            <button className="text-gray-300 dark:text-gray-600 hover:text-red-600" onClick={() => removeAt(i)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-2">
        <button className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100" onClick={add} data-testid="sort-add">
          {t('db.addSort')}
        </button>
        <button className="ml-auto text-xs text-blue-600 hover:text-blue-800" onClick={onClose}>
          {t('db.done')}
        </button>
      </div>
    </div>
  );
}

/** "New ▾" split button: empty row + each template + manage templates. */
function NewRowButton({
  templates,
  onAddRow,
  onAddFromTemplate,
  onCreateTemplate,
  onDeleteTemplate,
}: {
  templates: DbTemplate[];
  onAddRow: () => void;
  onAddFromTemplate: (templateId: string) => void;
  onCreateTemplate: () => void;
  onDeleteTemplate: (id: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative inline-flex items-center mt-2" ref={ref}>
      <button
        className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 px-2 py-1 border border-gray-200 dark:border-gray-700 rounded-l"
        onClick={onAddRow}
        data-testid="db-new-row"
      >
        ＋ {t('db.newRow')}
      </button>
      <button
        className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-800 dark:hover:text-gray-100 px-1 py-1 border border-l-0 border-gray-200 dark:border-gray-700 rounded-r"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('db.newRowMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="db-new-menu"
      >
        ▾
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 top-9 z-20 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-1 text-sm"
        >
          <button
            className="w-full text-left px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            role="menuitem"
            onClick={() => {
              onAddRow();
              setOpen(false);
            }}
          >
            {t('db.newEmpty')}
          </button>
          {templates.length > 0 ? (
            <>
              <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {t('db.templates')}
              </div>
              {templates.map((tpl) => (
                <div key={tpl.id} className="flex items-center group">
                  <button
                    className="flex-1 text-left px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 truncate"
                    role="menuitem"
                    onClick={() => {
                      onAddFromTemplate(tpl.id);
                      setOpen(false);
                    }}
                  >
                    {tpl.title}
                  </button>
                  <a
                    href={`/p/${tpl.id}`}
                    className="px-1 text-gray-300 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-200 text-xs"
                    title={t('db.renameTemplate')}
                  >
                    ✎
                  </a>
                  <button
                    className="px-1 text-gray-300 dark:text-gray-600 hover:text-red-600 text-xs"
                    onClick={() => onDeleteTemplate(tpl.id)}
                    aria-label={t('db.deleteTemplate')}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </>
          ) : null}
          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          <button
            className="w-full text-left px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
            role="menuitem"
            onClick={() => {
              onCreateTemplate();
              setOpen(false);
            }}
          >
            {t('db.newTemplate')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Persist a new option list onto a select/status/multi_select property. The
 *  `databaseId` hint routes a native_do property to its workspace DO; ignored
 *  on the PG path. */
async function propAddOptionViaUpdate(
  propertyId: string,
  options: SelectOption[],
  databaseId: string,
) {
  const { propUpdate } = await import('~/server/docs');
  await propUpdate({ data: { id: propertyId, config: { options }, databaseId } });
}

// ---------- Table view ----------

interface TableViewProps {
  workspaceId: string;
  /** The DB rows actually belong to (sourceDatabaseId for linked views). */
  databaseId: string;
  view: DbView;
  properties: DbProperty[];
  rows: DbRow[];
  editable: boolean;
  templates: DbTemplate[];
  onAddRow: (props?: Record<string, JsonValue>, templateId?: string) => void;
  onPatchRow: (id: string, patch: { title?: string; props?: Record<string, JsonValue> }) => void;
  onDeleteRow: (id: string) => void;
  onAddProperty: (name: string, type: PropertyType, config?: Record<string, JsonValue>) => void;
  onAddOption: (property: DbProperty, name: string) => Promise<SelectOption>;
  onAddSubItem: (parentId: string) => void;
  onSetSubItemParent: (id: string, parentId: string | null) => void;
  onCreateTemplate: () => void;
  onDeleteTemplate: (id: string) => void;
  onToggleSubItems: (enabled: boolean) => void;
  /** Persist a column's aggregation-footer op into the active view's config. */
  onSetCalc: (propId: string, op: AggregationOp) => void;
  /** Open a row in the right-side peek panel. */
  onOpenPeek: (rowId: string) => void;
  /** Bulk archive the given rows. */
  onBulkDelete: (ids: string[]) => void;
  /** Bulk set one property's value across the given rows. */
  onBulkSetProp: (ids: string[], propId: string, value: JsonValue) => void;
}

function TableView({
  workspaceId,
  databaseId: writeDbId,
  view,
  properties,
  rows,
  editable,
  templates,
  onAddRow,
  onPatchRow,
  onDeleteRow,
  onAddProperty,
  onAddOption,
  onAddSubItem,
  onSetSubItemParent,
  onCreateTemplate,
  onDeleteTemplate,
  onToggleSubItems,
  onSetCalc,
  onOpenPeek,
  onBulkDelete,
  onBulkSetProp,
}: TableViewProps) {
  const { t } = useT();
  const [addingProp, setAddingProp] = useState(false);
  const [newPropName, setNewPropName] = useState('');
  const [newPropType, setNewPropType] = useState<PropertyType>('text');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Multi-select bulk-actions: component-local selected row ids (not persisted).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // The view's persisted per-column aggregation ops (footer selections).
  const calcs = view.config.calcs ?? {};

  // Keep the selection scoped to rows still present (e.g. after a refresh).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(rows.map((r) => r.id));
      const next = new Set<string>();
      for (const id of prev) if (present.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  // Esc clears the current selection.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(new Set());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected.size]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleSelectAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function handleBulkDeleteClick() {
    const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    onBulkDelete(ids);
    setSelected(new Set());
  }

  function handleBulkSetPropApply(propId: string, value: JsonValue) {
    const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    onBulkSetProp(ids, propId, value);
  }

  function submitNewProp(config?: Record<string, JsonValue>) {
    const name = newPropName.trim();
    if (!name) return;
    onAddProperty(name, newPropType, config);
    setNewPropName('');
    setNewPropType('text');
    setAddingProp(false);
  }

  // relation/rollup/formula/button need extra config collected before creation.
  const needsConfig =
    newPropType === 'relation' ||
    newPropType === 'rollup' ||
    newPropType === 'formula' ||
    newPropType === 'button';

  const subItemsEnabled = view.config.subItemsEnabled === true;
  const groupBy = view.config.groupBy ?? '';
  // +1 title, +1 select checkbox (editable only), +1 trailing "add property".
  const selectColCount = editable ? 1 : 0;
  const colCount = properties.length + 2 + selectColCount;

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // One <tr> for a row (with optional indent + sub-item chevron/add controls).
  function renderRow(row: DbRow, depth: number, hasChildren: boolean) {
    const isCollapsed = collapsed.has(row.id);
    const isSelected = selected.has(row.id);
    return (
      <tr
        key={row.id}
        className={`border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 group ${
          isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''
        }`}
      >
        {editable ? (
          <td className="py-1 px-2 w-8 align-middle">
            <input
              type="checkbox"
              className="opacity-0 group-hover:opacity-100 checked:opacity-100 transition-opacity"
              checked={isSelected}
              onChange={() => toggleSelect(row.id)}
              aria-label={t('db.selectRow')}
              data-testid="row-select"
            />
          </td>
        ) : null}
        <td className="py-1 px-2">
          <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 1.25}rem` }}>
            {subItemsEnabled ? (
              hasChildren ? (
                <button
                  className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 text-xs w-4"
                  onClick={() => toggleCollapse(row.id)}
                  aria-label={isCollapsed ? t('db.expandRow') : t('db.collapseRow')}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
              ) : (
                <span className="w-4 inline-block" />
              )
            ) : null}
            <a
              href={`/p/${row.id}`}
              className="no-underline text-gray-900 dark:text-gray-100 hover:underline truncate"
            >
              {row.title || 'Untitled'}
            </a>
            <button
              className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-200 text-xs"
              onClick={() => onOpenPeek(row.id)}
              title={t('db.openPeek')}
              aria-label={t('db.openPeek')}
              data-testid="row-open-peek"
            >
              ⤢
            </button>
            {editable && subItemsEnabled ? (
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-200 text-xs"
                onClick={() => onAddSubItem(row.id)}
                title={t('db.addSubItem')}
                aria-label={t('db.addSubItem')}
              >
                ＋
              </button>
            ) : null}
            {editable && subItemsEnabled && row.subItemParentId ? (
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-200 text-xs"
                onClick={() => onSetSubItemParent(row.id, null)}
                title={t('db.removeRule')}
                aria-label={t('db.removeRule')}
              >
                ⇤
              </button>
            ) : null}
            {editable ? (
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 dark:text-gray-600 hover:text-red-600 text-xs"
                onClick={() => onDeleteRow(row.id)}
                title="Delete row"
                aria-label="Delete row"
              >
                🗑
              </button>
            ) : null}
          </div>
        </td>
        {properties.map((p) => (
          <td key={p.id} className="py-1 px-2">
            {!editable ? (
              <span className="text-gray-700 dark:text-gray-300">{renderValueText(row, p) || '—'}</span>
            ) : p.type === 'formula' ? (
              <FormulaCell property={p} row={row} />
            ) : p.type === 'button' ? (
              <ButtonPropertyCell property={p} databaseId={writeDbId} rowId={row.id} />
            ) : AUTO_PROPERTY_TYPES.has(p.type) || p.type === 'rollup' ? (
              <span className="text-gray-500 dark:text-gray-400">{renderValueText(row, p) || '—'}</span>
            ) : p.type === 'relation' ? (
              <RelationCell
                property={p}
                chips={row.relations?.[p.id] ?? []}
                value={Array.isArray(row.props[p.id]) ? (row.props[p.id] as string[]) : []}
                onChange={(ids) => onPatchRow(row.id, { props: { [p.id]: ids } })}
              />
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
    );
  }

  // Decide what rows to render: grouped sections, a sub-item tree, or flat.
  function renderBodyRows(scopedRows: DbRow[]) {
    if (subItemsEnabled) {
      const tree = buildSubItemTree(scopedRows);
      return flattenSubItems(tree, collapsed).map((n) => renderRow(n.row, n.depth, n.hasChildren));
    }
    return scopedRows.map((row) => renderRow(row, 0, false));
  }

  const groupProp = groupBy ? properties.find((p) => p.id === groupBy) : undefined;
  const groups = groupBy ? groupRowsForView(rows, groupBy) : null;

  function groupLabel(key: string | null): string {
    if (key === null) return t('db.noValue');
    const opt = (groupProp?.config.options ?? []).find((o) => o.id === key);
    return opt?.name ?? key;
  }

  return (
    <div className="overflow-x-auto">
      {editable ? (
        <label className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 mb-1">
          <input
            type="checkbox"
            checked={subItemsEnabled}
            onChange={(e) => onToggleSubItems(e.target.checked)}
          />
          {t('db.enableSubItems')}
        </label>
      ) : null}
      {editable && selected.size > 0 ? (
        <SelectionBar
          count={selected.size}
          properties={properties}
          onDelete={handleBulkDeleteClick}
          onClear={clearSelection}
          onSetProp={handleBulkSetPropApply}
        />
      ) : null}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
            {editable ? (
              <th className="py-1.5 px-2 w-8">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  aria-label={t('db.selectAll')}
                  data-testid="row-select-all"
                />
              </th>
            ) : null}
            <th className="py-1.5 px-2 font-medium min-w-[12rem]">{t('db.title')}</th>
            {properties.map((p) => (
              <th key={p.id} className="py-1.5 px-2 font-medium min-w-[8rem]">
                {p.name}
              </th>
            ))}
            <th className="py-1.5 px-2 font-medium relative">
              {!editable ? null : addingProp ? (
                <span className="flex items-center gap-1">
                  <input
                    autoFocus
                    className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-24 text-gray-800 dark:text-gray-200"
                    placeholder={t('db.title')}
                    data-testid="prop-add-name"
                    value={newPropName}
                    onChange={(e) => setNewPropName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !needsConfig && submitNewProp()}
                  />
                  <select
                    className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 text-gray-800 dark:text-gray-200"
                    value={newPropType}
                    onChange={(e) => setNewPropType(e.target.value as PropertyType)}
                  >
                    {PROPERTY_TYPES.map((pt) => (
                      <option key={pt.value} value={pt.value}>
                        {pt.label}
                      </option>
                    ))}
                  </select>
                  {needsConfig ? null : (
                    <button
                      className="text-gray-700 dark:text-gray-300 hover:text-gray-900"
                      onClick={() => submitNewProp()}
                      data-testid="prop-add-confirm"
                    >
                      ✓
                    </button>
                  )}
                  <button
                    className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
                    onClick={() => setAddingProp(false)}
                  >
                    ✕
                  </button>
                  {newPropType === 'relation' ? (
                    <RelationConfigPanel
                      workspaceId={workspaceId}
                      onCancel={() => setAddingProp(false)}
                      onConfirm={(config) => submitNewProp(config)}
                    />
                  ) : newPropType === 'rollup' ? (
                    <RollupConfigPanel
                      properties={properties}
                      onCancel={() => setAddingProp(false)}
                      onConfirm={(config) => submitNewProp(config)}
                    />
                  ) : newPropType === 'formula' ? (
                    <FormulaConfigPanel
                      properties={properties}
                      onCancel={() => setAddingProp(false)}
                      onConfirm={(config) => submitNewProp(config)}
                    />
                  ) : newPropType === 'button' ? (
                    <ButtonConfigPanel
                      properties={properties}
                      onCancel={() => setAddingProp(false)}
                      onConfirm={(config) => submitNewProp(config)}
                    />
                  ) : null}
                </span>
              ) : (
                <button
                  className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-editor-500 dark:focus-visible:ring-editor-400 rounded"
                  onClick={() => setAddingProp(true)}
                  data-testid="prop-add-open"
                >
                  ＋ property
                </button>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {groups
            ? groups.map((g) => (
                <Fragment key={g.key ?? '__none__'}>
                  <tr className="bg-gray-50 dark:bg-gray-800">
                    <td colSpan={colCount} className="py-1 px-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                      {groupLabel(g.key)}{' '}
                      <span className="text-gray-400 dark:text-gray-500">{g.rows.length}</span>
                    </td>
                  </tr>
                  {renderBodyRows(g.rows)}
                </Fragment>
              ))
            : renderBodyRows(rows)}
        </tbody>
        <tfoot data-testid="db-calc-footer">
          <tr className="border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
            {editable ? <td className="px-2 w-8" /> : null}
            <CalcFooterCell
              propId="title"
              type="title"
              op={(calcs['title'] as AggregationOp) ?? 'none'}
              values={rows.map((r) => r.title)}
              editable={editable}
              onSetCalc={onSetCalc}
            />
            {properties.map((p) => (
              <CalcFooterCell
                key={p.id}
                propId={p.id}
                type={p.type}
                op={(calcs[p.id] as AggregationOp) ?? 'none'}
                values={rows.map((r) => calcValueFor(r, p))}
                editable={editable}
                onSetCalc={onSetCalc}
              />
            ))}
            <td className="px-2" />
          </tr>
        </tfoot>
      </table>
      {editable ? (
        <NewRowButton
          templates={templates}
          onAddRow={() => onAddRow()}
          onAddFromTemplate={(templateId) => onAddRow(undefined, templateId)}
          onCreateTemplate={onCreateTemplate}
          onDeleteTemplate={onDeleteTemplate}
        />
      ) : null}
    </div>
  );
}

// ---------- Aggregation footer cell ----------

/**
 * One <td> in the table's aggregation footer. Shows the computed value when an
 * op is chosen; on hover (or when no op) shows a "Calculate" affordance that
 * opens a small op menu (Notion-style). Math runs over the already-loaded
 * `values` — no server round-trip. The chosen op persists via onSetCalc.
 */
function CalcFooterCell({
  propId,
  type,
  op,
  values,
  editable,
  onSetCalc,
}: {
  propId: string;
  type: string;
  op: AggregationOp;
  values: unknown[];
  editable: boolean;
  onSetCalc: (propId: string, op: AggregationOp) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLTableCellElement>(null);
  const options = useMemo(() => aggOptionsForType(type), [type]);
  const result = useMemo(() => computeAggregation(op, values, type), [op, values, type]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Read-only viewers see the computed value (no menu).
  if (!editable) {
    return (
      <td className="px-2 py-1 align-middle" data-testid="calc-cell">
        {op !== 'none' ? (
          <span>
            <span className="text-gray-400 dark:text-gray-500 mr-1">{t(AGG_LABEL_KEY[op])}</span>
            <span className="text-gray-700 dark:text-gray-300 font-medium">{result.text}</span>
          </span>
        ) : null}
      </td>
    );
  }

  return (
    <td className="px-2 py-1 align-middle relative group/calc" ref={ref} data-testid="calc-cell">
      <button
        type="button"
        className={`w-full text-left ${
          op === 'none'
            ? 'opacity-0 group-hover/calc:opacity-100 transition-opacity text-gray-400 dark:text-gray-500'
            : 'text-gray-600 dark:text-gray-300'
        }`}
        onClick={() => setOpen((v) => !v)}
        aria-label={t('db.calcAria')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="calc-trigger"
      >
        {op === 'none' ? (
          <span>{t('db.calc.none')} ▾</span>
        ) : (
          <span>
            <span className="text-gray-400 dark:text-gray-500 mr-1">{t(AGG_LABEL_KEY[op])}</span>
            <span className="font-medium">{result.text}</span>
          </span>
        )}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 bottom-8 z-20 w-44 max-h-64 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-1 text-xs"
          data-testid="calc-menu"
        >
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="menuitem"
              className={`w-full text-left px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 ${
                o === op ? 'text-blue-600' : 'text-gray-700 dark:text-gray-200'
              }`}
              onClick={() => {
                onSetCalc(propId, o);
                setOpen(false);
              }}
            >
              {t(AGG_LABEL_KEY[o])}
            </button>
          ))}
        </div>
      ) : null}
    </td>
  );
}

// ---------- Bulk-actions selection bar ----------

/** Property types whose value can be bulk-set across selected rows. */
const BULK_SETTABLE = new Set(['select', 'status', 'checkbox']);

/**
 * The selection bar shown above the table when ≥1 row is selected: count +
 * Delete + Clear, plus an optional "set a select/status/checkbox value across
 * the selection" control.
 */
function SelectionBar({
  count,
  properties,
  onDelete,
  onClear,
  onSetProp,
}: {
  count: number;
  properties: DbProperty[];
  onDelete: () => void;
  onClear: () => void;
  onSetProp: (propId: string, value: JsonValue) => void;
}) {
  const { t } = useT();
  const settable = properties.filter((p) => BULK_SETTABLE.has(p.type));
  const [propId, setPropId] = useState('');
  const prop = settable.find((p) => p.id === propId);
  const [value, setValue] = useState<JsonValue>('');

  return (
    <div
      className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 text-sm"
      data-testid="selection-bar"
    >
      <span className="font-medium text-blue-800 dark:text-blue-200" data-testid="selection-count">
        {t('db.selectedCount', { count: String(count) })}
      </span>
      <button
        type="button"
        className="text-red-600 hover:text-red-800"
        onClick={onDelete}
        data-testid="bulk-delete"
      >
        {t('db.bulkDelete')}
      </button>
      {settable.length > 0 ? (
        <span className="flex items-center gap-1">
          <select
            className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 text-xs bg-white dark:bg-gray-800"
            value={propId}
            onChange={(e) => {
              setPropId(e.target.value);
              const p = settable.find((x) => x.id === e.target.value);
              setValue(p?.type === 'checkbox' ? true : '');
            }}
            data-testid="bulk-prop"
            aria-label={t('db.bulkSetProp')}
          >
            <option value="">{t('db.bulkSetProp')}</option>
            {settable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {prop && prop.type === 'checkbox' ? (
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => setValue(e.target.checked)}
              />
              {t('db.bulkSetValue')}
            </label>
          ) : prop ? (
            <select
              className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 text-xs bg-white dark:bg-gray-800"
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => setValue(e.target.value || null)}
              data-testid="bulk-value"
              aria-label={t('db.bulkSetValue')}
            >
              <option value="">—</option>
              {(prop.config.options ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : null}
          {prop ? (
            <button
              type="button"
              className="text-blue-600 hover:text-blue-800 text-xs"
              onClick={() => onSetProp(prop.id, value)}
              data-testid="bulk-apply"
            >
              {t('db.bulkApply')}
            </button>
          ) : null}
        </span>
      ) : null}
      <button
        type="button"
        className="ml-auto text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
        onClick={onClear}
        data-testid="bulk-clear"
      >
        {t('db.bulkClear')}
      </button>
    </div>
  );
}

// ---------- Side-peek (open a row in a right-side panel) ----------

/**
 * A right-side overlay that opens a database row (a page) without leaving the
 * database. Renders the row's editable title + a compact property list reusing
 * the table cell editors. The page body is descoped to "open as full page"
 * (v1) — embedding the CollaborativeEditor here would require threading a
 * collab token + room, which balloons the peek; the header link covers it.
 * SSR-safe via a mount gate; closes on Esc / ✕ / click-outside.
 */
function SidePeek({
  rowId,
  row,
  properties,
  editable,
  onAddOption,
  onPatchRow,
  onClose,
}: {
  rowId: string;
  row: DbRow | null;
  properties: DbProperty[];
  editable: boolean;
  onAddOption: (property: DbProperty, name: string) => Promise<SelectOption>;
  onPatchRow: (id: string, patch: { title?: string; props?: Record<string, JsonValue> }) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [mounted, setMounted] = useState(false);
  const [title, setTitle] = useState(row?.title ?? '');

  useEffect(() => setMounted(true), []);
  useEffect(() => setTitle(row?.title ?? ''), [row?.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!mounted) return null;

  function commitTitle() {
    const next = title.trim() || 'Untitled';
    onPatchRow(rowId, { title: next });
    // Persist directly too — the peek isn't always inside a fresh-fetch loop.
    void updatePageFn({ data: { id: rowId, title: next } }).catch(() => {});
  }

  // Properties shown in the peek: skip the trailing "add property" affordance;
  // relations/rollups/formulas/buttons render read-only text for v1 brevity.
  return (
    <>
      {/* click-outside scrim */}
      <div
        className="fixed inset-0 z-30 bg-black/20"
        onClick={onClose}
        data-testid="peek-scrim"
        aria-hidden="true"
      />
      <aside
        className="fixed right-0 top-0 z-40 h-full w-full max-w-md bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-xl overflow-y-auto"
        role="dialog"
        aria-label={title || 'Untitled'}
        data-testid="side-peek"
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900">
          <a
            href={`/p/${rowId}`}
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 no-underline"
            data-testid="peek-open-full"
          >
            ⤢ {t('db.peekOpenFull')}
          </a>
          <button
            type="button"
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
            onClick={onClose}
            aria-label={t('db.peekClose')}
            data-testid="peek-close"
          >
            ✕
          </button>
        </div>
        <div className="px-4 py-3">
          <input
            className="w-full text-2xl font-bold outline-none border-0 bg-transparent text-gray-900 dark:text-gray-100 mb-3"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            placeholder={t('page.untitled')}
            readOnly={!editable}
            aria-label="Row title"
            data-testid="peek-title"
          />
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">
            {t('db.peekProperties')}
          </div>
          {row ? (
            <div className="space-y-2" data-testid="peek-props">
              {properties.map((p) => (
                <div key={p.id} className="flex items-start gap-2 text-sm">
                  <span className="w-28 shrink-0 text-gray-500 dark:text-gray-400 truncate pt-0.5">
                    {p.name}
                  </span>
                  <div className="flex-1 min-w-0">
                    {!editable ||
                    AUTO_PROPERTY_TYPES.has(p.type) ||
                    p.type === 'rollup' ||
                    p.type === 'formula' ||
                    p.type === 'button' ||
                    p.type === 'relation' ? (
                      <span className="text-gray-700 dark:text-gray-300">
                        {renderValueText(row, p) || '—'}
                      </span>
                    ) : (
                      <CellEditor
                        property={p}
                        value={row.props[p.id] ?? null}
                        onChange={(value) => onPatchRow(rowId, { props: { [p.id]: value } })}
                        onAddOption={(name) => onAddOption(p, name)}
                      />
                    )}
                  </div>
                </div>
              ))}
              {properties.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-gray-500">—</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500">—</p>
          )}
          <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">{t('db.peekBodyHint')}</p>
        </div>
      </aside>
    </>
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
          className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-20"
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
          <span className="text-gray-300 dark:text-gray-600">—</span>
        ) : (
          value.map((id) => (
            <span key={id} className="bg-gray-100 dark:bg-gray-700 rounded px-1 text-xs">
              {byId.get(id)?.name ?? id}
            </span>
          ))
        )}
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow p-1 min-w-[8rem]">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-1 px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700">
              <input
                type="checkbox"
                checked={value.includes(o.id)}
                onChange={() => toggle(o.id)}
              />
              <span className="text-xs">{o.name}</span>
            </label>
          ))}
          <div className="flex items-center gap-1 mt-1 border-t border-gray-100 dark:border-gray-700 pt-1">
            <input
              className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-20 text-xs"
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

// ---------- Relation cell (search target DB via /v1/db/related-rows) ----------

interface RelationCellProps {
  property: DbProperty;
  chips: RelationChip[];
  value: string[];
  onChange: (ids: string[]) => void;
}

function RelationCell({ property, chips, value, onChange }: RelationCellProps) {
  const { t } = useT();
  const targetDatabaseId =
    typeof property.config.targetDatabaseId === 'string' ? property.config.targetDatabaseId : '';
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RelationChip[]>([]);
  // Remember labels for chosen ids so chips render even before a refetch.
  const [labels, setLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries(chips.map((c) => [c.id, c.title])),
  );

  useEffect(() => {
    setLabels((prev) => {
      const next = { ...prev };
      for (const c of chips) next[c.id] = c.title;
      return next;
    });
  }, [chips]);

  useEffect(() => {
    if (!open || !targetDatabaseId) return;
    let cancelled = false;
    void relatedRowsFn({ data: { databaseId: targetDatabaseId, q } }).then((r) => {
      if (!cancelled) setResults(r);
    });
    return () => {
      cancelled = true;
    };
  }, [q, open, targetDatabaseId]);

  function toggle(chip: RelationChip) {
    setLabels((prev) => ({ ...prev, [chip.id]: chip.title }));
    onChange(value.includes(chip.id) ? value.filter((v) => v !== chip.id) : [...value, chip.id]);
  }

  if (!targetDatabaseId) {
    return <span className="text-gray-300 dark:text-gray-600 text-xs">{t('db.noTargetDb')}</span>;
  }

  return (
    <div className="relative">
      <button
        className="flex flex-wrap gap-1 w-full text-left min-h-[1.25rem]"
        onClick={() => setOpen((v) => !v)}
        aria-label={property.name}
      >
        {value.length === 0 ? (
          <span className="text-gray-300 dark:text-gray-600">—</span>
        ) : (
          value.map((id) => (
            <a
              key={id}
              href={`/p/${id}`}
              onClick={(e) => e.stopPropagation()}
              className="bg-blue-50 text-blue-700 rounded px-1 text-xs no-underline hover:underline"
            >
              {labels[id] ?? 'Untitled'}
            </a>
          ))
        )}
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow p-1 min-w-[12rem]">
          <input
            autoFocus
            className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-full text-xs mb-1"
            placeholder="Search rows…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {results.map((r) => (
            <label key={r.id} className="flex items-center gap-1 px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700">
              <input
                type="checkbox"
                checked={value.includes(r.id)}
                onChange={() => toggle(r)}
              />
              <span className="text-xs truncate">
                {r.icon ? `${r.icon} ` : ''}
                {r.title || 'Untitled'}
              </span>
            </label>
          ))}
          {results.length === 0 ? (
            <div className="text-xs text-gray-400 dark:text-gray-500 px-1 py-0.5">{t('db.noMatches')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------- Relation property config panel (pick the target database) ----------

interface RelationConfigPanelProps {
  workspaceId: string;
  onCancel: () => void;
  onConfirm: (config: Record<string, JsonValue>) => void;
}

function RelationConfigPanel({ workspaceId, onCancel, onConfirm }: RelationConfigPanelProps) {
  const { t } = useT();
  const [databases, setDatabases] = useState<DatabaseListItem[]>([]);
  const [targetId, setTargetId] = useState('');

  useEffect(() => {
    let cancelled = false;
    void dbListFn({ data: { workspaceId } }).then((d) => {
      if (!cancelled) setDatabases(d);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return (
    <div className="absolute z-20 top-9 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-2 min-w-[14rem] text-left font-normal">
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('db.relatedTo')}</div>
      <select
        className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-full text-sm text-gray-800 dark:text-gray-200 mb-2"
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
      >
        <option value="">Choose a database…</option>
        {databases.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title || 'Untitled database'}
          </option>
        ))}
      </select>
      <div className="flex items-center justify-end gap-2">
        <button className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-300"
          disabled={!targetId}
          onClick={() => onConfirm({ targetDatabaseId: targetId })}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---------- Rollup property config panel (relation → target prop → fn) ----------

const ROLLUP_FNS: { value: string; label: string }[] = [
  { value: 'count', label: 'Count all' },
  { value: 'count_values', label: 'Count values' },
  { value: 'show_unique', label: 'Count unique' },
  { value: 'sum', label: 'Sum' },
  { value: 'average', label: 'Average' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'range', label: 'Range' },
  { value: 'earliest_date', label: 'Earliest date' },
  { value: 'latest_date', label: 'Latest date' },
  { value: 'percent_checked', label: 'Percent checked' },
  { value: 'percent_unchecked', label: 'Percent unchecked' },
];

interface RollupConfigPanelProps {
  properties: DbProperty[];
  onCancel: () => void;
  onConfirm: (config: Record<string, JsonValue>) => void;
}

function RollupConfigPanel({ properties, onCancel, onConfirm }: RollupConfigPanelProps) {
  const { t } = useT();
  const relationProps = properties.filter((p) => p.type === 'relation');
  const [relationPropId, setRelationPropId] = useState('');
  const [targetPropId, setTargetPropId] = useState('title');
  const [fn, setFn] = useState('count');
  const [targetProps, setTargetProps] = useState<DbProperty[]>([]);

  // When the chosen relation changes, fetch its target DB schema for the
  // target-property dropdown (reuses dbSchema).
  useEffect(() => {
    const rel = relationProps.find((p) => p.id === relationPropId);
    const targetDbId =
      rel && typeof rel.config.targetDatabaseId === 'string' ? rel.config.targetDatabaseId : '';
    if (!targetDbId) {
      setTargetProps([]);
      return;
    }
    let cancelled = false;
    void dbSchemaFn({ data: { databaseId: targetDbId } }).then((s) => {
      if (!cancelled) setTargetProps(s.properties);
    });
    return () => {
      cancelled = true;
    };
  }, [relationPropId, relationProps]);

  if (relationProps.length === 0) {
    return (
      <div className="absolute z-20 top-9 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-2 min-w-[14rem] text-left font-normal text-xs text-gray-600 dark:text-gray-300">
        Add a relation property first, then a rollup can aggregate it.
        <div className="flex justify-end mt-1">
          <button className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute z-20 top-9 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-2 min-w-[15rem] text-left font-normal">
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('db.relation')}</div>
      <select
        className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-full text-sm text-gray-800 dark:text-gray-200 mb-2"
        value={relationPropId}
        onChange={(e) => setRelationPropId(e.target.value)}
      >
        <option value="">Choose a relation…</option>
        {relationProps.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('db.property')}</div>
      <select
        className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-full text-sm text-gray-800 dark:text-gray-200 mb-2"
        value={targetPropId}
        onChange={(e) => setTargetPropId(e.target.value)}
      >
        <option value="title">Name (title)</option>
        {targetProps.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('db.calculate')}</div>
      <select
        className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-full text-sm text-gray-800 dark:text-gray-200 mb-2"
        value={fn}
        onChange={(e) => setFn(e.target.value)}
      >
        {ROLLUP_FNS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <div className="flex items-center justify-end gap-2">
        <button className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-300"
          disabled={!relationPropId}
          onClick={() => onConfirm({ relationPropId, targetPropId, fn })}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---------- Formula cell (read-only computed value) ----------

interface FormulaCellProps {
  property: DbProperty;
  row: DbRow;
}

function FormulaCell({ property, row }: FormulaCellProps) {
  const value = row.formulas?.[property.id] ?? null;
  const err = formulaError(value);
  if (err) {
    return (
      <span className="text-gray-400 dark:text-gray-500 text-xs" title={err}>
        ⚠ {err}
      </span>
    );
  }
  const text = formatFormula(value);
  return <span className="text-gray-500 dark:text-gray-400">{text || '—'}</span>;
}

// ---------- Formula property config panel (expression textarea + prop hint) ----------

interface FormulaConfigPanelProps {
  properties: DbProperty[];
  onCancel: () => void;
  onConfirm: (config: Record<string, JsonValue>) => void;
}

function FormulaConfigPanel({ properties, onCancel, onConfirm }: FormulaConfigPanelProps) {
  const { t } = useT();
  const [expression, setExpression] = useState('');
  // The implicit Name (title) column plus every defined property.
  const names = ['Name', ...properties.map((p) => p.name)];

  return (
    <div className="absolute z-20 top-9 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-2 min-w-[20rem] text-left font-normal">
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('db.expression')}</div>
      <textarea
        autoFocus
        className="border border-gray-300 dark:border-gray-600 rounded px-1.5 py-1 w-full text-sm text-gray-800 dark:text-gray-200 font-mono h-20 resize-y"
        placeholder={'e.g. if({{Done}}, "✓", round({{Price}} * 1.1, 2))'}
        value={expression}
        onChange={(e) => setExpression(e.target.value)}
      />
      <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 leading-snug">
        Reference properties as <code>{'{{Name}}'}</code> or <code>prop(&quot;Name&quot;)</code>.
        <div className="mt-0.5">
          {t('db.formulaProperties')} <span className="text-gray-500 dark:text-gray-400">{names.join(', ')}</span>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 mt-2">
        <button className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-300"
          disabled={!expression.trim()}
          onClick={() => onConfirm({ expression: expression.trim() })}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---------- Board view ----------

interface BoardViewProps {
  view: DbView;
  properties: DbProperty[];
  rows: DbRow[];
  editable: boolean;
  onSetGroupBy: (propId: string) => void;
  onAddRow: (props: Record<string, JsonValue>) => void;
  onPatchRow: (id: string, patch: { props?: Record<string, JsonValue> }) => void;
}

function BoardView({
  view,
  properties,
  rows,
  editable,
  onSetGroupBy,
  onAddRow,
  onPatchRow,
}: BoardViewProps) {
  const { t } = useT();
  const groupable = properties.filter((p) => SELECT_TYPES.has(p.type));
  const groupBy = view.config.groupBy ?? groupable[0]?.id ?? '';
  const groupProp = properties.find((p) => p.id === groupBy);

  if (!groupProp) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Board views need a select or status property to group by.{' '}
        {groupable.length > 0 ? (
          <select
            className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 ml-1"
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
      <div className="mb-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
        Group by:
        <select
          className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
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
          <div key={col.id ?? '__none__'} className="w-64 shrink-0 bg-gray-50 dark:bg-gray-800 rounded p-2">
            <div className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2 px-1">
              {col.label} <span className="text-gray-400 dark:text-gray-500">{rowsFor(col.id).length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {rowsFor(col.id).map((row) => (
                <div key={row.id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-sm">
                  <a
                    href={`/p/${row.id}`}
                    className="no-underline text-gray-900 dark:text-gray-100 hover:underline block truncate"
                  >
                    {row.title || 'Untitled'}
                  </a>
                  {editable ? (
                    <select
                      className="mt-1 text-xs text-gray-500 dark:text-gray-400 bg-transparent outline-none w-full"
                      value={(row.props[groupProp.id] as string) ?? ''}
                      onChange={(e) => onPatchRow(row.id, { props: { [groupProp.id]: e.target.value || null } })}
                      aria-label="Move card"
                    >
                      <option value="">{t('db.groupNoValue', { prop: groupProp.name })}</option>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              ))}
            </div>
            {editable ? (
              <button
                className="mt-2 w-full text-left text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 px-1"
                onClick={() => onAddRow(col.id ? { [groupProp.id]: col.id } : {})}
              >
                ＋ card
              </button>
            ) : null}
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
  const { t } = useT();
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
          <span className="bg-gray-100 dark:bg-gray-700 rounded px-1 text-xs">{display}</span>
        ) : (
          <span className="text-gray-300 dark:text-gray-600">—</span>
        )}
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow p-1 min-w-[10rem]">
          <input
            autoFocus
            className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 w-full text-xs mb-1"
            placeholder="Search people…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {value ? (
            <button
              className="block w-full text-left text-xs px-1 py-0.5 text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700"
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
              className="block w-full text-left text-xs px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700"
              onClick={() => pick(r.id, r.label)}
            >
              {r.label}
            </button>
          ))}
          {results.length === 0 ? (
            <div className="text-xs text-gray-400 dark:text-gray-500 px-1 py-0.5">{t('db.noMatches')}</div>
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
              <img src={f.url} alt={f.name} className="h-6 w-6 object-cover rounded border border-gray-200 dark:border-gray-700" />
            </a>
          ) : (
            <a href={f.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">
              {f.name}
            </a>
          )}
          <button
            className="text-gray-300 dark:text-gray-600 hover:text-red-600 text-xs"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label="Remove file"
          >
            ✕
          </button>
        </span>
      ))}
      <label className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer">
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
  const { t } = useT();
  // Show up to two inline props next to each row's title (skip files for brevity).
  const inlineProps = properties.filter((p) => !FILE_TYPES.has(p.type)).slice(0, 2);
  if (rows.length === 0) return <div className="text-sm text-gray-400 dark:text-gray-500 py-4">{t('db.noRows')}</div>;
  return (
    <div className="divide-y divide-gray-100 dark:divide-gray-700 border-t border-gray-100 dark:border-gray-700">
      {rows.map((row) => (
        <a
          key={row.id}
          href={`/p/${row.id}`}
          className="flex items-center gap-3 py-2 px-1 no-underline text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <span className="truncate font-medium">{row.title || 'Untitled'}</span>
          <span className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 truncate">
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
  const { t } = useT();
  const cardPropId = view.config.cardPropId ?? properties[0]?.id ?? '';
  const cardProp = properties.find((p) => p.id === cardPropId);
  return (
    <div>
      <div className="mb-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
        Card preview:
        <select
          className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
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
        <div className="text-sm text-gray-400 dark:text-gray-500 py-4">{t('db.noRows')}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {rows.map((row) => {
            const img = firstImageUrl(row, properties);
            const preview = cardProp ? renderValueText(row, cardProp) : '';
            return (
              <a
                key={row.id}
                href={`/p/${row.id}`}
                className="block no-underline text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 rounded overflow-hidden hover:shadow"
              >
                {img ? (
                  <img src={img} alt="" className="w-full h-28 object-cover" />
                ) : (
                  <div className="w-full h-28 bg-gray-50 dark:bg-gray-800" />
                )}
                <div className="p-2">
                  <div className="font-medium text-sm truncate">{row.title || 'Untitled'}</div>
                  {preview ? <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{preview}</div> : null}
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Chart view (Phase 18) ----------

interface ChartViewProps {
  view: DbView;
  properties: DbProperty[];
  rows: DbRow[];
  editable: boolean;
  onSetChartConfig: (config: ChartConfig) => void;
}

/**
 * Read-only chart view over the loaded (filter/sort-shaped) rows. Aggregation
 * is purely client-side via `~/lib/db-chart`. A config bar lets the user pick
 * the chart type, group-by property, and measure; KPI shows a single number.
 */
function ChartView({ view, properties, rows, editable, onSetChartConfig }: ChartViewProps) {
  const { t } = useT();
  const config = normalizeChartConfig(view.config.chart);

  const labels = useMemo<BuildSeriesLabels>(
    () => ({
      empty: t('db.chartEmptyBucket'),
      title: t('db.title'),
      count: t('db.chartMeasureCount'),
      sum: t('db.chartMeasureSum'),
      average: t('db.chartMeasureAverage'),
      min: t('db.chartMeasureMin'),
      max: t('db.chartMeasureMax'),
    }),
    [t],
  );

  const series = useMemo(
    () => buildChartSeries(rows, properties, config, labels),
    [rows, properties, config, labels],
  );

  const groupable = properties.filter((p) => isGroupableProp(p));
  const measurable = properties.filter((p) => isMeasurableProp(p));
  const isKpi = config.chartType === 'kpi';

  function patch(next: Partial<ChartConfig>) {
    onSetChartConfig({ ...config, ...next });
  }

  function setChartType(chartType: ChartType) {
    patch({ chartType });
  }

  function setGroupBy(groupBy: string) {
    patch({ groupBy: groupBy || undefined });
  }

  function setMeasureKind(kind: ChartMeasure['kind']) {
    if (kind === 'count') {
      patch({ measure: { kind: 'count' } });
    } else {
      // Keep the chosen measure prop if still valid, else first measurable.
      const current = config.measure.kind !== 'count' ? config.measure.propId : undefined;
      const propId =
        current && measurable.some((p) => p.id === current) ? current : measurable[0]?.id;
      if (propId) patch({ measure: { kind, propId } });
    }
  }

  function setMeasureProp(propId: string) {
    if (config.measure.kind === 'count') return;
    patch({ measure: { kind: config.measure.kind, propId } });
  }

  const hasData = series.values.some((v) => v !== 0) || (isKpi && series.total !== 0);
  const noRows = rows.length === 0;

  return (
    <div data-testid="chart-view">
      {/* Config bar */}
      {editable ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <label className="flex items-center gap-1">
            {t('db.chartType')}
            <select
              className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-800"
              value={config.chartType}
              onChange={(e) => setChartType(e.target.value as ChartType)}
              data-testid="chart-type"
              aria-label={t('db.chartType')}
            >
              {CHART_TYPES.map((ct) => (
                <option key={ct} value={ct}>
                  {t(`db.chart.${ct}`)}
                </option>
              ))}
            </select>
          </label>

          {!isKpi ? (
            <label className="flex items-center gap-1">
              {t('db.chartGroupBy')}
              <select
                className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-800"
                value={config.groupBy ?? ''}
                onChange={(e) => setGroupBy(e.target.value)}
                data-testid="chart-groupby"
                aria-label={t('db.chartGroupBy')}
              >
                <option value="">{t('db.chartGroupNone')}</option>
                <option value="title">{t('db.title')}</option>
                {groupable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="flex items-center gap-1">
            {t('db.chartMeasure')}
            <select
              className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-800"
              value={config.measure.kind}
              onChange={(e) => setMeasureKind(e.target.value as ChartMeasure['kind'])}
              data-testid="chart-measure"
              aria-label={t('db.chartMeasure')}
            >
              {MEASURE_KINDS.map((k) => (
                <option key={k} value={k} disabled={k !== 'count' && measurable.length === 0}>
                  {t(`db.chartMeasure.${k}`)}
                </option>
              ))}
            </select>
          </label>

          {config.measure.kind !== 'count' ? (
            <label className="flex items-center gap-1">
              {t('db.chartMeasureProp')}
              <select
                className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-800"
                value={config.measure.propId}
                onChange={(e) => setMeasureProp(e.target.value)}
                data-testid="chart-measure-prop"
                aria-label={t('db.chartMeasureProp')}
              >
                {measurable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {isKpi ? (
            <label className="flex items-center gap-1">
              {t('db.chartKpiLabel')}
              <input
                className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-800 w-32"
                value={config.kpiLabel ?? ''}
                placeholder={series.measureLabel}
                onChange={(e) => patch({ kpiLabel: e.target.value })}
                data-testid="chart-kpi-label"
                aria-label={t('db.chartKpiLabel')}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {/* Chart canvas */}
      {noRows ? (
        <div className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center" data-testid="chart-empty">
          {t('db.noRows')}
        </div>
      ) : !isKpi && !config.groupBy ? (
        <div className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center" data-testid="chart-empty">
          {t('db.chartPickGroupBy')}
        </div>
      ) : !hasData ? (
        <div className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center" data-testid="chart-empty">
          {t('db.chartNoData')}
        </div>
      ) : config.chartType === 'kpi' ? (
        <KpiCard series={series} />
      ) : config.chartType === 'bar' ? (
        <BarChart series={series} />
      ) : config.chartType === 'line' ? (
        <LineChart series={series} />
      ) : (
        <PieChart series={series} donut={config.chartType === 'donut'} />
      )}
    </div>
  );
}

/** Short accessible summary of a series (for `aria-label` on the SVG). */
function chartAriaSummary(t: (k: string, p?: Record<string, string>) => string, series: ChartSeries): string {
  return t('db.chartAria', {
    measure: series.measureLabel,
    count: String(series.labels.length),
  });
}

/** Vertical bar chart. Responsive width via viewBox; hover tooltips via <title>. */
function BarChart({ series }: { series: ChartSeries }) {
  const { t } = useT();
  const W = 640;
  const H = 320;
  const padL = 44;
  const padB = 56;
  const padT = 12;
  const padR = 12;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = series.values.length;
  const slot = plotW / Math.max(n, 1);
  const barW = Math.max(4, slot * 0.6);
  const maxVal = series.max > 0 ? series.max : 1;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto max-w-3xl"
      role="img"
      aria-label={chartAriaSummary(t, series)}
      data-testid="chart-bar"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Y axis baseline */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth={1} />
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth={1} />
      {/* Max + mid Y ticks */}
      <text x={padL - 6} y={padT + 4} textAnchor="end" className="fill-gray-400 dark:fill-gray-500 text-[10px]">
        {formatChartValue(maxVal)}
      </text>
      <text x={padL - 6} y={padT + plotH + 4} textAnchor="end" className="fill-gray-400 dark:fill-gray-500 text-[10px]">
        0
      </text>
      {series.values.map((v, i) => {
        const h = (v / maxVal) * plotH;
        const x = padL + i * slot + (slot - barW) / 2;
        const y = padT + plotH - h;
        const label = series.labels[i] ?? '';
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={Math.max(0, h)} rx={2} fill={chartColor(i)}>
              <title>{`${label}: ${formatChartValue(v)}`}</title>
            </rect>
            <text
              x={x + barW / 2}
              y={padT + plotH + 14}
              textAnchor="middle"
              className="fill-gray-600 dark:fill-gray-300 text-[10px]"
            >
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Line chart (polyline over evenly-spaced points). */
function LineChart({ series }: { series: ChartSeries }) {
  const { t } = useT();
  const W = 640;
  const H = 320;
  const padL = 44;
  const padB = 56;
  const padT = 12;
  const padR = 12;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = series.values.length;
  const maxVal = series.max > 0 ? series.max : 1;
  const stepX = n > 1 ? plotW / (n - 1) : 0;
  const pointX = (i: number) => (n > 1 ? padL + i * stepX : padL + plotW / 2);
  const pointY = (v: number) => padT + plotH - (v / maxVal) * plotH;
  const points = series.values.map((v, i) => `${pointX(i)},${pointY(v)}`).join(' ');

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto max-w-3xl"
      role="img"
      aria-label={chartAriaSummary(t, series)}
      data-testid="chart-line"
      preserveAspectRatio="xMidYMid meet"
    >
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth={1} />
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth={1} />
      <text x={padL - 6} y={padT + 4} textAnchor="end" className="fill-gray-400 dark:fill-gray-500 text-[10px]">
        {formatChartValue(maxVal)}
      </text>
      <text x={padL - 6} y={padT + plotH + 4} textAnchor="end" className="fill-gray-400 dark:fill-gray-500 text-[10px]">
        0
      </text>
      {n > 1 ? (
        <polyline points={points} fill="none" stroke={chartColor(0)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
      {series.values.map((v, i) => {
        const label = series.labels[i] ?? '';
        return (
          <g key={i}>
            <circle cx={pointX(i)} cy={pointY(v)} r={3.5} fill={chartColor(0)}>
              <title>{`${label}: ${formatChartValue(v)}`}</title>
            </circle>
            <text
              x={pointX(i)}
              y={padT + plotH + 14}
              textAnchor="middle"
              className="fill-gray-600 dark:fill-gray-300 text-[10px]"
            >
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Build an SVG arc path for a pie/donut slice between two angles (radians). */
function arcPath(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + rOuter * Math.cos(a0);
  const y0 = cy + rOuter * Math.sin(a0);
  const x1 = cx + rOuter * Math.cos(a1);
  const y1 = cy + rOuter * Math.sin(a1);
  if (rInner <= 0) {
    // Full pie wedge (center → arc → center).
    return `M ${cx} ${cy} L ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} Z`;
  }
  // Donut ring segment (outer arc forward, inner arc backward).
  const ix1 = cx + rInner * Math.cos(a1);
  const iy1 = cy + rInner * Math.sin(a1);
  const ix0 = cx + rInner * Math.cos(a0);
  const iy0 = cy + rInner * Math.sin(a0);
  return [
    `M ${x0} ${y0}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1}`,
    `L ${ix1} ${iy1}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${ix0} ${iy0}`,
    'Z',
  ].join(' ');
}

/** Pie / donut chart with a side legend. Slices sized by value fraction. */
function PieChart({ series, donut }: { series: ChartSeries; donut: boolean }) {
  const { t } = useT();
  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 8;
  const rInner = donut ? rOuter * 0.55 : 0;

  // Only non-zero slices get a wedge; a single full-circle slice is drawn as a
  // ring/disc rather than a degenerate arc.
  const drawn = series.slices.map((s, i) => ({ ...s, color: chartColor(i) })).filter((s) => s.value > 0);
  let angle = -Math.PI / 2; // start at 12 o'clock

  return (
    <div className="flex flex-wrap items-center gap-6" data-testid="chart-pie">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="w-48 h-48 shrink-0"
        role="img"
        aria-label={chartAriaSummary(t, series)}
        preserveAspectRatio="xMidYMid meet"
      >
        {drawn.length === 1 ? (
          rInner > 0 ? (
            <>
              <circle cx={cx} cy={cy} r={rOuter} fill={drawn[0]!.color} />
              <circle cx={cx} cy={cy} r={rInner} className="fill-white dark:fill-gray-900" />
              <title>{`${drawn[0]!.label}: ${formatChartValue(drawn[0]!.value)} (100%)`}</title>
            </>
          ) : (
            <circle cx={cx} cy={cy} r={rOuter} fill={drawn[0]!.color}>
              <title>{`${drawn[0]!.label}: ${formatChartValue(drawn[0]!.value)} (100%)`}</title>
            </circle>
          )
        ) : (
          drawn.map((s, i) => {
            const a0 = angle;
            const a1 = angle + s.fraction * Math.PI * 2;
            angle = a1;
            return (
              <path key={i} d={arcPath(cx, cy, rOuter, rInner, a0, a1)} fill={s.color}>
                <title>{`${s.label}: ${formatChartValue(s.value)} (${Math.round(s.fraction * 100)}%)`}</title>
              </path>
            );
          })
        )}
      </svg>
      <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1" data-testid="chart-legend">
        {series.slices.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: chartColor(i) }} />
            <span className="truncate max-w-[12rem]">{s.label}</span>
            <span className="text-gray-400 dark:text-gray-500">
              {formatChartValue(s.value)} ({Math.round(s.fraction * 100)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Single big-number KPI card with an optional caption. */
function KpiCard({ series }: { series: ChartSeries }) {
  const value = series.values[0] ?? 0;
  const label = series.labels[0] ?? series.measureLabel;
  return (
    <div
      className="inline-flex flex-col items-start rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-5"
      role="img"
      aria-label={`${label}: ${formatChartValue(value)}`}
      data-testid="chart-kpi"
    >
      <span className="text-4xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
        {formatChartValue(value)}
      </span>
      <span className="mt-1 text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">{label}</span>
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
  const { t } = useT();
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
      <div className="mb-2 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1">
          Date property:
          <select
            className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
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
            className="px-2 hover:text-gray-800 dark:hover:text-gray-100"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
            aria-label="Previous month"
          >
            ‹
          </button>
          <span className="font-medium text-gray-700 dark:text-gray-300">{monthLabel}</span>
          <button
            className="px-2 hover:text-gray-800 dark:hover:text-gray-100"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>
      {!datePropId ? (
        <div className="text-sm text-gray-500 dark:text-gray-400">{t('db.pickDateCalendar')}</div>
      ) : (
        <div className="grid grid-cols-7 gap-px bg-gray-200 dark:bg-gray-700 border border-gray-200 dark:border-gray-700 text-xs">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="bg-gray-50 dark:bg-gray-800 px-1 py-1 font-medium text-gray-500 dark:text-gray-400 text-center">
              {d}
            </div>
          ))}
          {grid.map((cell, i) => (
            <div key={i} className="bg-white dark:bg-gray-800 min-h-[5rem] p-1 align-top">
              {cell ? (
                <>
                  <div className="text-gray-400 dark:text-gray-500 text-[10px] mb-1">{cell.getDate()}</div>
                  <div className="flex flex-col gap-0.5">
                    {(byDay.get(ymd(cell)) ?? []).map((row) => (
                      <a
                        key={row.id}
                        href={`/p/${row.id}`}
                        className="block truncate no-underline bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 rounded px-1 text-[11px] text-gray-800 dark:text-gray-200"
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
  const { t } = useT();
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
      <div className="mb-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
        Date property:
        <select
          className="border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5"
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
        <div className="text-sm text-gray-500 dark:text-gray-400">{t('db.pickDateTimeline')}</div>
      ) : !placed || !placed.start || placed.dated.length === 0 ? (
        <div className="text-sm text-gray-400 dark:text-gray-500 py-4">{t('db.noRowsWithDate')}</div>
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
                      className="absolute top-0 h-5 flex items-center bg-blue-100 hover:bg-blue-200 rounded px-2 no-underline text-gray-800 dark:text-gray-200 whitespace-nowrap"
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

// ---------- Phase 17: buttons + automations ----------

/** A property's button config: {label, icon, actions}. */
interface ButtonConfig {
  label?: string;
  icon?: string;
  actions?: ButtonAction[];
}

/**
 * Editor for an action list, shared by the button property config + the
 * automations builder. v1 supports adding edit_property / add_page_to_db /
 * send_notification / send_webhook / show_confirm and removing/reordering them.
 * Each action's fields are edited inline via small inputs.
 */
function ActionListEditor({
  actions,
  properties,
  databaseId,
  onChange,
}: {
  actions: ButtonAction[];
  properties: DbProperty[];
  databaseId: string;
  onChange: (next: ButtonAction[]) => void;
}) {
  const { t } = useT();
  function add(a: ButtonAction) {
    onChange([...actions, a]);
  }
  function patch(i: number, p: Partial<ButtonAction>) {
    onChange(actions.map((a, j) => (j === i ? ({ ...a, ...p } as ButtonAction) : a)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= actions.length) return;
    const next = actions.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }
  const editableProps = properties.filter(
    (p) => !AUTO_PROPERTY_TYPES.has(p.type) && p.type !== 'button' && p.type !== 'formula' && p.type !== 'rollup',
  );

  return (
    <div className="ae-action-list" data-testid="action-list">
      {actions.map((a, i) => (
        <div key={i} className="border border-gray-200 dark:border-gray-700 rounded p-1.5 mb-1 text-xs" data-testid="action-row">
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium">{describeAction(a, t)}</span>
            <span className="flex gap-1">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" disabled={i === actions.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" onClick={() => onChange(actions.filter((_, j) => j !== i))}>×</button>
            </span>
          </div>
          {a.kind === 'edit_pages' ? (
            <div className="flex flex-wrap gap-1 items-center">
              <select
                value={a.propertyId}
                onChange={(e) => patch(i, { propertyId: e.target.value } as Partial<ButtonAction>)}
              >
                <option value="">{t('automation.pickProperty')}</option>
                {editableProps.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <input
                className="border border-gray-300 dark:border-gray-600 rounded px-1"
                placeholder={t('automation.value')}
                value={String((a.value as string) ?? '')}
                onChange={(e) => patch(i, { value: e.target.value } as Partial<ButtonAction>)}
              />
            </div>
          ) : a.kind === 'send_notification' ? (
            <div className="flex flex-wrap gap-1 items-center">
              <input
                className="border border-gray-300 dark:border-gray-600 rounded px-1"
                placeholder={t('automation.recipients')}
                value={(a.recipients ?? []).join(', ')}
                onChange={(e) =>
                  patch(i, {
                    recipients: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  } as Partial<ButtonAction>)
                }
              />
              <input
                className="border border-gray-300 dark:border-gray-600 rounded px-1"
                placeholder={t('automation.message')}
                value={a.body ?? ''}
                onChange={(e) => patch(i, { body: e.target.value } as Partial<ButtonAction>)}
              />
            </div>
          ) : a.kind === 'send_webhook' ? (
            <input
              className="border border-gray-300 dark:border-gray-600 rounded px-1 w-full"
              placeholder="https://…"
              value={a.url ?? ''}
              onChange={(e) => patch(i, { url: e.target.value } as Partial<ButtonAction>)}
            />
          ) : a.kind === 'add_page_to_db' ? (
            <input
              className="border border-gray-300 dark:border-gray-600 rounded px-1"
              placeholder={t('automation.title')}
              value={a.title ?? ''}
              onChange={(e) => patch(i, { title: e.target.value } as Partial<ButtonAction>)}
            />
          ) : a.kind === 'show_confirm' ? (
            <input
              className="border border-gray-300 dark:border-gray-600 rounded px-1 w-full"
              placeholder={t('automation.message')}
              value={a.message ?? ''}
              onChange={(e) => patch(i, { message: e.target.value } as Partial<ButtonAction>)}
            />
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        <button type="button" data-testid="add-edit" onClick={() => add({ kind: 'edit_pages', databaseId, propertyId: '', value: '', currentRowOnly: true })}>
          + {t('action.edit_pages')}
        </button>
        <button type="button" data-testid="add-addpage" onClick={() => add({ kind: 'add_page_to_db', databaseId })}>
          + {t('action.add_page_to_db')}
        </button>
        <button type="button" data-testid="add-notify" onClick={() => add({ kind: 'send_notification', recipients: [], body: '' })}>
          + {t('action.send_notification')}
        </button>
        <button type="button" data-testid="add-webhook" onClick={() => add({ kind: 'send_webhook', url: '' })}>
          + {t('action.send_webhook')}
        </button>
        <button type="button" data-testid="add-confirm" onClick={() => add({ kind: 'show_confirm', message: '' })}>
          + {t('action.show_confirm')}
        </button>
      </div>
    </div>
  );
}

/** Collect a button property's {label, icon, actions} before the prop is created. */
function ButtonConfigPanel({
  properties,
  onCancel,
  onConfirm,
}: {
  properties: DbProperty[];
  onCancel: () => void;
  onConfirm: (config: Record<string, JsonValue>) => void;
}) {
  const { t } = useT();
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState('');
  const [actions, setActions] = useState<ButtonAction[]>([]);
  // The DB id isn't available here directly; actions default their own
  // databaseId at run-time to the current row's DB on the server.
  return (
    <div className="absolute z-20 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-2 w-80 text-left" data-testid="button-config-panel">
      <div className="flex gap-1 mb-2">
        <input className="border border-gray-300 dark:border-gray-600 rounded px-1 w-12" placeholder={t('button.icon')} maxLength={4} value={icon} onChange={(e) => setIcon(e.target.value)} />
        <input className="border border-gray-300 dark:border-gray-600 rounded px-1 flex-1" placeholder={t('button.label')} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <ActionListEditor actions={actions} properties={properties} databaseId="" onChange={setActions} />
      <div className="flex justify-end gap-2 mt-2">
        <button type="button" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          type="button"
          data-testid="button-config-save"
          onClick={() => onConfirm({ label, icon, actions } as unknown as Record<string, JsonValue>)}
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

/** A per-row button cell: clicking runs the property's actions for this row. */
function ButtonPropertyCell({
  property,
  databaseId,
  rowId,
}: {
  property: DbProperty;
  databaseId: string;
  rowId: string;
}) {
  const config = (property.config ?? {}) as unknown as ButtonConfig;
  const actions = (config.actions ?? []) as ButtonAction[];
  const [running, setRunning] = useState(false);
  async function run() {
    if (running) return;
    setRunning(true);
    try {
      await runActionsFn({
        data: {
          databaseId,
          rowId,
          actions: actions as unknown as Record<string, unknown>[],
        },
      });
    } finally {
      setRunning(false);
    }
  }
  return (
    <button
      type="button"
      className="ae-button"
      data-testid="button-prop-run"
      onClick={() => void run()}
      disabled={running}
    >
      {config.icon ? <span>{config.icon} </span> : null}
      {config.label || 'Button'}
    </button>
  );
}

/** The ⚡ Automations panel: list + a v1-simple builder. */
function AutomationsPanel({
  databaseId,
  properties,
  onClose,
}: {
  databaseId: string;
  properties: DbProperty[];
  onClose: () => void;
}) {
  const { t } = useT();
  const [list, setList] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggerKind, setTriggerKind] = useState<AutomationTrigger['kind']>('page_added');
  const [triggerPropId, setTriggerPropId] = useState('');
  const [scheduleEvery, setScheduleEvery] = useState<'day' | 'week' | 'month'>('day');
  const [actions, setActions] = useState<ButtonAction[]>([]);

  async function refresh() {
    setLoading(true);
    const next = await automationsListFn({ data: { databaseId } });
    setList(next);
    setLoading(false);
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId]);

  async function create() {
    const trigger: AutomationTrigger =
      triggerKind === 'property_edited'
        ? { kind: 'property_edited', propertyId: triggerPropId || undefined }
        : triggerKind === 'schedule'
          ? { kind: 'schedule', every: scheduleEvery, at: '09:00' }
          : { kind: 'page_added' };
    await automationCreateFn({
      data: {
        databaseId,
        trigger,
        actions: actions as unknown as Record<string, unknown>[],
      },
    });
    setActions([]);
    await refresh();
  }

  const editableProps = properties.filter((p) => !AUTO_PROPERTY_TYPES.has(p.type) && p.type !== 'button');

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded p-3 mb-3 bg-gray-50 dark:bg-gray-800" data-testid="automations-panel">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-sm">⚡ {t('db.automations')}</h3>
        <button type="button" onClick={onClose}>✕</button>
      </div>
      {loading ? (
        <div className="text-xs text-gray-400 dark:text-gray-500">…</div>
      ) : (
        <ul className="mb-3 space-y-1">
          {list.map((a) => (
            <li key={a.id} className="flex items-center justify-between text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-800" data-testid="automation-item">
              <span>
                <strong>{t('automation.when')}</strong> {t(`trigger.${a.trigger.kind}`)} →{' '}
                <strong>{t('automation.then')}</strong> {a.actions.length} {t('automation.action')}
              </span>
              <span className="flex items-center gap-2">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={async (e) => {
                      await automationSetEnabledFn({ data: { id: a.id, enabled: e.target.checked } });
                      await refresh();
                    }}
                  />
                  {t('automation.enable')}
                </label>
                <button
                  type="button"
                  onClick={async () => {
                    await automationDeleteFn({ data: { id: a.id } });
                    await refresh();
                  }}
                >
                  🗑
                </button>
              </span>
            </li>
          ))}
          {list.length === 0 ? <li className="text-xs text-gray-400 dark:text-gray-500">—</li> : null}
        </ul>
      )}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
        <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
          <strong>{t('automation.when')}</strong>
          <select value={triggerKind} onChange={(e) => setTriggerKind(e.target.value as AutomationTrigger['kind'])} data-testid="trigger-kind">
            <option value="page_added">{t('trigger.page_added')}</option>
            <option value="property_edited">{t('trigger.property_edited')}</option>
            <option value="schedule">{t('trigger.schedule')}</option>
          </select>
          {triggerKind === 'property_edited' ? (
            <select value={triggerPropId} onChange={(e) => setTriggerPropId(e.target.value)}>
              <option value="">{t('automation.anyProperty')}</option>
              {editableProps.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          ) : null}
          {triggerKind === 'schedule' ? (
            <select value={scheduleEvery} onChange={(e) => setScheduleEvery(e.target.value as 'day' | 'week' | 'month')}>
              <option value="day">{t('schedule.day')}</option>
              <option value="week">{t('schedule.week')}</option>
              <option value="month">{t('schedule.month')}</option>
            </select>
          ) : null}
        </div>
        <div className="text-xs mb-1"><strong>{t('automation.then')}</strong></div>
        <ActionListEditor actions={actions} properties={properties} databaseId={databaseId} onChange={setActions} />
        <button
          type="button"
          className="mt-2 px-2 py-1 bg-gray-800 text-white rounded text-xs"
          data-testid="automation-create"
          onClick={() => void create()}
          disabled={actions.length === 0}
        >
          {t('automation.create')}
        </button>
      </div>
    </div>
  );
}
