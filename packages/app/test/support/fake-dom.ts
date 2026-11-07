/**
 * Just enough of a page for the interface's small helpers (`h`, `checkRow`, `questionRow`, `markSelected`) to build into and be looked
 * at: elements that remember their attributes, children and class, and can be searched by tag and class. It is not a browser, and what
 * only a browser can show (focus, drawing, what a screen reader says) is not claimed from it.
 */

export class FakeNode {
  readonly tag: string;
  id = "";
  className = "";
  textContent = "";
  htmlFor = "";
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  /** How many times an attribute was written, so that a test can say a helper changed only what it had to. */
  writes = 0;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string): void {
    this.writes++;
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | undefined {
    return this.attrs[name];
  }
  /** `data-key` as `dataset.key`, which is how the interface reads it. */
  get dataset(): Record<string, string | undefined> {
    return { key: this.attrs["data-key"] };
  }
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  addEventListener(type: string, handler: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }
  /** Runs what was listening for a click, as a person clicking would. */
  click(): void {
    for (const handler of this.listeners["click"] ?? []) handler({});
  }
  append(...kids: FakeNode[]): void {
    this.children.push(...kids);
  }
  /** The words under this element, the way a reader of the page would take them. */
  get words(): string {
    return this.textContent + this.children.map((c) => c.words).join("");
  }
  /** Every descendant that is this tag with this class (`button.qrow`), in order. */
  querySelectorAll(selector: string): FakeNode[] {
    const [tag, cls] = selector.split(".");
    const found: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.tag === tag && (cls === undefined || child.className.split(/\s+/).includes(cls))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

export function installFakeDocument(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { textContent: text }),
  };
}

/** The element with this id, searching down from `root`. */
export function findById(root: FakeNode, id: string): FakeNode | undefined {
  return root.id === id ? root : root.children.map((c) => findById(c, id)).find((f) => f !== undefined);
}
