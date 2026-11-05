import type { AcceptAck, CancelAck, Capabilities, Offer, OfferAck, Receipt, TransferRequest, Result, TransferStatus } from "@cdep/protocol";

/**
 * CDEP method surface. Declared as object types (not interfaces) so Penpal's
 * `Methods` index-signature constraint accepts them.
 */
export type ReceiverWire = {
  getCapabilities(): Promise<Result<Capabilities>>;
  offer(offer: Offer): Promise<Result<OfferAck>>;
  transfer(request: TransferRequest): Promise<Result<Receipt>>;
  getStatus(request: { transferId: string }): Promise<Result<TransferStatus>>;
  cancel(request: { transferId: string; reason?: string }): Promise<Result<CancelAck>>;
};

export type SenderWire = {
  accept(request: { offerId: string; formatId: string }): Promise<Result<AcceptAck>>;
  cancel(request: { transferId: string; reason?: string }): Promise<Result<CancelAck>>;
};
