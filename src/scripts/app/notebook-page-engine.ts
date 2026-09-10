/** Editors store JSON through the shared note document's revision/conflict/sync path. */
export interface NotebookPageEngine {
  element: HTMLElement;
  load(value: unknown): void;
  serialize(): unknown;
  text(): string;
  /** Remote editors keep unsaved cells outside the notebook document. */
  dirty?(): boolean;
  flush?(): Promise<boolean>;
  destroy(): void;
  focus(): void;
}
export interface NotebookPageOptions {
  onChange(): void;
  api?(): string | null;
}
