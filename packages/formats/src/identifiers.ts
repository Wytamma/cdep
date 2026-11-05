/**
 * CDEP-proposed format identifiers.
 *
 * These are namespaced identifiers, not the official identifiers of the
 * underlying formats, and not file extensions. Version suffixes are part of
 * the identifier: a v2 representation is a different format to v1.
 */
export const NEWICK_V1 = "org.cdep.format.newick.v1";
export const FASTA_V1 = "org.cdep.format.fasta.v1";
export const CSV_V1 = "org.cdep.format.csv.v1";
export const NEXUS_V1 = "org.cdep.format.nexus.v1";
export const AUSPICE_V2 = "org.cdep.format.auspice.v2";

/**
 * Generic CSV is a container, not an agreement about columns. Applications
 * that understand a specific table shape should declare this schema as well.
 */
export const TIP_METADATA_SCHEMA_V1 = "org.cdep.schema.tip-metadata.v1";
