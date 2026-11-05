/**
 * CDEP v0.3 wire types.
 *
 * This module is transport-agnostic: every shape here is what a CDEP
 * implementation sends over its channel. Penpal is an implementation detail;
 * the specification (specification/protocol.md) documents these shapes.
 */
import type { CdepError, Result } from "./errors.js";
import type { JsonValue } from "./json.js";

export const PROTOCOL = "cdep" as const;
export const PROTOCOL_VERSION = 3 as const;

/** Hard protocol ceiling on files in one bundle; capabilities may be stricter. */
export const MAX_BUNDLE_FILES = 16;

/** Conservative default ceiling for the total payload of one transfer. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_OFFER_TTL_MS = 5 * 60_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

export interface SchemaRef {
  id: string;
  version: number;
}

/** A single data representation an application can read or write. */
export interface FormatCapability {
  /** Namespaced, versioned identifier, e.g. `org.cdep.format.newick.v1`. */
  id: string;
  /** Human-readable name for consent UI. Display only; never negotiated on. */
  label?: string;
  mediaTypes?: string[];
  extensions?: string[];
  /** Maximum cumulative size of this format's files in one bundle, in bytes. */
  maxBytes?: number;
  /** Maximum number of files of this format in one bundle. */
  maxFiles?: number;
  /** Maximum size of any single file of this format, in bytes. */
  maxFileBytes?: number;
  /** Present when a generic container is not enough (e.g. CSV with columns). */
  schema?: SchemaRef;
}

export interface ApplicationInfo {
  name: string;
  /** Canonical app URL. Informational only; never used for origin checks. */
  url?: string;
}

export interface Capabilities {
  protocol: typeof PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  application: ApplicationInfo;
  imports: FormatCapability[];
  exports: FormatCapability[];
}

export interface DatasetFileDescriptor {
  name: string;
  /** Every file carries its own format: a bundle may mix formats. */
  formatId: string;
  sizeBytes: number;
  mediaType?: string;
  schema?: SchemaRef;
  /** Free-form, format-specific metadata. No schema; JSON only. */
  metadata?: JsonValue;
}

export interface DatasetDescriptor {
  /** Human-readable bundle name, e.g. "tree + metadata". */
  name: string;
  /** Total size of all files. */
  sizeBytes: number;
  files: DatasetFileDescriptor[];
}

export interface SenderIdentity {
  /** Origin verified by the transport, not a caller-supplied string. */
  origin: string;
  application: string;
}

export interface Offer {
  offerId: string;
  transferId: string;
  dataset: DatasetDescriptor;
  sender: SenderIdentity;
  issuedAt: number;
  expiresAt: number;
}

export interface OfferAck {
  offerId: string;
  transferId: string;
  state: "OFFERED";
  expiresAt: number;
}

export interface AcceptRequest {
  offerId: string;
}

export interface AcceptAck {
  transferId: string;
  acceptedAt: number;
}

export interface TransferFile {
  name: string;
  formatId: string;
  sizeBytes: number;
  /** Must match the metadata accepted in the offer, if any. */
  metadata?: JsonValue;
  /** Text formats transfer as strings; binary formats as `ArrayBuffer`. */
  data: string | ArrayBuffer;
}

export interface TransferRequest {
  transferId: string;
  /** Total declared size of all files. */
  sizeBytes: number;
  files: TransferFile[];
}

export interface Receipt {
  transferId: string;
  state: "IMPORTED";
  importedAt: number;
  sizeBytes: number;
  fileCount: number;
  /** Distinct format identifiers that were imported. */
  formats: string[];
}

export interface TransferStatus {
  transferId: string;
  state: TransferState;
  updatedAt: number;
  error?: CdepError;
  receipt?: Receipt;
}

export type TransferState =
  | "CONNECTED"
  | "CAPABILITIES_DISCOVERED"
  | "OFFERED"
  | "ACCEPTED"
  | "TRANSFERRING"
  | "IMPORTED"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export type TransferEvent =
  | "DISCOVER"
  | "OFFER"
  | "ACCEPT"
  | "REJECT"
  | "TRANSFER_START"
  | "TRANSFER_COMPLETE"
  | "FAIL"
  | "CANCEL"
  | "TIMEOUT";

export interface CancelRequest {
  transferId: string;
  reason?: string;
}

export interface CancelAck {
  transferId: string;
  cancelled: boolean;
}

/**
 * Methods the receiving application exposes to the sender.
 * Implemented by `@cdep/browser`'s receiver; documented for alternate stacks.
 */
export interface ReceiverService {
  getCapabilities(): Promise<Result<Capabilities>>;
  offer(offer: Offer): Promise<Result<OfferAck>>;
  transfer(request: TransferRequest): Promise<Result<Receipt>>;
  getStatus(request: { transferId: string }): Promise<Result<TransferStatus>>;
  cancel(request: CancelRequest): Promise<Result<CancelAck>>;
}

/**
 * Methods the sending application exposes to the receiver. `accept` is how the
 * receiver reports that a human approved the offer.
 */
export interface SenderService {
  accept(request: AcceptRequest): Promise<Result<AcceptAck>>;
  cancel(request: CancelRequest): Promise<Result<CancelAck>>;
}

export interface ImportedFile {
  name: string;
  formatId: string;
  sizeBytes: number;
  mediaType?: string;
  schema?: SchemaRef;
  /** Free-form JSON supplied by the sender and verified against the offer. */
  metadata?: JsonValue;
  data: string | ArrayBuffer;
}

/** Dataset handed to an import adapter after validation. */
export interface ImportedBundle {
  name: string;
  sizeBytes: number;
  files: ImportedFile[];
}

export interface ImportContext {
  transferId: string;
  senderOrigin: string;
  senderApplication: string;
  bundle: {
    name: string;
    sizeBytes: number;
    /** Manifest of every file in the bundle, including formats. */
    files: Array<{ name: string; formatId: string }>;
  };
}

export interface ExportFile {
  name: string;
  /** Required for bundle exports; inferred from the adapter format otherwise. */
  formatId?: string;
  mediaType?: string;
  schema?: SchemaRef;
  /** Free-form JSON; validated and bounded before it reaches the wire. */
  metadata?: JsonValue;
  data: string | ArrayBuffer | Uint8Array;
}

export interface ExportValue {
  /** Bundle name. Defaults to a name derived from the selection. */
  name?: string;
  files: ExportFile[];
}
