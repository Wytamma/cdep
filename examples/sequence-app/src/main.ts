import { createBridge } from "@cdep/browser";
import { FASTA_V1, NEWICK_V1, normalizeFormatKey, registryCapability } from "@cdep/formats";
import { CdepException } from "@cdep/protocol";

const DEMO_FASTA = [
  ">sample_1 Escherichia coli",
  "ATGCGTACGTAGCTAGCTAGGCTA",
  ">sample_2 Escherichia coli",
  "ATGCGTACGTAGCTAGCTAGGCTC",
  ">sample_3 Shigella flexneri",
  "ATGCGTACGTAGCTAGCTAGGCTT",
  ">sample_4 Salmonella enterica",
  "ATGCGTACGTAGCTAGCTAGGCTG",
].join("\n");

const DEMO_TREE = "((sample_1:0.12,sample_2:0.08):0.15,sample_3:0.21,sample_4:0.33);";

/**
 * Demo fixture for exercising size limits: `?fixture=oversize` makes the
 * Newick export exceed the SDK's 10 MB default ceiling.
 */
const OVERSIZE = new URLSearchParams(location.search).get("fixture") === "oversize";

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

const elements = {
  session: must<HTMLParagraphElement>("#session"),
  dataset: must<HTMLPreElement>("#dataset"),
  records: must<HTMLSpanElement>("#records"),
  source: must<HTMLSpanElement>("#source"),
  status: must<HTMLParagraphElement>("#status"),
  target: must<HTMLInputElement>("#target"),
  format: must<HTMLSelectElement>("#format"),
  form: must<HTMLFormElement>("#send-form"),
  capabilities: must<HTMLParagraphElement>("#capabilities"),
  treeEditor: must<HTMLTextAreaElement>("#tree-editor"),
  treeStatus: must<HTMLSpanElement>("#tree-status"),
};

let fasta = DEMO_FASTA;

interface TreeInputReport {
  valid: boolean;
  message: string;
  leaves: number;
}

function invalid(message: string): TreeInputReport {
  return { valid: false, message, leaves: 0 };
}

/**
 * Structural check only. The receiving application parses Newick for real; the
 * sender must not pretend to understand the format, but an obvious typo should
 * not cost a round trip.
 */
function inspectTreeInput(text: string): TreeInputReport {
  const draft = text.trim();
  if (draft.length === 0) return invalid("Enter a Newick tree.");
  if (!draft.endsWith(";")) return invalid("A Newick tree must end with ';'.");

  let depth = 0;
  let leaves = 0;
  let expectLeaf = true;
  let quoted = false;

  for (let index = 0; index < draft.length; index += 1) {
    const char = draft.charAt(index);

    if (quoted) {
      if (char === "'") {
        if (draft.charAt(index + 1) === "'") {
          index += 1;
          continue;
        }
        quoted = false;
      }
      continue;
    }

    if (char === "'") {
      if (expectLeaf) {
        leaves += 1;
        expectLeaf = false;
      }
      quoted = true;
      continue;
    }
    if (/\s/.test(char)) continue;

    switch (char) {
      case "(":
        if (!expectLeaf) return invalid("Unexpected '(' after a label.");
        depth += 1;
        expectLeaf = true;
        break;
      case ")":
        if (expectLeaf) return invalid("Empty branch before ')'.");
        depth -= 1;
        if (depth < 0) return invalid("Unbalanced ')'.");
        expectLeaf = false;
        break;
      case ",":
        if (expectLeaf) return invalid("Empty branch before ','.");
        if (depth === 0) return invalid("Comma outside parentheses.");
        expectLeaf = true;
        break;
      case ";":
        if (depth !== 0) return invalid("Missing ')' before ';'.");
        if (index !== draft.length - 1) return invalid("Content after the terminating ';'.");
        break;
      case ":":
        if (expectLeaf) return invalid("Branch length without a branch.");
        break;
      default:
        if (expectLeaf) {
          leaves += 1;
          expectLeaf = false;
        }
    }
  }

  if (quoted) return invalid("Unterminated quoted label.");
  if (depth !== 0) return invalid("Missing ')'.");
  if (leaves === 0) return invalid("The tree has no labeled branches.");
  return { valid: true, message: `${leaves} leaves`, leaves };
}

function renderTreeStatus(): void {
  const report = inspectTreeInput(elements.treeEditor.value);
  elements.treeStatus.textContent = report.valid
    ? `Structurally valid · ${report.message}`
    : report.message;
  elements.treeStatus.dataset.valid = String(report.valid);
  elements.treeEditor.setAttribute("aria-invalid", String(!report.valid));
}


function readFasta(text: string): { name: string; length: number }[] {
  const records: { name: string; length: number }[] = [];
  let current: { name: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(">")) {
      if (current) records.push(current);
      current = { name: line.slice(1).trim() || "unnamed", length: 0 };
      continue;
    }
    if (current) current.length += line.replace(/\s+/g, "").length;
  }
  if (current) records.push(current);
  return records;
}

function showDataset(): void {
  const records = readFasta(fasta);
  elements.dataset.textContent = fasta;
  elements.records.textContent = `${records.length} records`;
  elements.records.dataset.count = String(records.length);
}

showDataset();

function setStatus(message: string, kind: "info" | "error" = "info"): void {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function describeError(error: unknown): string {
  if (error instanceof CdepException) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function newickPayload(): string {
  if (OVERSIZE) return `(${"A:0.1,".repeat(2_000_000)}B:0.1);`;
  return elements.treeEditor.value.trim();
}

const bridge = createBridge({
  application: { name: "Sequence App", url: `${location.origin}${location.pathname}` },
  normalizeFormatKey,
  imports: {
    [FASTA_V1]: (dataset, context) => {
      if (typeof dataset.data !== "string") throw new Error("FASTA payload must be text");
      fasta = dataset.data;
      showDataset();
      elements.source.textContent = `Imported "${dataset.name}" from ${context.senderOrigin}`;
      elements.session.dataset.state = "IMPORTED";
      elements.session.textContent = `Imported ${dataset.sizeBytes} bytes from ${context.senderApplication}.`;
    },
  },
  exports: {
    [NEWICK_V1]: () => ({ data: newickPayload(), name: "tree.newick", mediaType: "text/plain" }),
    [FASTA_V1]: () => ({ data: fasta, name: "sequences.fasta", mediaType: "text/plain" }),
  },
  importCapabilities: { [FASTA_V1]: registryCapability(FASTA_V1) },
  exportCapabilities: {
    [NEWICK_V1]: registryCapability(NEWICK_V1),
    [FASTA_V1]: registryCapability(FASTA_V1),
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

elements.treeEditor.value = DEMO_TREE;
elements.treeEditor.addEventListener("input", renderTreeStatus);
renderTreeStatus();

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (elements.format.value === "newick") {
    const report = inspectTreeInput(elements.treeEditor.value);
    if (!report.valid) {
      setStatus(`Fix the Newick draft — ${report.message}`, "error");
      return;
    }
  }
  setStatus("Opening the receiving application…");
  bridge
    .sendTo(elements.target.value, { format: elements.format.value })
    .then((receipt) => {
      setStatus(
        `Imported ${receipt.sizeBytes} bytes as ${receipt.formatId} (transfer ${receipt.transferId.slice(0, 8)}…).`,
      );
    })
    .catch((error: unknown) => {
      setStatus(`Transfer failed — ${describeError(error)}`, "error");
    });
});
