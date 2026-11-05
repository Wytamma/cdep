import { CdepException, fail, ok, type Result } from "./errors.js";
import {
  MAX_BUNDLE_FILES,
  PROTOCOL,
  PROTOCOL_VERSION,
  type ApplicationInfo,
  type Capabilities,
  type FormatCapability,
  type SchemaRef,
} from "./types.js";
import {
  IssueCollector,
  isAbsoluteHttpUrl,
  isExtension,
  isFormatId,
  isMediaType,
  isNonEmptyString,
  isPlainObject,
  isPositiveSafeInteger,
} from "./validate.js";

/** Bounds processing so a hostile peer cannot exhaust the receiver. */
const MAX_CAPABILITIES_PER_DIRECTION = 512;
const MAX_MEDIA_TYPES = 16;
const MAX_EXTENSIONS = 16;

function readSchema(value: unknown, path: string, issues: IssueCollector): SchemaRef | undefined {
  if (!isPlainObject(value)) {
    issues.add(path, "expected an object");
    return undefined;
  }
  const before = issues.issues.length;
  if (!isFormatId(value.id)) {
    issues.add(`${path}.id`, "expected a namespaced lowercase schema identifier");
  }
  if (!isPositiveSafeInteger(value.version)) {
    issues.add(`${path}.version`, "expected a positive integer");
  }
  return issues.issues.length === before
    ? { id: value.id as string, version: value.version as number }
    : undefined;
}

function readFormatCapability(
  value: unknown,
  path: string,
  issues: IssueCollector,
): FormatCapability | undefined {
  if (!isPlainObject(value)) {
    issues.add(path, "expected an object");
    return undefined;
  }

  const before = issues.issues.length;
  const capability: FormatCapability = { id: "" };

  if (isFormatId(value.id)) {
    capability.id = value.id;
  } else {
    issues.add(`${path}.id`, "expected a namespaced lowercase identifier, e.g. org.cdep.format.newick.v1");
  }

  if (value.label !== undefined) {
    if (isNonEmptyString(value.label, 200)) capability.label = value.label;
    else issues.add(`${path}.label`, "expected a non-empty string up to 200 characters");
  }

  if (value.mediaTypes !== undefined) {
    const mediaTypes = value.mediaTypes;
    if (!Array.isArray(mediaTypes) || mediaTypes.length > MAX_MEDIA_TYPES) {
      issues.add(`${path}.mediaTypes`, `expected an array of at most ${MAX_MEDIA_TYPES} media types`);
    } else if (!mediaTypes.every(isMediaType)) {
      issues.add(`${path}.mediaTypes`, "expected media types such as text/plain");
    } else {
      capability.mediaTypes = [...mediaTypes];
    }
  }

  if (value.extensions !== undefined) {
    const extensions = value.extensions;
    if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS) {
      issues.add(`${path}.extensions`, `expected an array of at most ${MAX_EXTENSIONS} extensions`);
    } else if (!extensions.every(isExtension)) {
      issues.add(`${path}.extensions`, "expected extensions such as .nwk");
    } else {
      capability.extensions = [...extensions];
    }
  }

  if (value.maxBytes !== undefined) {
    if (isPositiveSafeInteger(value.maxBytes)) capability.maxBytes = value.maxBytes;
    else issues.add(`${path}.maxBytes`, "expected a positive integer number of bytes");
  }

  if (value.maxFiles !== undefined) {
    if (isPositiveSafeInteger(value.maxFiles) && value.maxFiles <= MAX_BUNDLE_FILES) {
      capability.maxFiles = value.maxFiles;
    } else {
      issues.add(`${path}.maxFiles`, `expected an integer between 1 and ${MAX_BUNDLE_FILES}`);
    }
  }

  if (value.maxFileBytes !== undefined) {
    if (isPositiveSafeInteger(value.maxFileBytes)) capability.maxFileBytes = value.maxFileBytes;
    else issues.add(`${path}.maxFileBytes`, "expected a positive integer number of bytes");
  }

  if (value.schema !== undefined) {
    const schema = readSchema(value.schema, `${path}.schema`, issues);
    if (schema) capability.schema = schema;
  }

  return issues.issues.length === before ? capability : undefined;
}

function readCapabilityList(
  value: unknown,
  path: string,
  issues: IssueCollector,
): FormatCapability[] {
  if (!Array.isArray(value)) {
    issues.add(path, "expected an array");
    return [];
  }
  if (value.length > MAX_CAPABILITIES_PER_DIRECTION) {
    issues.add(path, `expected at most ${MAX_CAPABILITIES_PER_DIRECTION} entries`);
    return [];
  }

  const seen = new Set<string>();
  const capabilities: FormatCapability[] = [];
  value.forEach((entry, index) => {
    const capability = readFormatCapability(entry, `${path}[${index}]`, issues);
    if (!capability) return;
    if (seen.has(capability.id)) {
      issues.add(`${path}[${index}].id`, `duplicate capability for ${capability.id}`);
      return;
    }
    seen.add(capability.id);
    capabilities.push(capability);
  });
  return capabilities;
}

function readApplication(value: unknown, issues: IssueCollector): ApplicationInfo | undefined {
  if (!isPlainObject(value)) {
    issues.add("application", "expected an object");
    return undefined;
  }
  const application: ApplicationInfo = { name: "" };
  if (isNonEmptyString(value.name, 200)) application.name = value.name;
  else issues.add("application.name", "expected a non-empty string up to 200 characters");

  if (value.url !== undefined) {
    if (isAbsoluteHttpUrl(value.url)) application.url = value.url;
    else issues.add("application.url", "expected an absolute http(s) URL");
  }
  return application;
}

/**
 * Validates a `getCapabilities()` response from an untrusted peer.
 * Protocol and version mismatches get their own codes so the SDK can report a
 * precise failure instead of a generic validation error.
 */
export function validateCapabilities(input: unknown): Result<Capabilities> {
  if (!isPlainObject(input)) {
    return fail("CAPABILITIES_INVALID", "Capabilities must be an object", {
      issues: [{ path: "", message: "expected an object" }],
    });
  }

  if (input.protocol !== PROTOCOL) {
    return fail("PROTOCOL_MISMATCH", `Expected protocol "${PROTOCOL}"`, {
      received: typeof input.protocol === "string" ? input.protocol : typeof input.protocol,
    });
  }

  if (input.version !== PROTOCOL_VERSION) {
    return fail("VERSION_UNSUPPORTED", `Unsupported protocol version`, {
      received: input.version,
      supported: PROTOCOL_VERSION,
    });
  }

  const issues = new IssueCollector();
  const application = readApplication(input.application, issues);
  const imports = readCapabilityList(input.imports, "imports", issues);
  const exports = readCapabilityList(input.exports, "exports", issues);

  if (!issues.valid || !application) {
    return fail("CAPABILITIES_INVALID", "Malformed capabilities payload", {
      issues: issues.issues,
    });
  }

  return ok({
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    application,
    imports,
    exports,
  });
}

export function findImportCapability(
  capabilities: Capabilities,
  formatId: string,
): FormatCapability | undefined {
  return capabilities.imports.find((capability) => capability.id === formatId);
}

/** Rejects unknown/invalid capabilities locally, at bridge construction time. */
export function assertLocalCapabilities(capabilities: unknown): Capabilities {
  const result = validateCapabilities(capabilities);
  if (!result.ok) {
    throw new CdepException(result.error);
  }
  return result.value;
}
