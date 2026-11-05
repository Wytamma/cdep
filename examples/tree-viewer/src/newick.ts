/**
 * Minimal Newick reader/writer for the demo app.
 *
 * This is application code, deliberately outside the SDK: CDEP transports
 * bytes; it does not know what a phylogenetic tree is.
 */
export interface TreeNode {
  name: string;
  length?: number;
  children: TreeNode[];
}

export function parseNewick(input: string): TreeNode {
  let index = 0;
  const text = input;
  const end = text.length;

  const skipWhitespace = (): void => {
    while (index < end && /\s/.test(text.charAt(index))) index += 1;
  };

  function parseLabel(): string {
    skipWhitespace();
    if (text.charAt(index) === "'") {
      index += 1;
      let label = "";
      while (index < end) {
        const char = text.charAt(index);
        if (char === "'") {
          if (text.charAt(index + 1) === "'") {
            label += "'";
            index += 2;
            continue;
          }
          index += 1;
          return label;
        }
        label += char;
        index += 1;
      }
      throw new Error("Unterminated quoted label");
    }

    let label = "";
    while (index < end) {
      const char = text.charAt(index);
      if (/\s/.test(char) || ",():;".includes(char)) break;
      label += char;
      index += 1;
    }
    return label;
  }

  function parseLength(): number | undefined {
    skipWhitespace();
    if (text.charAt(index) !== ":") return undefined;
    index += 1;
    skipWhitespace();
    const start = index;
    while (index < end && /[0-9eE+.-]/.test(text.charAt(index))) index += 1;
    const raw = text.slice(start, index);
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) {
      throw new Error(`Invalid branch length "${raw}"`);
    }
    return value;
  }

  function parseSubtree(): TreeNode {
    skipWhitespace();
    if (text.charAt(index) === "(") {
      index += 1;
      const children: TreeNode[] = [];
      for (;;) {
        children.push(parseSubtree());
        skipWhitespace();
        const next = text.charAt(index);
        if (next === ",") {
          index += 1;
          continue;
        }
        if (next === ")") {
          index += 1;
          break;
        }
        throw new Error("Expected ',' or ')' in Newick input");
      }
      if (children.length === 0) throw new Error("Empty internal node");
      const name = parseLabel();
      const length = parseLength();
      return { name, children, ...(length === undefined ? {} : { length }) };
    }

    const name = parseLabel();
    if (name === "") throw new Error("Leaf without a name");
    const length = parseLength();
    return { name, children: [], ...(length === undefined ? {} : { length }) };
  }

  const root = parseSubtree();
  skipWhitespace();
  if (text.charAt(index) === ";") index += 1;
  skipWhitespace();
  if (index !== end) throw new Error("Unexpected content after the tree");
  return root;
}

export function serializeNewick(root: TreeNode): string {
  return `${serializeNode(root)};`;
}

function serializeNode(node: TreeNode): string {
  const children =
    node.children.length > 0 ? `(${node.children.map((child) => serializeNode(child)).join(",")})` : "";
  const name = node.name === "" ? "" : quoteLabel(node.name);
  const branch = node.length === undefined ? "" : `:${node.length}`;
  return `${children}${name}${branch}`;
}

function quoteLabel(label: string): string {
  return /[\s(),:;']/.test(label) ? `'${label.replace(/'/g, "''")}'` : label;
}

export function countLeaves(node: TreeNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((total, child) => total + countLeaves(child), 0);
}
