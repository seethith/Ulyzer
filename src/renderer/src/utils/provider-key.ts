import type { ProviderConfig } from '@shared/types';

export function providerKeychainKey(provider: ProviderConfig): string | null {
  if (provider.type === 'ollama') return null;
  return provider.apiKeyName ?? provider.id;
}
