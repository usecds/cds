import type { EditResult, EditValue, EditorSession, SourceEdit, SourceEditor, SourceFieldRef } from "@usecds/server";

export interface DirectusEditorConfig {
  url: string;
}

/** Thrown for a failed login or an expired session */
export class DirectusAuthError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "DirectusAuthError";
  }
}

/**
 * The write side of the Directus adapter: an edit of one published value goes to the Directus field
 * it comes from (see the source map), with the editor's own session, so Directus applies the
 * editor's permissions. Nothing is written into CDS; the next publish includes the change.
 */
export class DirectusEditor implements SourceEditor {
  private readonly url: string;

  constructor(config: DirectusEditorConfig) {
    this.url = config.url.replace(/\/$/, "");
  }

  private async request(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, body, message: body?.errors?.[0]?.message ?? res.statusText };
  }

  private async session(tokens: { access_token: string; refresh_token?: string; expires?: number }): Promise<EditorSession> {
    const session: EditorSession = {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.expires ? { expiresAt: Date.now() + tokens.expires } : {})
    };
    const me = await this.request("GET", "/users/me?fields=id,first_name,last_name,email", { token: session.accessToken });
    if (me.status === 200 && me.body?.data) {
      const u = me.body.data;
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || undefined;
      session.user = { id: String(u.id), ...(name ? { name } : {}) };
    }
    return session;
  }

  async login(credentials: { email: string; password: string }): Promise<EditorSession> {
    const res = await this.request("POST", "/auth/login", { body: { ...credentials, mode: "json" } });
    if (res.status !== 200) throw new DirectusAuthError(res.status, res.message || "Login failed");
    return this.session(res.body.data);
  }

  async refresh(session: EditorSession): Promise<EditorSession> {
    if (!session.refreshToken) throw new DirectusAuthError(401, "No refresh token");
    const res = await this.request("POST", "/auth/refresh", { body: { refresh_token: session.refreshToken, mode: "json" } });
    if (res.status !== 200) throw new DirectusAuthError(res.status, res.message || "Session expired");
    return this.session(res.body.data);
  }

  async logout(session: EditorSession): Promise<void> {
    if (session.refreshToken) await this.request("POST", "/auth/logout", { body: { refresh_token: session.refreshToken, mode: "json" } });
  }

  async read(ref: SourceFieldRef, session: EditorSession): Promise<EditValue> {
    const res = await this.request("GET", `${itemPath(ref.collection, ref.id)}?fields=${encodeURIComponent(ref.field)}`, { token: session.accessToken });
    if (res.status === 401) throw new DirectusAuthError(401, res.message);
    if (res.status !== 200) throw new Error(`Directus ${res.status}: ${res.message}`);
    return scalar(res.body?.data?.[ref.field]);
  }

  async write(edit: SourceEdit, session: EditorSession): Promise<EditResult> {
    const { ref } = edit;
    if (ref.editable === false) return { status: "rejected", message: "This value is derived and can't be edited in place" };
    // Optimistic check: the editor saw edit.basedOn; refuse when someone changed the field since
    let current: EditValue;
    try {
      current = await this.read(ref, session);
    } catch (err) {
      if (err instanceof DirectusAuthError) throw err;
      return { status: "rejected", message: err instanceof Error ? err.message : String(err) };
    }
    if (!same(current, edit.basedOn)) return { status: "conflict", current };
    if (same(current, edit.value)) return { status: "saved", value: edit.value };

    const res = await this.request("PATCH", `${itemPath(ref.collection, ref.id)}?fields=${encodeURIComponent(ref.field)}`, {
      token: session.accessToken,
      body: { [ref.field]: edit.value }
    });
    if (res.status === 401) throw new DirectusAuthError(401, res.message);
    if (res.status !== 200 && res.status !== 204) return { status: "rejected", message: res.message, code: res.status };
    return { status: "saved", value: scalar(res.body?.data?.[ref.field] ?? edit.value) };
  }

  /**
   * Creates a record (nested relations included, as Directus accepts them) as the editor; returns
   * its primary key. A building block for structure edits (pages, blocks, menu entries).
   */
  async createItem(collection: string, data: Record<string, unknown>, session: EditorSession): Promise<string> {
    const res = await this.request("POST", `${collectionPath(collection)}?fields=id`, { token: session.accessToken, body: data });
    if (res.status === 401) throw new DirectusAuthError(401, res.message);
    if (res.status !== 200) throw new Error(`Directus ${res.status}: ${res.message}`);
    return String(res.body?.data?.id);
  }

  /** Updates fields of a record as the editor */
  async updateItem(collection: string, id: string, data: Record<string, unknown>, session: EditorSession): Promise<void> {
    const res = await this.request("PATCH", `${itemPath(collection, id)}?fields=id`, { token: session.accessToken, body: data });
    if (res.status === 401) throw new DirectusAuthError(401, res.message);
    if (res.status !== 200 && res.status !== 204) throw new Error(`Directus ${res.status}: ${res.message}`);
  }

  /** Reads records as the editor (Directus query params, e.g. { fields: "id,sort", "filter[page_id][_eq]": id }) */
  async readItems(collection: string, params: Record<string, string>, session: EditorSession): Promise<Array<Record<string, any>>> {
    const res = await this.request("GET", `${collectionPath(collection)}?${new URLSearchParams(params)}`, { token: session.accessToken });
    if (res.status === 401) throw new DirectusAuthError(401, res.message);
    if (res.status !== 200) throw new Error(`Directus ${res.status}: ${res.message}`);
    return res.body?.data ?? [];
  }
}

// System collections have their own endpoints: directus_files → /files
const collectionPath = (collection: string) =>
  collection.startsWith("directus_") ? `/${collection.slice("directus_".length)}` : `/items/${encodeURIComponent(collection)}`;
const itemPath = (collection: string, id: string) => `${collectionPath(collection)}/${encodeURIComponent(id)}`;

const scalar = (value: unknown): EditValue =>
  value === null || value === undefined ? null
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value
    : JSON.stringify(value);

// Values compare as text, with an empty field equal to an empty string
const same = (a: unknown, b: unknown) => (a === null || a === undefined ? "" : String(a)) === (b === null || b === undefined ? "" : String(b));

// The edit contract, for apps that use the editor without depending on @usecds/server
export type { EditResult, EditValue, EditorSession, SourceEdit, SourceEditor, SourceFieldRef, StructureEditor } from "@usecds/server";
