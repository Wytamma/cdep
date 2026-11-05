/**
 * CDEP v0.1 wire types.
 *
 * This module is transport-agnostic: every shape here is what a CDEP
 * implementation sends over its channel. Penpal is an implementation detail;
 * the specification (specification/protocol.md) documents these shapes.
 */
import type { CdepError, Result } from "./errors.js";

export const PROTOCOL = "cdep" as const;
export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_VERSION_HEADER = "cdep-version";

/** Conservative default ceiling for a single v0.1 payload. */
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
  /** Maximum payload size this side accepts or produces, in bytes. */
  maxBytes?: number;
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

export interface DatasetDescriptor {
  formatId: string;
  name: string;
  sizeBytes: number;
  mediaType?: string;
  schema?: SchemaRef;
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
  formatId: string;
}

export interface AcceptAck {
  transferId: string;
  acceptedAt: number;
}

export interface TransferRequest {
  transferId: string;
  formatId: string;
  sizeBytes: number;
  mediaType?: string;
  /** Text formats transfer as strings; binary formats as `ArrayBuffer`. */
  data: string | ArrayBuffer;
}

export interface Receipt {
  transferId: string;
  formatId: string;
  state: "IMPORTED";
  importedAt: number;
  sizeBytes: number;
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

/** Dataset handed to an import adapter after validation. */
export interface ImportedDataset {
  formatId: string;
  name: string;
  sizeBytes: number;
  mediaType?: string;
  data: string | ArrayBuffer;
}

export interface ImportContext {
  transferId: string;
  senderOrigin: string;
  senderApplication: string;
}

export interface ExportValue {
  data: string | ArrayBuffer | Uint8Array;
  name?: string;
  mediaType?: string;
  schema?: SchemaRef;
}
