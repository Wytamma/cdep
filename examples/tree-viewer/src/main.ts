import { createBridge } from "@cdep/browser";
import { CSV_V1, NEWICK_V1, normalizeFormatKey, registryCapability } from "@cdep/formats";
import { CdepException, type ImportedFile, type JsonValue } from "@cdep/protocol";
import { countLeaves, parseNewick, type TreeNode } from "./newick.js";
import { renderTree } from "./render.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 8;

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

const elements = {
  session: must<HTMLParagraphElement>("#session"),
  svg: must<SVGSVGElement>("#tree"),
  leaves: must<HTMLSpanElement>("#leaves"),
  files: must<HTMLSpanElement>("#files"),
  source: must<HTMLSpanElement>("#source"),
  bundle: must<HTMLUListElement>("#bundle"),
  metadataSection: must<HTMLElement>("#metadata-section"),
  metadata: must<HTMLTableElement>("#metadata"),
  metadataSource: must<HTMLSpanElement>("#metadata-source"),
  status: must<HTMLParagraphElement>("#status"),
  target: must<HTMLInputElement>("#target"),
  format: must<HTMLSelectElement>("#format"),
  form: must<HTMLFormElement>("#send-form"),
  capabilities: must<HTMLParagraphElement>("#capabilities"),
  file: must<HTMLInputElement>("#tree-file"),
  send: must<HTMLButtonElement>("#send"),
};

interface LoadedTree {
  name: string;
  text: string;
  tree: TreeNode;
  metadata?: JsonValue;
}

let loaded: LoadedTree[] = [];
let metadataText: string | undefined;
let metadataJson: JsonValue | undefined;

function resetMetadata(): void {
  metadataText = undefined;
  metadataJson = undefined;
  elements.metadata.replaceChildren();
  elements.metadataSection.hidden = true;
  elements.metadataSource.textContent = "";
}

function clearBundle(): void {
  loaded = [];
  elements.svg.replaceChildren();
  elements.bundle.replaceChildren();
  elements.leaves.textContent = "No tree";
  elements.leaves.removeAttribute("data-count");
  elements.files.textContent = "No files";
  elements.files.removeAttribute("data-count");
  elements.source.textContent = "Nothing loaded yet";
  elements.send.disabled = true;
  resetMetadata();
}

function applyBundle(
  entries: { name: string; text: string; metadata?: JsonValue }[],
  source: string,
): void {
  const names = new Set<string>();
  const parsed = entries.map((entry) => {
    if (
      entry.name.length === 0 ||
      entry.name.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(entry.name)
    ) {
      throw new Error(`Invalid file name "${entry.name}"`);
    }
    if (names.has(entry.name)) throw new Error(`Duplicate file name "${entry.name}"`);
    names.add(entry.name);
    return { ...entry, tree: parseNewick(entry.text) };
  });

  const [first] = parsed;
  if (!first) {
    clearBundle();
    return;
  }

  loaded = parsed;
  resetMetadata();
  const layout = renderTree(elements.svg, first.tree);
  elements.leaves.textContent = `${layout.leaves} leaves`;
  elements.leaves.dataset.count = String(layout.leaves);
  elements.files.textContent = parsed.length === 1 ? "1 file" : `${parsed.length} files`;
  elements.files.dataset.count = String(parsed.length);
  elements.source.textContent = source;
  elements.bundle.replaceChildren(
    ...parsed.map((entry) => {
      const item = document.createElement("li");
      const metadata =
        entry.metadata === undefined ? "" : ` · ${compactJson(entry.metadata)}`;
      item.textContent = `${entry.name} — ${countLeaves(entry.tree)} leaves${metadata}`;
      return item;
    }),
  );
  elements.send.disabled = false;
}

function compactJson(value: JsonValue): string {
  const text = JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(index + 1) === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (char === "\r") continue;
    cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

function renderMetadata(text: string, source: string): void {
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  if (!header || header.length === 0) {
    resetMetadata();
    return;
  }

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of header) {
    const th = document.createElement("th");
    th.textContent = cell.trim();
    headRow.append(th);
  }
  head.append(headRow);

  const tableBody = document.createElement("tbody");
  for (const row of body) {
    const tr = document.createElement("tr");
    for (let index = 0; index < header.length; index += 1) {
      const td = document.createElement("td");
      td.textContent = row[index] ?? "";
      tr.append(td);
    }
    tableBody.append(tr);
  }

  elements.metadata.replaceChildren(head, tableBody);
  elements.metadataSource.textContent = source;
  elements.metadataSection.hidden = false;
  metadataText = text;
}

function textFiles(files: ImportedFile[], label: string): string[] {
  return files.map((file) => {
    if (typeof file.data !== "string") throw new Error(`${label} payload must be text`);
    return file.data;
  });
}

