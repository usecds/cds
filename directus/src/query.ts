// The subset of Directus REST query semantics that read-only frontends use:
// filter (_eq, _neq, _in, _nin, _starts_with, _ends_with, _contains, _null, _nnull, _empty, _nempty,
// _gt, _gte, _lt, _lte), sort, limit (default 100, -1 = all), offset and fields (projection).

export type Row = Record<string, any>;

export interface DirectusQuery {
  fields?: string | string[];
  filter?: Record<string, any>; // nested form: { status: { _eq: "published" } }
  sort?: string | string[];
  limit?: number | string;
  offset?: number | string;
  [param: string]: unknown; // flat form from URL params: "filter[status][_eq]": "published"
}

export const DEFAULT_LIMIT = 100; // Directus QUERY_LIMIT_DEFAULT

type Condition = { path: string[]; op: string; value: unknown };

/**
 * Collects filter conditions from both the nested form and flat URL params like
 * filter[menu][_in]=1,2 or filter[to][slug][_eq]=x.
 */
export function parseFilter(query: DirectusQuery): Condition[] {
  const conditions: Condition[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node as Row)) {
        if (key.startsWith("_") && key !== "_and") conditions.push({ path, op: key, value });
        else if (key === "_and" && Array.isArray(value)) value.forEach((v) => walk(v, path));
        else walk(value, [...path, key]);
      }
    }
  };
  if (query.filter) {
    walk(typeof query.filter === "string" ? JSON.parse(query.filter) : query.filter, []);
  }
  for (const [param, value] of Object.entries(query)) {
    const match = /^filter((?:\[[^\]]+\])+)$/.exec(param);
    if (!match) continue;
    const parts = [...match[1].matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    const op = parts.pop()!;
    conditions.push({ path: parts, op, value });
  }
  return conditions;
}

// A related record compares by its primary key
const scalar = (value: unknown): unknown =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row).id ?? (value as Row).code ?? value : value;

function valuesAt(row: Row, path: string[]): unknown[] {
  let current: unknown[] = [row];
  for (const key of path) {
    current = current.flatMap((v) => {
      const next = (v as Row | null)?.[key];
      return Array.isArray(next) ? next : [next];
    });
  }
  return current.map(scalar);
}

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : String(value).split(",")).map((v) => String(v));

function test(actual: unknown, op: string, expected: unknown): boolean {
  const a = actual === undefined ? null : actual;
  const s = a === null ? "" : String(a);
  switch (op) {
    case "_eq": return expected === null ? a === null : a !== null && s === String(expected);
    case "_neq": return a === null || s !== String(expected);
    case "_in": return a !== null && list(expected).includes(s);
    case "_nin": return a === null || !list(expected).includes(s);
    case "_starts_with": return s.startsWith(String(expected));
    case "_ends_with": return s.endsWith(String(expected));
    case "_contains": return s.includes(String(expected));
    case "_icontains": return s.toLowerCase().includes(String(expected).toLowerCase());
    case "_null": return (a === null) === (String(expected) !== "false");
    case "_nnull": return (a !== null) === (String(expected) !== "false");
    case "_empty": return (a === null || s === "") === (String(expected) !== "false");
    case "_nempty": return (a !== null && s !== "") === (String(expected) !== "false");
    case "_gt": return a !== null && Number(a) > Number(expected);
    case "_gte": return a !== null && Number(a) >= Number(expected);
    case "_lt": return a !== null && Number(a) < Number(expected);
    case "_lte": return a !== null && Number(a) <= Number(expected);
    default: throw new Error(`Unsupported filter operator ${op}`);
  }
}

export function applyFilter(rows: Row[], conditions: Condition[]): Row[] {
  if (!conditions.length) return rows;
  return rows.filter((row) =>
    conditions.every(({ path, op, value }) => {
      const actual = valuesAt(row, path);
      // A to-many path matches if any related value matches (like Directus' _some), except negations
      const negation = op === "_neq" || op === "_nin";
      return negation ? actual.every((v) => test(v, op, value)) : actual.some((v) => test(v, op, value));
    }));
}

// Without a sort, rows keep the order Directus returned them in when publishing: its default
// (the collection's sort field, else the primary key)
export function applySort(rows: Row[], sort?: string | string[]): Row[] {
  const keys = (Array.isArray(sort) ? sort : sort ? String(sort).split(",") : []).filter(Boolean);
  if (!keys.length) return rows;
  const compare = (a: unknown, b: unknown) => {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1; // nulls last, like Postgres ascending
    if (b === null || b === undefined) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  };
  return [...rows].sort((x, y) => {
    for (const key of keys) {
      const desc = key.startsWith("-");
      const path = (desc ? key.slice(1) : key).split(".");
      const order = compare(valuesAt(x, path)[0], valuesAt(y, path)[0]);
      if (order !== 0) return desc ? -order : order;
    }
    return 0;
  });
}

