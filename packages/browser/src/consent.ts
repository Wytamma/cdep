export interface ConsentRequest {
  /** Receiving application's own name, so the dialog is unambiguous. */
  receiverApplication: string;
  senderApplication: string;
  /** Origin verified by the transport, never a claimed value. */
  senderOrigin: string;
  datasetName: string;
  formatLabel: string;
  formatId: string;
  sizeBytes: number;
}

export interface ConsentOptions {
  /** Replaces the built-in dialog. Returning anything but `true` declines. */
  onTransferRequest?: (request: ConsentRequest) => boolean | Promise<boolean>;
  /** Auto-declines after this long; defaults to the offer's remaining lifetime. */
  timeoutMs?: number;
  document?: Document;
}

const STYLE = `
  .dialog {
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #0f172a;
    background: #fff;
    border: 0;
    border-radius: 12px;
    padding: 0;
    width: min(92vw, 440px);
    box-shadow: 0 24px 64px rgba(15, 23, 42, 0.35);
  }
  .body { padding: 20px 24px 16px; }
  h2 { margin: 0 0 4px; font-size: 17px; }
  .sub { margin: 0 0 16px; color: #475569; }
  dl { margin: 0 0 16px; display: grid; grid-template-columns: 92px 1fr; gap: 8px 12px; }
  dt { color: #64748b; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .warning {
    margin: 0 0 18px; padding: 10px 12px; border-radius: 8px;
    background: #fef3c7; color: #78350f;
  }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  button {
    font: inherit; padding: 8px 16px; border-radius: 8px; cursor: pointer;
    border: 1px solid #cbd5e1; background: #fff; color: #0f172a;
  }
  button.accept { background: #0f172a; border-color: #0f172a; color: #fff; }
  button:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The receiving application must show what is about to arrive, and from where,
 * before any byte reaches an import adapter.
 */
export async function requestConsent(
  request: ConsentRequest,
  options: ConsentOptions = {},
): Promise<boolean> {
  if (options.onTransferRequest) {
    try {
      return (await options.onTransferRequest(request)) === true;
    } catch {
      return false;
    }
  }
  const doc = options.document ?? globalThis.document;
  if (!doc) return false;
  return showConsentDialog(doc, request, options.timeoutMs ?? 0);
}

function showConsentDialog(
  doc: Document,
  request: ConsentRequest,
  timeoutMs: number,
): Promise<boolean> {
  const host = doc.createElement("div");
  host.setAttribute("data-cdep-consent", "");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(15,23,42,.55);";

  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = STYLE;

  const dialog = doc.createElement("dialog");
  dialog.className = "dialog";
  dialog.setAttribute("aria-labelledby", "cdep-consent-title");

  const body = doc.createElement("div");
  body.className = "body";

  const title = doc.createElement("h2");
  title.id = "cdep-consent-title";
  title.textContent = "Incoming dataset";

  const subtitle = doc.createElement("p");
  subtitle.className = "sub";
  subtitle.textContent = `${request.receiverApplication} was asked to receive data.`;

  const details = doc.createElement("dl");
  const addRow = (label: string, value: string): void => {
    const term = doc.createElement("dt");
    term.textContent = label;
    const description = doc.createElement("dd");
    description.textContent = value;
    details.append(term, description);
  };
  addRow("From", request.senderApplication);
  addRow("Origin", request.senderOrigin);
  addRow("Dataset", request.datasetName);
  addRow("Format", `${request.formatLabel} (${request.formatId})`);
  addRow("Size", formatBytes(request.sizeBytes));

  const warning = doc.createElement("p");
  warning.className = "warning";
  warning.textContent =
    "Only accept data from applications you trust. A successful connection does not make the sender trustworthy.";

  const actions = doc.createElement("div");
  actions.className = "actions";
  const decline = doc.createElement("button");
  decline.type = "button";
  decline.className = "decline";
  decline.textContent = "Decline";
  const accept = doc.createElement("button");
  accept.type = "button";
  accept.className = "accept";
  accept.textContent = "Accept";
  actions.append(decline, accept);
  body.append(title, subtitle, details, warning, actions);
  dialog.append(body);
  shadow.append(style, dialog);

  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (approved: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    dialog.close();
    host.remove();
    resolve(approved);
  };

  decline.addEventListener("click", () => finish(false));
  accept.addEventListener("click", () => finish(true));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(false);
  });
  dialog.addEventListener("close", () => finish(false));

  doc.body.append(host);
  dialog.showModal();
  decline.focus();

  if (timeoutMs > 0) {
    timer = setTimeout(() => finish(false), timeoutMs);
  }

  return promise;
}
