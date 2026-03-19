export interface AuthenticatedClient {
  clientId: string;
  clientName: string;
  defaultWebhookUrl?: string | null;
  maxBatchSize: number;
}

