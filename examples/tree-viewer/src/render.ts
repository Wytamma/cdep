import type { TreeNode } from "./newick.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 680;
const PADDING = 18;
const RIGHT_PADDING = 110;
const LEAF_GAP = 26;

interface LayoutNode {
  node: TreeNode;
  depth: number;
  y: number;
  children: LayoutNode[];
}

export interface RenderResult {
  leaves: number;
  height: number;
}

/** Rectangular cladogram: leaves evenly spaced, internal nodes centred. */
export function renderTree(svg: SVGSVGElement, root: TreeNode): RenderResult {
  let cursor = PADDING;
  let maxDepth = 0;

  const build = (node: TreeNode, depth: number): LayoutNode => {
    maxDepth = Math.max(maxDepth, depth);
    const children = node.children.map((child) => build(child, depth + 1));
    let y: number;
    if (children.length === 0) {
      y = cursor;
      cursor += LEAF_GAP;
    } else {
      y = (children[0]!.y + children[children.length - 1]!.y) / 2;
    }
    return { node, depth, y, children };
  };

  const layout = build(root, 0);
  const height = cursor + PADDING;
  const plotWidth = WIDTH - PADDING - RIGHT_PADDING;

  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${WIDTH} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Phylogenetic tree with ${countLayoutLeaves(layout)} leaves`);

  const edges = appendGroup(svg, {
    stroke: "currentColor",
    "stroke-width": "1.5",
    fill: "none",
  });
  const labels = appendGroup(svg, {
    fill: "currentColor",
    "font-size": "12",
    "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
  });

  const xFor = (depth: number): number =>
    PADDING + (maxDepth === 0 ? 0 : (depth / maxDepth) * plotWidth);

  const draw = (item: LayoutNode): void => {
    const x = xFor(item.depth);
    if (item.children.length > 0) {
      const first = item.children[0]!;
      const last = item.children[item.children.length - 1]!;
      appendLine(edges, x, first.y, x, last.y);
      for (const child of item.children) {
        appendLine(edges, x, child.y, xFor(child.depth), child.y);
        draw(child);
      }
      if (item.node.name !== "") {
        const text = appendText(labels, x - 4, item.y - 4, item.node.name);
        text.setAttribute("text-anchor", "end");
        text.setAttribute("opacity", "0.55");
        text.setAttribute("font-size", "10");
      }
      return;
    }
    appendText(labels, x + 6, item.y + 4, item.node.name);
  };

  draw(layout);
  return { leaves: countLayoutLeaves(layout), height };
}

function appendGroup(parent: SVGSVGElement, attributes: Record<string, string>): SVGGElement {
  const group = document.createElementNS(SVG_NS, "g");
  for (const [name, value] of Object.entries(attributes)) group.setAttribute(name, value);
  parent.append(group);
  return group;
}

function appendLine(
  parent: SVGGElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SVGLineElement {
  const element = document.createElementNS(SVG_NS, "line");
  element.setAttribute("x1", String(x1));
  element.setAttribute("y1", String(y1));
  element.setAttribute("x2", String(x2));
  element.setAttribute("y2", String(y2));
  element.setAttribute("vector-effect", "non-scaling-stroke");
  parent.append(element);
  return element;
}

function appendText(
  parent: SVGGElement,
  x: number,
  y: number,
  content: string,
): SVGTextElement {
  const element = document.createElementNS(SVG_NS, "text");
  element.setAttribute("x", String(x));
  element.setAttribute("y", String(y));
  element.textContent = content;
  parent.append(element);
  return element;
}

function countLayoutLeaves(node: LayoutNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((total, child) => total + countLayoutLeaves(child), 0);
}
