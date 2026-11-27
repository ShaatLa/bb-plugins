import { experimental_PluginRpcCallError } from "@get-bb/plugin-sdk/app";
import { textConfigSchemas, type TextConfigKey } from "./config-fields";

type SavedDraft = { base: string; text: string };
type DraftState = {
  text: string;
  status: "idle" | "saving" | "saved" | "invalid" | "failed";
  error?: string;
};
type Write = (value: string) => Promise<string>;
const retryDelays = [1000, 3000];

const browserSchemas = textConfigSchemas(
  path => path.startsWith("/"),
  path => !/^[\\/]|^[a-z]:[\\/]/i.test(path),
);

function readDraft(key: string): { raw: string | null; draft?: SavedDraft } {
  try {
    const raw = localStorage.getItem(key);
    const draft = JSON.parse(raw ?? "null");
    if (typeof draft?.base === "string" && typeof draft.text === "string") return { raw, draft };
    return { raw };
  } catch {
    return { raw: null };
  }
}

export class SettingsDraft {
  private readonly storageKey: string;
  private readonly listeners = new Set<() => void>();
  private snapshot: DraftState;
  private persisted: string | null;
  private saved: string;
  private inFlight?: string;
  private queued?: Write;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private conflict = false;
  version = 0;

  constructor(projectId: string, private readonly field: TextConfigKey, saved: string) {
    this.storageKey = `project-instructions:draft:${JSON.stringify([projectId, field])}`;
    const { raw, draft: restored } = readDraft(this.storageKey);
    this.persisted = raw;
    this.saved = saved;
    this.snapshot = { text: restored?.text ?? saved, status: "idle" };
    if (restored && restored.text !== saved && restored.base !== saved) {
      this.conflict = true;
      this.snapshot = { text: restored.text, status: "failed", error: "The saved value changed while this draft was open." };
    }
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopRetry();
    };
  };

  stopRetry = () => clearTimeout(this.retryTimer);

  private persist(snapshot: DraftState, edited: boolean) {
    if (this.conflict) return;
    try {
      // An older write can settle after another settings view has edited this field.
      if (!edited && localStorage.getItem(this.storageKey) !== this.persisted) return;
      if (snapshot.text === this.saved && this.inFlight === undefined) {
        localStorage.removeItem(this.storageKey);
        this.persisted = null;
      } else {
        const next = JSON.stringify({ base: this.saved, text: snapshot.text });
        localStorage.setItem(this.storageKey, next);
        this.persisted = next;
      }
    } catch {
      // Keep the in-memory draft if storage is unavailable.
    }
  }

  private update(snapshot: DraftState, edited = false) {
    this.snapshot = snapshot;
    this.persist(snapshot, edited);
    this.listeners.forEach(listener => listener());
  }

  edit(text: string) {
    clearTimeout(this.retryTimer);
    this.attempts = 0;
    this.queued = undefined;
    this.conflict = false;
    this.update({ text, status: "idle" }, true);
  }

  reconcile(saved: string, version: number) {
    if (version !== this.version || this.inFlight !== undefined || saved === this.saved) return;
    const { text } = this.snapshot;
    const dirty = text !== this.saved && text !== saved;
    this.saved = saved;
    if (dirty) {
      clearTimeout(this.retryTimer);
      this.conflict = true;
      this.update({ text, status: "failed", error: "The saved value changed while this draft was open." });
    } else {
      this.conflict = false;
      this.update({ text: saved, status: "idle" });
    }
  }

  commit(write: Write, retry = false) {
    const { text, status } = this.snapshot;
    if (status === "failed" && !retry) return;
    if (this.inFlight === undefined && text === this.saved) return;
    if (text === this.inFlight) return;

    const parsed = browserSchemas[this.field].safeParse(text);
    if (!parsed.success) {
      this.update({ text, status: "invalid", error: parsed.error.issues[0]?.message ?? "Invalid value." });
      return;
    }
    if (this.inFlight !== undefined) {
      this.queued = write;
      return;
    }

    clearTimeout(this.retryTimer);
    this.conflict = false;
    this.inFlight = text;
    this.update({ text, status: "saving" });
    void this.write(text, write);
  }

  private async write(text: string, write: Write) {
    try {
      const saved = await write(text);
      this.inFlight = undefined;
      this.saved = saved;
      this.version++;
      this.attempts = 0;
      if (this.snapshot.text === text) {
        this.update({ text: saved, status: "saved" });
      } else {
        this.update(this.snapshot);
      }
    } catch (error) {
      this.inFlight = undefined;
      if (this.snapshot.text === text) {
        const message = error instanceof Error ? error.message : String(error);
        this.update({ text, status: "failed", error: message });
        const delay = retryDelays[this.attempts];
        if (delay !== undefined && this.listeners.size && error instanceof experimental_PluginRpcCallError && error.code === "transport_error") {
          this.attempts++;
          this.retryTimer = setTimeout(() => this.commit(write, true), delay);
        }
      } else {
        this.update(this.snapshot);
      }
    } finally {
      const queued = this.queued;
      this.queued = undefined;
      if (queued) this.commit(queued);
    }
  }
}
