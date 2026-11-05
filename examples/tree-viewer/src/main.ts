import { createBridge } from "@cdep/browser";
import { NEWICK_V1, normalizeFormatKey, registryCapability } from "@cdep/formats";
import { CdepException } from "@cdep/protocol";
import { parseNewick, serializeNewick, type TreeNode } from "./newick.js";
import { renderTree } from "./render.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

const elements = {
  session: must<HTMLParagraphElement>("#session"),
  svg: must<SVGSVGElement>("#tree"),
  leaves: must<HTMLSpanElement>("#leaves"),
  source: must<HTMLSpanElement>("#source"),
  status: must<HTMLParagraphElement>("#status"),
  target: must<HTMLInputElement>("#target"),
  form: must<HTMLFormElement>("#send-form"),
  capabilities: must<HTMLParagraphElement>("#capabilities"),
  file: must<HTMLInputElement>("#tree-file"),
  send: must<HTMLButtonElement>("#send"),
};

let tree: TreeNode | null = null;

function clearTree(): void {
  tree = null;
  elements.svg.replaceChildren();
  elements.leaves.textContent = "No tree";
  elements.leaves.removeAttribute("data-count");
  elements.source.textContent = "Nothing loaded yet";
  elements.send.disabled = true;
}

function setTree(next: TreeNode, source: string): void {
  tree = next;
  const layout = renderTree(elements.svg, next);
  elements.leaves.textContent = `${layout.leaves} leaves`;
  elements.leaves.dataset.count = String(layout.leaves);
  elements.source.textContent = source;
  elements.send.disabled = false;
}

clearTree();

function setStatus(message: string, kind: "info" | "error" = "info"): void {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function describeError(error: unknown): string {
  if (error instanceof CdepException) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

const bridge = createBridge({
  application: { name: "Tree Viewer", url: `${location.origin}${location.pathname}` },
  normalizeFormatKey,
  imports: {
    [NEWICK_V1]: (dataset, context) => {
      if (typeof dataset.data !== "string") throw new Error("Newick payload must be text");
      const parsed = parseNewick(dataset.data);
      setTree(parsed, `Imported "${dataset.name}" from ${context.senderOrigin}`);
      elements.session.dataset.state = "IMPORTED";
      elements.session.textContent = `Imported ${dataset.sizeBytes} bytes from ${context.senderApplication}.`;
    },
  },
  exports: {
    [NEWICK_V1]: () => {
      if (!tree) throw new Error("No tree is loaded");
      return {
        data: serializeNewick(tree),
        name: "tree.newick",
        mediaType: "text/plain",
      };
    },
  },
  importCapabilities: {
    [NEWICK_V1]: registryCapability(NEWICK_V1, { maxBytes: 2 * 1024 * 1024 }),
  },
  exportCapabilities: {
    [NEWICK_V1]: registryCapability(NEWICK_V1),
  },
  onState: (snapshot) => {
    elements.session.dataset.state = snapshot.state;
    elements.session.textContent =
      snapshot.state === "IMPORTED"
        ? `Imported "${snapshot.datasetName}".`
        : `Incoming "${snapshot.datasetName}" (${snapshot.formatId}): ${snapshot.state}`;
  },
  onError: (error) => {
    elements.session.dataset.state = "FAILED";
    elements.session.textContent = `Receiver error — ${error.code}: ${error.message}`;
  },
});

if (bridge.receiver) {
  elements.session.textContent = "Waiting for the sender to propose a dataset…";
  elements.session.dataset.state = "CONNECTED";
}

elements.capabilities.textContent = [
  `Exports: ${bridge.capabilities.exports.map((capability) => capability.label ?? capability.id).join(", ") || "none"}`,
  `Imports: ${bridge.capabilities.imports.map((capability) => capability.label ?? capability.id).join(", ") || "none"}`,
].join(" · ");

elements.file.addEventListener("change", async () => {
  const file = elements.file.files?.[0];
  elements.file.value = "";
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    setStatus(`"${file.name}" is larger than the 2 MB import limit.`, "error");
    return;
  }
  try {
    const text = await file.text();
    setTree(parseNewick(text), `Loaded "${file.name}"`);
    setStatus(`Loaded "${file.name}".`);
  } catch (error) {
    setStatus(
      `Could not parse "${file.name}" — ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!tree) {
    setStatus("Load or receive a tree before sending.", "error");
    return;
  }
  setStatus("Opening the receiving application…");
  bridge
    .sendTo(elements.target.value, { format: "newick" })
    .then((receipt) => {
      setStatus(
        `Imported ${receipt.sizeBytes} bytes as ${receipt.formatId} (transfer ${receipt.transferId.slice(0, 8)}…).`,
      );
    })
    .catch((error: unknown) => {
      setStatus(`Transfer failed — ${describeError(error)}`, "error");
    });
});