export function applyPage(rows: Row[], limit?: number | string, offset?: number | string): Row[] {
  const n = limit === undefined || limit === "" ? DEFAULT_LIMIT : Number(limit);
  const start = offset ? Number(offset) : 0;
  return n < 0 ? rows.slice(start) : rows.slice(start, start + n);
}

// --- fields projection ---------------------------------------------------------------

interface FieldTree { all: boolean; children: Map<string, FieldTree> }

export function parseFields(fields?: string | string[]): FieldTree {
  const root: FieldTree = { all: false, children: new Map() };
  const specs = (Array.isArray(fields) ? fields : String(fields ?? "*").split(",")).map((f) => f.trim()).filter(Boolean);
  for (const spec of specs.length ? specs : ["*"]) {
    let node = root;
    const parts = spec.split(".");
    parts.forEach((part) => {
      if (part === "*") {
        node.all = true;
        return;
      }
      // Directus M2A syntax "item:collection" selects the same nested item
      const key = part.split(":")[0];
      if (!node.children.has(key)) node.children.set(key, { all: false, children: new Map() });
      node = node.children.get(key)!;
    });
  }
  return root;
}

// Related records not asked for collapse to their primary key, like Directus returns them
function collapse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(collapse);
  if (value && typeof value === "object") {
    const row = value as Row;
    if ("id" in row) return row.id;
    if ("code" in row && Object.keys(row).length <= 4) return row.code;
  }
  return value;
}

export function project(value: unknown, tree: FieldTree): unknown {
  if (Array.isArray(value)) return value.map((v) => project(v, tree));
  if (!value || typeof value !== "object") return value;
  const row = value as Row;
  const out: Row = {};
  if (tree.all) {
    for (const [key, v] of Object.entries(row)) {
      out[key] = tree.children.has(key) ? project(v, tree.children.get(key)!) : collapse(v);
    }
  }
  for (const [key, child] of tree.children) {
    if (key in out || !(key in row)) continue;
    const v = row[key];
    // A named leaf without sub-fields ("slug") is taken as is; a named relation with sub-fields is projected
    out[key] = child.all || child.children.size ? project(v, child) : collapse(v);
  }
  return out;
}

/**
 * Nested sorts from deep[<relation>][_sort]=<fields> (flat params or a nested object), e.g.
 * deep[interfaces][_sort]=sort: to-many arrays at that path are sorted like the top level.
 * Other deep options (_filter, _limit) aren't supported.
 */
export function parseDeepSorts(query: DirectusQuery): Array<{ path: string[]; sort: string }> {
  const sorts: Array<{ path: string[]; sort: string }> = [];
  for (const [key, value] of Object.entries(query)) {
    const flat = /^deep((?:\[[^\]]+\])+)\[_sort\]$/.exec(key);
    if (flat) sorts.push({ path: [...flat[1].matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]), sort: String(value) });
  }
  const walk = (node: unknown, path: string[]) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Row)) {
      if (key === "_sort") sorts.push({ path, sort: Array.isArray(value) ? value.join(",") : String(value) });
      else if (!key.startsWith("_")) walk(value, [...path, key]);
    }
  };
  const deep = typeof query.deep === "string" ? JSON.parse(query.deep) : query.deep;
  walk(deep, []);
  return sorts.filter((s) => s.path.length);
}

export function applyDeepSorts(row: Row, query: DirectusQuery): Row {
  return parseDeepSorts(query).reduce((r, d) => applyDeepSort(r, d.path, d.sort), row);
}

function applyDeepSort(row: Row, path: string[], sort: string): Row {
  const [head, ...rest] = path;
  const value = row?.[head];
  if (value === undefined || value === null) return row;
  if (!rest.length) return Array.isArray(value) ? { ...row, [head]: applySort(value, sort) } : row;
  const next = Array.isArray(value)
    ? value.map((v) => (v && typeof v === "object" ? applyDeepSort(v, rest, sort) : v))
    : typeof value === "object" ? applyDeepSort(value, rest, sort) : value;
  return { ...row, [head]: next };
}

/**
 * Runs a Directus-style query over stored rows: filter, sort, offset/limit, then field projection.
 */
export function runQuery(rows: Row[], query: DirectusQuery = {}): Row[] {
  if (parseDeepSorts(query).length) rows = rows.map((row) => applyDeepSorts(row, query));
  const filtered = applyFilter(rows, parseFilter(query));
  const sorted = applySort(filtered, query.sort as string | string[] | undefined);
  const paged = applyPage(sorted, query.limit as number | string | undefined, query.offset as number | string | undefined);
  const tree = parseFields(query.fields as string | string[] | undefined);
  return paged.map((row) => project(row, tree) as Row);
}