clearBundle();

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
    [NEWICK_V1]: (files, context) => {
      const entries = files.map((file) => {
        if (typeof file.data !== "string") throw new Error("Newick payload must be text");
        return {
          name: file.name,
          text: file.data,
          ...(file.metadata === undefined ? {} : { metadata: file.metadata }),
        };
      });
      applyBundle(entries, `Imported ${files.length} file(s) from ${context.senderOrigin}`);
      elements.session.dataset.state = "IMPORTED";
      elements.session.textContent = `Imported ${files.length} file(s), ${context.bundle.sizeBytes} bytes from ${context.senderApplication}.`;
    },
    [CSV_V1]: (files) => {
      renderMetadata(textFiles(files, "CSV").join("\n"), `Loaded ${files.length} CSV file(s)`);
      metadataJson = files[0]?.metadata;
      elements.session.dataset.state = "IMPORTED";
      elements.session.textContent = `Imported ${files.length} CSV file(s).`;
    },
  },
  importBundle: (bundle, context) => {
    const treeFiles = bundle.files.filter((file) => file.formatId === NEWICK_V1);
    const csvFiles = bundle.files.filter((file) => file.formatId === CSV_V1);
    if (treeFiles.length === 0) {
      throw new Error("The bundle contains no Newick tree");
    }

    const entries = treeFiles.map((file) => {
      if (typeof file.data !== "string") throw new Error("Newick payload must be text");
      return {
        name: file.name,
        text: file.data,
        ...(file.metadata === undefined ? {} : { metadata: file.metadata }),
      };
    });
    applyBundle(entries, `Imported ${bundle.files.length} file(s) from ${context.senderOrigin}`);

    if (csvFiles.length > 0) {
      renderMetadata(
        textFiles(csvFiles, "CSV").join("\n"),
        `Imported ${csvFiles.length} CSV file(s)`,
      );
      metadataJson = csvFiles[0]?.metadata;
    }

    elements.session.dataset.state = "IMPORTED";
    elements.session.textContent = `Imported ${bundle.files.length} file(s) (${bundle.files
      .map((file) => file.formatId)
      .join(", ")}) from ${context.senderApplication}.`;
  },
  exports: {
    [NEWICK_V1]: () => {
      if (loaded.length === 0) throw new Error("No tree is loaded");
      return {
        name: "trees.newick",
        files: loaded.map((entry) => ({
          name: entry.name,
          data: entry.text,
          ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
        })),
      };
    },
    [CSV_V1]: () => {
      if (metadataText === undefined) throw new Error("No metadata is loaded");
      return {
        name: "metadata.csv",
        files: [
          {
            name: "metadata.csv",
            data: metadataText,
            ...(metadataJson === undefined ? {} : { metadata: metadataJson }),
          },
        ],
      };
    },
  },
  bundles: {
    "tree-metadata": () => {
      if (loaded.length === 0) throw new Error("No tree is loaded");
      if (metadataText === undefined) throw new Error("No metadata is loaded");
      return {
        name: "tree + metadata",
        files: [
          ...loaded.map((entry) => ({
            name: entry.name,
            formatId: NEWICK_V1,
            data: entry.text,
            ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
          })),
          {
            name: "metadata.csv",
            formatId: CSV_V1,
            data: metadataText,
            ...(metadataJson === undefined ? {} : { metadata: metadataJson }),
          },
        ],
      };
    },
  },
  importCapabilities: {
    [NEWICK_V1]: registryCapability(NEWICK_V1, {
      maxBytes: MAX_FILES * MAX_FILE_BYTES,
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
    }),
    [CSV_V1]: registryCapability(CSV_V1, { maxBytes: MAX_FILE_BYTES }),
  },
  exportCapabilities: {
    [NEWICK_V1]: registryCapability(NEWICK_V1, { maxFiles: MAX_FILES }),
    [CSV_V1]: registryCapability(CSV_V1, { maxBytes: MAX_FILE_BYTES }),
  },
  onState: (snapshot) => {
    elements.session.dataset.state = snapshot.state;
    elements.session.textContent =
      snapshot.state === "IMPORTED"
        ? `Imported "${snapshot.datasetName}".`
        : `Incoming "${snapshot.datasetName}" (${snapshot.fileCount} file(s), ${snapshot.formats.join(", ")}): ${snapshot.state}`;
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
  const selected = Array.from(elements.file.files ?? []);
  elements.file.value = "";
  if (selected.length === 0) return;

  if (selected.length > MAX_FILES) {
    setStatus(`Select at most ${MAX_FILES} files.`, "error");
    return;
  }
  const oversized = selected.find((file) => file.size > MAX_FILE_BYTES);
  if (oversized) {
    setStatus(`"${oversized.name}" is larger than the 2 MB per-file limit.`, "error");
    return;
  }

  try {
    const entries = await Promise.all(
      selected.map(async (file) => ({ name: file.name, text: await file.text() })),
    );
    applyBundle(
      entries,
      selected.length === 1 ? `Loaded "${selected[0]!.name}"` : `Loaded ${selected.length} files`,
    );
    setStatus(selected.length === 1 ? `Loaded "${selected[0]!.name}".` : `Loaded ${selected.length} files.`);
  } catch (error) {
    setStatus(
      `Could not load the selection — ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (loaded.length === 0) {
    setStatus("Load or receive a tree before sending.", "error");
    return;
  }
  const choice = elements.format.value;
  if (choice === "bundle:tree-metadata" && metadataText === undefined) {
    setStatus("Receive or load CSV metadata before sending the bundle.", "error");
    return;
  }
  const sendOptions =
    choice === "bundle:tree-metadata" ? { bundle: "tree-metadata" } : { format: "newick" };
  setStatus("Opening the receiving application…");
  bridge
    .sendTo(elements.target.value, sendOptions)
    .then((receipt) => {
      setStatus(
        `Imported ${receipt.fileCount} file(s) (${receipt.sizeBytes} bytes; ${receipt.formats.join(", ")}) (transfer ${receipt.transferId.slice(0, 8)}…).`,
      );
    })
    .catch((error: unknown) => {
      setStatus(`Transfer failed — ${describeError(error)}`, "error");
    });
});
