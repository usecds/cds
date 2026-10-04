import type { EditResult, EditorSession, SourceEdit, SourceEditor, SourceFieldRef } from "@cds/server";

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

  async read(ref: SourceFieldRef, session: EditorSession): Promise<string | null> {
    const res = await this.request("GET", `${itemPath(ref)}?fields=${encodeURIComponent(ref.field)}`, { token: session.accessToken });
    if (res.status === 401) throw new DirectusAuthError(401, res.message);
    if (res.status !== 200) throw new Error(`Directus ${res.status}: ${res.message}`);
    return text(res.body?.data?.[ref.field]);
  }

  async write(edit: SourceEdit, session: EditorSession): Promise<EditResult> {
    const { ref } = edit;
    if (ref.editable === false) return { status: "rejected", message: "This value is derived and can't be edited in place" };
    // Optimistic check: the editor saw edit.basedOn; refuse when someone changed the field since
    let current: string | null;
    try {
      current = await this.read(ref, session);
    } catch (err) {
      if (err instanceof DirectusAuthError) throw err;
      return { status: "rejected", message: err instanceof Error ? err.message : String(err) };
    }
    if ((current ?? "") !== (text(edit.basedOn) ?? "")) return { status: "conflict", current };
    if ((current ?? "") === edit.value) return { status: "saved", value: edit.value };

    const res = await this.request("PATCH", `${itemPath(ref)}?fields=${encodeURIComponent(ref.field)}`, {
      token: session.accessToken,
      body: { [ref.field]: edit.value }
    });
    if (res.status === 401) throw new DirectusAuthError(401, res.message);
    if (res.status !== 200 && res.status !== 204) return { status: "rejected", message: res.message, code: res.status };
    return { status: "saved", value: text(res.body?.data?.[ref.field]) ?? edit.value };
  }
}

const itemPath = (ref: SourceFieldRef) => `/items/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.id)}`;

// Field values compare as text; an empty field is null
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : String(value);

// The edit contract, for apps that use the editor without depending on @cds/server
export type { EditResult, EditorSession, SourceEdit, SourceEditor, SourceFieldRef } from "@cds/server";
