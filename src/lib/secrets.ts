import { config } from './app-config.ts';

// Compatibility names for the typed, encrypted admin configuration layer.

export type SecretKey =
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'MS_CLIENT_ID'
  | 'MS_CLIENT_SECRET'
  | 'NOTION_CLIENT_ID'
  | 'NOTION_CLIENT_SECRET'
  | 'ZOHO_CLIENT_ID'
  | 'ZOHO_CLIENT_SECRET';

export function secret(key: SecretKey): string { return config(key); }
