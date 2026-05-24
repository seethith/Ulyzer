import type { ProviderConfig, ProviderModel } from '@shared/types';

export function selectedModelIsAvailable(
  provider: string,
  model: string,
  models: ProviderModel[],
  providers: ProviderConfig[] = [],
): boolean {
  const providerConfig = providers.find((p) => p.id === provider);
  if (providers.length > 0 && providerConfig?.enabled !== true) return false;
  return Boolean(
    provider &&
    model &&
    models.some((m) => m.providerId === provider && m.modelId === model && m.source !== 'builtin'),
  );
}
