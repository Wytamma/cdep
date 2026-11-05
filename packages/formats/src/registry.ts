import type { FormatCapability } from "@cdep/protocol";
import {
  AUSPICE_V2,
  CSV_V1,
  FASTA_V1,
  NEXUS_V1,
  NEWICK_V1,
} from "./identifiers.js";

export interface FormatDefinition {
  id: string;
  label: string;
  description: string;
  mediaTypes: string[];
  extensions: string[];
  /** True when the canonical representation is bytes, not text. */
  binary: boolean;
}

export const FORMAT_REGISTRY: readonly FormatDefinition[] = [
  {
    id: NEWICK_V1,
    label: "Newick",
    description: "Phylogenetic trees in Newick notation",
    mediaTypes: ["text/plain"],
    extensions: [".nwk", ".newick", ".tree"],
    binary: false,
  },
  {
    id: FASTA_V1,
    label: "FASTA",
    description: "Nucleotide or protein sequences in FASTA notation",
    mediaTypes: ["text/plain", "text/x-fasta"],
    extensions: [".fasta", ".fa", ".fna", ".faa"],
    binary: false,
  },
  {
    id: CSV_V1,
    label: "CSV",
    description: "Generic comma-separated table; columns are not specified",
    mediaTypes: ["text/csv"],
    extensions: [".csv"],
    binary: false,
  },
  {
    id: NEXUS_V1,
    label: "Nexus",
    description: "Phylogenetic data in NEXUS notation",
    mediaTypes: ["text/plain", "text/x-nexus"],
    extensions: [".nex", ".nexus", ".nxs"],
    binary: false,
  },
  {
    id: AUSPICE_V2,
    label: "Auspice JSON v2",
    description: "Structured phylogenetic visualisation dataset, Auspice schema v2",
    mediaTypes: ["application/json"],
    extensions: [".json"],
    binary: false,
  },
];

export const REGISTRY_BY_ID: ReadonlyMap<string, FormatDefinition> = new Map(
  FORMAT_REGISTRY.map((definition) => [definition.id, definition]),
);

/** Short alias used in developer-facing code, e.g. `newick` for `org.cdep.format.newick.v1`. */
export const REGISTRY_BY_ALIAS: ReadonlyMap<string, FormatDefinition> = new Map(
  FORMAT_REGISTRY.map((definition) => {
    const segments = definition.id.split(".");
    return [segments[segments.length - 2] ?? definition.id, definition];
  }),
);

export function formatDefinition(id: string): FormatDefinition | undefined {
  return REGISTRY_BY_ID.get(id);
}

/**
 * Accepts a registry alias (`newick`) or a full identifier. Unknown keys are
 * returned unchanged: negotiation, not string rewriting, decides compatibility.
 */
export function normalizeFormatKey(key: string): string {
  return REGISTRY_BY_ALIAS.get(key)?.id ?? key;
}

/** Capability pre-filled from the registry; overrides win (e.g. a size limit). */
export function registryCapability(
  id: string,
  overrides: Partial<FormatCapability> = {},
): FormatCapability {
  const definition = formatDefinition(id);
  if (!definition) {
    return { id, ...overrides };
  }
  return {
    id: definition.id,
    label: definition.label,
    mediaTypes: [...definition.mediaTypes],
    extensions: [...definition.extensions],
    ...overrides,
  };
}
